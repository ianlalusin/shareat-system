import { describe, expect, it } from 'vitest';
import { AiProviderError, errorFromStatus, triesNextProvider } from '../src/errors';
import { anthropicAdapter, googleAdapter, openaiAdapter } from '../src/adapters';
import type { HttpClient, HttpRequest } from '../src/http';
import { costMicroPesos } from '../src/pricing';
import { MODEL_CATALOGUE, catalogueModel } from '../src/models';
import { judgeTestReply, testRequest } from '../src/test-call';
import type { ChatRequest } from '../src/types';

/**
 * T-640 test 8: the three provider adapters, against FAKE HTTP (no network, ever): what each sends, how each reads a reply, how each failure becomes a kind,
 * and that the key only ever travels in a header. The replies below are written by hand in each provider's documented shape.
 */
const KEY = 'sk-test-0123456789abcdefghijklmnop-ZZZZ';
const REQ: ChatRequest = {
  model: 'm-1',
  system: 'Be brief.',
  messages: [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
    { role: 'user', content: 'sum 2 and 3' },
  ],
  tools: [{ name: 'add', description: 'adds', parameters: { type: 'object', properties: { a: { type: 'number' } }, required: ['a'] } }],
  maxOutputTokens: 100,
};

function fake(status: number, reply: unknown): { http: HttpClient; seen: HttpRequest[] } {
  const seen: HttpRequest[] = [];
  return {
    seen,
    http: async (req) => {
      seen.push(req);
      return { status, body: typeof reply === 'string' ? reply : JSON.stringify(reply) };
    },
  };
}

describe('T-640 Anthropic adapter', () => {
  const reply = { content: [{ type: 'text', text: 'Five.' }, { type: 'tool_use', id: 'tu_1', name: 'add', input: { a: 2 } }], usage: { input_tokens: 31, output_tokens: 7 } };

  it('sends the documented request (key in x-api-key only) and reads text, tool calls and token counts [kills: a key in the URL or body, a misread usage]', async () => {
    const f = fake(200, reply);
    const r = await anthropicAdapter.chat(REQ, KEY, f.http);
    expect(r).toEqual({ text: 'Five.', toolCalls: [{ id: 'tu_1', name: 'add', args: { a: 2 } }], tokensIn: 31, tokensOut: 7 });
    const sent = f.seen[0]!;
    expect(sent.url).toBe('https://api.anthropic.com/v1/messages');
    expect(sent.headers['x-api-key']).toBe(KEY);
    expect(sent.headers['anthropic-version']).toBeTruthy();
    expect(sent.url).not.toContain(KEY);
    expect(sent.body).not.toContain(KEY);
    const body = JSON.parse(sent.body);
    expect(body).toMatchObject({ model: 'm-1', max_tokens: 100, system: 'Be brief.' });
    expect(body.messages).toEqual([{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }, { role: 'user', content: 'sum 2 and 3' }]);
    expect(body.tools[0]).toMatchObject({ name: 'add', input_schema: { type: 'object' } });
  });
});

describe('T-640 OpenAI adapter', () => {
  const reply = { choices: [{ message: { content: 'Five.', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'add', arguments: '{"a":2}' } }] } }], usage: { prompt_tokens: 40, completion_tokens: 9 } };

  it('sends the documented request (key as a Bearer header only), puts the system prompt first, parses the arguments string [kills: arguments left as a string, system dropped]', async () => {
    const f = fake(200, reply);
    const r = await openaiAdapter.chat(REQ, KEY, f.http);
    expect(r).toEqual({ text: 'Five.', toolCalls: [{ id: 'c1', name: 'add', args: { a: 2 } }], tokensIn: 40, tokensOut: 9 });
    const sent = f.seen[0]!;
    expect(sent.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(sent.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(sent.url).not.toContain(KEY);
    expect(sent.body).not.toContain(KEY);
    const body = JSON.parse(sent.body);
    expect(body.messages[0]).toEqual({ role: 'system', content: 'Be brief.' });
    expect(body.messages).toHaveLength(4);
    expect(body).toMatchObject({ model: 'm-1', max_completion_tokens: 100 });
    expect(body.tools[0]).toEqual({ type: 'function', function: { name: 'add', description: 'adds', parameters: REQ.tools![0]!.parameters } });
  });

  it('unreadable tool arguments are a bad response, never a guess [kills: swallowing a malformed argument string]', async () => {
    const bad = { choices: [{ message: { content: null, tool_calls: [{ id: 'c1', function: { name: 'add', arguments: '{not json' } }] } }], usage: {} };
    await expect(openaiAdapter.chat(REQ, KEY, fake(200, bad).http)).rejects.toMatchObject({ kind: 'bad_response' });
  });
});

