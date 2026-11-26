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

/** One tool's answer, handed back to the model. `id` is the call's id (Gemini ignores it and matches on `name`); `content` is text our own code wrote, scrubbed by the privacy guard like everything else. */
export interface ToolResult {
  readonly id: string;
  readonly name: string;
  readonly content: string;
}
/**
 * One turn. T-641 added the tool loop: an assistant turn may carry the calls it made, and a `tool` turn carries our answers to them (one result per call, in the order called).
 * A provider that cannot take a tool turn in the middle of a conversation is not on the model list.
 */
export type ChatMessage =
  | { readonly role: 'user'; readonly content: string }
  | { readonly role: 'assistant'; readonly content: string; readonly toolCalls?: readonly ToolCall[] }
  | { readonly role: 'tool'; readonly results: readonly ToolResult[] };
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
  /** Gemini 3 models return an opaque signature with a function call and refuse the next turn unless it is sent back unchanged. Kept only to be echoed. */
  readonly thoughtSignature?: string;
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
