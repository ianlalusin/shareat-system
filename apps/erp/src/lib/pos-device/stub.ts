/**
 * T-526 STUB - replaced by work order T-530a; do not extend.
 *
 * The T-530a public API (docs: shareat-coord/work-orders/open/T-530a-pos-device-store.md) over an in-memory Map instead of IndexedDB,
 * so T-526 can build and test against the real signatures. Nothing here survives a reload. When T-530a lands, its files replace this one
 * and `index.ts` re-exports from them.
 */
export type PosEventKind = 'stand.opened' | 'lines.added' | 'heads.set' | 'refill.requested' | 'line.cancelled'
  | 'discount.added' | 'discount.removed' | 'discount.applied_to_all' | 'session.voided' | 'sale.completed';
export interface PosEvent { seq: number; kind: PosEventKind; personId: string; occurredAtDevice: string; payload: Record<string, unknown> }
export type NewPosEvent = Omit<PosEvent, 'seq'>;
export type PosEventResultStatus = 'applied' | 'duplicate' | 'conflict' | 'quarantined' | 'retry';
export interface PosEventResult { seq: number; status: PosEventResultStatus; error?: string; storedKind?: string }
export type SendOutcome =
  | { kind: 'ok'; stateVersion: number; results: PosEventResult[] }
  | { kind: 'http'; status: number }
  | { kind: 'network' };
export interface CachedSnapshot { body: unknown; etag: string; fetchedAtMs: number }
export interface StoredVerifier { personId: string; employeeId: string; salt: string; hash: string; iterations: number; createdAtMs: number }
export interface DrainReport {
  stopped: 'empty' | 'retry' | 'http' | 'network';
  status?: number;
  sent: number;
  removed: number;
  conflicts: PosEventResult[];
  stateVersion: number | null;
}

const outbox = new Map<number, PosEvent>();
const verifiers = new Map<string, StoredVerifier>();
const meta = new Map<string, unknown>();
let snapshot: CachedSnapshot | null = null;
let nextSeq = 1;
let nextTerminalSeq = 1; // reserveTerminalSeq() arrives with T-530a; nothing in T-526 calls it
let running: Promise<DrainReport> | null = null;

export async function enqueue(event: NewPosEvent): Promise<PosEvent> {
  const stored: PosEvent = { ...event, seq: nextSeq++ };
  outbox.set(stored.seq, stored);
  return stored;
}
export async function resumeAbove(server: { lastSeq: number; lastTerminalSeq: number }): Promise<void> {
  nextSeq = Math.max(nextSeq, server.lastSeq + 1);
  nextTerminalSeq = Math.max(nextTerminalSeq, server.lastTerminalSeq + 1);
}
export async function listPending(limit: number): Promise<PosEvent[]> {
  return [...outbox.values()].sort((a, b) => a.seq - b.seq).slice(0, limit);
}
export async function countPending(): Promise<number> {
  return outbox.size;
}
export async function applyResults(results: PosEventResult[]): Promise<{ removed: number[]; conflicts: PosEventResult[]; retryFrom: number | null }> {
  const removed: number[] = [];
  for (const r of results) if (r.status !== 'retry' && outbox.delete(r.seq)) removed.push(r.seq);
  return { removed, conflicts: results.filter((r) => r.status === 'conflict'), retryFrom: results.find((r) => r.status === 'retry')?.seq ?? null };
}

async function drainOnce(send: (events: PosEvent[]) => Promise<SendOutcome>): Promise<DrainReport> {
  const report: DrainReport = { stopped: 'empty', sent: 0, removed: 0, conflicts: [], stateVersion: null };
  for (;;) {
    const batch = await listPending(100);
    if (batch.length === 0) return report;
    let outcome: SendOutcome;
    try {
      outcome = await send(batch);
    } catch {
      outcome = { kind: 'network' };
    }
    if (outcome.kind !== 'ok') return { ...report, stopped: outcome.kind, ...(outcome.kind === 'http' ? { status: outcome.status } : {}) };
    const applied = await applyResults(outcome.results);
    Object.assign(report, { sent: report.sent + batch.length, removed: report.removed + applied.removed.length, stateVersion: outcome.stateVersion });
    report.conflicts.push(...applied.conflicts);
    if (applied.retryFrom !== null || outcome.results.length < batch.length) return { ...report, stopped: 'retry' };
  }
}
/** Single flight: a second call while one runs gets the running one's promise. */
export function drain(send: (events: PosEvent[]) => Promise<SendOutcome>): Promise<DrainReport> {
  running ??= drainOnce(send).finally(() => {
    running = null;
  });
  return running;
}

export async function saveSnapshot(s: CachedSnapshot): Promise<void> {
  snapshot = s;
}
export async function touchSnapshot(fetchedAtMs: number): Promise<void> {
  if (snapshot) snapshot = { ...snapshot, fetchedAtMs };
}
export async function readSnapshot(): Promise<CachedSnapshot | null> {
  return snapshot;
}
export function isSnapshotUsable(s: CachedSnapshot | null, nowMs: number, maxAgeMs: number): boolean {
  return s !== null && nowMs - s.fetchedAtMs <= maxAgeMs;
}

export async function putVerifier(v: StoredVerifier): Promise<void> {
  verifiers.set(v.personId, v);
}
export async function getVerifierByEmployeeId(employeeId: string): Promise<StoredVerifier | null> {
  return [...verifiers.values()].find((v) => v.employeeId === employeeId) ?? null;
}
export async function deleteVerifier(personId: string): Promise<void> {
  verifiers.delete(personId);
}
export async function listVerifiers(): Promise<StoredVerifier[]> {
  return [...verifiers.values()];
}

const assertAppKey = (key: string): void => {
  if (!/^app\./.test(key)) throw new Error('meta keys must start with "app."');
};
export async function getMeta<T>(key: string): Promise<T | null> {
  assertAppKey(key);
  return (meta.get(key) as T | undefined) ?? null;
}
export async function setMeta<T>(key: string, value: T): Promise<void> {
  assertAppKey(key);
  meta.set(key, value);
}
