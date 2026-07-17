import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import type { Config } from './config.js';
import { createWebhookServer } from './server.js';
import type { WebhookPayload } from './types.js';

const config: Config = {
  botToken: 'secret-token',
  messengerUrl: 'http://messenger',
  llmBaseUrl: 'http://llm/v1',
  llmApiKey: null,
  llmModel: 'm',
  llmTimeoutMs: 1000,
  llmReasoningEffort: null,
  userTimezone: 'Europe/Vilnius',
  port: 0,
  botUserId: null,
  botName: 'Reminder',
};

let server: http.Server | null = null;

function start(handler: (p: WebhookPayload) => Promise<void>): Promise<string> {
  return new Promise((resolve) => {
    server = createWebhookServer(config, { handle: handler }, () => undefined);
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`);
    });
  });
}

afterEach(() => {
  server?.close();
  server = null;
});

describe('webhook server', () => {
  it('answers /healthz without any token', async () => {
    const base = await start(async () => undefined);
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('rejects POSTs without the right X-Bot-Token', async () => {
    let called = 0;
    const base = await start(async () => void called++);
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'X-Bot-Token': 'wrong' },
      body: '{}',
    });
    expect(res.status).toBe(403);
    await new Promise((r) => setTimeout(r, 20));
    expect(called).toBe(0);
  });

  it('acks 200 before handling and passes the payload through', async () => {
    let received: WebhookPayload | null = null;
    let resolveHandled: () => void;
    const handled = new Promise<void>((r) => (resolveHandled = r));
    const base = await start(async (p) => {
      received = p;
      resolveHandled();
    });

    const payload = {
      message: { id: 1, content: 'hi', sender: { id: 2, displayName: 'O' }, mentions: [] },
      chat: { id: 3, type: 'dm', name: null },
    };
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'X-Bot-Token': config.botToken, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(200);
    await handled;
    expect(received).toEqual(payload);
  });

  it('404s anything that is not POST or /healthz', async () => {
    const base = await start(async () => undefined);
    expect((await fetch(`${base}/whatever`)).status).toBe(404);
  });

  it('rejects an unparseable body with 400 so the messenger redelivers', async () => {
    let called = 0;
    const base = await start(async () => void called++);
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'X-Bot-Token': config.botToken },
      body: 'not json {{{',
    });
    expect(res.status).toBe(400);
    await new Promise((r) => setTimeout(r, 20));
    expect(called).toBe(0);
  });
});
