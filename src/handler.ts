import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import type { Llm } from './llm.js';
import { LlmError } from './llm.js';
import { MessengerError, type Messenger, type SendOptions } from './messenger.js';
import {
  bumpWallClockDays,
  formatInZone,
  formatRelative,
  parseWallClock,
  wallClockInZone,
  zonedWallClockToUtc,
  type WallClock,
} from './time.js';
import type {
  ActionWebhookPayload,
  MessageWebhookPayload,
  ScheduledMessage,
  ThreadEntry,
  WebhookPayload,
} from './types.js';

/**
 * The bot's brain: one webhook payload in, zero or more messenger calls out.
 * Everything impure (messenger, llm, clock) is injected; tests drive it with
 * fakes. Never throws — every path ends in a user-facing reply or a logged
 * skip, because a webhook handler crash would just mean silence.
 *
 * Every response REPLIES to the message that triggered it (replyToId), so
 * each answer is visibly anchored to its question; the fired reminder itself
 * replies to the message that requested it (jump-to-original context).
 *
 * LLM-parsed creates are NOT scheduled directly: the parse becomes a
 * PROPOSAL with Approve/Deny buttons, and only an approve tap schedules.
 * The deterministic "in N min" fast path skips the ceremony — it can't
 * misparse, and its confirmation already carries Cancel.
 */

export interface HandlerDeps {
  config: Config;
  messenger: Messenger;
  llm: Llm;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface Handler {
  handle(payload: WebhookPayload): Promise<void>;
}

/** Server floor is 60 s; anything thinner than this at POST time gets bumped. */
const MIN_SAFE_LEAD_MS = 75_000;
/** Where a too-thin lead gets bumped to. */
const CLAMPED_LEAD_MS = 90_000;
/** How stale an approved proposal's time may be before we refuse instead of clamping. */
const APPROVE_GRACE_MS = 2 * 60_000;
/** How far past a parsed time may be and still mean "tomorrow" (bump 1 day). */
const PAST_BUMP_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Reminder text cap — well under the server's 4000 incl. the "⏰ " prefix. */
const MAX_WHAT_CHARS = 1000;
/** Dedup memory for webhook redeliveries (server retries on lost acks). */
const DEDUP_CAP = 500;
/** Seen-message cache for reply-thread reconstruction. */
const CACHE_CAP = 300;
/** Un-decided proposals kept in memory. */
const PENDING_CAP = 100;
/** Reply-thread depth and per-entry length shown to the LLM. */
const THREAD_MAX_HOPS = 5;
const THREAD_ENTRY_CHARS = 300;
/** Re-arm the typing indicator this often while the LLM runs (clients expire it at ~4 s). */
const TYPING_REFRESH_MS = 3000;

const HELP_TEXT = [
  'I set reminders in this chat. Try:',
  '• "remind me tomorrow at 9 to call mom"',
  '• "in 20 min check the oven"',
  '• "primink rytoj 9 val. išnešti šiukšles"',
  '• "what\'s scheduled?" — list & cancel',
  'One-off reminders only for now (no repeating).',
].join('\n');

/** Insertion-ordered bounded set — enough LRU for webhook dedup. */
class BoundedSet {
  private seen = new Set<number>();
  constructor(private readonly cap: number) {}
  has(key: number): boolean {
    return this.seen.has(key);
  }
  add(key: number): void {
    this.seen.delete(key);
    this.seen.add(key);
    if (this.seen.size > this.cap) {
      const oldest: number = this.seen.values().next().value!;
      this.seen.delete(oldest);
    }
  }
}

/** Insertion-ordered bounded map (oldest evicted past cap). */
class BoundedMap<K, V> {
  private map = new Map<K, V>();
  constructor(private readonly cap: number) {}
  get(key: K): V | undefined {
    return this.map.get(key);
  }
  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.cap) {
      const oldest: K = this.map.keys().next().value!;
      this.map.delete(oldest);
    }
  }
  delete(key: K): boolean {
    return this.map.delete(key);
  }
}

/** A cached sighting of a message — enough to rebuild reply threads. */
interface CachedMessage {
  content: string;
  isBot: boolean;
  replyToId: number | null;
}

