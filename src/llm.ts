import type { Config } from './config.js';
import { dayLookup, promptNow, wallClockInZone, wallClockIso } from './time.js';
import type { ParsedCommand, ThreadEntry } from './types.js';

/**
 * Structured extraction over the OpenAI Chat Completions dialect (Ollama's
 * /v1, OpenAI, OpenRouter, … — pick with LLM_BASE_URL/LLM_API_KEY/LLM_MODEL).
 * Originally Ollama-native; migrated so both bots share one provider-portable
 * dialect. Facts validated against the live server that shape everything here:
 *
 * - A schema constraint alone yields valid-but-garbage JSON; the prompt must
 *   ALSO state the extraction task. Both are sent, always: the schema rides
 *   as `response_format.json_schema` (Ollama maps it onto its native
 *   `format` grammar — verified live).
 * - The endpoint sits behind a reverse proxy that 504s after ~60 s of idle
 *   read — which a CPU-bound generation regularly trips on a buffered
 *   (`stream: false`) response. So we ALWAYS stream: tokens flow from the
 *   first second, the proxy's read timeout never fires, and our own
 *   AbortSignal caps total time instead.
 * - `reasoning_effort` is sent only when configured: Ollama VALIDATES it
 *   against the model ("does not support thinking" → HTTP 400 on qwen2.5),
 *   so unconditionally sending one would break non-thinking models.
 * - temperature 0 + greedy thinking can loop; 0.2 keeps it near-deterministic
 *   without the pathology.
 *
 * Calls are serialized through an in-process queue: two concurrent CPU-bound
 * generations are strictly worse than two sequential ones. The proxy has also
 * been observed answering HTML error pages — non-JSON bodies are an expected
 * failure → one retry.
 */

export class LlmError extends Error {
  constructor(
    message: string,
    /** HTTP status when the provider answered one (drives retry policy). */
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export interface Llm {
  /**
   * Extract a reminder command; throws {@link LlmError} when the provider is
   * unusable. `thread` is the reply chain leading to this message (oldest
   * first) — lets an answer like "tomorrow at 9" complete an earlier ask.
   * `timeZone` is the SENDER's zone (per-message, from the browser); when
   * omitted, the configured fallback zone is used.
   */
  parse(
    message: string,
    now: Date,
    thread?: ThreadEntry[],
    timeZone?: string,
  ): Promise<ParsedCommand>;
}

// additionalProperties/strict are for OpenAI's strict json_schema mode;
// Ollama ignores them and applies the same grammar either way.
const FORMAT_SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: ['create', 'list', 'cancel', 'help', 'other'] },
    what: { type: 'string' },
    when_local: { type: 'string' },
  },
  required: ['intent', 'what', 'when_local'],
  additionalProperties: false,
} as const;

/**
 * Prompt design, tuned against live models (see PLAN.md amendments 11-12):
 * a small model can't do calendar arithmetic, so dates come from a lookup
 * table, and the few-shot examples are computed from the LIVE `now` — a
 * frozen example date would teach the model to answer in the past.
 */
export function buildPrompt(
  message: string,
  now: Date,
  timeZone: string,
  thread: ThreadEntry[] = [],
): string {
  const in20 = wallClockIso(wallClockInZone(new Date(now.getTime() + 20 * 60_000), timeZone));
  const tomorrow = wallClockInZone(new Date(now.getTime() + 86_400_000), timeZone);
  const tomorrow9 = wallClockIso({ ...tomorrow, hour: 9, minute: 0 });
  const threadBlock =
    thread.length === 0
      ? []
      : [
          'Earlier messages in this thread (oldest first) — the Message below answers/continues them; take missing details (the thing to remind, or the time) from here:',
          ...thread.map((t) => `${t.from}: ${JSON.stringify(t.text)}`),
        ];
  return [
    'Extract the reminder command from a chat message sent to a reminder bot.',
    `Now: ${promptNow(now, timeZone)} in ${timeZone} (24h clock).`,
    `Days: ${dayLookup(now, timeZone)}.`,
    'intent: create=set a reminder, list=show reminders, cancel=cancel one, help=usage question, other=anything else.',
    'what: what to remind about, short, original language, no "remind me" wrapper. Empty unless create.',
    'when_local: "YYYY-MM-DDTHH:MM" when it fires. Empty unless create. Pick the date from Days. A day named without a clock time -> 09:00. "in N minutes/hours" -> Now plus exactly N. Bare day of month ("on the 1st") -> the next such day. Must be after Now. If the message names NO day and NO time, leave when_local EMPTY — never invent one.',
    'The message may be in any language (often Lithuanian).',
    'Examples for this exact Now:',
    `"in 20 min tea" -> {"intent":"create","what":"tea","when_local":"${in20}"}`,
    `"primink rytoj 9 val paskambinti mamai" -> {"intent":"create","what":"paskambinti mamai","when_local":"${tomorrow9}"}`,
    `"remind me to feed the cat" -> {"intent":"create","what":"feed the cat","when_local":""}`,
    `"kas suplanuota?" -> {"intent":"list","what":"","when_local":""}`,
    ...threadBlock,
    '',
    `Message: ${JSON.stringify(message)}`,
  ].join('\n');
}

/** Defensive coercion of whatever the model produced into a ParsedCommand. */
export function coerceParsed(raw: unknown): ParsedCommand {
  const o = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const intent = FORMAT_SCHEMA.properties.intent.enum.find((i) => i === o.intent) ?? 'other';
  return {
    intent,
    what: typeof o.what === 'string' ? o.what.trim() : '',
    whenLocal: typeof o.when_local === 'string' ? o.when_local.trim() : '',
  };
}

