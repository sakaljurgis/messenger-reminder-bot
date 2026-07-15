# Reminder Bot — Plan

A natural-language reminder bot for the messenger PWA. Users tell it things
like *"remind me tomorrow at 9 to call mom"*, *"in 20 min check the oven"*,
*"what do I have scheduled?"* — an Ollama-hosted LLM parses the request, and
the messenger server's **built-in scheduled-messages API** does the actual
time-keeping and delivery.

Lives in this standalone repo (`messenger-reminder-bot`), mounted as a git
submodule at `reminder-bot/` in the messenger repo.

## Core design decisions

### 1. The messenger server is the scheduler — the bot is stateless

The messenger already persists scheduled messages (SQLite), dispatches them
through the same `createMessage` path as live sends, and exposes a full
Bearer-token CRUD for them (`POST/GET/DELETE /api/bot/scheduled`). The bot
therefore keeps **zero state**: no DB, no timers, no queue. Restart/redeploy
loses nothing — every pending reminder is a row on the messenger side, and
"list"/"cancel" read/mutate it over the API.

Consequences (accepted trade-offs):

- **One-shot reminders only.** Recurring ("every day at 9") would need
  bot-side state + a timer, and the server never webhooks a bot about its own
  messages, so the bot can't piggyback on the fire event to reschedule.
  Explicitly out of scope for v1; the LLM classifies such requests and the bot
  replies that it can't do recurring yet.
- Server-enforced bounds apply: `scheduledAt` ≥ 1 min and ≤ 1 year out,
  ≤ 20 pending **per sender per chat** (the bot's own budget, independent of
  the humans' send-later messages — which also means "list" shows only
  reminders created through the bot), text-only content.

### 2. LLM parsing via Ollama structured outputs — with belt and braces

Validated against the real server (`lfm2.5-thinking:latest` on the owner's
Ollama host):

- `format: <json-schema>` alone produces *syntactically* valid but
  *semantically garbage* JSON (the model never "sees" the schema — it's a
  grammar constraint). The prompt must **also** spell out the extraction task
  and fields. Both together produced clean output.
- `think: false` does NOT disable thinking — it leaks `<think>…</think>` into
  `content`. Never send it; let thinking land in the separate `thinking` field
  and read only `content` (which is format-constrained anyway).
- Prompt eval is slow (~50 tok/s) — keep the prompt **short** (< ~400 tokens).
  Generation with a format schema is fast (~40 tokens out).
- `options.temperature: 0` for determinism.

The parse result is validated bot-side (dates parseable, intent in enum,
etc.) — the LLM proposes, deterministic code disposes. On Ollama
failure/timeout, reply honestly ("can't reach my brain, try again").

One LLM call per message. Parse schema (flat, small — small models do badly
with nesting):

```json
{
  "intent": "create | list | cancel | help | other",
  "what":   "reminder text, imperative, without the 'remind me' wrapper",
  "when_local": "YYYY-MM-DDTHH:MM in the user's timezone, or \"\""
}
```

### 3. Timezone: the user is not in UTC

The messenger API speaks UTC ISO timestamps; the user lives in
**Europe/Vilnius** (UTC+3 in summer, UTC+2 in winter — DST matters). Config:
`USER_TIMEZONE` (IANA name, default `Europe/Vilnius`). Two conversions, both
implemented dependency-free with `Intl.DateTimeFormat` in `src/time.ts`:

- **Prompt side:** the model can't know "now". Inject the current date-time
  *in the user's zone*, with weekday (relative phrases like "tomorrow",
  "Friday" need it): `now: Tuesday 2026-07-15 11:42`.
- **Schedule side:** the model outputs local wall-clock `YYYY-MM-DDTHH:MM`;
  convert wall-clock-in-zone → UTC instant via the standard iterative Intl
  offset technique (2 passes, handles DST transitions; nonexistent/ambiguous
  local times resolve to a nearby valid instant — fine for reminders).
- **Display side:** every time shown to the user (confirmations, lists) is
  formatted in `USER_TIMEZONE`, plus a relative "(in 2 h 5 min)" so mistakes
  are instantly visible.

The bot never relies on the process `TZ` — the zone is explicit everywhere,
so the container can stay UTC.

### 4. Where the bot listens

