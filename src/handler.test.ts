import { describe, expect, it } from 'vitest';
import type { Config } from './config.js';
import { createHandler, parseDecision, parseRelativeFastPath } from './handler.js';
import { LlmError, type Llm } from './llm.js';
import { MessengerError, type Messenger } from './messenger.js';
import type {
  ActionWebhookPayload,
  MessageAction,
  MessageWebhookPayload,
  ParsedCommand,
  ReplyToRef,
  ScheduledMessage,
  ThreadEntry,
} from './types.js';

/** Fixed clock: 2026-07-15T08:00:00Z == Wednesday 11:00 in Europe/Vilnius (UTC+3). */
const NOW = new Date('2026-07-15T08:00:00.000Z');
const BOT_ID = 42;
const HUMAN_ID = 7;

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    botToken: 'tok',
    messengerUrl: 'http://messenger',
    ollamaUrl: 'http://ollama',
    ollamaModel: 'test-model',
    ollamaTimeoutMs: 1000,
    ollamaThink: null,
    userTimezone: 'Europe/Vilnius',
    port: 0,
    botUserId: null,
    botName: 'Reminder',
    ...overrides,
  };
}

interface SentMessage {
  id: number;
  chatId: number;
  content: string;
  opts?: { mentions?: number[]; actions?: MessageAction[]; replyToId?: number };
}

interface FakeMessenger {
  api: Messenger;
  sent: SentMessage[];
  scheduled: Array<{
    chatId: number;
    content: string;
    scheduledAt: Date;
    mentions?: number[];
    replyToId?: number;
  }>;
  canceled: number[];
  typingPings: number[];
  listResult: ScheduledMessage[];
  cancelResult: boolean;
  scheduleError: Error | null;
}

function makeMessenger(): FakeMessenger {
  const fake: FakeMessenger = {
    sent: [],
    scheduled: [],
    canceled: [],
    typingPings: [],
    listResult: [],
    cancelResult: true,
    scheduleError: null,
    api: {
      async sendMessage(chatId, content, opts) {
        const id = 1000 + fake.sent.length;
        fake.sent.push({ id, chatId, content, opts });
        return {
          id,
          content,
          sender: { id: BOT_ID, displayName: 'Reminder', isBot: true },
          mentions: [],
        };
      },
      async schedule(chatId, content, scheduledAt, opts) {
        if (fake.scheduleError) throw fake.scheduleError;
        fake.scheduled.push({
          chatId,
          content,
          scheduledAt,
          mentions: opts?.mentions,
          replyToId: opts?.replyToId,
        });
        return {
          id: 500 + fake.scheduled.length,
          chatId,
          content,
          mentions: opts?.mentions ?? [],
          replyToId: opts?.replyToId ?? null,
          scheduledAt: scheduledAt.toISOString(),
          createdAt: NOW.toISOString(),
        };
      },
      async listScheduled() {
        return fake.listResult;
      },
      async cancelScheduled(id) {
        fake.canceled.push(id);
        return fake.cancelResult;
      },
      async sendTyping(chatId) {
        fake.typingPings.push(chatId);
      },
    },
  };
  return fake;
}

