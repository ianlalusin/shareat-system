/** T-640 - Anthropic Messages API over plain HTTPS (no SDK). The key goes in a header only. */
import type { AiAdapter, ChatResult, ToolCall } from '../types';
import { argsOf, asArray, asCount, asObject, asString, okJson } from './parse';

const URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_TIMEOUT_MS = 30_000;

export const anthropicAdapter: AiAdapter = {
  provider: 'anthropic',
  async chat(req, apiKey, http): Promise<ChatResult> {
    const body = {
      model: req.model,
      max_tokens: req.maxOutputTokens,
      ...(req.system ? { system: req.system } : {}),
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
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