- **DMs:** every message is for the bot — handle it.
- **Groups:** only messages that mention the bot (otherwise every group
  message would burn a 30 s LLM call and the bot would be insufferable).
  Mention = `message.mentions` contains the bot's own id — self-learned from
  the `sender.id` of any send response (seeded by optional `BOT_USER_ID` env);
  until the first-ever send, content matching `@<BOT_NAME>` (env, default
  `Reminder`) is the fallback.
- Action-tap payloads (`type: "action"`) are handled without the LLM.

The reminder is always scheduled **into the chat where it was requested** —
in a group, everyone sees it fire (that's the natural "remind us" semantics).
`mentions: [requesterId]` is set on the scheduled message so the requester
gets a mention-grade notification.

### 5. UX flows

| User does | Bot does |
| --- | --- |
| "remind me tomorrow 9am to call mom" | LLM parse → `POST /api/bot/scheduled` → confirm: "✅ Wed, Jul 16 · 09:00 (in 21 h): call mom" + **Cancel** button (`cancel:<id>`) |
| "what's scheduled?" / "list reminders" | `GET /api/bot/scheduled?chatId=` → text list in local time + cancel buttons for the soonest 6 |
| "cancel the dentist reminder" | same list flow (v1 doesn't LLM-match which one — buttons are unambiguous and the pending set is ≤20) |
| taps **Cancel** | `DELETE /api/bot/scheduled/:id` → "🗑️ Canceled" (404 → "already sent or canceled") |
| "hi" / anything else | short help text (static, no second LLM call) |
| parse gives a past time | assume the user meant the next day: bump +24 h **once** and say so in the confirmation; still past → ask to rephrase |
| parse gives lead < 1 min ("in 30 s") | clamp to ~65 s (server minimum) and say so |
| messenger 400/cap errors | surface the server's message ("Too many scheduled messages…") |

No "thinking…" ack message in v1 — the LLM round-trip is ~15–45 s and an ack
would double every interaction to two messages. Documented in README;
revisit if it feels dead in practice.

### 6. Zero runtime dependencies

Like `examples/echo-bot.mjs`: `node:http` + global `fetch` + `Intl`. Dev-only
deps: `typescript`, `tsx` (runtime), `vitest`, `@types/node`. Node ≥ 24
(matches the messenger repo). The handful of wire types the bot needs
(message/webhook payload shapes) are **intentionally duplicated** as minimal
structural types in `src/types.ts` — this repo must build standalone when
cloned on its own, and the contract surface used is tiny and stable.

## Module layout

```
reminder-bot/
  package.json          type: module; scripts: dev / start (tsx), test (vitest run), typecheck
  tsconfig.json
  .env.example
  README.md             setup, env vars, deploy notes
  Dockerfile            node:24-alpine, tsx runtime, non-root
  src/
    config.ts           env parsing + defaults, fail-fast on missing BOT_TOKEN
    types.ts            minimal wire types (webhook payloads, DTO subsets, parse result)
    time.ts             wallClockToUtc(zone), formatInZone, formatRelative, nowInZone
    llm.ts              Ollama /api/chat call: prompt build, format schema, response validation
    messenger.ts        API client: sendMessage, schedule, listScheduled, cancelScheduled
    handler.ts          the brain: webhook payload → replies/actions (DI: clients + now())
    index.ts            node:http server: token check, /healthz, ack-then-handle; boot
  src/*.test.ts         colocated vitest tests
```

`handler.ts` receives `{ messenger, llm, now }` injected, so tests drive it
with fakes and never touch the network — same DI convention as the messenger
server.

## Configuration (env)

| Var | Default | Notes |
| --- | --- | --- |
| `BOT_TOKEN` | — (required) | apiToken from bot creation; also validates inbound `X-Bot-Token` |
| `MESSENGER_URL` | `http://localhost:3001` | prod: `https://msg.example.com` |
| `OLLAMA_URL` | `http://localhost:11434` | e.g. `http://ollama.server:port` |
| `OLLAMA_MODEL` | `lfm2.5-thinking:latest` | |
| `OLLAMA_TIMEOUT_MS` | `90000` | abort + user-facing error beyond this |
| `USER_TIMEZONE` | `Europe/Vilnius` | IANA zone for parsing & display |
| `PORT` | `4002` | webhook listener (echo-bot claims 4001) |
| `BOT_USER_ID` | — (optional) | enables mention detection by id in groups |
| `BOT_NAME` | `Reminder` | `@name` fallback mention match in groups |

## Testing

- **Unit (vitest, mocked fetch):** `time.ts` conversions incl. DST edges
  (Vilnius summer/winter, spring-forward gap); prompt contains local now +
  zone; LLM response validation (garbage JSON, missing fields, bad dates);
  handler flows: create/confirm content, past-time bump, <1 min clamp, list
  formatting + button cap 6, cancel tap → DELETE, 404 tap, group
  mention-gating, DM always-on, webhook token rejection, Ollama-down reply.
- **E2E (scripted curl, real everything):** local messenger server
  (`:memory:`-adjacent throwaway SQLite), real Ollama (`OLLAMA_URL`):
  register human → create bot (webhookUrl → local bot) → DM → "remind me in
  2 minutes to test e2e" → assert confirmation + scheduled row → wait →
  assert the reminder message fires. Then list + cancel-button round-trip.
- Test/process hygiene per messenger repo rules: no `pkill -f`, track PIDs,
  no vitest watch mode.

## Deployment (prod)

Bot container needs: outbound access to the messenger (`MESSENGER_URL`) and
to Ollama (`OLLAMA_URL`); inbound HTTP from the messenger container (set the
bot's `webhookUrl` to wherever this container is reachable from it —
same Docker network or host port). `docker build` + `docker run --env-file`.
Owner deploys manually like the messenger itself.

## Amendments from adversarial review (all folded into the design above conceptually; listed here so the deltas are explicit)

1. **Webhook dedup (BLOCKER).** The server retries delivery once on network
   error *or* non-2xx — from the bot's side that's at-least-once. Scheduling
   is not idempotent, so a redelivered message would create a duplicate
   reminder. Fix: bounded in-memory LRU set of processed `message.id`s; skip
   repeats. Action taps are NOT deduped — cancel is idempotent (DELETE →
   404 → "already canceled"), and a real second tap deserves a reply.
2. **Prod reachability (BLOCKER).** The messenger runs in a container: a
   `webhookUrl` of `http://localhost:4002` resolves to the messenger
   container itself and the bot silently never hears anything. README must
   prescribe a container-reachable URL (shared docker network service name,
   or host LAN IP) and the bot logs its listen address + expectations at boot.
3. **Fresh-lead clamp.** The LLM call takes 15–90 s, so a lead computed from
   the prompt-injected "now" is stale by POST time. Recompute
   `lead = whenUtc − Date.now()` immediately before scheduling; if < 75 s,
   schedule at `now + 90 s` and say so ("in 1 minute" survives the server's
   60 s floor).
4. **Past-time bump is local-date arithmetic.** "+24 h on the instant"
   shifts wall time across DST boundaries. Bump the local *date* field and
   re-convert. Only bump when the parse is ≤24 h past; older → ask to
   rephrase. Confirmation always shows resolved weekday+date+relative, which
   is the real safety net.
5. **Serialize LLM calls.** One in-process queue in front of Ollama — two
   concurrent 30 s calls on a 0.7 GB model just make two timeouts. Webhooks
   still ack instantly.
6. **Validation escapes closed.** `create` with empty `what` → ask what;
   empty/unparseable `when_local` → ask when (echoing the understood `what`);
   attachment-only (empty content) → help text instead of a wasted LLM call;
   `what` truncated to 1000 chars; real JSON Schema with `enum` on intent +
   `required` (the schema sketch in §2 is illustrative).
7. **Cancel past 6 pending.** Full numbered text list (≤20), cancel buttons
   for the soonest 6, and a deterministic (no-LLM) `cancel N` text follow-up
   using a per-chat in-memory map of the last listing. Restart loses the map;
   re-listing rebuilds it.
8. **Self-learned bot id.** Every send response's `message.sender.id` IS the
   bot's id — cache it on first send and use id-based mention matching in
   groups. `BOT_USER_ID` env becomes a bootstrap override; `@name` text match
   remains only as the pre-first-send fallback.
9. **Parsing hygiene.** Tolerate 1-digit month/day/hour from the model in
   `when_local`; never `new Date(string)` on model output; outgoing
   `scheduledAt` is always `.toISOString()`. Ollama sits behind a reverse
   proxy that can answer HTML error pages (observed live) — the client must
   survive non-JSON bodies and retry once.
10. **No "thinking…" ack** stays, but only because dedup (1) makes an
    impatient resend harmless; without dedup, no-ack would be unshippable.
11. **Stream, always (found during implementation).** The model host is
    CPU-only (`size_vram: 0`), so a thinking generation takes 30–120 s — and
    the reverse proxy in front of Ollama 504s a buffered `stream: false`
    response at ~60 s of idle read (observed repeatedly). `stream: true`
    sends tokens from the first second, the idle timeout never fires, and the
    bot's own `OLLAMA_TIMEOUT_MS` abort governs instead. Also validated live:
    `think: false` makes this 1.2B model fast (~7 s) but *wrong* (broken
    intents, bad date arithmetic, few-shot contamination) — thinking stays on
    and the `thinking` stream field is discarded; `temperature: 0` can make
    greedy thinking loop forever — 0.2 is used. And a caution learned the
    hard way: a killed/timed-out client does NOT stop the server-side
    generation; aggressive timeout+retry against a busy box only deepens its
    queue (one retry, nothing more).
12. **Model choice: qwen2.5:3b by default (found during implementation).**
    Live A/B on the 8-case accuracy gate, same prompt, same box:
    - `lfm2.5-thinking:latest` (1.2B, thinking): 95–230 s per parse even
      streaming, and *garbage* — copied the prompt's "Now" verbatim into
      `when_local`, leaked instruction text into fields, classified
      "cancel X" as create. Unusable for this task despite being fine at
      freeform chat.
    - `qwen2.5:3b` (non-thinking): 5–9 s per parse, correct intents, clean
      Lithuanian extraction; only weakness was calendar arithmetic
      ("tomorrow" off by a day, "on the 1st" → the past).
    The arithmetic weakness is fixed in the prompt, not the model: a 7-day
    **date lookup table** and few-shot examples **computed from the live
    now** (a frozen example date would teach it to answer in the past).
    `OLLAMA_MODEL` env still switches models freely.
    Also tested (2026-07-15): `qwen3.5:2b` — thinks by default (minutes per
    parse on this CPU box, unusable); with `OLLAMA_THINK=false` (a config
    knob added for exactly this) it answers in 7–23 s but LOST to qwen2.5:3b
    anyway: few-shot contamination on the top English create case (copied
    the Lithuanian example's text into `what`), "on Friday" resolved to
    Saturday (silently wrong day), Lithuanian "kas suplanuota?" → help
    instead of list, and it's 2–3× slower despite being smaller. Its one win:
    exact "in 2 hours" arithmetic — which the regex fast path already covers.
    Re-test if the box ever gets a GPU (thinking mode would then be viable).
    Also tested (2026-07-15): `gemma4:e2b` (5.1B MoE, ~2B active, 6.8 GB in
    RAM) — **the accuracy champion at 7/8** but not the default. It also
    thinks by default (and unlike the "Say OK" probe suggested — structured
    asks trigger it), pushing parses to 60–108 s; `OLLAMA_THINK=false` is
    honored cleanly and brings it to a consistent 21–23 s (≈16 s of that is
    prompt eval at ~23 tok/s — generation is only ~8 tok/s, and the format
    grammar over Gemma's 256k vocab is CPU-expensive). With thinking off it
    got everything right except "on the 1st" (→ July 1, past — the one case
    every model failed), including "friday evening" → Friday **21:00**.
    Kept as the documented accuracy-leaning alternative
    (`OLLAMA_MODEL=gemma4:e2b` + `OLLAMA_THINK=false`): after the regex fast
    path neutralizes qwen's "in N hours" weakness, gemma's practical edge is
    small (mainly classifying "can you do recurring?" as other instead of
    scheduling a bogus reminder) and doesn't buy back 3–4× latency or the
    extra ~5 GB RAM (matters when both models stay loaded — Ollama's default
    keep_alive is 5 min).

## Post-v1 additions (2026-07-15, owner request)

1. **Approval step for LLM-parsed creates.** The parse no longer schedules
   directly — it becomes a proposal (`Set this reminder? 📌 what 🕐 when`)
   with **Approve/Deny** buttons, and only the approve tap schedules. The
   point is visibility: a small model's misparse now needs an explicit OK
   before it can put anything on the calendar. Pending proposals live in a
   bounded in-memory map under random keys (`approve:<uuid8>` fits the
   64-char action-id limit; random so a restart can't resurrect a stale key
   into a different proposal) — a restart forgets them and taps answer
   "I lost track, re-send". Approving after the proposed time has passed
   (>2 min grace) is refused rather than silently clamped forward. The
   regex fast path ("in 20 min X") deliberately keeps NO approval: nothing
   was inferred, and its confirmation already carries Cancel. One tap
   consumes all of a message's buttons (platform `actionTaken` semantics),
   which fits: Approve or Deny, never both.
2. **Everything is a reply.** Every bot response sets `replyToId` to the
   message that triggered it (for taps: the message carrying the button),
   and the scheduled reminder itself replies to the request message — the
   fired "⏰" quotes what asked for it (the server degrades gracefully if
   that message is deleted meanwhile).
3. **Reply-thread context to the LLM.** When a user replies to a bot
   message, the reply chain (≤5 hops, ≤300 chars each, oldest first) is
   prepended to the prompt, so "remind me to feed the cat" → bot asks
   "When?" → user replies "tomorrow at 8" completes the create. The chain is
   rebuilt from a bounded in-memory cache of every seen message (incoming +
   own sends, with their replyTo links); on a cold cache the webhook DTO's
   single embedded reply hop still provides one level. The ask-what/ask-when
   replies now say "(You can reply to this message.)" to teach the flow.
4. **Typed Approve/Deny.** "yes"/"ok"/"taip"/👍 (or "no"/"ne"/"nereikia"/👎)
   as a whole message settles the chat's pending proposal without the LLM —
   a couple types "ok" far more often than they tap. Full-message match
   only, so "ne rytoj…" can never accidentally deny.
5. **One proposal per chat (supersede).** A new LLM-parsed create replaces
   the chat's previous un-decided proposal (its buttons answer "isn't active
   anymore") — replying with a correction can no longer end in two
   reminders. This also gives typed yes/no an unambiguous target.
6a. **Per-message sender timezone (owner request).** The messenger client now
   stamps every send with the device's IANA zone
   (`Intl.DateTimeFormat().resolvedOptions().timeZone` →
   `SendMessageRequest.timezone`); the server sanitizes it (invalid → null,
   mirroring mention filtering), stores it on the message row
   (`sender_timezone`, migration 0013), and echoes it as
   `MessageDTO.senderTimezone` — which therefore rides into webhook payloads
   and history for free. The bot resolves each interaction's zone as
   `message.senderTimezone` (validated) → else `USER_TIMEZONE`, and threads
   it through the LLM prompt (now-line + day table), wall-clock→UTC
   conversion, the copied-now guard, proposals (a proposal remembers its
   zone so a later approve confirms consistently), listings and
   confirmations. `USER_TIMEZONE` is thereby demoted from "the" zone to the
   fallback for zone-less messages (bots, scheduled dispatches, older
   clients). Per-user zones now come for free — each sender's own device
   rules their reminders.
7. **Typing indicator during LLM parses.** New messenger endpoint
   `POST /api/bot/typing` (bot-api route → `typing` bus event → socket
   relay, identical payload to a human's socket typing) — the bot pings it
   every 3 s while a parse runs, so the ~5–20 s wait looks alive instead of
   dead. Client expiry (4 s) makes it self-cleaning; the endpoint is
   best-effort on the bot side (a failure never breaks the parse). This was
   the one feature that required touching the messenger server; the route,
   bus event, and socket relay follow the existing fan-out pattern and are
   covered by server + socket integration tests.

## Out of scope (v1)

- Recurring reminders (needs bot-side state; see §1)
- Editing a reminder in place (cancel + re-create; the API has no PATCH either)
- Multi-turn conversation memory (each message parsed independently)
- Per-user timezones (single `USER_TIMEZONE` — it's a two-person app)
- Snooze buttons on the fired reminder (the fired message is a plain
  scheduled send; the bot doesn't hear it fire, so it can't attach buttons — 
  would need bot-side scheduling. Revisit with recurring.)
