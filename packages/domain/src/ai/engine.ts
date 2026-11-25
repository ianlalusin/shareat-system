/**
 * The pieces the Test call and the real call path share. T-640: the privacy guard and the prompt hash, the cap sentence, the failure sentences, and the one place a stored key is opened.
 *
 * ⛔ A key is opened here, in memory, for one request, by `openKey`. It is never returned past the function that uses it, never logged, never in an error or an audit row.
 */
import { createHash } from 'node:crypto';
import {
  AiProviderError,
  KeyCryptoError,
  PrivacyRefusal,
  decryptSecret,
  guardChatRequest,
  keyContext,
  type AiErrorKind,
  type AiProvider,
  type ChatRequest,
  type RedactionCounts,
} from '@shareat/ai';
import { aiHubRepo, type Tx } from '@shareat/db';
import { refuse } from '../shared/refusal';
import { requireMasterKey, usageLevel, type HubDeps, type HubSettings } from './shared';

/** A technical ceiling on one answer's length, not a business value: no feature needs more, and a typo here must not become a large bill. */
export const MAX_OUTPUT_TOKENS = 8192;

/**
 * Runs the request through the privacy guard and fingerprints what will actually be sent. The fingerprint is the SHA-256 of the cleaned prompt (system, messages, tool definitions);
 * the text itself is never stored anywhere. A request that holds a picture is refused.
 */
export function guarded(req: ChatRequest): { request: ChatRequest; sha256: string; redactions: RedactionCounts } {
  let g: ReturnType<typeof guardChatRequest>;
  try {
    g = guardChatRequest(req);
  } catch (e) {
    if (e instanceof PrivacyRefusal) throw refuse('ai hub: a picture was in the payload', 'This request contains a picture. Pictures are never sent to an AI provider.');
    throw e;
  }
  const request: ChatRequest = { ...req, system: g.system, messages: g.messages, ...(g.tools ? { tools: g.tools } : {}) };
  const sha256 = createHash('sha256')
    .update(JSON.stringify({ system: g.system ?? null, messages: g.messages, tools: g.tools ?? [] }))
    .digest('hex');
  return { request, sha256, redactions: g.redactions };
}

/** Refuses, in a sentence, when this month's spend has reached the cap. */
export function assertUnderCap(settings: HubSettings, spentMicro: number): void {
  if (usageLevel(spentMicro, settings.monthlyCapPesos, settings.warnAtPercent) === 'capped') {
    throw refuse(
      'ai hub: the monthly cap is reached',
      `The monthly AI spending cap (₱${settings.monthlyCapPesos.toLocaleString('en-US')}) has been reached. AI features work again from the 1st of next month, or sooner if a super admin raises the cap.`,
    );
  }
}

/** What a failed provider call means, in words an owner can act on. No provider reply text is ever used. */
export function failureSentence(kind: AiErrorKind): string {
  switch (kind) {
    case 'auth':
      return 'The provider refused the key. Check that it was copied whole and belongs to this provider.';
    case 'rate_limit':
      return 'The provider says there are too many requests right now. Try again in a minute.';
    case 'timeout':
      return 'The provider did not answer in time. Try again.';
    case 'network':
      return 'The provider could not be reached from the server.';
    case 'server':
      return 'The provider had a problem on its side. Try again later.';
    case 'bad_request':
      return 'The provider did not accept the request. The model name may no longer exist at the provider.';
    case 'bad_response':
      return 'The provider answered in a form the hub could not read.';
  }
}

/** Anything an adapter throws is one of ours; a bug that throws something else is treated as an unreadable answer (never its message). */
export function asProviderError(e: unknown): AiProviderError {
  return e instanceof AiProviderError ? e : new AiProviderError('bad_response');
}

/**
 * Reads a provider's stored key and opens it in memory. Null when there is none, or it cannot be opened (say, the server key changed): the caller decides what that means.
 * The key is returned to its caller only to be put in a request header and dropped.
 */
export async function openKey(tx: Tx, orgId: string, provider: AiProvider, deps: HubDeps): Promise<string | null> {
  const envelope = await aiHubRepo.getKeyEnvelope(tx, orgId, provider);
  if (!envelope) return null;
  try {
    return decryptSecret(envelope, requireMasterKey(deps), keyContext(orgId, provider));
  } catch (e) {
    if (e instanceof KeyCryptoError) return null;
    throw e;
  }
}
