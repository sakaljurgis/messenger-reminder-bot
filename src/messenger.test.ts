import { describe, expect, it } from 'vitest';
import { createMessenger, MessengerError } from './messenger.js';

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(status: number, payload: unknown): { fetchFn: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchFn = (async (url: unknown, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body !== undefined ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(payload === undefined ? null : JSON.stringify(payload), { status });
  }) as typeof fetch;
  return { fetchFn, calls };
}

describe('createMessenger', () => {
  it('sends messages with Bearer auth and returns the DTO', async () => {
    const dto = { id: 9, content: 'hi', sender: { id: 42, displayName: 'R' }, mentions: [] };
    const { fetchFn, calls } = fakeFetch(201, { message: dto });
    const m = createMessenger('http://host', 'tok', fetchFn);

    const sent = await m.sendMessage(1, 'hi', { actions: [{ id: 'a', label: 'A' }] });

    expect(sent).toEqual(dto);
    const call = calls[0]!;
    expect(call.url).toBe('http://host/api/bot/messages');
    expect(call.headers.Authorization).toBe('Bearer tok');
    expect(call.body).toEqual({ chatId: 1, content: 'hi', actions: [{ id: 'a', label: 'A' }] });
  });

  it('schedules with an ISO UTC instant, mentions and a reply target', async () => {
    const { fetchFn, calls } = fakeFetch(201, { scheduled: { id: 1 } });
    const m = createMessenger('http://host', 'tok', fetchFn);

    await m.schedule(5, '⏰ x', new Date('2026-07-16T06:00:00.000Z'), {
      mentions: [7],
      replyToId: 88,
    });

    expect(calls[0]!.body).toEqual({
      chatId: 5,
      content: '⏰ x',
      scheduledAt: '2026-07-16T06:00:00.000Z',
      mentions: [7],
      replyToId: 88,
    });
  });

  it('lists scheduled rows via the chatId query', async () => {
    const { fetchFn, calls } = fakeFetch(200, { scheduled: [] });
    const m = createMessenger('http://host', 'tok', fetchFn);

    await expect(m.listScheduled(3)).resolves.toEqual([]);
    expect(calls[0]!.url).toBe('http://host/api/bot/scheduled?chatId=3');
  });

  it('maps cancel 204/404 to true/false', async () => {
    const m204 = createMessenger('http://h', 't', fakeFetch(204, undefined).fetchFn);
    const m404 = createMessenger('http://h', 't', fakeFetch(404, { error: 'nope' }).fetchFn);
    await expect(m204.cancelScheduled(1)).resolves.toBe(true);
    await expect(m404.cancelScheduled(1)).resolves.toBe(false);
  });

  it('sends typing as a fire-and-forget POST', async () => {
    const { fetchFn, calls } = fakeFetch(204, undefined);
    const m = createMessenger('http://host', 'tok', fetchFn);

    await m.sendTyping(9);

    expect(calls[0]!.url).toBe('http://host/api/bot/typing');
    expect(calls[0]!.body).toEqual({ chatId: 9 });
  });

  it('swallows typing failures (old server without the endpoint, network down)', async () => {
    const m404 = createMessenger('http://h', 't', fakeFetch(404, { error: 'nope' }).fetchFn);
    const mBoom = createMessenger('http://h', 't', (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch);

    await expect(m404.sendTyping(1)).resolves.toBeUndefined();
    await expect(mBoom.sendTyping(1)).resolves.toBeUndefined();
  });

  it('throws MessengerError carrying the server error message and status', async () => {
    const { fetchFn } = fakeFetch(400, { error: 'Too many scheduled messages' });
    const m = createMessenger('http://h', 't', fetchFn);
    const err = await m.schedule(1, 'x', new Date()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MessengerError);
    expect((err as MessengerError).status).toBe(400);
    expect((err as MessengerError).message).toBe('Too many scheduled messages');
  });
});
