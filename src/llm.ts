import type { Config } from './config.js';
import { dayLookup, promptNow, wallClockInZone, wallClockIso } from './time.js';
import type { ParsedCommand, ThreadEntry } from './types.js';

/**
 * Ollama structured extraction. Facts validated against the live server that
 * shape everything here:
 *
 * - `format: <schema>` alone yields valid-but-garbage JSON; the prompt must
 *   ALSO state the extraction task. Both are sent, always.
 * - `think: false` makes this 1.2B model fast but useless (wrong intents,
 *   broken date arithmetic, few-shot contamination). Thinking stays ON; the
 *   `thinking` stream field is simply discarded.
 * - The endpoint sits behind a reverse proxy that 504s after ~60 s of idle
 *   read — which a 30-120 s CPU-bound thinking generation regularly trips on
 *   a buffered (`stream: false`) response. So we ALWAYS stream: tokens flow
 *   from the first second, the proxy's read timeout never fires, and our own
 *   AbortSignal caps total time instead.
 * - temperature 0 + greedy thinking can loop; 0.2 keeps it near-deterministic
 *   without the pathology.
 *
 * Calls are serialized through an in-process queue: two concurrent CPU-bound
 * generations are strictly worse than two sequential ones. The proxy has also
 * been observed answering HTML error pages — non-JSON bodies are an expected
 * failure → one retry.
 */

export class LlmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmError';
  }
}

export interface Llm {
  /**
   * Extract a reminder command; throws {@link LlmError} when Ollama is
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

const FORMAT_SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: ['create', 'list', 'cancel', 'help', 'other'] },
    what: { type: 'string' },
    when_local: { type: 'string' },
  },
  required: ['intent', 'what', 'when_local'],
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

/** One NDJSON chunk of a streamed /api/chat response. */
interface StreamLine {
  message?: { content?: string };
  done?: boolean;
  error?: string;
}

/** Assemble the assistant `content` from a streamed NDJSON body. */
export async function readStreamedContent(body: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';

  const consume = (line: string): void => {
    if (!line.trim()) return;
    let obj: StreamLine;
    try {
      obj = JSON.parse(line) as StreamLine;
    } catch {
      throw new LlmError('Ollama stream contained a non-JSON line');
    }
    if (obj.error) throw new LlmError(`Ollama: ${obj.error}`);
    content += obj.message?.content ?? '';
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
    const res = await fetchFn(`${config.ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.ollamaModel,
        messages: [{ role: 'user', content: buildPrompt(message, now, timeZone, thread) }],
        format: FORMAT_SCHEMA,
        stream: true,
        ...(config.ollamaThink !== null ? { think: config.ollamaThink } : {}),
        options: { temperature: 0.2 },
      }),
      signal: AbortSignal.timeout(config.ollamaTimeoutMs),
    });
    if (!res.ok) {
      await res.text().catch(() => undefined); // drain (proxy HTML, error JSON, …)
      throw new LlmError(`Ollama HTTP ${res.status}`);
    }
    if (!res.body) throw new LlmError('Ollama response had no body');

    const content = await readStreamedContent(res.body as unknown as AsyncIterable<Uint8Array>);
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
          throw new LlmError(`Ollama timed out after ${config.ollamaTimeoutMs} ms`);
        }
        lastError = err;
      }
    }
    throw lastError instanceof LlmError
      ? lastError
      : new LlmError(`Ollama unreachable: ${String(lastError)}`);
  }

  return {
    parse(message, now, thread = [], timeZone = config.userTimezone) {
      const task = queue.then(() => parseWithRetry(message, now, thread, timeZone));
      queue = task.catch(() => undefined); // keep the chain alive past failures
      return task;
    },
  };
}