function makeLlm(...results: Array<ParsedCommand | Error>): Llm & {
  calls: string[];
  threads: ThreadEntry[][];
  zones: (string | undefined)[];
} {
  const queue = [...results];
  const calls: string[] = [];
  const threads: ThreadEntry[][] = [];
  const zones: (string | undefined)[] = [];
  return {
    calls,
    threads,
    zones,
    async parse(message, _now, thread = [], timeZone) {
      calls.push(message);
      threads.push(thread);
      zones.push(timeZone);
      const next = queue.shift();
      if (next === undefined) throw new Error('LLM fake exhausted');
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

let nextMessageId = 1;
function msg(
  content: string,
  opts: {
    chatType?: 'dm' | 'group';
    chatId?: number;
    senderId?: number;
    senderIsBot?: boolean;
    mentions?: number[];
    id?: number;
    replyTo?: ReplyToRef | null;
    senderTimezone?: string | null;
  } = {},
): MessageWebhookPayload {
  return {
    message: {
      id: opts.id ?? nextMessageId++,
      content,
      sender: {
        id: opts.senderId ?? HUMAN_ID,
        displayName: 'Ona',
        isBot: opts.senderIsBot ?? false,
      },
      mentions: opts.mentions ?? [],
      replyTo: opts.replyTo ?? null,
      senderTimezone: opts.senderTimezone ?? null,
    },
    chat: { id: opts.chatId ?? 1, type: opts.chatType ?? 'dm', name: null },
  };
}

function tap(actionId: string, opts: { chatId?: number; messageId?: number } = {}): ActionWebhookPayload {
  return {
    type: 'action',
    action: { id: actionId },
    message: {
      id: opts.messageId ?? 999,
      content: 'x',
      sender: { id: BOT_ID, displayName: 'Reminder' },
      mentions: [],
    },
    user: { id: HUMAN_ID, displayName: 'Ona' },
    chatId: opts.chatId ?? 1,
  };
}

function scheduledRow(id: number, iso: string, content: string): ScheduledMessage {
  return {
    id,
    chatId: 1,
    content,
    mentions: [],
    replyToId: null,
    scheduledAt: iso,
    createdAt: NOW.toISOString(),
  };
}

function build(overrides: {
  config?: Partial<Config>;
  llm?: Llm;
  messenger?: FakeMessenger;
} = {}) {
  const messenger = overrides.messenger ?? makeMessenger();
  const llm = overrides.llm ?? makeLlm();
  const handler = createHandler({
    config: makeConfig(overrides.config),
    messenger: messenger.api,
    llm,
    now: () => new Date(NOW),
    log: () => undefined,
  });
  return { handler, messenger, llm };
}

/** The proposal the last-sent message carries, or throws. */
function proposalOf(messenger: FakeMessenger): {
  message: SentMessage;
  approveId: string;
  denyId: string;
} {
  const message = messenger.sent.at(-1)!;
  const [approve, deny] = message.opts?.actions ?? [];
  expect(approve?.id).toMatch(/^approve:/);
  expect(deny?.id).toMatch(/^deny:/);
  return { message, approveId: approve!.id, denyId: deny!.id };
}

describe('LLM create flow (proposal → approve)', () => {
  it('proposes instead of scheduling, then schedules on approve', async () => {
    const llm = makeLlm({ intent: 'create', what: 'call mom', whenLocal: '2026-07-16T09:00' });
    const { handler, messenger } = build({ llm });

    await handler.handle(msg('remind me tomorrow at 9 to call mom', { id: 70 }));

    // Nothing scheduled yet — only a proposal, replying to the request.
    expect(messenger.scheduled).toHaveLength(0);
    const { message: proposal, approveId } = proposalOf(messenger);
    expect(proposal.content).toContain('Set this reminder?');
    expect(proposal.content).toContain('call mom');
    expect(proposal.content).toContain('Thu, Jul 16 09:00');
    expect(proposal.opts?.replyToId).toBe(70);
    expect(proposal.opts?.actions).toEqual([
      { id: approveId, label: 'Approve', style: 'primary' },
      { id: expect.stringMatching(/^deny:/), label: 'Deny', style: 'danger' },
    ]);

    await handler.handle(tap(approveId, { messageId: proposal.id }));

    expect(messenger.scheduled).toHaveLength(1);
    const s = messenger.scheduled[0]!;
    expect(s.content).toBe('⏰ call mom');
    expect(s.scheduledAt.toISOString()).toBe('2026-07-16T06:00:00.000Z'); // 09:00 EEST
    expect(s.mentions).toEqual([HUMAN_ID]);
    expect(s.replyToId).toBe(70); // the fired reminder quotes the request

    const confirm = messenger.sent.at(-1)!;
    expect(confirm.content).toContain('✅');
    expect(confirm.opts?.replyToId).toBe(proposal.id);
    expect(confirm.opts?.actions).toEqual([{ id: 'cancel:501', label: 'Cancel' }]);
  });

  it('drops the proposal on deny', async () => {
    const llm = makeLlm({ intent: 'create', what: 'x', whenLocal: '2026-07-16T09:00' });
    const { handler, messenger } = build({ llm });

    await handler.handle(msg('remind me...'));
    const { message: proposal, denyId } = proposalOf(messenger);

    await handler.handle(tap(denyId, { messageId: proposal.id }));

    expect(messenger.scheduled).toHaveLength(0);
    expect(messenger.sent.at(-1)!.content).toContain('dropped');
    // (A re-tap on the same message can't happen — the platform 409s it and
    // the action dedup would drop a webhook retry; the stale-key reply is
    // covered by the "unknown proposal keys" test below.)
  });

  it('answers "no longer active" for unknown proposal keys (restart/superseded)', async () => {
    const { handler, messenger } = build();
    await handler.handle(tap('approve:deadbeef'));
    expect(messenger.sent[0]!.content).toContain("isn't active anymore");
  });

  it('refuses an approve that arrives long after the time passed', async () => {
    const llm = makeLlm({ intent: 'create', what: 'x', whenLocal: '2026-07-15T11:30' });
    const messenger = makeMessenger();
    let clock = NOW.getTime();
    const handler = createHandler({
      config: makeConfig(),
      messenger: messenger.api,
      llm,
      now: () => new Date(clock),
      log: () => undefined,
    });

    await handler.handle(msg('remind me at 11:30 to x'));
    const { message: proposal, approveId } = proposalOf(messenger);

    clock += 3 * 60 * 60 * 1000; // approve 3h later — 11:30 is long gone
    await handler.handle(tap(approveId, { messageId: proposal.id }));

    expect(messenger.scheduled).toHaveLength(0);
    expect(messenger.sent.at(-1)!.content).toContain('already passed');
  });

  it('bumps a past-by-hours time to tomorrow and notes it on the proposal', async () => {
    // 08:00 local is 3h in the past at 11:00 local now.
    const llm = makeLlm({ intent: 'create', what: 'take pills', whenLocal: '2026-07-15T08:00' });
    const { handler, messenger } = build({ llm });

    await handler.handle(msg('remind me at 8 to take pills'));
    const { message: proposal, approveId } = proposalOf(messenger);
    expect(proposal.content).toContain('assumed you meant tomorrow');

    await handler.handle(tap(approveId, { messageId: proposal.id }));
    expect(messenger.scheduled[0]!.scheduledAt.toISOString()).toBe('2026-07-16T05:00:00.000Z');
  });

  it('refuses times more than a day in the past without proposing', async () => {
    const llm = makeLlm({ intent: 'create', what: 'x', whenLocal: '2026-07-10T09:00' });
    const { handler, messenger } = build({ llm });

    await handler.handle(msg('remind me...', { id: 71 }));

    expect(messenger.scheduled).toHaveLength(0);
    const reply = messenger.sent[0]!;
    expect(reply.content).toContain('past');
    expect(reply.opts?.replyToId).toBe(71);
    expect(reply.opts?.actions).toBeUndefined();
  });

  it('clamps the lead when an approve lands just before the proposed time', async () => {
    // Proposed for 11:30; approved at 11:29:30 → 30s lead → clamp to +90s.
    const llm = makeLlm({ intent: 'create', what: 'check oven', whenLocal: '2026-07-15T11:30' });
    const messenger = makeMessenger();
    let clock = NOW.getTime();
    const handler = createHandler({
      config: makeConfig(),
      messenger: messenger.api,
      llm,
      now: () => new Date(clock),
      log: () => undefined,
    });

    await handler.handle(msg('at 11:30 check the oven'));
    const { message: proposal, approveId } = proposalOf(messenger);

    clock += 29.5 * 60_000; // 11:29:30 local
    await handler.handle(tap(approveId, { messageId: proposal.id }));

    expect(messenger.scheduled[0]!.scheduledAt.toISOString()).toBe(
      new Date(clock + 90_000).toISOString(),
    );
    expect(messenger.sent.at(-1)!.content).toContain('1 min minimum');
  });

  it('asks for the what when missing, replying to the request', async () => {
    const llm = makeLlm({ intent: 'create', what: '', whenLocal: '2026-07-16T09:00' });
    const { handler, messenger } = build({ llm });

    await handler.handle(msg('remind me tomorrow', { id: 72 }));

    expect(messenger.scheduled).toHaveLength(0);
    expect(messenger.sent[0]!.content).toContain('What should I remind you about?');
    expect(messenger.sent[0]!.opts?.replyToId).toBe(72);
  });

  it('asks for the when on missing or unparseable time, echoing the what', async () => {
    const llm = makeLlm(
      { intent: 'create', what: 'call mom', whenLocal: '' },
      { intent: 'create', what: 'call dad', whenLocal: 'tomorrow-ish' },
    );
    const { handler, messenger } = build({ llm });

    await handler.handle(msg('remind me to call mom'));
    await handler.handle(msg('remind me to call dad sometime'));

    expect(messenger.scheduled).toHaveLength(0);
    expect(messenger.sent[0]!.content).toContain('call mom');
    expect(messenger.sent[0]!.content).toContain('When');
    expect(messenger.sent[1]!.content).toContain('call dad');
  });

  it('treats a when_local that copies "now" as no time given (observed model reflex)', async () => {
    // Now is 11:00 Vilnius; the model answers with 11:01 — a copied now.
    const llm = makeLlm({ intent: 'create', what: 'feed the cat', whenLocal: '2026-07-15T11:01' });
    const { handler, messenger } = build({ llm });

    await handler.handle(msg('remind me to feed the cat'));

    expect(messenger.sent[0]!.content).toContain('When should I remind you about "feed the cat"');
    expect(messenger.sent[0]!.opts?.actions).toBeUndefined(); // an ask, not a proposal
  });

  it('tolerates 1-digit month/day/hour from the model', async () => {
    const llm = makeLlm({ intent: 'create', what: 'x', whenLocal: '2026-7-16T9:00' });
    const { handler, messenger } = build({ llm });

    await handler.handle(msg('remind me tomorrow at 9'));

    expect(proposalOf(messenger).message.content).toContain('Thu, Jul 16 09:00');
  });

  it('truncates an absurdly long what', async () => {
    const llm = makeLlm({ intent: 'create', what: 'x'.repeat(2000), whenLocal: '2026-07-16T09:00' });
    const { handler, messenger } = build({ llm });

    await handler.handle(msg('remind me...'));
    const { message: proposal, approveId } = proposalOf(messenger);
    await handler.handle(tap(approveId, { messageId: proposal.id }));

    expect(messenger.scheduled[0]!.content.length).toBeLessThanOrEqual(1010);
  });

  it('degrades to a plain reminder when the request message was deleted before approve', async () => {
    const messenger = makeMessenger();
    const realSchedule = messenger.api.schedule.bind(messenger.api);
    messenger.api.schedule = async (chatId, content, at, opts) => {
      if (opts?.replyToId) throw new MessengerError(400, 'Invalid reply target');
      return realSchedule(chatId, content, at, opts);
    };
    const llm = makeLlm({ intent: 'create', what: 'call mom', whenLocal: '2026-07-16T09:00' });
    const { handler } = build({ llm, messenger });

    await handler.handle(msg('remind me tomorrow at 9 to call mom'));
    const { message: proposal, approveId } = proposalOf(messenger);
    await handler.handle(tap(approveId, { messageId: proposal.id }));

    expect(messenger.scheduled).toHaveLength(1); // scheduled anyway, minus the quote
    expect(messenger.scheduled[0]!.replyToId).toBeUndefined();
    expect(messenger.sent.at(-1)!.content).toContain('✅');
  });

  it('drops a redelivered action callback instead of answering twice', async () => {
    const llm = makeLlm({ intent: 'create', what: 'x', whenLocal: '2026-07-16T09:00' });
    const { handler, messenger } = build({ llm });

    await handler.handle(msg('remind me...'));
    const { message: proposal, approveId } = proposalOf(messenger);
    const sentBefore = messenger.sent.length;

    await handler.handle(tap(approveId, { messageId: proposal.id }));
    await handler.handle(tap(approveId, { messageId: proposal.id })); // webhook retry

    expect(messenger.scheduled).toHaveLength(1);
    // Exactly one confirmation — no trailing "I lost track…" from the retry.
    expect(messenger.sent.length).toBe(sentBefore + 1);
  });

  it('surfaces server 400s (e.g. the pending cap) on approve', async () => {
    const messenger = makeMessenger();
    messenger.scheduleError = new MessengerError(400, 'Too many scheduled messages for this chat (max 20)');
    const llm = makeLlm({ intent: 'create', what: 'x', whenLocal: '2026-07-16T09:00' });
    const { handler } = build({ llm, messenger });

    await handler.handle(msg('remind me...'));
    const { message: proposal, approveId } = proposalOf(messenger);
    await handler.handle(tap(approveId, { messageId: proposal.id }));

    expect(messenger.sent.at(-1)!.content).toContain('Too many scheduled messages');
  });
});

describe('relative fast path (no LLM, no approval)', () => {
  it.each([
    ['in 20 min check the oven', 'check the oven', 20],
    ['remind me in 2 hours to stretch', 'stretch', 120],
    ['please remind me in 5 min to call mom', 'call mom', 5],
    ['remind me to hydrate in 45 minutes', 'hydrate', 45],
    ['in 1 h standup', 'standup', 60],
    ['po 5 min išjunk orkaitę', 'išjunk orkaitę', 5],
    ['primink po 2 valandų paskambinti', 'paskambinti', 120],
  ])('%j -> %j in %i min', (input, what, minutes) => {
    expect(parseRelativeFastPath(input)).toEqual({ what, offsetMs: minutes * 60_000 });
  });

  it.each([
    'remind me tomorrow at 9 to call mom', // no relative marker
    'rytoj 9 val paskambinti mamai', // bare "val" is o'clock, not hours
    'po 9 val pas dantistą', // ambiguous Lithuanian — leave to the LLM
    'in 20 min', // no what
    'in a few minutes tea', // no digits
  ])('leaves %j to the LLM', (input) => {
    expect(parseRelativeFastPath(input)).toBeNull();
  });

  it('schedules immediately (no proposal), reply-anchored both ways', async () => {
    const llm = makeLlm(); // exhausted fake — any call would throw
    const { handler, messenger } = build({ llm });

    await handler.handle(msg('in 20 min check the oven', { id: 80 }));

    expect(messenger.scheduled[0]!.scheduledAt.toISOString()).toBe('2026-07-15T08:20:00.000Z');
    expect(messenger.scheduled[0]!.content).toBe('⏰ check the oven');
    expect(messenger.scheduled[0]!.replyToId).toBe(80);
    const confirm = messenger.sent[0]!;
    expect(confirm.content).toContain('✅');
    expect(confirm.opts?.replyToId).toBe(80);
  });

  it('clamps a fast-path "in 1 min" to the safe minimum', async () => {
    const { handler, messenger } = build();

    await handler.handle(msg('in 1 min tea'));

    expect(messenger.scheduled[0]!.scheduledAt.toISOString()).toBe('2026-07-15T08:01:30.000Z');
    expect(messenger.sent[0]!.content).toContain('1 min minimum');
  });
});

describe('per-message sender timezone', () => {
  it('parses, proposes and schedules in the SENDER\'s zone when the message carries one', async () => {
    // NOW is 08:00Z — 04:00 in New York (EDT, UTC-4).
    const llm = makeLlm({ intent: 'create', what: 'call mom', whenLocal: '2026-07-16T09:00' });
    const { handler, messenger } = build({ llm });

    await handler.handle(
      msg('remind me tomorrow at 9 to call mom', { senderTimezone: 'America/New_York' }),
    );

    expect(llm.zones[0]).toBe('America/New_York'); // prompt anchored to NY time
    const { message: proposal, approveId } = proposalOf(messenger);
    expect(proposal.content).toContain('Thu, Jul 16 09:00'); // NY wall clock shown

    await handler.handle(tap(approveId, { messageId: proposal.id }));
    // 09:00 America/New_York == 13:00Z (not 06:00Z as Vilnius would give).
    expect(messenger.scheduled[0]!.scheduledAt.toISOString()).toBe('2026-07-16T13:00:00.000Z');
  });

  it('falls back to USER_TIMEZONE for an invalid or missing sender zone', async () => {
    const llm = makeLlm(
      { intent: 'help', what: '', whenLocal: '' },
      { intent: 'help', what: '', whenLocal: '' },
    );
    const { handler } = build({ llm });

    await handler.handle(msg('help', { senderTimezone: 'Mars/Olympus_Mons' }));
    await handler.handle(msg('help'));

    expect(llm.zones).toEqual(['Europe/Vilnius', 'Europe/Vilnius']);
  });

  it('formats fast-path confirmations in the sender zone', async () => {
    const { handler, messenger } = build();

    await handler.handle(msg('in 20 min tea', { senderTimezone: 'America/New_York' }));

    // 08:20Z is 04:20 in New York.
    expect(messenger.sent[0]!.content).toContain('04:20');
  });
});

describe('typed approve/deny', () => {
  it.each([
    ['yes', 'approve'],
    ['OK!', 'approve'],
    ['taip', 'approve'],
    ['👍', 'approve'],
    ['no', 'deny'],
    ['ne', 'deny'],
    ['nereikia', 'deny'],
  ])('%j -> %s', (input, expected) => {
    expect(parseDecision(input)).toBe(expected);
  });

  it.each(['ne rytoj', 'ok let me think', 'yes and also remind me later', 'kas suplanuota?'])(
    'ignores %j (not a whole-message decision)',
    (input) => {
      expect(parseDecision(input)).toBeNull();
    },
  );

  it('approves the pending proposal on a typed "ok" without an LLM call', async () => {
    const llm = makeLlm({ intent: 'create', what: 'call mom', whenLocal: '2026-07-16T09:00' });
    const { handler, messenger } = build({ llm });

    await handler.handle(msg('remind me tomorrow at 9 to call mom'));
    await handler.handle(msg('ok', { id: 200 }));

    expect(llm.calls).toHaveLength(1); // "ok" never reached the LLM
    expect(messenger.scheduled).toHaveLength(1);
    const confirm = messenger.sent.at(-1)!;
    expect(confirm.content).toContain('✅');
    expect(confirm.opts?.replyToId).toBe(200);

    // Nothing pending anymore — a second "yes" says so instead of re-scheduling.
    await handler.handle(msg('yes'));
    expect(messenger.scheduled).toHaveLength(1);
    expect(messenger.sent.at(-1)!.content).toContain('Nothing is awaiting approval');
  });

  it('denies on a typed Lithuanian "ne"', async () => {
    const llm = makeLlm({ intent: 'create', what: 'x', whenLocal: '2026-07-16T09:00' });
    const { handler, messenger } = build({ llm });

    await handler.handle(msg('remind me...'));
    await handler.handle(msg('ne'));

    expect(messenger.scheduled).toHaveLength(0);
    expect(messenger.sent.at(-1)!.content).toContain('dropped');
  });

  it('answers "nothing awaiting" for a decision with no pending proposal', async () => {
    const llm = makeLlm(); // any LLM call would throw
    const { handler, messenger } = build({ llm });

    await handler.handle(msg('yes'));

    expect(messenger.sent[0]!.content).toContain('Nothing is awaiting approval');
  });
});

describe('proposal superseding (one per chat)', () => {
  it('a corrected proposal kills the previous one', async () => {
    const llm = makeLlm(
      { intent: 'create', what: 'call mom', whenLocal: '2026-07-16T09:00' },
      { intent: 'create', what: 'call mom', whenLocal: '2026-07-16T10:00' },
    );
    const { handler, messenger } = build({ llm });

    await handler.handle(msg('remind me tomorrow at 9 to call mom'));
    const first = proposalOf(messenger);

    await handler.handle(msg('actually make it 10'));
    const second = proposalOf(messenger);
    expect(second.message.content).toContain('replaces the previous proposal');

    // The superseded key is dead…
    await handler.handle(tap(first.approveId, { messageId: first.message.id }));
    expect(messenger.scheduled).toHaveLength(0);
    expect(messenger.sent.at(-1)!.content).toContain("isn't active anymore");

    // …the new one works, and the supersede note stays OUT of the confirmation.
    await handler.handle(tap(second.approveId, { messageId: second.message.id }));
    expect(messenger.scheduled).toHaveLength(1);
    expect(messenger.scheduled[0]!.scheduledAt.toISOString()).toBe('2026-07-16T07:00:00.000Z');
    expect(messenger.sent.at(-1)!.content).not.toContain('replaces');
  });
});

describe('typing indicator', () => {
  it('pings typing while the LLM parses', async () => {
    const llm = makeLlm({ intent: 'help', what: '', whenLocal: '' });
    const { handler, messenger } = build({ llm });

    await handler.handle(msg('what can you do?'));

    expect(messenger.typingPings.length).toBeGreaterThanOrEqual(1);
    expect(messenger.typingPings[0]).toBe(1);
  });

  it('skips typing on the instant fast paths', async () => {
    const { handler, messenger } = build();

    await handler.handle(msg('in 20 min tea'));
    await handler.handle(msg('yes'));

    expect(messenger.typingPings).toHaveLength(0);
  });
});

describe('reply-thread context to the LLM', () => {
  it('passes the bot question + earlier request when the user replies (cache walk)', async () => {
    const llm = makeLlm(
      { intent: 'create', what: 'call mom', whenLocal: '' }, // ask-when
      { intent: 'create', what: 'call mom', whenLocal: '2026-07-16T09:00' },
    );
    const { handler, messenger } = build({ llm });

    await handler.handle(msg('remind me to call mom', { id: 90 }));
    const ask = messenger.sent[0]!; // bot's "When…?" reply (id 1000, replyTo 90)

    await handler.handle(
      msg('tomorrow at 9', {
        id: 91,
        replyTo: { id: ask.id, senderId: BOT_ID, content: ask.content, isDeleted: false },
      }),
    );

    expect(llm.threads[1]).toEqual([
      { from: 'user', text: 'remind me to call mom' },
      { from: 'bot', text: expect.stringContaining('When should I remind you') },
    ]);
    expect(proposalOf(messenger).message.content).toContain('call mom');
  });

  it('falls back to the embedded reply hop when the cache is cold', async () => {
    const llm = makeLlm({ intent: 'help', what: '', whenLocal: '' });
    const { handler } = build({ llm, config: { botUserId: BOT_ID } });

    await handler.handle(
      msg('what?', {
        replyTo: { id: 555, senderId: BOT_ID, content: 'When should I remind you about "x"?', isDeleted: false },
      }),
    );

    expect(llm.threads[0]).toEqual([
      { from: 'bot', text: 'When should I remind you about "x"?' },
    ]);
  });

  it('skips deleted reply targets and sends no thread for plain messages', async () => {
    const llm = makeLlm(
      { intent: 'help', what: '', whenLocal: '' },
      { intent: 'help', what: '', whenLocal: '' },
    );
    const { handler } = build({ llm });

    await handler.handle(
      msg('hello', { replyTo: { id: 556, senderId: HUMAN_ID, content: 'gone', isDeleted: true } }),
    );
    await handler.handle(msg('hello again'));

    expect(llm.threads[0]).toEqual([]);
    expect(llm.threads[1]).toEqual([]);
  });
});

describe('webhook dedup', () => {
  it('processes a redelivered message id only once', async () => {
    const llm = makeLlm(
      { intent: 'create', what: 'call mom', whenLocal: '2026-07-16T09:00' },
      { intent: 'create', what: 'call mom', whenLocal: '2026-07-16T09:00' },
    );
    const { handler, messenger } = build({ llm });

    const payload = msg('remind me tomorrow at 9 to call mom', { id: 77 });
    await handler.handle(payload);
    await handler.handle(structuredClone(payload));

    expect(messenger.sent).toHaveLength(1); // one proposal, not two
  });
});

describe('addressing rules', () => {
  it('ignores messages from other bots', async () => {
    const { handler, messenger, llm } = build();
    await handler.handle(msg('Echo: remind me tomorrow', { senderIsBot: true }));
    expect((llm as ReturnType<typeof makeLlm>).calls).toHaveLength(0);
    expect(messenger.sent).toHaveLength(0);
  });

  it('ignores group messages that do not mention the bot', async () => {
    const { handler, messenger } = build({ config: { botUserId: BOT_ID } });
    await handler.handle(msg('lunch?', { chatType: 'group' }));
    expect(messenger.sent).toHaveLength(0);
  });

  it('handles group messages mentioning the bot by id and strips the @name', async () => {
    const llm = makeLlm({ intent: 'create', what: 'standup', whenLocal: '2026-07-16T09:00' });
    const { handler, messenger } = build({ llm, config: { botUserId: BOT_ID } });

    await handler.handle(
      msg('@Reminder remind us about standup tomorrow 9', {
        chatType: 'group',
        mentions: [BOT_ID],
      }),
    );

    expect(llm.calls[0]).not.toContain('@Reminder');
    expect(proposalOf(messenger).message.content).toContain('standup');
  });

  it('falls back to @name matching in groups before the bot knows its own id', async () => {
    const llm = makeLlm({ intent: 'help', what: '', whenLocal: '' });
    const { handler, messenger } = build({ llm });

    await handler.handle(msg('@reminder help', { chatType: 'group' }));

    expect(messenger.sent).toHaveLength(1);
  });

  it('learns its own id from the first send and then matches group mentions by id', async () => {
    const llm = makeLlm(
      { intent: 'help', what: '', whenLocal: '' },
      { intent: 'help', what: '', whenLocal: '' },
    );
    const { handler, messenger } = build({ llm });

    await handler.handle(msg('help me out')); // DM → send → learns BOT_ID
    await handler.handle(msg('hey bot, help', { chatType: 'group', mentions: [BOT_ID] }));

    expect(messenger.sent).toHaveLength(2);
  });

  it('answers attachment-only (empty content) DMs with help without an LLM call', async () => {
    const llm = makeLlm();
    const { handler, messenger } = build({ llm });

    await handler.handle(msg('   ', { id: 95 }));

    expect((llm as ReturnType<typeof makeLlm>).calls).toHaveLength(0);
    expect(messenger.sent[0]!.content).toContain('I set reminders');
    expect(messenger.sent[0]!.opts?.replyToId).toBe(95);
  });
});

describe('list and cancel', () => {
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      scheduledRow(600 + i, new Date(NOW.getTime() + (i + 1) * 3_600_000).toISOString(), `⏰ item ${i + 1}`),
    );

  it('lists pending reminders with cancel buttons, as a reply', async () => {
    const messenger = makeMessenger();
    messenger.listResult = rows(2);
    const llm = makeLlm({ intent: 'list', what: '', whenLocal: '' });
    const { handler } = build({ llm, messenger });

    await handler.handle(msg("what's scheduled?", { id: 96 }));

    const sent = messenger.sent[0]!;
    expect(sent.content).toContain('1. ');
    expect(sent.content).toContain('item 2');
    expect(sent.content).not.toContain('⏰'); // prefix stripped in listing
    expect(sent.content).toContain('cancel N'); // buttons die after the first tap
    expect(sent.opts?.replyToId).toBe(96);
    expect(sent.opts?.actions).toHaveLength(2);
    expect(sent.opts?.actions?.[0]).toEqual({ id: 'cancel:600', label: 'Cancel 1' });
  });

  it('caps buttons at 6 and offers the cancel-N fallback for the rest', async () => {
    const messenger = makeMessenger();
    messenger.listResult = rows(8);
    const llm = makeLlm({ intent: 'list', what: '', whenLocal: '' });
    const { handler } = build({ llm, messenger });

    await handler.handle(msg('list'));

    const sent = messenger.sent[0]!;
    expect(sent.opts?.actions).toHaveLength(6);
    expect(sent.content).toContain('cancel N');
    expect(sent.content).toContain('8. ');
  });

  it('says so when nothing is scheduled', async () => {
    const llm = makeLlm({ intent: 'list', what: '', whenLocal: '' });
    const { handler, messenger } = build({ llm });

    await handler.handle(msg('list'));

    expect(messenger.sent[0]!.content).toContain('Nothing scheduled');
  });

  it('cancel intent shows the same listing', async () => {
    const messenger = makeMessenger();
    messenger.listResult = rows(1);
    const llm = makeLlm({ intent: 'cancel', what: 'dentist', whenLocal: '' });
    const { handler } = build({ llm, messenger });

    await handler.handle(msg('cancel the dentist one'));

    expect(messenger.sent[0]!.opts?.actions?.[0]?.id).toBe('cancel:600');
  });

  it('resolves "cancel N" against the last listing without the LLM', async () => {
    const messenger = makeMessenger();
    messenger.listResult = rows(3);
    const llm = makeLlm({ intent: 'list', what: '', whenLocal: '' });
    const { handler } = build({ llm, messenger });

    await handler.handle(msg('list'));
    await handler.handle(msg('cancel 2', { id: 97 }));

    expect(messenger.canceled).toEqual([601]);
    expect((llm as ReturnType<typeof makeLlm>).calls).toHaveLength(1); // only the list call
    const reply = messenger.sent[1]!;
    expect(reply.content).toContain('Canceled #2');
    expect(reply.opts?.replyToId).toBe(97);
  });

  it('shows a fresh listing when "cancel N" has no listing to refer to', async () => {
    const messenger = makeMessenger();
    messenger.listResult = rows(2);
    const { handler } = build({ messenger });

    await handler.handle(msg('cancel 1'));

    expect(messenger.canceled).toEqual([]);
    expect(messenger.sent[0]!.content).toContain('1. ');
  });
});

describe('action taps', () => {
  it('cancels on a cancel:<id> tap, replying to the tapped message', async () => {
    const { handler, messenger } = build();
    await handler.handle(tap('cancel:512', { messageId: 321 }));
    expect(messenger.canceled).toEqual([512]);
    expect(messenger.sent[0]!.content).toContain('Canceled');
    expect(messenger.sent[0]!.opts?.replyToId).toBe(321);
  });

  it('answers "already gone" when the row is missing (double tap / already fired)', async () => {
    const messenger = makeMessenger();
    messenger.cancelResult = false;
    const { handler } = build({ messenger });

    await handler.handle(tap('cancel:512'));

    expect(messenger.sent[0]!.content).toContain('already gone');
  });

  it('ignores unknown action ids', async () => {
    const { handler, messenger } = build();
    await handler.handle(tap('like'));
    expect(messenger.sent).toHaveLength(0);
  });
});

describe('failure modes', () => {
  it('reports an unreachable LLM honestly, as a reply', async () => {
    const llm = makeLlm(new LlmError('Ollama HTTP 504'));
    const { handler, messenger } = build({ llm });

    await handler.handle(msg('remind me tomorrow', { id: 98 }));

    expect(messenger.sent[0]!.content).toContain("couldn't reach my brain");
    expect(messenger.sent[0]!.opts?.replyToId).toBe(98);
  });

  it('answers help and other intents with usage text', async () => {
    const llm = makeLlm(
      { intent: 'help', what: '', whenLocal: '' },
      { intent: 'other', what: '', whenLocal: '' },
    );
    const { handler, messenger } = build({ llm });

    await handler.handle(msg('what can you do?'));
    await handler.handle(msg('nice weather eh'));

    expect(messenger.sent[0]!.content).toContain('I set reminders');
    expect(messenger.sent[1]!.content).toContain('only do reminders');
  });

  it('never throws out of handle(), even when everything fails', async () => {
    const messenger = makeMessenger();
    messenger.api.listScheduled = async () => {
      throw new Error('boom');
    };
    const llm = makeLlm({ intent: 'list', what: '', whenLocal: '' });
    const { handler } = build({ llm, messenger });

    await expect(handler.handle(msg('list'))).resolves.toBeUndefined();
    expect(messenger.sent[0]!.content).toContain('Something went wrong');
  });
});
