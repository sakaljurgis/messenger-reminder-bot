import { describe, expect, it } from 'vitest';
import type { Config } from './config.js';
import { buildPrompt, coerceParsed, createLlm, LlmError, readSseContent } from './llm.js';

const config: Config = {
  botToken: 'tok',
  messengerUrl: 'http://messenger',
  llmBaseUrl: 'http://llm/v1',
  llmApiKey: null,
  llmModel: 'test-model',
  llmTimeoutMs: 5000,
  llmReasoningEffort: null,
  userTimezone: 'Europe/Vilnius',
  port: 0,
  botUserId: null,
  botName: 'Reminder',
};

const NOW = new Date('2026-07-15T08:45:00.000Z'); // Wednesday 11:45 Vilnius

function encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

async function* chunks(...parts: string[]): AsyncGenerator<Uint8Array> {
  for (const p of parts) yield encode(p);
}

/** SSE frame for a piece of assistant content. */
function frame(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}
const DONE = 'data: [DONE]\n\n';

function streamedResponse(...parts: string[]): Response {
  return new Response(ReadableStream.from(chunks(...parts)));
}

describe('buildPrompt', () => {
  it('anchors the model to the local now with weekday and zone', () => {
    const p = buildPrompt('remind me tomorrow', NOW, 'Europe/Vilnius');
    expect(p).toContain('Now: Wednesday 2026-07-15 11:45 in Europe/Vilnius');
    expect(p).toContain('Message: "remind me tomorrow"');
  });

  it('gives the model a date lookup instead of expecting arithmetic', () => {
    const p = buildPrompt('x', NOW, 'Europe/Vilnius');
    expect(p).toContain('Wednesday (today)=2026-07-15');
    expect(p).toContain('Thursday (tomorrow/rytoj)=2026-07-16');
    expect(p).toContain('Tuesday=2026-07-21'); // 7th entry
  });

  it('computes the few-shot examples from the live now', () => {
    const p = buildPrompt('x', NOW, 'Europe/Vilnius');
    expect(p).toContain('"when_local":"2026-07-15T12:05"'); // 11:45 + 20 min
    expect(p).toContain('"when_local":"2026-07-16T09:00"'); // tomorrow at 9
  });

  it('renders the reply thread only when present', () => {
    const bare = buildPrompt('x', NOW, 'Europe/Vilnius');
    expect(bare).not.toContain('Earlier messages in this thread');

    const threaded = buildPrompt('tomorrow at 9', NOW, 'Europe/Vilnius', [
      { from: 'user', text: 'remind me to call mom' },
      { from: 'bot', text: 'When should I remind you?' },
    ]);
    expect(threaded).toContain('Earlier messages in this thread');
    expect(threaded).toContain('user: "remind me to call mom"');
    expect(threaded).toContain('bot: "When should I remind you?"');
    // The thread sits above the actual message so the model reads it as context.
    expect(threaded.indexOf('Earlier messages')).toBeLessThan(
      threaded.indexOf('Message: "tomorrow at 9"'),
    );
  });
});

describe('coerceParsed', () => {
  it('passes a clean command through', () => {
    expect(
      coerceParsed({ intent: 'create', what: ' call mom ', when_local: '2026-07-16T09:00' }),
    ).toEqual({ intent: 'create', what: 'call mom', whenLocal: '2026-07-16T09:00' });
  });

  it.each([
    [null],
    ['string'],
    [{ intent: 'createReminder', what: 42, when_local: null }],
    [{}],
  ])('degrades garbage %j to a safe other-command', (raw) => {
    const parsed = coerceParsed(raw);
    expect(parsed.intent).toBe('other');
    expect(parsed.what).toBe('');
    expect(parsed.whenLocal).toBe('');
  });
});

describe('readSseContent', () => {
  it('assembles content across chunks, including frames split mid-chunk', async () => {
    const f1 = frame('{"intent":');
    const content = await readSseContent(
      chunks(f1.slice(0, 12), f1.slice(12), frame('"create"}'), DONE),
    );
    expect(content).toBe('{"intent":"create"}');
  });

  it('stops at [DONE] and tolerates a missing trailing newline', async () => {
    const content = await readSseContent(
      chunks(frame('a'), frame('b'), 'data: [DONE]'.trimEnd(), ''),
    );
    expect(content).toBe('ab');
  });

  it('skips comments and event fields, and handles CRLF', async () => {
    const content = await readSseContent(
      chunks(': ping\r\n', 'event: message\r\n', frame('ok').replace(/\n/g, '\r\n'), DONE),
    );
    expect(content).toBe('ok');
  });

  it('throws LlmError on an in-stream error frame', async () => {
    await expect(
      readSseContent(chunks('data: {"error":{"message":"model exploded"}}\n')),
    ).rejects.toThrow('model exploded');
  });

  it('throws LlmError on a non-JSON data line (proxy HTML)', async () => {
    await expect(readSseContent(chunks('data: <html>504</html>\n'))).rejects.toThrow(LlmError);
  });

  it('throws LlmError on a non-SSE line instead of skipping it (injected HTML)', async () => {
    await expect(
      readSseContent(chunks('<html><body>Gateway error</body></html>\n')),
    ).rejects.toThrow(/non-SSE line/);
  });
});

