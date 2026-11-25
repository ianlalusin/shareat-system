import { describe, expect, it } from 'vitest';
import { anthropicAdapter, googleAdapter, openaiAdapter } from '../src/adapters';
import type { HttpClient, HttpRequest } from '../src/http';
import { guardChatRequest } from '../src/privacy';
import type { ChatMessage, ChatRequest } from '../src/types';

/**
 * T-641 S1: a conversation that holds tool turns (the model asked for tools, our code answered) is sent in each provider's own shape, and every outgoing byte of it, the tool
 * results and the model's own tool arguments included, goes through the privacy guard. FAKE HTTP only; every key and number below is made up.
 */
const KEY = 'sk-test-0123456789abcdefghijklmnop-ZZZZ';
const CALL = { id: 'call_a', name: 'costDrivers', args: { period: 'this_month' } };
const TURNS: ChatMessage[] = [
  { role: 'user', content: 'What is our cost driver this month?' },
  { role: 'assistant', content: '', toolCalls: [CALL] },
  { role: 'tool', results: [{ id: 'call_a', name: 'costDrivers', content: '{"total":"1,000.00"}' }] },
];
const REQ: ChatRequest = {
  model: 'm-1',
  messages: TURNS,
  tools: [{ name: 'costDrivers', description: 'x', parameters: { type: 'object', properties: {} } }],
  maxOutputTokens: 100,
};

function fake(reply: unknown): { http: HttpClient; seen: HttpRequest[] } {
  const seen: HttpRequest[] = [];
  return {
    seen,
    http: async (req) => {
      seen.push(req);
      return { status: 200, body: JSON.stringify(reply) };
    },
  };
}

describe('T-641 tool turns, per provider', () => {
  it('Anthropic: tool_use blocks (no empty text block) then a tool_result block in a user turn [kills: an empty text block, a tool result sent as plain text, a lost call id]', async () => {
    const f = fake({ content: [{ type: 'text', text: 'Rent.' }], usage: { input_tokens: 5, output_tokens: 2 } });
    const r = await anthropicAdapter.chat(REQ, KEY, f.http);
    expect(r.text).toBe('Rent.');
    const body = JSON.parse(f.seen[0]!.body);
    expect(body.messages).toEqual([
      { role: 'user', content: 'What is our cost driver this month?' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_a', name: 'costDrivers', input: { period: 'this_month' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_a', content: '{"total":"1,000.00"}' }] },
    ]);
  });

  it('Anthropic: an assistant turn with words AND a call keeps the words first [kills: the words dropped]', async () => {
    const f = fake({ content: [{ type: 'text', text: 'ok' }] });
    await anthropicAdapter.chat({ ...REQ, messages: [TURNS[0]!, { role: 'assistant', content: 'Let me look.', toolCalls: [CALL] }, TURNS[2]!] }, KEY, f.http);
    expect(JSON.parse(f.seen[0]!.body).messages[1].content).toEqual([{ type: 'text', text: 'Let me look.' }, { type: 'tool_use', id: 'call_a', name: 'costDrivers', input: { period: 'this_month' } }]);
  });

  it('OpenAI: assistant tool_calls with the arguments as a JSON string, then one role:tool message per result keyed by the call id [kills: arguments as an object, a missing tool_call_id]', async () => {
    const f = fake({ choices: [{ message: { content: 'Rent.' } }], usage: { prompt_tokens: 5, completion_tokens: 2 } });
    await openaiAdapter.chat({ ...REQ, system: 'Be brief.', messages: [...TURNS.slice(0, 2), { role: 'tool', results: [{ id: 'call_a', name: 'costDrivers', content: 'A' }, { id: 'call_b', name: 'lowStock', content: 'B' }] }] }, KEY, f.http);
    const body = JSON.parse(f.seen[0]!.body);
    expect(body.messages).toEqual([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'What is our cost driver this month?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'costDrivers', arguments: '{"period":"this_month"}' } }] },
      { role: 'tool', tool_call_id: 'call_a', content: 'A' },
      { role: 'tool', tool_call_id: 'call_b', content: 'B' },
    ]);
  });

  it('Google: a model turn with functionCall parts, then functionResponse parts in a user turn matched by name; the thought signature is sent back unchanged [kills: no signature echo, a response not keyed by name]', async () => {
    const f = fake({ candidates: [{ content: { parts: [{ text: 'Rent.' }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 } });
    await googleAdapter.chat({ ...REQ, messages: [TURNS[0]!, { role: 'assistant', content: '', toolCalls: [{ ...CALL, thoughtSignature: 'sig-xyz' }] }, TURNS[2]!] }, KEY, f.http);
    const body = JSON.parse(f.seen[0]!.body);
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: 'What is our cost driver this month?' }] },
      { role: 'model', parts: [{ functionCall: { name: 'costDrivers', args: { period: 'this_month' } }, thoughtSignature: 'sig-xyz' }] },
      { role: 'user', parts: [{ functionResponse: { name: 'costDrivers', response: { result: '{"total":"1,000.00"}' } } }] },
    ]);
  });

  it('Google: a function call reply keeps its thought signature on the ToolCall, and none is invented when there is none [kills: a dropped signature; a made-up one]', async () => {
    const withSig = fake({ candidates: [{ content: { parts: [{ functionCall: { name: 'costDrivers', args: {} }, thoughtSignature: 'sig-1' }] } }] });
    expect((await googleAdapter.chat(REQ, KEY, withSig.http)).toolCalls[0]).toEqual({ id: 'call_0', name: 'costDrivers', args: {}, thoughtSignature: 'sig-1' });
    const without = fake({ candidates: [{ content: { parts: [{ functionCall: { name: 'costDrivers', args: {} } }] } }] });
    expect((await googleAdapter.chat(REQ, KEY, without.http)).toolCalls[0]).toEqual({ id: 'call_0', name: 'costDrivers', args: {} });
  });

  it('a plain text conversation is sent exactly as before [kills: a change that touched the no-tool path]', async () => {
    const f = fake({ content: [{ type: 'text', text: 'hi' }] });
    await anthropicAdapter.chat({ model: 'm', messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }], maxOutputTokens: 5 }, KEY, f.http);
    expect(JSON.parse(f.seen[0]!.body).messages).toEqual([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]);
  });
});

