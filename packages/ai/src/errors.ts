/**
 * T-640 - what can go wrong talking to a model provider. A message NEVER carries a key, a prompt or a provider's reply body: a provider's
 * "wrong key" reply can echo part of the key, so only the kind and the HTTP status are ever kept (and logged).
 */
export type AiErrorKind = 'timeout' | 'network' | 'rate_limit' | 'server' | 'auth' | 'bad_request' | 'bad_response';

export class AiProviderError extends Error {
  readonly kind: AiErrorKind;
  readonly status: number | undefined;
  constructor(kind: AiErrorKind, status?: number) {
    super(status === undefined ? `ai provider: ${kind}` : `ai provider: ${kind} (${status})`);
    this.name = 'AiProviderError';
    this.kind = kind;
    this.status = status;
  }
}

/** HTTP status to error kind: 429 is a rate limit, 5xx a server fault, 401/403 a refused key, anything else our own bad request. */
export function errorFromStatus(status: number): AiProviderError {
  if (status === 429) return new AiProviderError('rate_limit', status);
  if (status >= 500) return new AiProviderError('server', status);
  if (status === 401 || status === 403) return new AiProviderError('auth', status);
  return new AiProviderError('bad_request', status);
}

/** The next provider in the priority list is tried for every kind except a request our own code got wrong (it would fail everywhere). */
export function triesNextProvider(kind: AiErrorKind): boolean {
  return kind !== 'bad_request';
}

/** The stored short code for an error (the `ai_calls.error_code` column): kind, plus the status when there is one. */
export function errorCode(e: AiProviderError): string {
  return e.status === undefined ? e.kind : `${e.kind}_${e.status}`;
}
