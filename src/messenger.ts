import type { MessageAction, MessageRef, ScheduledMessage } from './types.js';

/**
 * Thin client for the messenger's Bearer-authenticated bot API. Non-2xx
 * responses throw {@link MessengerError} carrying the server's `{ error }`
 * message so the handler can surface real reasons ("Too many scheduled
 * messages…") to the user instead of a generic failure.
 */

export class MessengerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'MessengerError';
  }
}

export interface SendOptions {
  mentions?: number[];
  actions?: MessageAction[];
  replyToId?: number;
}

export interface ScheduleOptions {
  mentions?: number[];
  /** Live message in the same chat the fired reminder should quote. */
  replyToId?: number;
}

export interface Messenger {
  sendMessage(chatId: number, content: string, opts?: SendOptions): Promise<MessageRef>;
  schedule(
    chatId: number,
    content: string,
    scheduledAt: Date,
    opts?: ScheduleOptions,
  ): Promise<ScheduledMessage>;
  listScheduled(chatId: number): Promise<ScheduledMessage[]>;
  /** true = deleted; false = 404 (already sent or already canceled). */
  cancelScheduled(id: number): Promise<boolean>;
  /**
   * Transient "the bot is typing" signal (clients expire it in ~4 s — re-send
   * while slow work runs). Best-effort: NEVER throws; a lost indicator must
   * not break the real work.
   */
  sendTyping(chatId: number): Promise<void>;
}

export function createMessenger(
  baseUrl: string,
  token: string,
  fetchFn: typeof fetch = fetch,
): Messenger {
  async function request(method: string, path: string, body?: unknown): Promise<Response> {
    return fetchFn(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  async function errorOf(res: Response): Promise<MessengerError> {
    let message = `Messenger API ${res.status}`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) message = data.error;
    } catch {
      // Non-JSON error body — keep the status-based message.
    }
    return new MessengerError(res.status, message);
  }

  return {
    async sendMessage(chatId, content, opts = {}) {
      const res = await request('POST', '/api/bot/messages', {
        chatId,
        content,
        ...(opts.mentions?.length ? { mentions: opts.mentions } : {}),
        ...(opts.actions?.length ? { actions: opts.actions } : {}),
        ...(opts.replyToId ? { replyToId: opts.replyToId } : {}),
      });
      if (!res.ok) throw await errorOf(res);
      const data = (await res.json()) as { message: MessageRef };
      return data.message;
    },

    async schedule(chatId, content, scheduledAt, opts = {}) {
      const res = await request('POST', '/api/bot/scheduled', {
        chatId,
        content,
        scheduledAt: scheduledAt.toISOString(),
        ...(opts.mentions?.length ? { mentions: opts.mentions } : {}),
        ...(opts.replyToId ? { replyToId: opts.replyToId } : {}),
      });
      if (!res.ok) throw await errorOf(res);
      const data = (await res.json()) as { scheduled: ScheduledMessage };
      return data.scheduled;
    },

    async listScheduled(chatId) {
      const res = await request('GET', `/api/bot/scheduled?chatId=${chatId}`);
      if (!res.ok) throw await errorOf(res);
      const data = (await res.json()) as { scheduled: ScheduledMessage[] };
      return data.scheduled;
    },

    async cancelScheduled(id) {
      const res = await request('DELETE', `/api/bot/scheduled/${id}`);
      if (res.status === 204) return true;
      if (res.status === 404) return false;
      throw await errorOf(res);
    },

    async sendTyping(chatId) {
      try {
        await request('POST', '/api/bot/typing', { chatId });
      } catch {
        // Decoration only — swallow everything (old server without the
        // endpoint, network blip, …).
      }
    },
  };
}
