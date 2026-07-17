import { describe, expect, it, vi } from 'vitest';
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
      llmBaseUrl: 'http://localhost:11434/v1',
      llmApiKey: null,
      llmModel: 'qwen2.5:3b',
      llmTimeoutMs: 90_000,
      llmReasoningEffort: null,
      userTimezone: 'Europe/Vilnius',
      port: 4002,
      botUserId: null,
      botName: 'Reminder',
    });
  });

  it('strips trailing slashes off URLs', () => {
    const c = loadConfig({
      BOT_TOKEN: 't',
      MESSENGER_URL: 'https://msg.example.com/',
      LLM_BASE_URL: 'https://openrouter.ai/api/v1//',
    });
    expect(c.messengerUrl).toBe('https://msg.example.com');
    expect(c.llmBaseUrl).toBe('https://openrouter.ai/api/v1');
  });

  it('accepts an API key and a reasoning effort', () => {
    const c = loadConfig({
      BOT_TOKEN: 't',
      LLM_API_KEY: 'sk-abc',
      LLM_REASONING_EFFORT: 'none',
    });
    expect(c.llmApiKey).toBe('sk-abc');
    expect(c.llmReasoningEffort).toBe('none');
  });

  it('honors legacy OLLAMA_* aliases (URL gets the /v1 suffix)', () => {
    const c = loadConfig({
      BOT_TOKEN: 't',
      OLLAMA_URL: 'http://ollama.example.com//',
      OLLAMA_MODEL: 'gemma4:e2b',
      OLLAMA_TIMEOUT_MS: '30000',
    });
    expect(c.llmBaseUrl).toBe('http://ollama.example.com/v1');
    expect(c.llmModel).toBe('gemma4:e2b');
    expect(c.llmTimeoutMs).toBe(30_000);
  });

  it('prefers LLM_* over the legacy aliases', () => {
    const c = loadConfig({
      BOT_TOKEN: 't',
      LLM_BASE_URL: 'https://api.openai.com/v1',
      OLLAMA_URL: 'http://ollama.example.com',
      LLM_MODEL: 'gpt-4.1-mini',
      OLLAMA_MODEL: 'qwen2.5:3b',
    });
    expect(c.llmBaseUrl).toBe('https://api.openai.com/v1');
    expect(c.llmModel).toBe('gpt-4.1-mini');
  });

  it('maps the retired OLLAMA_THINK=false onto reasoning_effort "none" (no warning)', () => {
    const warn = vi.fn();
    const c = loadConfig({ BOT_TOKEN: 't', OLLAMA_THINK: 'false' }, warn);
    expect(c.llmReasoningEffort).toBe('none');
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns about (and ignores) OLLAMA_THINK values other than false', () => {
    const warn = vi.fn();
    const c = loadConfig({ BOT_TOKEN: 't', OLLAMA_THINK: 'true' }, warn);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('OLLAMA_THINK'));
    expect(c.llmReasoningEffort).toBeNull();
  });

  it('lets an explicit LLM_REASONING_EFFORT win over the OLLAMA_THINK alias', () => {
    const c = loadConfig({ BOT_TOKEN: 't', OLLAMA_THINK: 'false', LLM_REASONING_EFFORT: 'low' });
    expect(c.llmReasoningEffort).toBe('low');
  });

  it('rejects an invalid timezone, port, timeout and bot user id', () => {
    expect(() => loadConfig({ BOT_TOKEN: 't', USER_TIMEZONE: 'Mars/Olympus' })).toThrow(
      'USER_TIMEZONE',
    );
    expect(() => loadConfig({ BOT_TOKEN: 't', PORT: 'abc' })).toThrow('PORT');
    expect(() => loadConfig({ BOT_TOKEN: 't', LLM_TIMEOUT_MS: '-5' })).toThrow('LLM_TIMEOUT_MS');
    expect(() => loadConfig({ BOT_TOKEN: 't', OLLAMA_TIMEOUT_MS: '-5' })).toThrow(
      'LLM_TIMEOUT_MS',
    );
    expect(() => loadConfig({ BOT_TOKEN: 't', BOT_USER_ID: 'x' })).toThrow('BOT_USER_ID');
  });

  it('accepts a numeric BOT_USER_ID', () => {
    expect(loadConfig({ BOT_TOKEN: 't', BOT_USER_ID: '42' }).botUserId).toBe(42);
  });
});
