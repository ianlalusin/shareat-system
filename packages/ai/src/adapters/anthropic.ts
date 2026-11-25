/** T-640 - Anthropic Messages API over plain HTTPS (no SDK). The key goes in a header only. */
import type { AiAdapter, ChatMessage, ChatResult, ToolCall } from '../types';
import { argsOf, asArray, asCount, asObject, asString, okJson } from './parse';

const URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_TIMEOUT_MS = 30_000;

/** A plain turn stays `{role, content: string}`; a turn with tool calls becomes tool_use blocks, and our answers come back as tool_result blocks in a user turn. An empty text block is refused by the API, so none is sent. */
function wire(m: ChatMessage): { role: 'user' | 'assistant'; content: unknown } {
  if (m.role === 'tool') return { role: 'user', content: m.results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.content })) };
  if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
    return { role: 'assistant', content: [...(m.content ? [{ type: 'text', text: m.content }] : []), ...m.toolCalls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.args }))] };
  }
  return { role: m.role, content: m.content };
}

export const anthropicAdapter: AiAdapter = {
  provider: 'anthropic',
  async chat(req, apiKey, http): Promise<ChatResult> {
    const body = {
      model: req.model,
      max_tokens: req.maxOutputTokens,
      ...(req.system ? { system: req.system } : {}),
      messages: req.messages.map(wire),
      ...(req.tools && req.tools.length > 0 ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) } : {}),
    };
    const res = await http({
      url: URL,
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
      timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    const json = okJson(res);
    let text = '';
    const toolCalls: ToolCall[] = [];
    for (const block of asArray(json.content)) {
      const b = asObject(block);
      if (b.type === 'text') text += asString(b.text);
      else if (b.type === 'tool_use') toolCalls.push({ id: asString(b.id), name: asString(b.name), args: argsOf(b.input) });
    }
    const usage = asObject(json.usage);
    return { text, toolCalls, tokensIn: asCount(usage.input_tokens), tokensOut: asCount(usage.output_tokens) };
  },
};
