import http from 'node:http';
import type { Config } from './config.js';
import type { Handler } from './handler.js';
import type { WebhookPayload } from './types.js';

/**
 * The webhook listener. Deliberately dumb:
 *
 * - `GET /healthz` answers before any auth — it's a liveness probe.
 * - Every POST must carry `X-Bot-Token: <BOT_TOKEN>` — proof the caller is
 *   the messenger server (only it and this bot know the token).
 * - Ack `200` IMMEDIATELY, then process. The messenger gives a webhook 5 s
 *   before calling it failed and redelivering; an LLM parse takes 15–90 s.
 *   Holding the connection would guarantee every message arrives twice.
 */

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export function createWebhookServer(
  config: Config,
  handler: Handler,
  log: (line: string) => void = console.log,
): http.Server {
  return http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(404).end();
      return;
    }
    if (req.headers['x-bot-token'] !== config.botToken) {
      res.writeHead(403).end();
      return;
    }

    res.writeHead(200).end(); // ack now — see module docstring

    readJson(req)
      .then((payload) => handler.handle(payload as WebhookPayload))
      .catch((err) => log(`[server] failed to handle webhook: ${String(err)}`));
  });
}