describe('createLlm', () => {
  it('sends a schema-constrained streaming request and parses the result', async () => {
    let captured: { url: string; headers: Record<string, string>; body: Record<string, unknown> } | null =
      null;
    const fetchFn = (async (url: unknown, init?: RequestInit) => {
      captured = {
        url: String(url),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init?.body)),
      };
      return streamedResponse(
        frame('{"intent":"create","what":"call mom",'),
        frame('"when_local":"2026-07-16T09:00"}'),
        DONE,
      );
    }) as typeof fetch;

    const llm = createLlm(config, fetchFn);
    const parsed = await llm.parse('remind me tomorrow at 9 to call mom', NOW);

    expect(parsed).toEqual({ intent: 'create', what: 'call mom', whenLocal: '2026-07-16T09:00' });
    expect(captured!.url).toBe('http://llm/v1/chat/completions');
    expect(captured!.body.stream).toBe(true);
    expect(captured!.body.model).toBe('test-model');
    expect(captured!.body.temperature).toBe(0.2);
    expect(captured!.body.response_format).toMatchObject({
      type: 'json_schema',
      json_schema: { schema: { type: 'object' } },
    });
    expect(captured!.body.reasoning_effort).toBeUndefined(); // only when configured
    expect(captured!.headers.Authorization).toBeUndefined(); // only with an API key
  });

  it('reasoning mode: sends reasoning_effort + the API key, drops temperature', async () => {
    let headers: Record<string, string> = {};
    let body: Record<string, unknown> = {};
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      headers = (init?.headers ?? {}) as Record<string, string>;
      body = JSON.parse(String(init?.body));
      return streamedResponse(frame('{"intent":"list","what":"","when_local":""}'), DONE);
    }) as typeof fetch;

    await createLlm(
      { ...config, llmReasoningEffort: 'none', llmApiKey: 'sk-1' },
      fetchFn,
    ).parse('x', NOW);
    expect(body.reasoning_effort).toBe('none');
    // OpenAI reasoning models 400 on a non-default temperature.
    expect(body.temperature).toBeUndefined();
    expect(headers.Authorization).toBe('Bearer sk-1');
  });

  it('strips a leaked <think> block before parsing', async () => {
    const fetchFn = (async () =>
      streamedResponse(
        frame('<think>hmm</think>'),
        frame('{"intent":"help","what":"","when_local":""}'),
        DONE,
      )) as typeof fetch;
    await expect(createLlm(config, fetchFn).parse('x', NOW)).resolves.toMatchObject({
      intent: 'help',
    });
  });

  it('retries once after a failed attempt', async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      if (calls === 1) return new Response('<html>504</html>', { status: 504 });
      return streamedResponse(frame('{"intent":"list","what":"","when_local":""}'), DONE);
    }) as typeof fetch;

    const llm = createLlm(config, fetchFn);
    await expect(llm.parse('list', NOW)).resolves.toMatchObject({ intent: 'list' });
    expect(calls).toBe(2);
  });

  it('does NOT retry a timeout (fail fast, do not deepen the queue)', async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      throw new DOMException('signal timed out', 'TimeoutError');
    }) as typeof fetch;

    const llm = createLlm(config, fetchFn);
    await expect(llm.parse('x', NOW)).rejects.toThrow('timed out');
    expect(calls).toBe(1);
  });

  it('surfaces a definitive 4xx immediately — no second identical call', async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return new Response(JSON.stringify({ error: { message: 'invalid api key' } }), {
        status: 401,
      });
    }) as typeof fetch;
    const llm = createLlm(config, fetchFn);
    await expect(llm.parse('x', NOW)).rejects.toThrow('LLM HTTP 401: invalid api key');
    expect(calls).toBe(1);
  });

  it('still retries a 5xx once', async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      if (calls === 1) return new Response('bad gateway', { status: 502 });
      return streamedResponse(frame('{"intent":"help","what":"","when_local":""}'), DONE);
    }) as typeof fetch;
    const llm = createLlm(config, fetchFn);
    await expect(llm.parse('x', NOW)).resolves.toMatchObject({ intent: 'help' });
    expect(calls).toBe(2);
  });

  it('throws LlmError when the model emits non-JSON content', async () => {
    const fetchFn = (async () => streamedResponse(frame('not json at all'), DONE)) as typeof fetch;
    const llm = createLlm(config, fetchFn);
    await expect(llm.parse('x', NOW)).rejects.toThrow('not the requested JSON');
  });

  it('serializes concurrent parses (never two in-flight generations)', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchFn = (async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return streamedResponse(frame('{"intent":"other","what":"","when_local":""}'), DONE);
    }) as typeof fetch;

    const llm = createLlm(config, fetchFn);
    await Promise.all([llm.parse('a', NOW), llm.parse('b', NOW), llm.parse('c', NOW)]);
    expect(maxInFlight).toBe(1);
  });

  it('keeps the queue alive after a failure', async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      if (calls <= 2) return new Response('down', { status: 500 }); // both attempts of parse #1
      return streamedResponse(frame('{"intent":"help","what":"","when_local":""}'), DONE);
    }) as typeof fetch;

    const llm = createLlm(config, fetchFn);
    await expect(llm.parse('first', NOW)).rejects.toThrow(LlmError);
    await expect(llm.parse('second', NOW)).resolves.toMatchObject({ intent: 'help' });
  });
});
