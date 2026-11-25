/**
 * T-640 - Google Gemini `generateContent` over plain HTTPS (no SDK). The key goes in the `x-goog-api-key` header, NEVER in the URL
 * (a URL ends up in logs and proxies). Gemini 2.5 models bill their "thinking" tokens as output, so those are counted in `tokensOut`.
 */
import type { AiAdapter, ChatMessage, ChatResult, ToolCall } from '../types';
import { argsOf, asArray, asCount, asObject, asString, okJson } from './parse';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
const DEFAULT_TIMEOUT_MS = 30_000;

/** A model turn with calls carries functionCall parts (and the thought signature when Gemini sent one); our answers go back as functionResponse parts, matched by function name, in a user turn. */
function wire(m: ChatMessage): { role: 'user' | 'model'; parts: unknown[] } {
  if (m.role === 'tool') return { role: 'user', parts: m.results.map((r) => ({ functionResponse: { name: r.name, response: { result: r.content } } })) };
  if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
    return {
      role: 'model',
      parts: [...(m.content ? [{ text: m.content }] : []), ...m.toolCalls.map((c) => ({ functionCall: { name: c.name, args: c.args }, ...(c.thoughtSignature ? { thoughtSignature: c.thoughtSignature } : {}) }))],
    };
  }
  return { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] };
}

export const googleAdapter: AiAdapter = {
  provider: 'google',
  async chat(req, apiKey, http): Promise<ChatResult> {
    const body = {
      ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
      contents: req.messages.map(wire),
      ...(req.tools && req.tools.length > 0 ? { tools: [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }] } : {}),
      generationConfig: { maxOutputTokens: req.maxOutputTokens },
    };
    const res = await http({
      url: `${BASE}${encodeURIComponent(req.model)}:generateContent`,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    const json = okJson(res);
    let text = '';
    const toolCalls: ToolCall[] = [];
    const parts = asArray(asObject(asObject(asArray(json.candidates)[0]).content).parts);
    parts.forEach((part, i) => {
      const p = asObject(part);
      if (typeof p.text === 'string') text += p.text;
      const fc = asObject(p.functionCall);
      if (typeof fc.name === 'string') toolCalls.push({ id: `call_${i}`, name: fc.name, args: argsOf(fc.args), ...(typeof p.thoughtSignature === 'string' ? { thoughtSignature: p.thoughtSignature } : {}) });
    });
    const usage = asObject(json.usageMetadata);
    return { text, toolCalls, tokensIn: asCount(usage.promptTokenCount), tokensOut: asCount(usage.candidatesTokenCount) + asCount(usage.thoughtsTokenCount) };
  },
};
