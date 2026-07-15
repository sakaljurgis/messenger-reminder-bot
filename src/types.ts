/**
 * Minimal wire types for the messenger bot API. Intentionally duplicated from
 * `@messenger/shared` (structural subset only): this repo must build
 * standalone when cloned on its own, and the surface the bot touches is tiny
 * and stable — see examples/README.md in the messenger repo for the contract.
 */

export interface UserRef {
  id: number;
  displayName: string;
  isBot?: boolean;
}

/** The one embedded reply hop the server includes on a message (ReplyToDTO subset). */
export interface ReplyToRef {
  id: number;
  senderId: number;
  content: string;
  isDeleted: boolean;
}

export interface MessageRef {
  id: number;
  content: string;
  sender: UserRef;
  mentions: number[];
  replyTo?: ReplyToRef | null;
}

/** One earlier message of a reply thread, oldest first, as shown to the LLM. */
export interface ThreadEntry {
  from: 'user' | 'bot';
  text: string;
}

/** POSTed to the webhook for every new message in a chat the bot is in (no `type` field). */
export interface MessageWebhookPayload {
  message: MessageRef;
  chat: { id: number; type: 'dm' | 'group'; name: string | null };
}

/** POSTed to the webhook when a member taps an action button on a bot message. */
export interface ActionWebhookPayload {
  type: 'action';
  action: { id: string };
  message: MessageRef;
  user: UserRef;
  chatId: number;
}

export type WebhookPayload = MessageWebhookPayload | ActionWebhookPayload;

export interface ScheduledMessage {
  id: number;
  chatId: number;
  content: string;
  mentions: number[];
  replyToId: number | null;
  scheduledAt: string; // UTC ISO
  createdAt: string; // UTC ISO
}

export interface MessageAction {
  id: string; // ≤64 chars
  label: string; // ≤40 chars
  style?: 'primary' | 'danger';
}

/** What the LLM extraction is asked to produce (flat on purpose — small model). */
export interface ParsedCommand {
  intent: 'create' | 'list' | 'cancel' | 'help' | 'other';
  what: string;
  whenLocal: string; // "YYYY-MM-DDTHH:MM" in USER_TIMEZONE, or ""
}