describe('T-640 Google adapter', () => {
  const reply = { candidates: [{ content: { parts: [{ text: 'Five.' }, { functionCall: { name: 'add', args: { a: 2 } } }] } }], usageMetadata: { promptTokenCount: 22, candidatesTokenCount: 5, thoughtsTokenCount: 60 } };

  it('puts the key in a header and NEVER the URL, maps roles, and counts thinking tokens as output [kills: a key in the URL, a model that bills thinking for free]', async () => {
    const f = fake(200, reply);
    const r = await googleAdapter.chat({ ...REQ, model: 'gemini-2.5-flash' }, KEY, f.http);
    expect(r).toEqual({ text: 'Five.', toolCalls: [{ id: 'call_1', name: 'add', args: { a: 2 } }], tokensIn: 22, tokensOut: 65 });
    const sent = f.seen[0]!;
    expect(sent.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
    expect(sent.url).not.toContain('key=');
    expect(sent.url).not.toContain(KEY);
    expect(sent.headers['x-goog-api-key']).toBe(KEY);
    expect(sent.body).not.toContain(KEY);
    const body = JSON.parse(sent.body);
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'Be brief.' }] });
    expect(body.contents.map((c: { role: string }) => c.role)).toEqual(['user', 'model', 'user']);
    expect(body.generationConfig).toEqual({ maxOutputTokens: 100 });
    expect(body.tools[0].functionDeclarations[0]).toMatchObject({ name: 'add' });
  });
});

describe('T-640 failures, for all three', () => {
  const adapters = [anthropicAdapter, openaiAdapter, googleAdapter];

  it('429 is a rate limit, 5xx a server fault, 401 / 403 a refused key, other 4xx a bad request, and none of the messages holds the key or the reply [kills: a provider reply (which can echo a key) in an error]', async () => {
    const echo = { error: { message: `Incorrect API key provided: ${KEY}` } };
    for (const a of adapters) {
      for (const [status, kind] of [[429, 'rate_limit'], [500, 'server'], [503, 'server'], [401, 'auth'], [403, 'auth'], [400, 'bad_request'], [404, 'bad_request']] as const) {
        const err = await a.chat(REQ, KEY, fake(status, echo).http).then(() => null, (e: unknown) => e);
        expect(err, `${a.provider} ${status}`).toBeInstanceOf(AiProviderError);
        expect((err as AiProviderError).kind).toBe(kind);
        expect((err as AiProviderError).message).not.toContain(KEY.slice(0, 12));
        expect((err as AiProviderError).message).not.toContain('Incorrect API key');
      }
    }
  });

  it('a 200 whose body is not the expected JSON is a bad response [kills: a crash on an HTML error page]', async () => {
    for (const a of adapters) {
      await expect(a.chat(REQ, KEY, fake(200, '<html>gateway</html>').http), a.provider).rejects.toMatchObject({ kind: 'bad_response' });
      await expect(a.chat(REQ, KEY, fake(200, '[1,2]').http), a.provider).rejects.toMatchObject({ kind: 'bad_response' });
    }
  });

  it('a timeout or network failure from the client passes through as that kind [kills: swallowing a timeout]', async () => {
    for (const a of adapters) {
      const http: HttpClient = async () => {
        throw new AiProviderError('timeout');
      };
      await expect(a.chat(REQ, KEY, http)).rejects.toMatchObject({ kind: 'timeout' });
    }
  });

  it('every kind except a bad request moves on to the next model [kills: a walk that stops on a timeout, or retries a request that can never work]', () => {
    for (const k of ['timeout', 'network', 'rate_limit', 'server', 'auth', 'bad_response'] as const) expect(triesNextProvider(k), k).toBe(true);
    expect(triesNextProvider('bad_request')).toBe(false);
    expect(errorFromStatus(429).kind).toBe('rate_limit');
  });
});