describe('T-641 the privacy guard covers tool turns', () => {
  const dirty: ChatMessage[] = [
    { role: 'user', content: 'cost driver?' },
    { role: 'assistant', content: 'Looking.', toolCalls: [{ id: 'c1', name: 'costDrivers', args: { note: 'TIN 123-456-789-000 sss 34-1234567-8', employeeName: 'Juan Dela Cruz' } }] },
    {
      role: 'tool',
      results: [{ id: 'c1', name: 'costDrivers', content: JSON.stringify({ total: '1,000.00', netPay: '12,345.00', contact: 'juan@example.com', card: '4111 1111 1111 1111', pin: '4821' }) }],
    },
  ];

  it('tool results lose personal fields, ID numbers, card numbers and e-mail addresses; the figures stay [kills: a guard that only cleans typed text]', () => {
    const g = guardChatRequest({ messages: dirty });
    const tool = g.messages[2]!;
    if (tool.role !== 'tool') throw new Error('expected a tool turn');
    const text = tool.results[0]!.content;
    expect(text).toContain('1,000.00');
    expect(text).not.toContain('12,345.00');
    expect(text).not.toContain('juan@example.com');
    expect(text).not.toContain('4111');
    expect(text).not.toContain('4821');
    expect(g.redactions.personal_field).toBeGreaterThanOrEqual(2);
  });

  it('the model\'s own tool arguments are cleaned too, and the call id and name are kept [kills: arguments sent raw]', () => {
    const g = guardChatRequest({ messages: dirty });
    const a = g.messages[1]!;
    if (a.role !== 'assistant' || !a.toolCalls) throw new Error('expected an assistant turn with calls');
    const call = a.toolCalls[0]!;
    expect(call.id).toBe('c1');
    expect(call.name).toBe('costDrivers');
    expect(JSON.stringify(call.args)).not.toContain('123-456-789');
    expect(JSON.stringify(call.args)).not.toContain('Juan');
  });

  it('the input is not changed [kills: in-place edits that would leak the raw text into a retry]', () => {
    const before = JSON.stringify(dirty);
    guardChatRequest({ messages: dirty });
    expect(JSON.stringify(dirty)).toBe(before);
  });

  it('a picture inside a tool result is refused outright [kills: an image slipping in through a tool]', () => {
    expect(() => guardChatRequest({ messages: [{ role: 'tool', results: [{ id: 'c', name: 'x', content: 'data:image/png;base64,AAAA' }] }] })).toThrow();
  });
});
