/** T-640 - OpenAI Chat Completions over plain HTTPS (no SDK). The key goes in a header only. */
import type { AiAdapter, ChatMessage, ChatResult, ToolCall } from '../types';
import { argsOf, asArray, asCount, asObject, asString, okJson } from './parse';

const URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_TIMEOUT_MS = 30_000;

/** An assistant turn with calls carries `tool_calls` (arguments as a JSON string); each of our answers is its own `tool` message keyed by the call id. */
function wire(m: ChatMessage): unknown[] {
  if (m.role === 'tool') return m.results.map((r) => ({ role: 'tool', tool_call_id: r.id, content: r.content }));
  if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
    return [{ role: 'assistant', content: m.content || null, tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) }];
  }
  return [{ role: m.role, content: m.content }];
}

export const openaiAdapter: AiAdapter = {
  provider: 'openai',
  async chat(req, apiKey, http): Promise<ChatResult> {
    const body = {
      model: req.model,
      max_completion_tokens: req.maxOutputTokens,
      messages: [...(req.system ? [{ role: 'system', content: req.system }] : []), ...req.messages.flatMap(wire)],
      ...(req.tools && req.tools.length > 0
        ? { tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) }
        : {}),
    };
    const res = await http({
      url: URL,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    const json = okJson(res);
    const message = asObject(asObject(asArray(json.choices)[0]).message);
    const toolCalls: ToolCall[] = asArray(message.tool_calls).map((c) => {
      const call = asObject(c);
      const fn = asObject(call.function);
      return { id: asString(call.id), name: asString(fn.name), args: argsOf(fn.arguments) };
    });
    const usage = asObject(json.usage);
    return { text: asString(message.content), toolCalls, tokensIn: asCount(usage.prompt_tokens), tokensOut: asCount(usage.completion_tokens) };
  },
};
