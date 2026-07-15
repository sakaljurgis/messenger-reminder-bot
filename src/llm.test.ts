import { describe, expect, it } from 'vitest';
import type { Config } from './config.js';
import { buildPrompt, coerceParsed, createLlm, LlmError, readStreamedContent } from './llm.js';

const config: Config = {
  botToken: 'tok',
  messengerUrl: 'http://messenger',
  ollamaUrl: 'http://ollama',
  ollamaModel: 'test-model',
  ollamaTimeoutMs: 5000,
  ollamaThink: null,
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

/** NDJSON stream chunk for a piece of assistant content. */
function line(content: string, done = false): string {
  return `${JSON.stringify({ message: { role: 'assistant', content }, done })}\n`;
}

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

describe('readStreamedContent', () => {
  it('assembles content across chunks, including lines split mid-chunk', async () => {
    const l1 = line('{"intent":');
    const content = await readStreamedContent(
      chunks(l1.slice(0, 10), l1.slice(10), line('"create"}', true)),
    );
    expect(content).toBe('{"intent":"create"}');
  });

  it('handles a final line without a trailing newline', async () => {
    const content = await readStreamedContent(chunks(line('a'), line('b', true).trimEnd()));
    expect(content).toBe('ab');
  });

  it('throws LlmError on an in-stream error field', async () => {
    await expect(
      readStreamedContent(chunks(`${JSON.stringify({ error: 'model exploded' })}\n`)),
    ).rejects.toThrow('model exploded');
  });

  it('throws LlmError on a non-JSON line (proxy HTML)', async () => {
    await expect(readStreamedContent(chunks('<html>504</html>\n'))).rejects.toThrow(LlmError);
  });
});

describe('createLlm', () => {
  it('sends format schema + streaming request and parses the result', async () => {
    let captured: { url: string; body: Record<string, unknown> } | null = null;
    const fetchFn = (async (url: unknown, init?: RequestInit) => {
      captured = { url: String(url), body: JSON.parse(String(init?.body)) };
      return streamedResponse(
        line('{"intent":"create","what":"call mom",'),
        line('"when_local":"2026-07-16T09:00"}', true),
      );
    }) as typeof fetch;

    const llm = createLlm(config, fetchFn);
    const parsed = await llm.parse('remind me tomorrow at 9 to call mom', NOW);

    expect(parsed).toEqual({ intent: 'create', what: 'call mom', whenLocal: '2026-07-16T09:00' });
    expect(captured!.url).toBe('http://ollama/api/chat');
    expect(captured!.body.stream).toBe(true);
    expect(captured!.body.model).toBe('test-model');
    expect(captured!.body.format).toMatchObject({ type: 'object' });
    expect(captured!.body.think).toBeUndefined(); // never sent — see module docs
  });

  it('passes think through only when configured (qwen3-style models)', async () => {
    let body: Record<string, unknown> = {};
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return streamedResponse(line('{"intent":"list","what":"","when_local":""}', true));
    }) as typeof fetch;

    await createLlm({ ...config, ollamaThink: false }, fetchFn).parse('x', NOW);
    expect(body.think).toBe(false);
  });

  it('retries once after a failed attempt', async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      if (calls === 1) return new Response('<html>504</html>', { status: 504 });
      return streamedResponse(line('{"intent":"list","what":"","when_local":""}', true));
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

  it('gives up with LlmError after two failures', async () => {
    const fetchFn = (async () => new Response('nope', { status: 502 })) as typeof fetch;
    const llm = createLlm(config, fetchFn);
    await expect(llm.parse('x', NOW)).rejects.toThrow('Ollama HTTP 502');
  });

  it('throws LlmError when the model emits non-JSON content', async () => {
    const fetchFn = (async () => streamedResponse(line('not json at all', true))) as typeof fetch;
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
      return streamedResponse(line('{"intent":"other","what":"","when_local":""}', true));
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
      return streamedResponse(line('{"intent":"help","what":"","when_local":""}', true));
    }) as typeof fetch;

    const llm = createLlm(config, fetchFn);
    await expect(llm.parse('first', NOW)).rejects.toThrow(LlmError);
    await expect(llm.parse('second', NOW)).resolves.toMatchObject({ intent: 'help' });
  });
});
