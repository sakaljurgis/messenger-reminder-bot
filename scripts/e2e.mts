/**
 * End-to-end test: REAL messenger server (throwaway SQLite), REAL Ollama,
 * REAL bot process — driven over HTTP exactly like the app would.
 *
 * Requires: this repo checked out as the `reminder-bot/` submodule inside the
 * messenger repo (or MESSENGER_REPO pointing at one), and a reachable Ollama
 * (OLLAMA_URL, default http://ollama.server.sklk.lt).
 *
 *   npm run e2e
 *
 * Takes several minutes: every parse is a real 20-90 s CPU-bound LLM call,
 * and the fired reminder waits out the server's 30 s dispatcher tick.
 * Exits 0 on success, 1 with a loud diagnostic on the first failed step.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MESSENGER_REPO = path.resolve(process.env.MESSENGER_REPO ?? path.join(BOT_DIR, '..'));
const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://ollama.server.sklk.lt';
const SERVER_PORT = 3999;
const BOT_PORT = 4102;
const SERVER = `http://127.0.0.1:${SERVER_PORT}`;

const children: ChildProcess[] = [];
const workDir = mkdtempSync(path.join(tmpdir(), 'reminder-bot-e2e-'));
let failed = false;

function log(step: string): void {
  console.log(`\n=== ${step}`);
}

function die(why: string): never {
  failed = true;
  console.error(`\nFAILED: ${why}`);
  process.exit(1);
}

/**
 * Spawn the LOCAL tsx binary directly — an `npx` wrapper would be what our
 * cleanup kills, orphaning the actual tsx grandchild (bitten once: a stale
 * bot kept :4102 and poisoned the next run). detached + group-kill is the
 * second belt: SIGTERM to -pid takes the whole tree.
 */
const capturedLogs = new Map<string, string>();