describe('T-640 prices and the test call', () => {
  it('cost is whole micro-pesos, rounded UP, never a float [kills: rounding a small call down to nothing]', () => {
    // 1,000,000 tokens in at $1.00 per million, at 58.00 pesos per dollar: 58 pesos = 58,000,000 micro-pesos
    expect(costMicroPesos({ tokensIn: 1_000_000, tokensOut: 0 }, { centsPerMillionIn: 100, centsPerMillionOut: 500 }, 5800)).toBe(58_000_000);
    // 1,000 in and 200 out on a mini model: 1000*15 + 200*60 = 27,000 cent-tokens x 5800 / 10,000 = 15,660 micro-pesos
    expect(costMicroPesos({ tokensIn: 1000, tokensOut: 200 }, { centsPerMillionIn: 15, centsPerMillionOut: 60 }, 5800)).toBe(15_660);
    expect(costMicroPesos({ tokensIn: 0, tokensOut: 0 }, { centsPerMillionIn: 15, centsPerMillionOut: 60 }, 5800)).toBe(0);
    // one token still costs something: 1 x 10 x 5800 / 10,000 = 5.8 -> 6
    expect(costMicroPesos({ tokensIn: 1, tokensOut: 0 }, { centsPerMillionIn: 10, centsPerMillionOut: 40 }, 5800)).toBe(6);
    expect(() => costMicroPesos({ tokensIn: -1, tokensOut: 0 }, { centsPerMillionIn: 1, centsPerMillionOut: 1 }, 5800)).toThrow(RangeError);
    expect(() => costMicroPesos({ tokensIn: 1.5, tokensOut: 0 }, { centsPerMillionIn: 1, centsPerMillionOut: 1 }, 5800)).toThrow(RangeError);
  });

  it('the model list: every entry is unique, priced in whole cents, and findable; an unlisted name is not [kills: a duplicate or a free-text model]', () => {
    const names = MODEL_CATALOGUE.map((m) => `${m.provider}/${m.model}`);
    expect(new Set(names).size).toBe(names.length);
    for (const m of MODEL_CATALOGUE) {
      expect(Number.isInteger(m.centsPerMillionIn) && m.centsPerMillionIn > 0, m.model).toBe(true);
      expect(Number.isInteger(m.centsPerMillionOut) && m.centsPerMillionOut > 0, m.model).toBe(true);
      expect(catalogueModel(m.provider, m.model)).toBe(m);
    }
    expect(new Set(MODEL_CATALOGUE.map((m) => m.provider))).toEqual(new Set(['anthropic', 'google', 'openai']));
    expect(catalogueModel('openai', 'gpt-made-up')).toBeUndefined();
    expect(catalogueModel('openai', 'claude-haiku-4-5')).toBeUndefined();
  });

  it('the test reply passes with words or a tool call, and records whether the tool was called [kills: tool_calling decided by anything but the reply]', () => {
    expect(judgeTestReply({ text: '', toolCalls: [{ id: '1', name: 'ping', args: { value: 'ok' } }], tokensIn: 1, tokensOut: 1 })).toEqual({ passed: true, toolCalling: true });
    expect(judgeTestReply({ text: 'ok', toolCalls: [], tokensIn: 1, tokensOut: 1 })).toEqual({ passed: true, toolCalling: false });
    expect(judgeTestReply({ text: '  ', toolCalls: [], tokensIn: 1, tokensOut: 1 })).toEqual({ passed: false, toolCalling: false });
    expect(judgeTestReply({ text: '', toolCalls: [{ id: '1', name: 'other', args: {} }], tokensIn: 1, tokensOut: 1 }).toolCalling).toBe(false);
    const req = testRequest('gpt-4o-mini');
    expect(req.tools).toHaveLength(1);
    expect(req.maxOutputTokens).toBeLessThanOrEqual(256);
  });
});
