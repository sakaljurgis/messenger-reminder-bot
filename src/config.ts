/** Env-based configuration; fail fast and loud on anything unusable. */

export interface Config {
  botToken: string;
  messengerUrl: string;
  ollamaUrl: string;
  ollamaModel: string;
  ollamaTimeoutMs: number;
  /**
   * Sent as the `think` request field when set; leave unset for models
   * without a thinking switch (Ollama errors on unsupported `think`).
   * qwen3-family models honor `false` cleanly (validated live); lfm2.5
   * leaks `<think>` into content instead — never set it there.
   */
  ollamaThink: boolean | null;
  userTimezone: string;
  port: number;
  botUserId: number | null;
  botName: string;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const botToken = env.BOT_TOKEN?.trim();
  if (!botToken) {
    throw new Error('Missing BOT_TOKEN env var (the apiToken returned by POST /api/bots).');
  }

  const userTimezone = env.USER_TIMEZONE?.trim() || 'Europe/Vilnius';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: userTimezone });
  } catch {
    throw new Error(`Invalid USER_TIMEZONE: ${userTimezone} (use an IANA name like Europe/Vilnius)`);
  }

  const port = Number(env.PORT ?? 4002);
  if (!Number.isInteger(port) || port <= 0) throw new Error(`Invalid PORT: ${env.PORT}`);

  const ollamaTimeoutMs = Number(env.OLLAMA_TIMEOUT_MS ?? 90_000);
  if (!Number.isFinite(ollamaTimeoutMs) || ollamaTimeoutMs <= 0) {
    throw new Error(`Invalid OLLAMA_TIMEOUT_MS: ${env.OLLAMA_TIMEOUT_MS}`);
  }

  const rawThink = env.OLLAMA_THINK?.trim().toLowerCase() || null;
  if (rawThink !== null && rawThink !== 'true' && rawThink !== 'false') {
    throw new Error(`Invalid OLLAMA_THINK: ${env.OLLAMA_THINK} (use true, false, or unset)`);
  }

  const botUserId = env.BOT_USER_ID ? Number(env.BOT_USER_ID) : null;
  if (botUserId !== null && (!Number.isInteger(botUserId) || botUserId <= 0)) {
    throw new Error(`Invalid BOT_USER_ID: ${env.BOT_USER_ID}`);
  }

  return {
    botToken,
    messengerUrl: stripTrailingSlash(env.MESSENGER_URL?.trim() || 'http://localhost:3001'),
    ollamaUrl: stripTrailingSlash(env.OLLAMA_URL?.trim() || 'http://ollama.server.sklk.lt'),
    // qwen2.5:3b won the live A/B for this task hands-down: ~5-9 s per parse
    // vs 95-230 s for lfm2.5-thinking, correct intents, clean Lithuanian
    // extraction (see PLAN.md amendment 12). Override with OLLAMA_MODEL.
    ollamaModel: env.OLLAMA_MODEL?.trim() || 'qwen2.5:3b',
    ollamaTimeoutMs,
    ollamaThink: rawThink === null ? null : rawThink === 'true',
    userTimezone,
    port,
    botUserId,
    botName: env.BOT_NAME?.trim() || 'Reminder',
  };
}