/** An LLM-parsed create waiting for its Approve tap. */
interface PendingProposal {
  chatId: number;
  requesterId: number;
  requestMessageId: number;
  what: string;
  whenUtc: Date;
  notes: string[];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A whole-message typed Approve/Deny for the chat's pending proposal —
 * buttons are nicer, but a 2-person chat will type "ok"/"taip" constantly.
 * Full-match only: "ne" mid-sentence must never deny anything.
 */
export function parseDecision(content: string): 'approve' | 'deny' | null {
  if (/^(?:yes|yep|yeah|ok|okay|sure|approve|confirm|taip|gerai|jo|👍)[\s!.…]*$/iu.test(content)) {
    return 'approve';
  }
  if (/^(?:no|nope|deny|drop|ne|nereikia|atšauk(?:ti)?|👎)[\s!.…]*$/iu.test(content)) {
    return 'deny';
  }
  return null;
}

/** Same wall-clock minute, ±1 min slack (LLM saw a slightly older "now"). */
function sameMinute(a: WallClock, b: WallClock): boolean {
  return (
    a.year === b.year &&
    a.month === b.month &&
    a.day === b.day &&
    Math.abs(a.hour * 60 + a.minute - (b.hour * 60 + b.minute)) <= 1
  );
}

function isAction(p: WebhookPayload): p is ActionWebhookPayload {
  return 'type' in p && p.type === 'action';
}

/**
 * "in 20 min check the oven" / "po 5 min išjunk orkaitę" — the single most
 * common reminder shape, and precisely the one small LLMs botch (clock
 * arithmetic). Regex-sized, so it never touches the LLM: instant and exact.
 * Deliberately narrow: Lithuanian bare "val" is NOT a relative marker
 * ("rytoj 9 val" = "tomorrow at 9 o'clock"), only the full "valand…" stem is.
 */
export function parseRelativeFastPath(
  content: string,
): { what: string; offsetMs: number } | null {
  // \p{L} (not \w) — the unit stems must match Lithuanian letters (valandų, minučių).
  const m =
    /\b(?:in|po|už)\s+(\d{1,3})\s*(min(?:ute)?s?\.?|minu\p{L}+|h\b|hours?|valand\p{L}+)(?=[\s,.!?]|$)/iu.exec(
      content,
    );
  if (!m) return null;
  const n = Number(m[1]);
  if (n <= 0) return null;
  const isHours = /^(h|hour|valand)/i.test(m[2]!);
  const what = content
    .replace(m[0], ' ')
    .replace(/^\s*(?:please\s+|prašau\s+)?(?:remind me(?:\s+to)?|priminki?(?:te)?(?:\s+man)?)\b/i, ' ')
    .replace(/^\s*to\s+/i, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!what) return null; // bare "in 20 min" — let the LLM/ask-what path handle it
  return { what, offsetMs: n * (isHours ? 3_600_000 : 60_000) };
}

export function createHandler(deps: HandlerDeps): Handler {
  const { config, messenger, llm } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line: string) => console.log(line));

  const processed = new BoundedSet(DEDUP_CAP);
  const processedActions = new BoundedSet(DEDUP_CAP);
  /** chatId → scheduled ids in the order of the last listing (for "cancel N"). */
  const lastListing = new Map<number, number[]>();
  /** Recently seen messages (incoming AND our own sends) for thread rebuilds. */
  const seenMessages = new BoundedMap<number, CachedMessage>(CACHE_CAP);
  /** Proposals awaiting Approve/Deny. Restart loses them — taps then say so. */
  const pendingProposals = new BoundedMap<string, PendingProposal>(PENDING_CAP);
  /** chatId → key of its ONE pending proposal (a new proposal supersedes the old). */
  const chatProposal = new Map<number, string>();
  /** Self-learned from send responses; env BOT_USER_ID is just the bootstrap. */
  let ownId: number | null = config.botUserId;

  async function send(chatId: number, content: string, opts?: SendOptions): Promise<void> {
    const sent = await messenger.sendMessage(chatId, content, opts);
    ownId ??= sent.sender.id;
    seenMessages.set(sent.id, {
      content,
      isBot: true,
      replyToId: opts?.replyToId ?? null,
    });
  }

  /** Keep the chat's typing indicator alive while `work` runs (best-effort). */
  async function withTyping<T>(chatId: number, work: () => Promise<T>): Promise<T> {
    void messenger.sendTyping(chatId);
    const timer = setInterval(() => void messenger.sendTyping(chatId), TYPING_REFRESH_MS);
    timer.unref?.();
    try {
      return await work();
    } finally {
      clearInterval(timer);
    }
  }

  const zone = config.userTimezone;

  /** Reply chain leading to `message`, oldest first, for the LLM prompt. */
  function buildThread(message: MessageWebhookPayload['message']): ThreadEntry[] {
    const thread: ThreadEntry[] = [];
    let nextId: number | null = message.replyTo?.id ?? null;
    for (let hop = 0; nextId !== null && hop < THREAD_MAX_HOPS; hop++) {
      const cached = seenMessages.get(nextId);
      let entry: { text: string; isBot: boolean } | null = null;
      if (cached) {
        entry = { text: cached.content, isBot: cached.isBot };
        nextId = cached.replyToId;
      } else if (hop === 0 && message.replyTo && !message.replyTo.isDeleted) {
        // Not in cache (restart, eviction) — the DTO still embeds one hop.
        entry = {
          text: message.replyTo.content,
          isBot: ownId !== null && message.replyTo.senderId === ownId,
        };
        nextId = null;
      } else {
        break;
      }
      if (entry.text.trim()) {
        thread.unshift({
          from: entry.isBot ? 'bot' : 'user',
          text: entry.text.slice(0, THREAD_ENTRY_CHARS),
        });
      }
    }
    return thread;
  }

  function describe(row: ScheduledMessage, at: Date): string {
    const when = new Date(row.scheduledAt);
    const what = row.content.replace(/^⏰ /, '');
    return `${formatInZone(when, zone, at)} (${formatRelative(when, at)}) — ${what}`;
  }

  /** Shared by the "list" and "cancel" intents: text list + cancel buttons. */
  async function sendListing(chatId: number, replyToId: number): Promise<void> {
    const rows = await messenger.listScheduled(chatId);
    if (rows.length === 0) {
      lastListing.delete(chatId);
      await send(chatId, 'Nothing scheduled in this chat.', { replyToId });
      return;
    }
    const at = now();
    const lines = rows.map((row, i) => `${i + 1}. ${describe(row, at)}`);
    lastListing.set(
      chatId,
      rows.map((r) => r.id),
    );
    // Buttons on a message are single-use as a set (first tap claims the
    // message), so with several rows the text fallback is the real cancel UI.
    const extra = rows.length > 1 ? '\nReply "cancel N" to cancel one without a button.' : '';
    await send(chatId, `📋 Scheduled:\n${lines.join('\n')}${extra}`, {
      replyToId,
      actions: rows.slice(0, 6).map((row, i) => ({ id: `cancel:${row.id}`, label: `Cancel ${i + 1}` })),
    });
  }

  async function cancelById(
    chatId: number,
    scheduledId: number,
    label: string,
    replyToId: number,
  ): Promise<void> {
    const deleted = await messenger.cancelScheduled(scheduledId);
    await send(
      chatId,
      deleted ? `🗑️ Canceled ${label}.` : `${label} is already gone — sent or canceled earlier.`,
      { replyToId },
    );
  }

  /** Shared tail of both create paths: clamp, schedule, surface 400s, confirm. */
  async function scheduleAndConfirm(
    chatId: number,
    requesterId: number,
    what: string,
    whenUtcIn: Date,
    notes: string[],
    opts: { confirmReplyToId: number; requestMessageId: number },
  ): Promise<void> {
    let whenUtc = whenUtcIn;
    if (whenUtc.getTime() - now().getTime() < MIN_SAFE_LEAD_MS) {
      whenUtc = new Date(now().getTime() + CLAMPED_LEAD_MS);
      notes.push('bumped to the ~1 min minimum');
    }

    let scheduled: ScheduledMessage;
    try {
      // The fired reminder replies to the message that asked for it.
      scheduled = await messenger.schedule(chatId, `⏰ ${what}`, whenUtc, {
        mentions: [requesterId],
        replyToId: opts.requestMessageId,
      });
    } catch (err) {
      if (err instanceof MessengerError && err.status === 400) {
        if (err.message === 'Invalid reply target') {
          // The request message was deleted between asking and scheduling.
          // The quote was nice-to-have context — degrade to a plain reminder
          // (the platform dispatcher does the same for targets that die
          // later), never fail an approved reminder over it.
          scheduled = await messenger.schedule(chatId, `⏰ ${what}`, whenUtc, {
            mentions: [requesterId],
          });
        } else {
          await send(chatId, `The server refused that: ${err.message}`, {
            replyToId: opts.confirmReplyToId,
          });
          return;
        }
      } else {
        throw err;
      }
    }

    const at = now();
    const when = new Date(scheduled.scheduledAt);
    const noteSuffix = notes.length > 0 ? `\n(${notes.join('; ')})` : '';
    await send(
      chatId,
      `✅ ${formatInZone(when, zone, at)} (${formatRelative(when, at)}) — ${what}${noteSuffix}`,
      {
        replyToId: opts.confirmReplyToId,
        actions: [{ id: `cancel:${scheduled.id}`, label: 'Cancel' }],
      },
    );
  }

  /** The LLM create path: validate the parse, resolve the time, then PROPOSE. */
  async function proposeReminder(
    chatId: number,
    requesterId: number,
    requestMessageId: number,
    what: string,
    whenLocal: string,
  ): Promise<void> {
    const trimmedWhat = what.length > MAX_WHAT_CHARS ? `${what.slice(0, MAX_WHAT_CHARS)}…` : what;
    if (!trimmedWhat) {
      await send(
        chatId,
        'What should I remind you about? E.g. "remind me tomorrow at 9 to call mom". (You can reply to this message.)',
        { replyToId: requestMessageId },
      );
      return;
    }
    const wall = whenLocal ? parseWallClock(whenLocal) : null;
    // Observed model reflex (systematic on small models): a message with NO
    // time in it comes back with the prompt's "Now" copied into when_local.
    // A reminder for the current minute is meaningless anyway — treat it as
    // "no time given" and ask, instead of proposing a nonsense time.
    const copiedNow = wall !== null && sameMinute(wall, wallClockInZone(now(), zone));
    if (!wall || copiedNow) {
      await send(
        chatId,
        `When should I remind you about "${trimmedWhat}"? Try "tomorrow 9:00" or "in 20 min". (You can reply to this message.)`,
        { replyToId: requestMessageId },
      );
      return;
    }

    // Lead is computed against a FRESH clock — the LLM call above took seconds.
    const notes: string[] = [];
    let whenUtc = zonedWallClockToUtc(wall, zone);
    const lead = whenUtc.getTime() - now().getTime();

    if (lead < 0 && lead >= -PAST_BUMP_WINDOW_MS) {
      // "at 8" said at 22:30 → the model resolved to this morning; the human
      // meant tomorrow. Bump on the local calendar (never ms — DST).
      whenUtc = zonedWallClockToUtc(bumpWallClockDays(wall, 1), zone);
      notes.push('assumed you meant tomorrow');
    } else if (lead < -PAST_BUMP_WINDOW_MS) {
      await send(
        chatId,
        `That time reads as the past to me (${formatInZone(whenUtc, zone, now())}). Try rephrasing?`,
        { replyToId: requestMessageId },
      );
      return;
    }

    const key = randomUUID().slice(0, 8);
    // One live proposal per chat: a new one supersedes the old (its buttons
    // stay visible but their key is dead — taps get the "no longer active"
    // answer). Prevents a corrected proposal from double-scheduling.
    const displayNotes = [...notes];
    const superseded = chatProposal.get(chatId);
    if (superseded !== undefined && pendingProposals.get(superseded)) {
      pendingProposals.delete(superseded);
      displayNotes.push('replaces the previous proposal');
    }
    chatProposal.set(chatId, key);
    pendingProposals.set(key, {
      chatId,
      requesterId,
      requestMessageId,
      what: trimmedWhat,
      whenUtc,
      notes,
    });
    const at = now();
    const noteSuffix = displayNotes.length > 0 ? `\n(${displayNotes.join('; ')})` : '';
    await send(
      chatId,
      `Set this reminder?\n📌 ${trimmedWhat}\n🕐 ${formatInZone(whenUtc, zone, at)} (${formatRelative(whenUtc, at)})${noteSuffix}\nApprove with a button or just reply "yes" / "no".`,
      {
        replyToId: requestMessageId,
        actions: [
          { id: `approve:${key}`, label: 'Approve', style: 'primary' },
          { id: `deny:${key}`, label: 'Deny', style: 'danger' },
        ],
      },
    );
  }

  /** Shared by button taps and typed yes/no: settle one pending proposal. */
  async function decideProposal(
    key: string,
    pending: PendingProposal,
    verb: 'approve' | 'deny',
    replyToId: number,
  ): Promise<void> {
    pendingProposals.delete(key);
    if (chatProposal.get(pending.chatId) === key) chatProposal.delete(pending.chatId);
    if (verb === 'deny') {
      await send(pending.chatId, 'Okay, dropped. Rephrase it if you still want it.', { replyToId });
      return;
    }
    if (pending.whenUtc.getTime() - now().getTime() < -APPROVE_GRACE_MS) {
      await send(
        pending.chatId,
        `⏳ ${formatInZone(pending.whenUtc, zone, now())} has already passed — send it again with a new time.`,
        { replyToId },
      );
      return;
    }
    await scheduleAndConfirm(
      pending.chatId,
      pending.requesterId,
      pending.what,
      pending.whenUtc,
      [...pending.notes],
      { confirmReplyToId: replyToId, requestMessageId: pending.requestMessageId },
    );
  }

  async function handleMessage(payload: MessageWebhookPayload): Promise<void> {
    const { message, chat } = payload;
    if (processed.has(message.id)) {
      log(`[handler] duplicate delivery of message ${message.id}, skipping`);
      return;
    }
    processed.add(message.id);

    // Remember every sighting (even ones we won't answer) — reply threads may
    // reference them later.
    seenMessages.set(message.id, {
      content: message.content,
      isBot: Boolean(message.sender.isBot),
      replyToId: message.replyTo?.id ?? null,
    });

    // Never converse with other bots — the cheapest possible loop breaker.
    if (message.sender.isBot) return;

    let content = message.content.trim();

    if (chat.type === 'group') {
      const mentionedById = ownId !== null && message.mentions.includes(ownId);
      const namePattern = new RegExp(`@${escapeRegExp(config.botName)}\\b`, 'i');
      if (!mentionedById && !namePattern.test(content)) return; // not addressed to us
      content = content.replace(new RegExp(`@${escapeRegExp(config.botName)}\\b`, 'gi'), ' ').trim();
    }

    if (!content) {
      // Attachment-only or all-mention message — no point burning an LLM call.
      await send(chat.id, HELP_TEXT, { replyToId: message.id });
      return;
    }

    // Deterministic fast-path: "in 20 min X" / "po 5 min X" — exact, instant,
    // and immune to the LLM's shaky clock arithmetic. No approval ceremony:
    // nothing was inferred, and the confirmation carries Cancel anyway.
    const rel = parseRelativeFastPath(content);
    if (rel) {
      const cappedWhat =
        rel.what.length > MAX_WHAT_CHARS ? `${rel.what.slice(0, MAX_WHAT_CHARS)}…` : rel.what;
      await scheduleAndConfirm(
        chat.id,
        message.sender.id,
        cappedWhat,
        new Date(now().getTime() + rel.offsetMs),
        [],
        { confirmReplyToId: message.id, requestMessageId: message.id },
      );
      return;
    }

    // Deterministic fast-path: "cancel N" against the last listing (no LLM).
    const cancelN = /^cancel\s*#?(\d{1,2})$/i.exec(content);
    if (cancelN) {
      const ids = lastListing.get(chat.id);
      const index = Number(cancelN[1]);
      const id = ids?.[index - 1];
      if (id !== undefined) {
        await cancelById(chat.id, id, `#${index}`, message.id);
      } else {
        await sendListing(chat.id, message.id); // no/stale listing — show one to pick from
      }
      return;
    }

    // Typed Approve/Deny for the chat's pending proposal (no LLM): a couple
    // will type "ok"/"taip" far more often than they tap buttons.
    const decision = parseDecision(content);
    if (decision) {
      const key = chatProposal.get(chat.id);
      const pending = key !== undefined ? pendingProposals.get(key) : undefined;
      if (key !== undefined && pending) {
        await decideProposal(key, pending, decision, message.id);
      } else {
        await send(chat.id, 'Nothing is awaiting approval right now.', { replyToId: message.id });
      }
      return;
    }

    const thread = buildThread(message);
    let parsed;
    try {
      parsed = await withTyping(chat.id, () => llm.parse(content, now(), thread));
    } catch (err) {
      if (err instanceof LlmError) {
        log(`[handler] LLM failed: ${err.message}`);
        await send(chat.id, "⚠️ I couldn't reach my brain (Ollama). Try again in a minute.", {
          replyToId: message.id,
        });
        return;
      }
      throw err;
    }
    log(
      `[handler] parsed ${JSON.stringify(content)} (thread: ${thread.length}) -> ${JSON.stringify(parsed)}`,
    );

    switch (parsed.intent) {
      case 'create':
        await proposeReminder(chat.id, message.sender.id, message.id, parsed.what, parsed.whenLocal);
        return;
      case 'list':
      case 'cancel':
        await sendListing(chat.id, message.id);
        return;
      case 'help':
        await send(chat.id, HELP_TEXT, { replyToId: message.id });
        return;
      case 'other':
        await send(chat.id, `Not sure what you mean — I only do reminders.\n${HELP_TEXT}`, {
          replyToId: message.id,
        });
        return;
    }
  }

  async function handleAction(payload: ActionWebhookPayload): Promise<void> {
    const { action, chatId } = payload;
    const replyToId = payload.message.id; // anchor responses to the tapped message

    // The platform sends at most ONE genuine action webhook per message (the
    // first tap claims all its buttons; later taps 409 without a webhook), so
    // a second callback for the same message id is always a delivery retry —
    // processing it would answer twice ("✅ scheduled" + "I lost track…").
    // Bot-message ids never enter this set via the message path (the server
    // never webhooks a bot about its own messages), so no collision.
    if (processedActions.has(payload.message.id)) {
      log(`[handler] duplicate delivery of action on message ${payload.message.id}, skipping`);
      return;
    }
    processedActions.add(payload.message.id);

    const cancelMatch = /^cancel:(\d+)$/.exec(action.id);
    if (cancelMatch) {
      await cancelById(chatId, Number(cancelMatch[1]), 'that reminder', replyToId);
      return;
    }

    const proposalMatch = /^(approve|deny):([a-f0-9-]+)$/.exec(action.id);
    if (proposalMatch) {
      const [, verb, key] = proposalMatch;
      const pending = pendingProposals.get(key!);
      if (!pending) {
        await send(
          chatId,
          "That proposal isn't active anymore — replaced by a newer one, already decided, or I restarted. Send the reminder again if you still need it.",
          { replyToId },
        );
        return;
      }
      await decideProposal(key!, pending, verb as 'approve' | 'deny', replyToId);
      return;
    }

    log(`[handler] unknown action id ${action.id}, ignoring`);
  }

  return {
    async handle(payload) {
      try {
        if (isAction(payload)) {
          await handleAction(payload);
        } else {
          await handleMessage(payload);
        }
      } catch (err) {
        // Last-resort net: log, try to tell the user, never crash the server.
        log(`[handler] unhandled error: ${String(err)}`);
        const chatId =
          'chatId' in payload ? payload.chatId : 'chat' in payload ? payload.chat.id : null;
        if (chatId !== null) {
          await messenger
            .sendMessage(chatId, '⚠️ Something went wrong on my side. Try again?')
            .catch(() => undefined);
        }
      }
    },
  };
}
