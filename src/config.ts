/** Env-based configuration; fail fast and loud on anything unusable. */

export interface Config {
  botToken: string;
  messengerUrl: string;
  /**
   * Base URL of any OpenAI-compatible Chat Completions provider, WITHOUT the
   * /chat/completions suffix — e.g. `http://host:11434/v1` (Ollama),
   * `https://api.openai.com/v1`, `https://openrouter.ai/api/v1`.
   */
  llmBaseUrl: string;
  /** Sent as `Authorization: Bearer` only when set (Ollama needs none). */
  llmApiKey: string | null;
  llmModel: string;
  llmTimeoutMs: number;
  /**
   * Sent as the `reasoning_effort` request field when set; leave unset for
   * models without a thinking switch. Value sets are provider-specific
   * (passed through verbatim): Ollama accepts none/low/medium/high/max and
   * maps it onto its native `think` — so `none` is the old
   * OLLAMA_THINK=false for qwen3-family/gemma models; OpenAI accepts
   * minimal/low/medium/high.
   */
  llmReasoningEffort: string | null;
  userTimezone: string;
  port: number;
  botUserId: number | null;
  botName: string;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  warn: (line: string) => void = console.warn,
): Config {
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

  // LLM_* is the real config; OLLAMA_* are legacy aliases so a pre-migration
  // .env keeps working (OLLAMA_URL pointed at the native API root, so the
  // OpenAI-compat /v1 suffix is appended for it).
  const rawTimeout = env.LLM_TIMEOUT_MS ?? env.OLLAMA_TIMEOUT_MS;
  const llmTimeoutMs = Number(rawTimeout ?? 90_000);
  if (!Number.isFinite(llmTimeoutMs) || llmTimeoutMs <= 0) {
    throw new Error(`Invalid LLM_TIMEOUT_MS: ${rawTimeout}`);
  }

  // OLLAMA_THINK=false has an exact equivalent (reasoning_effort "none", which
  // Ollama maps onto native think) — alias it like the other OLLAMA_* vars so
  // a gemma4/qwen3 deployment doesn't silently start thinking again after the
  // upgrade. =true had no effect worth keeping (thinking models think by
  // default), so it's warned about and dropped.
  let legacyThinkEffort: string | null = null;
  const rawThink = env.OLLAMA_THINK?.trim().toLowerCase();
  if (rawThink === 'false') {
    legacyThinkEffort = 'none';
  } else if (rawThink !== undefined) {
    warn(
      `[config] OLLAMA_THINK=${env.OLLAMA_THINK} is retired and has no effect — use ` +
        'LLM_REASONING_EFFORT (Ollama maps it onto native think; "none" is the old false).',
    );
  }

  const legacyOllamaUrl = env.OLLAMA_URL?.trim();
  const llmBaseUrl = env.LLM_BASE_URL?.trim()
    ? stripTrailingSlash(env.LLM_BASE_URL.trim())
    : legacyOllamaUrl
      ? `${stripTrailingSlash(legacyOllamaUrl)}/v1`
      : 'http://localhost:11434/v1';

  const botUserId = env.BOT_USER_ID ? Number(env.BOT_USER_ID) : null;
  if (botUserId !== null && (!Number.isInteger(botUserId) || botUserId <= 0)) {
    throw new Error(`Invalid BOT_USER_ID: ${env.BOT_USER_ID}`);
  }

  return {
    botToken,
    messengerUrl: stripTrailingSlash(env.MESSENGER_URL?.trim() || 'http://localhost:3001'),
    llmBaseUrl,
    llmApiKey: env.LLM_API_KEY?.trim() || null,
    // qwen2.5:3b won the live A/B for this task hands-down: ~5-9 s per parse
    // vs 95-230 s for lfm2.5-thinking, correct intents, clean Lithuanian
    // extraction (see PLAN.md amendment 12). Override with LLM_MODEL.
    llmModel: env.LLM_MODEL?.trim() || env.OLLAMA_MODEL?.trim() || 'qwen2.5:3b',
    llmTimeoutMs,
    llmReasoningEffort: env.LLM_REASONING_EFFORT?.trim() || legacyThinkEffort,
    userTimezone,
    port,
    botUserId,
    botName: env.BOT_NAME?.trim() || 'Reminder',
  };
}