/** One SSE `data:` frame of a streamed chat completion. */
interface StreamFrame {
  choices?: { delta?: { content?: string | null } }[];
  error?: { message?: string } | string;
}

/**
 * Assemble the assistant text from an SSE body: `data: {json}` lines up to
 * `data: [DONE]`. Comment/event lines are skipped per the SSE spec; a
 * non-JSON data line means the proxy interleaved garbage → error (retryable).
 */
export async function readSseContent(body: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let done = false;

  const consume = (rawLine: string): void => {
    if (done) return;
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line || line.startsWith(':')) return; // keep-alive / comment
    if (!line.startsWith('data:')) {
      // Other SSE fields (event:/id:/retry:) are legal and irrelevant, but
      // anything else in the stream is a middlebox injecting garbage (the
      // proxy has served HTML error pages before) — surface it as the
      // retryable failure it is instead of "successfully" returning nothing.
      if (/^(event|id|retry):/.test(line)) return;
      throw new LlmError('LLM stream contained a non-SSE line');
    }
    const payload = line.slice('data:'.length).trim();
    if (payload === '[DONE]') {
      done = true;
      return;
    }
    let frame: StreamFrame;
    try {
      frame = JSON.parse(payload) as StreamFrame;
    } catch {
      throw new LlmError('LLM stream contained a non-JSON data line');
    }
    if (frame.error) {
      const message = typeof frame.error === 'string' ? frame.error : frame.error.message;
      throw new LlmError(`LLM: ${message ?? 'unknown stream error'}`);
    }
    content += frame.choices?.[0]?.delta?.content ?? '';
  };

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      consume(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
  }
  buffer += decoder.decode();
  consume(buffer);
  return content;
}

/** Drop a leading `<think>…</think>` block (thinking models can leak it into content). */
function stripThinking(text: string): string {
  return text.replace(/^\s*<think>[\s\S]*?<\/think>\s*/, '');
}

export function createLlm(config: Config, fetchFn: typeof fetch = fetch): Llm {
  // Serialization queue: each parse chains onto the previous one; failures
  // don't break the chain.
  let queue: Promise<unknown> = Promise.resolve();

  async function callOnce(
    message: string,
    now: Date,
    thread: ThreadEntry[],
    timeZone: string,
  ): Promise<ParsedCommand> {
    const res = await fetchFn(`${config.llmBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.llmApiKey ? { Authorization: `Bearer ${config.llmApiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.llmModel,
        messages: [{ role: 'user', content: buildPrompt(message, now, timeZone, thread) }],
        stream: true,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'reminder_command', strict: true, schema: FORMAT_SCHEMA },
        },
        // OpenAI's reasoning models 400 on any temperature but the default,
        // so a configured reasoning effort switches the near-deterministic
        // 0.2 off (the schema grammar still constrains the output shape).
        ...(config.llmReasoningEffort
          ? { reasoning_effort: config.llmReasoningEffort }
          : { temperature: 0.2 }),
      }),
      signal: AbortSignal.timeout(config.llmTimeoutMs),
    });
    if (!res.ok) {
      // Surface the provider's error line when it sent JSON (auth, quota,
      // unknown model, unsupported reasoning_effort, …).
      const text = await res.text().catch(() => '');
      let detail = '';
      try {
        const parsed = JSON.parse(text) as StreamFrame;
        const message = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message;
        if (message) detail = `: ${message}`;
      } catch {
        // HTML proxy page or empty body — the status is all we know.
      }
      throw new LlmError(`LLM HTTP ${res.status}${detail}`, res.status);
    }
    if (!res.body) throw new LlmError('LLM response had no body');

    const content = stripThinking(
      await readSseContent(res.body as unknown as AsyncIterable<Uint8Array>),
    );
    try {
      return coerceParsed(JSON.parse(content));
    } catch {
      throw new LlmError('Model output was not the requested JSON');
    }
  }

  /** AbortSignal.timeout rejections (headers or mid-stream). */
  function isTimeout(err: unknown): boolean {
    return err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError');
  }

  async function parseWithRetry(
    message: string,
    now: Date,
    thread: ThreadEntry[],
    timeZone: string,
  ): Promise<ParsedCommand> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return await callOnce(message, now, thread, timeZone);
      } catch (err) {
        // A timeout means the box is hung or queue-starved — retrying would
        // wait ANOTHER full timeout and deepen the server-side queue (killed
        // clients don't stop generations). Fail fast; retry only bad bodies.
        if (isTimeout(err)) {
          throw new LlmError(`LLM timed out after ${config.llmTimeoutMs} ms`);
        }
        // Definitive provider verdicts (bad key, unknown model, unsupported
        // parameter) need the operator, not a second identical call. Retry
        // only transport-level trouble: 5xx, 408/429, garbage bodies.
        if (err instanceof LlmError && err.status !== undefined) {
          const s = err.status;
          if (s >= 400 && s < 500 && s !== 408 && s !== 429) throw err;
        }
        lastError = err;
      }
    }
    throw lastError instanceof LlmError
      ? lastError
      : new LlmError(`LLM unreachable: ${String(lastError)}`);
  }

  return {
    parse(message, now, thread = [], timeZone = config.userTimezone) {
      const task = queue.then(() => parseWithRetry(message, now, thread, timeZone));
      queue = task.catch(() => undefined); // keep the chain alive past failures
      return task;
    },
  };
}