function launch(name: string, cwd: string, env: Record<string, string>, entry: string): ChildProcess {
  // npm workspaces hoist tsx to the repo root — fall back one level up.
  const tsxBin = [
    path.join(cwd, 'node_modules', '.bin', 'tsx'),
    path.join(cwd, '..', 'node_modules', '.bin', 'tsx'),
  ].find(existsSync);
  if (!tsxBin) die(`no tsx binary found for ${name} under ${cwd}`);
  const child = spawn(tsxBin, [entry], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  capturedLogs.set(name, '');
  child.stdout!.on('data', (d: Buffer) => {
    capturedLogs.set(name, capturedLogs.get(name)! + d.toString());
    process.stdout.write(`[${name}] ${d}`);
  });
  child.stderr!.on('data', (d: Buffer) => process.stderr.write(`[${name}!] ${d}`));
  children.push(child);
  return child;
}

async function waitFor(what: string, url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  die(`${what} did not come up within ${timeoutMs / 1000}s (${url})`);
}

interface Message {
  id: number;
  content: string;
  sender: { id: number; displayName: string; isBot?: boolean };
  actions?: Array<{ id: string; label: string }>;
}

let cookie = '';
async function api<T>(method: string, pathname: string, body?: unknown): Promise<T> {
  const res = await fetch(`${SERVER}${pathname}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0]!;
  if (!res.ok && res.status !== 204) {
    die(`${method} ${pathname} -> ${res.status}: ${await res.text()}`);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

async function messagesIn(chatId: number): Promise<Message[]> {
  const data = await api<{ messages: Message[] }>('GET', `/api/chats/${chatId}/messages`);
  return data.messages;
}

/** Poll the chat until a bot message matching `test` appears (newest wins). */
async function waitForBotMessage(
  chatId: number,
  what: string,
  test: (m: Message) => boolean,
  timeoutMs: number,
): Promise<Message> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = (await messagesIn(chatId)).filter((m) => m.sender.isBot).findLast(test);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return die(`timed out after ${timeoutMs / 1000}s waiting for ${what}`);
}

process.on('exit', () => {
  for (const child of children) {
    if (child.pid === undefined) continue;
    try {
      process.kill(-child.pid, 'SIGTERM'); // whole process group
    } catch {
      child.kill('SIGTERM');
    }
  }
  rmSync(workDir, { recursive: true, force: true });
  if (!failed) console.log('\nE2E PASSED ✔');
});

// Preflight: a stale server/bot from an aborted run poisons everything with
// cross-instance tokens and cookies — refuse to start over occupied ports.
for (const [what, url] of [
  ['messenger port', `${SERVER}/healthz`],
  ['bot port', `http://127.0.0.1:${BOT_PORT}/healthz`],
] as const) {
  const busy = await fetch(url, { signal: AbortSignal.timeout(500) }).then(
    () => true,
    () => false,
  );
  if (busy) die(`${what} already in use — kill the stale process first (ss -tlnp | grep -E '3999|4102')`);
}

// ── 1. messenger server on a throwaway DB ──────────────────────────────────
log(`starting messenger server (repo: ${MESSENGER_REPO}, db in ${workDir})`);
launch('server', path.join(MESSENGER_REPO, 'server'), {
  PORT: String(SERVER_PORT),
  DATABASE_PATH: path.join(workDir, 'e2e.sqlite'),
  UPLOADS_DIR: path.join(workDir, 'uploads'),
}, 'src/index.ts');
await waitFor('messenger server', `${SERVER}/healthz`, 30_000);

// ── 2. human + bot accounts ────────────────────────────────────────────────
log('registering human and creating the bot');
const { user: human } = await api<{ user: { id: number } }>('POST', '/api/auth/register', {
  email: `e2e-${Date.now()}@example.com`,
  password: 'supersecret',
  displayName: 'E2E Human',
});
const { bot, apiToken } = await api<{ bot: { id: number }; apiToken: string }>(
  'POST',
  '/api/bots',
  { name: 'Reminder', webhookUrl: `http://127.0.0.1:${BOT_PORT}` },
);
console.log(`human #${human.id}, bot #${bot.id}`);

// ── 3. the reminder bot itself ─────────────────────────────────────────────
log('starting reminder-bot');
launch('bot', BOT_DIR, {
  BOT_TOKEN: apiToken,
  MESSENGER_URL: SERVER,
  OLLAMA_URL,
  PORT: String(BOT_PORT),
  USER_TIMEZONE: 'Europe/Vilnius',
  OLLAMA_TIMEOUT_MS: '150000',
}, 'src/index.ts');
await waitFor('reminder-bot', `http://127.0.0.1:${BOT_PORT}/healthz`, 20_000);

// ── 4. create the DM and ask for a reminder ────────────────────────────────
log('DM: "remind me in 2 minutes to run the e2e suite"');
const { chat } = await api<{ chat: { id: number } }>('POST', '/api/chats', { userId: bot.id });
await api('POST', `/api/chats/${chat.id}/messages`, {
  content: 'remind me in 2 minutes to run the e2e suite',
});
const confirmation = await waitForBotMessage(
  chat.id,
  'the ✅ confirmation',
  (m) => m.content.includes('✅'),
  300_000,
);
console.log(`confirmation: ${confirmation.content.replace(/\n/g, ' | ')}`);

// ── 5. the scheduled row exists (via the bot's own API) ────────────────────
log('checking the scheduled row via the bot API');
const listRes = await fetch(`${SERVER}/api/bot/scheduled?chatId=${chat.id}`, {
  headers: { Authorization: `Bearer ${apiToken}` },
});
const { scheduled } = (await listRes.json()) as {
  scheduled: Array<{ id: number; content: string; scheduledAt: string }>;
};
if (scheduled.length !== 1) die(`expected 1 scheduled row, got ${JSON.stringify(scheduled)}`);
const lead = (new Date(scheduled[0]!.scheduledAt).getTime() - Date.now()) / 1000;
console.log(`scheduled "${scheduled[0]!.content}" in ${lead.toFixed(0)}s`);
if (lead < 30 || lead > 200) die(`lead ${lead.toFixed(0)}s is far off the requested ~2 min`);

// ── 6. LLM create now goes through a PROPOSAL: approve it ──────────────────
log('DM: "remind me tomorrow at 9 to water the plants" (expect proposal → approve)');
await api('POST', `/api/chats/${chat.id}/messages`, {
  content: 'remind me tomorrow at 9 to water the plants',
});
const proposal = await waitForBotMessage(
  chat.id,
  'the reminder proposal',
  (m) => m.content.includes('Set this reminder?') && m.content.includes('water the plants'),
  300_000,
);
const approve = proposal.actions?.find((a) => a.label === 'Approve');
if (!approve) die(`proposal has no Approve button: ${JSON.stringify(proposal.actions)}`);
log(`tapping Approve (${approve.id})`);
await api('POST', `/api/chats/${chat.id}/messages/${proposal.id}/actions`, {
  actionId: approve.id,
});
const plantsConfirm = await waitForBotMessage(
  chat.id,
  'the ✅ confirmation after approve',
  (m) => m.content.includes('✅') && m.content.includes('water the plants'),
  60_000,
);
if (!(plantsConfirm as { replyTo?: unknown }).replyTo) {
  die('confirmation is not a reply (expected replyTo to be set)');
}

// ── 6b. reply-thread context flows to the LLM, and Deny drops a proposal ────
// "remind me to feed the cat" has no time: depending on the model's mood the
// bot either asks "When…?" or proposes an invented time (which is exactly
// what the approval step exists to catch). Both are legitimate; the REPLY to
// that bot message must reach the LLM with thread context either way.
log('DM: "remind me to feed the cat" (no time — ask-when or proposal both fine)');
await api('POST', `/api/chats/${chat.id}/messages`, { content: 'remind me to feed the cat' });
const timelessResponse = await waitForBotMessage(
  chat.id,
  'the bot response to the time-less request',
  (m) =>
    m.content.includes('feed the cat') &&
    (m.content.includes('When should I remind you') || m.content.includes('Set this reminder?')),
  300_000,
);
log('replying to it: "tomorrow at 8, feed the cat" (thread context)');
await api('POST', `/api/chats/${chat.id}/messages`, {
  content: 'tomorrow at 8, feed the cat',
  replyToId: timelessResponse.id,
});
const threadProposal = await waitForBotMessage(
  chat.id,
  'a proposal from the threaded reply',
  (m) =>
    m.content.includes('Set this reminder?') &&
    m.content.includes('feed the cat') &&
    m.id !== timelessResponse.id,
  300_000,
);
if (!threadProposal.content.includes('08:00')) {
  die(`thread proposal lost the time from the reply: ${threadProposal.content}`);
}
if (!/\(thread: [1-9]/.test(capturedLogs.get('bot') ?? '')) {
  die('bot log never shows a non-empty thread — reply context did not reach the LLM');
}
const deny = threadProposal.actions?.find((a) => a.label === 'Deny');
if (!deny) die('thread proposal has no Deny button');
log(`tapping Deny (${deny.id})`);
await api('POST', `/api/chats/${chat.id}/messages/${threadProposal.id}/actions`, {
  actionId: deny.id,
});
await waitForBotMessage(chat.id, 'the deny ack', (m) => m.content.includes('dropped'), 60_000);

await api('POST', `/api/chats/${chat.id}/messages`, { content: 'what do I have scheduled?' });
const listing = await waitForBotMessage(
  chat.id,
  'the 📋 listing',
  (m) => m.content.includes('📋') && m.content.includes('water the plants'),
  300_000,
);
const cancelButton = listing.actions?.find((a) => a.label.startsWith('Cancel'));
if (!cancelButton) die(`listing carries no cancel buttons: ${JSON.stringify(listing.actions)}`);

log(`tapping "${cancelButton.label}" (${cancelButton.id}) on the listing`);
// Buttons are ordered soonest-first; the e2e reminder (row 1) fires soon, so
// cancel the plants one: find its index from the listing text.
const plantsLine = listing.content.split('\n').find((l) => l.includes('water the plants'))!;
const plantsIndex = Number(/^(\d+)\./.exec(plantsLine.trim())![1]);
const plantsButton = listing.actions!.find((a) => a.label === `Cancel ${plantsIndex}`)!;
await api('POST', `/api/chats/${chat.id}/messages/${listing.id}/actions`, {
  actionId: plantsButton.id,
});
await waitForBotMessage(chat.id, 'the 🗑️ cancel reply', (m) => m.content.includes('Canceled'), 60_000);

// ── 7. the first reminder actually fires ───────────────────────────────────
log('waiting for the ⏰ reminder to fire (dispatcher ticks every 30s)');
const fireBudget = Math.max(0, new Date(scheduled[0]!.scheduledAt).getTime() - Date.now()) + 90_000;
const fired = await waitForBotMessage(
  chat.id,
  'the ⏰ reminder',
  (m) => m.content.includes('⏰') && m.content.includes('e2e suite'),
  fireBudget,
);
console.log(`fired: ${fired.content}`);

// ── 8. nothing left pending ────────────────────────────────────────────────
const finalRes = await fetch(`${SERVER}/api/bot/scheduled?chatId=${chat.id}`, {
  headers: { Authorization: `Bearer ${apiToken}` },
});
const finalRows = ((await finalRes.json()) as { scheduled: unknown[] }).scheduled;
if (finalRows.length !== 0) die(`expected no pending rows at the end, got ${finalRows.length}`);

process.exit(0);
