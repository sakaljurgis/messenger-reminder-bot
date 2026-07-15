import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('fails fast without BOT_TOKEN', () => {
    expect(() => loadConfig({})).toThrow('BOT_TOKEN');
  });

  it('applies defaults', () => {
    const c = loadConfig({ BOT_TOKEN: 't' });
    expect(c).toEqual({
      botToken: 't',
      messengerUrl: 'http://localhost:3001',
      ollamaUrl: 'http://ollama.server.sklk.lt',
      ollamaModel: 'qwen2.5:3b',
      ollamaTimeoutMs: 90_000,
      ollamaThink: null,
      userTimezone: 'Europe/Vilnius',
      port: 4002,
      botUserId: null,
      botName: 'Reminder',
    });
  });

  it('strips trailing slashes off URLs', () => {
    const c = loadConfig({
      BOT_TOKEN: 't',
      MESSENGER_URL: 'https://msg.sklk.lt/',
      OLLAMA_URL: 'http://ollama.server.sklk.lt//',
    });
    expect(c.messengerUrl).toBe('https://msg.sklk.lt');
    expect(c.ollamaUrl).toBe('http://ollama.server.sklk.lt');
  });

  it('rejects an invalid timezone, port, timeout and bot user id', () => {
    expect(() => loadConfig({ BOT_TOKEN: 't', USER_TIMEZONE: 'Mars/Olympus' })).toThrow(
      'USER_TIMEZONE',
    );
    expect(() => loadConfig({ BOT_TOKEN: 't', PORT: 'abc' })).toThrow('PORT');
    expect(() => loadConfig({ BOT_TOKEN: 't', OLLAMA_TIMEOUT_MS: '-5' })).toThrow(
      'OLLAMA_TIMEOUT_MS',
    );
    expect(() => loadConfig({ BOT_TOKEN: 't', BOT_USER_ID: 'x' })).toThrow('BOT_USER_ID');
  });

  it('accepts a numeric BOT_USER_ID', () => {
    expect(loadConfig({ BOT_TOKEN: 't', BOT_USER_ID: '42' }).botUserId).toBe(42);
  });
});
