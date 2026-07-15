# messenger-reminder-bot

A natural-language reminder bot for the messenger PWA (this repo is its
`reminder-bot/` submodule). You DM the bot (or @mention it in a group):

> remind me tomorrow at 9 to call mom
> in 20 min check the oven
> primink rytoj 9 val. išnešti šiukšles
> what's scheduled?

An Ollama-hosted LLM parses the message; the **messenger server's built-in
scheduled-messages API** stores and delivers the reminder. The bot keeps no
state — restart/redeploy loses nothing. `PLAN.md` has the full design and the
adversarial-review amendments.

## How it answers

Every bot response is a **reply** to the message that triggered it, and the
fired reminder itself replies to the message that requested it.

| You | Bot |
| --- | --- |
| natural-language reminder | proposal: `Set this reminder? 📌 call mom 🕐 Thu, Jul 16 09:00 (in 21 h)` + **Approve** / **Deny** buttons; Approve → `✅ …` + **Cancel** button |
| "yes" / "ok" / "taip" / 👍 (or "no" / "ne" / 👎) | approves/denies the chat's pending proposal — typing works as well as the buttons |
| a corrected request while a proposal is pending | the new proposal **replaces** the old one (its buttons go dead) — never two reminders from one intent |
| "in 20 min X" / "po 5 min X" | no ceremony — parsed by regex (exact), scheduled instantly, `✅ …` + **Cancel** |
| reply to a bot question/proposal | the reply thread is passed to the LLM, so "remind me to feed the cat" → *"When?"* → reply "tomorrow at 8" completes the reminder |
| "what's scheduled?" / "cancel …" | numbered list + cancel buttons (soonest 6); `cancel N` works as a text reply too |
| a time that already passed today | assumes tomorrow and says so in the proposal |
| "in 30 seconds" | bumps to the server's ~1 min minimum and says so |
| anything else / "help" | usage text |

While the LLM parses (~5–20 s) the bot shows a **typing indicator** (via
`POST /api/bot/typing`, added to the messenger server for this — re-armed
every 3 s; the instant regex paths don't bother). Proposals live in bot
memory, at most one per chat: a restart or a newer proposal invalidates old
ones (their buttons answer "isn't active anymore"), and approving a proposal
whose time has since passed is refused rather than silently rescheduled. One
tap consumes all buttons on a message (platform behavior), so Approve *or*
Deny — not both.

"in N min/hours" (and Lithuanian "po N min / valandų") is parsed by the bot
itself — instant and exact, no LLM involved. Everything else goes through the
model and takes **~5–20 s** on the CPU-hosted default (qwen2.5:3b — chosen by
live A/B; see PLAN.md amendment 12 for why lfm2.5-thinking lost). There's no
"thinking…" ack; a resent message is deduplicated, so impatience is harmless.

Limits: one-off reminders only (no "every day"), text only, max 20 pending
per chat (the server's cap for the bot as a sender), and the listing shows
only reminders created through the bot — not ones you scheduled yourself with
the app's own send-later.

## Setup

1. Create the bot in the app (**Settings → Bots**) with the `webhookUrl`
   where this process will listen (see *Deployment* for what URL to use).
   **Copy the `apiToken` — it is shown exactly once.**
2. Configure and run:

```bash
cp .env.example .env   # fill in BOT_TOKEN at minimum
npm install
npm run dev            # tsx watch; `npm start` for no watch
```

Node ≥ 24. Zero runtime dependencies.

### Environment

| Var | Default | |
| --- | --- | --- |
| `BOT_TOKEN` | — **required** | apiToken from bot creation; also authenticates inbound webhooks |
| `MESSENGER_URL` | `http://localhost:3001` | prod: `https://msg.sklk.lt` |
| `OLLAMA_URL` | `http://ollama.server.sklk.lt` | |
| `OLLAMA_MODEL` | `qwen2.5:3b` | must be pulled on the Ollama host; `gemma4:e2b` + `OLLAMA_THINK=false` is the tested accuracy-leaning alternative (~22 s/parse vs ~7 s — PLAN.md am. 12) |
| `OLLAMA_TIMEOUT_MS` | `90000` | per-attempt abort (one retry) |
| `OLLAMA_THINK` | unset | `false` disables thinking on models with a switch (qwen3 family); leave unset otherwise |
| `USER_TIMEZONE` | `Europe/Vilnius` | IANA zone all times are parsed & shown in |
| `PORT` | `4002` | webhook listener |
| `BOT_USER_ID` | — | the bot's user id — **set it if you use group chats.** Without it the bot only hears groups via literal `@<BOT_NAME>` text until its first send; if the bot's display name differs from `BOT_NAME`, it stays deaf in groups forever. DMs are unaffected |
| `BOT_NAME` | `Reminder` | `@name` fallback match in groups |

## Deployment

```bash
docker build -t reminder-bot .
docker run -d --name reminder-bot --env-file .env -p 4002:4002 reminder-bot
```

**The `webhookUrl` must be reachable FROM INSIDE the messenger container.**
`http://localhost:4002` there means the messenger container itself — the bot
would silently never receive anything. Use one of:

- same docker network: `docker network connect <net> reminder-bot`, then
  `webhookUrl = http://reminder-bot:4002`;
- host networking / published port: `webhookUrl = http://<host-lan-ip>:4002`.

Outbound, the bot needs `MESSENGER_URL` (HTTPS to msg.sklk.lt is fine) and
`OLLAMA_URL`. `GET /healthz` is a tokenless liveness probe; the Dockerfile
HEALTHCHECK probes it on the default port.

## Development

```bash
npm test          # vitest unit suite (offline: fakes for messenger + ollama)
npm run typecheck
npm run e2e       # REAL everything: throwaway messenger server + real Ollama
                  # + this bot, driven over HTTP; takes several minutes
```

The e2e script assumes it runs inside the messenger repo checkout (submodule
layout; override with `MESSENGER_REPO=/path`) and needs the real Ollama
reachable.
