/** T-640 - the one shape every provider adapter speaks. Text and tools only: there is no way to pass an image or a file. */
import type { HttpClient } from './http';

export const AI_PROVIDERS = ['anthropic', 'google', 'openai'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export const PROVIDER_LABEL: Readonly<Record<AiProvider, string>> = {
  anthropic: 'Anthropic (Claude)',
  google: 'Google (Gemini)',
  openai: 'OpenAI (GPT)',
};

export function isAiProvider(value: string): value is AiProvider {
  return (AI_PROVIDERS as readonly string[]).includes(value);
}

export interface ChatMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}
export interface ToolDef {
  readonly name: string;
  readonly description: string;
  /** A JSON-schema object: `{ type: 'object', properties: {...}, required: [...] }`. Keep to the plain subset all three providers accept. */
  readonly parameters: Readonly<Record<string, unknown>>;
}
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
}
export interface ChatRequest {
  readonly model: string;
  readonly system?: string;
  readonly messages: readonly ChatMessage[];
  readonly tools?: readonly ToolDef[];
  readonly maxOutputTokens: number;
  readonly timeoutMs?: number;
}
export interface ChatResult {
  readonly text: string;
  readonly toolCalls: readonly ToolCall[];
  readonly tokensIn: number;
  readonly tokensOut: number;
}

/** One provider. `chat` throws `AiProviderError` and nothing else; the key is used for the request and never kept or echoed. */
export interface AiAdapter {
  readonly provider: AiProvider;
  chat(req: ChatRequest, apiKey: string, http: HttpClient): Promise<ChatResult>;
}
