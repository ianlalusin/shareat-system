/** T-640 - small readers for a provider's JSON reply. Anything that is not the expected shape is a `bad_response`, never a crash and never a guess. */
import { AiProviderError, errorFromStatus } from '../errors';
import type { HttpResponse } from '../http';

export type Json = Record<string, unknown>;

export const asObject = (v: unknown): Json => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
export const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const asString = (v: unknown): string => (typeof v === 'string' ? v : '');
export const asCount = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

/** A 2xx reply parsed as a JSON object; any other status becomes its error kind. The reply body is never put in an error. */
export function okJson(res: HttpResponse): Json {
  if (res.status < 200 || res.status >= 300) throw errorFromStatus(res.status);
  try {
    const parsed = JSON.parse(res.body) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new AiProviderError('bad_response');
    return parsed as Json;
  } catch (e) {
    if (e instanceof AiProviderError) throw e;
    throw new AiProviderError('bad_response');
  }
}

/** A tool call's arguments arrive as an object (Anthropic, Google) or as a JSON string (OpenAI). */
export function argsOf(v: unknown): Json {
  if (typeof v === 'string') {
    try {
      return asObject(JSON.parse(v));
    } catch {
      throw new AiProviderError('bad_response');
    }
  }
  return asObject(v);
}
