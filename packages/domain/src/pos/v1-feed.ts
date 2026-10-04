/**
 * T-375 S1 (R4, R5, R9) - the POS v1 bridge fetchers. `docs/tasks/375-pos-v1-day-feed.md` section S1.
 *
 * `fetchPosV1Day` returns the response EXACTLY as POS sent it (`body`, the text the day feed stores and hashes) and
 * its parsed `payload`; it derives nothing and writes nothing. It is called with POS's OWN store id (the link's
 * `pos_store_id`), never the v2 store id (F1). The env contract is `usage-pull.ts`'s: `POS_API_URL` / `POS_API_KEY`,
 * both optional in `@shareat/core/env`, read at call time through `env()`.
 *
 * Two named failures, so a caller can tell "nobody set it up" from "POS did not answer":
 *  - `PosNotConfiguredError` - either half of the pair is unset; POS is never called;
 *  - `PosUnreachableError`   - a network failure, a non-2xx of any shape, or a 2xx that is not JSON.
 * Both are `RefusalError`s (a sentence for the screen in `userMessage`). **POS's own `error` text is the raw half
 * only** (`message`): it can name a store id and means nothing to a person. No lock or transaction is held across
 * these calls (I4, T-373 R2), and a failed fetch writes nothing (I5).
 */
import { env } from '@shareat/core/env';
import { POS_V1_FEED_PATHS, POS_V1_PAYMENT_METHODS_PATH, POS_V1_STORES_PATH } from '@shareat/db';
import type { PosV1FeedKind } from '@shareat/db/schema';
import { RefusalError } from '../shared/refusal';

export class PosNotConfiguredError extends RefusalError {
  constructor(raw = 'POS bridge is not configured: POS_API_URL or POS_API_KEY is unset - see .env.example') {
    super(raw, "POS isn't connected to this system yet, so its sales can't be fetched. Ask the office to set it up.");
    this.name = 'PosNotConfiguredError';
  }
}

export class PosUnreachableError extends RefusalError {
  constructor(raw: string) {
    super(raw, "POS couldn't be reached just now, so this day has to wait. Try again in a few minutes.");
    this.name = 'PosUnreachableError';
  }
}

export interface FetchPosV1Day {
  /** The exact response text. Stored and hashed as-is. */
  readonly body: string;
  /** `JSON.parse(body)`. */
  readonly payload: unknown;
}

export interface FetchPosV1DayInput {
  /** POS's own store id (`pos_v1_store_links.pos_store_id`), NEVER the v2 store id. */
  readonly posStoreId: string;
  /** A Manila business date, `YYYY-MM-DD`. */
  readonly businessDate: string;
  readonly kind: PosV1FeedKind;
}

/** The injectable shape the import and the rechecks take, so a test never needs a live POS. */
export type PosV1DayFetcher = (input: FetchPosV1DayInput) => Promise<FetchPosV1Day>;

/** Every POS call is bounded: a POS that accepts the connection and never answers must not hold the request (and
 *  the caller's patience) forever. A timeout or abort is `PosUnreachableError`, like any network failure. */
const POS_FETCH_TIMEOUT_MS = 10_000;

function config(): { url: string; key: string } {
  const { POS_API_URL, POS_API_KEY } = env();
  if (!POS_API_URL || !POS_API_KEY) throw new PosNotConfiguredError();
  return { url: POS_API_URL.replace(/\/+$/, ''), key: POS_API_KEY };
}

/** GET, returning the response text on 2xx; every other outcome is `PosUnreachableError`. */
async function getText(path: string, query: string): Promise<string> {
  const { url, key } = config();
  const target = query ? `${url}${path}?${query}` : `${url}${path}`;
  let res: Response;
  try {
    res = await fetch(target, { headers: { 'x-api-key': key }, cache: 'no-store', signal: AbortSignal.timeout(POS_FETCH_TIMEOUT_MS) });
  } catch (err) {
    throw new PosUnreachableError(`POS request to ${path} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    throw new PosUnreachableError(`POS ${path} response could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    let detail = '';
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (typeof parsed.error === 'string') detail = parsed.error;
    } catch {
      /* not JSON: the status alone is the message */
    }
    throw new PosUnreachableError(`POS ${path} returned ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return text;
}

function parseJson(path: string, text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new PosUnreachableError(`POS ${path} returned a response that is not JSON`);
  }
}

export async function fetchPosV1Day(input: FetchPosV1DayInput): Promise<FetchPosV1Day> {
  const path = POS_V1_FEED_PATHS[input.kind];
  const body = await getText(path, `storeId=${encodeURIComponent(input.posStoreId)}&date=${encodeURIComponent(input.businessDate)}`);
  return { body, payload: parseJson(path, body) };
}

/** POS's method names for a store (the admin's mapping list, S2). */
export async function fetchPosV1PaymentMethods(posStoreId: string): Promise<string[]> {
  const text = await getText(POS_V1_PAYMENT_METHODS_PATH, `storeId=${encodeURIComponent(posStoreId)}`);
  const data = parseJson(POS_V1_PAYMENT_METHODS_PATH, text) as { methods?: unknown };
  return Array.isArray(data.methods) ? data.methods.filter((m): m is string => typeof m === 'string') : [];
}

export interface PosV1StoreOption {
  readonly id: string;
  readonly name: string;
}

/** POS's stores (the link screen's picker). A scoped key sees only its own. */
export async function fetchPosV1Stores(): Promise<PosV1StoreOption[]> {
  const text = await getText(POS_V1_STORES_PATH, '');
  const data = parseJson(POS_V1_STORES_PATH, text) as { stores?: unknown };
  if (!Array.isArray(data.stores)) return [];
  return data.stores
    .filter((s): s is { id: string; name?: unknown } => typeof s === 'object' && s !== null && typeof (s as { id?: unknown }).id === 'string')
    .map((s) => ({ id: s.id, name: typeof s.name === 'string' ? s.name : '' }));
}
