/**
 * T-530a — the POS v2 **server contract** for the tablet's outbox.
 *
 * These are the wire shapes the device queue stores and the server accepts. Nothing here computes
 * anything: the tablet writes a row, the server decides what it means. `apps/pos` is the v1 code
 * this replaces and is read as requirements only; these names and shapes are the v2 contract.
 */

/** The ten things a till action can be. Anything else is refused before it is stored. */
export type PosEventKind =
  | 'stand.opened'
  | 'lines.added'
  | 'heads.set'
  | 'refill.requested'
  | 'line.cancelled'
  | 'discount.added'
  | 'discount.removed'
  | 'discount.applied_to_all'
  | 'session.voided'
  | 'sale.completed';

/** One queued till action, with the device's own sequence number on it. */
export interface PosEvent {
  seq: number;
  kind: PosEventKind;
  personId: string;
  occurredAtDevice: string;
  payload: Record<string, unknown>;
}

/** A new event before the outbox gives it a `seq`. */
export type NewPosEvent = Omit<PosEvent, 'seq'>;

/**
 * What the server did with one event.
 * - `applied` — it changed state;
 * - `duplicate` — already had it;
 * - `conflict` — it contradicted something the server already knows (a head set on a moved table);
 * - `quarantined` — accepted into the queue but set aside for a human;
 * - `retry` — not decided yet; the device must send it again later.
 */
export type PosEventResultStatus = 'applied' | 'duplicate' | 'conflict' | 'quarantined' | 'retry';

export interface PosEventResult {
  seq: number;
  status: PosEventResultStatus;
  error?: string;
  storedKind?: string;
}

/** What the caller's network function returns for one `POST /api/pos/events`. */
export type SendOutcome =
  | { kind: 'ok'; stateVersion: number; results: PosEventResult[] }
  | { kind: 'http'; status: number } // 400, 401, 409, 413, 415, 5xx...
  | { kind: 'network' }; // no connection / timeout

/** The last good menu + settings the tablet can sell from offline. */
export interface CachedSnapshot {
  body: unknown;
  etag: string;
  fetchedAtMs: number;
}

/** An opaque PIN-verifier record, created by T-526. Stored and returned as-is; never computed here. */
export interface StoredVerifier {
  personId: string;
  employeeId: string;
  salt: string;
  hash: string;
  iterations: number;
  createdAtMs: number;
}

/** Why a drain stopped, and what it did before it did. */
export interface DrainReport {
  stopped: 'empty' | 'retry' | 'http' | 'network';
  status?: number;
  sent: number;
  removed: number;
  conflicts: PosEventResult[];
  stateVersion: number | null;
}
