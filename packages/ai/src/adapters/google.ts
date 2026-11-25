/**
 * T-640 - Google Gemini `generateContent` over plain HTTPS (no SDK). The key goes in the `x-goog-api-key` header, NEVER in the URL
 * (a URL ends up in logs and proxies). Gemini 2.5 models bill their "thinking" tokens as output, so those are counted in `tokensOut`.
 */
import type { AiAdapter, ChatResult, ToolCall } from '../types';
import { argsOf, asArray, asCount, asObject, asString, okJson } from './parse';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
const DEFAULT_TIMEOUT_MS = 30_000;

export const googleAdapter: AiAdapter = {
  provider: 'google',
  async chat(req, apiKey, http): Promise<ChatResult> {
    const body = {
      ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
      contents: req.messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
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
      if (typeof fc.name === 'string') toolCalls.push({ id: `call_${i}`, name: fc.name, args: argsOf(fc.args) });
    });
    const usage = asObject(json.usageMetadata);
    return { text, toolCalls, tokensIn: asCount(usage.promptTokenCount), tokensOut: asCount(usage.candidatesTokenCount) + asCount(usage.thoughtsTokenCount) };
  },
};
