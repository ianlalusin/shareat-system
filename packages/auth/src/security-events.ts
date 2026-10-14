/**
 * T-402 S2 (R9, R11; audit rulings A1, A3, A5, A6) - the security-event OUTBOX.
 *
 * One rule: a security event never holds a second connection, never blocks the caller, and never changes the caller's
 * outcome. Failure-path events (a refused sign-in, a PIN pause or stop outside a caller transaction, an authorize()
 * denial) and post-commit success events (`tx === null` sign-in and sign-out) are `enqueue*()`d - SYNCHRONOUSLY, returning
 * void - into an in-process buffer. A flush scheduled with `setImmediate` writes ONE `withOrgPrincipal` transaction per
 * org, sequentially, one flush in flight at a time, so the outbox holds at most one connection and no caller ever waits
 * on it (no deadlock at any pool size).
 *
 * Denials are coalesced per (org, actor, capability, store, hour bucket) into `{ count, firstAt }`: the first of the
 * Manila business day becomes a `security.authorize_denied` row and the rest are added to the hourly counter.
 * Accepted loss, by design: whatever is buffered when the process dies, and a flush whose DB write fails (one
 * `logger.error` per org per flush, entries dropped, no retry). The buffer is capped (10,000 distinct denial keys, 1,000
 * list events); beyond that entries are dropped and counted, one `logger.warn` per flush.
 *
 * No PIN, hash, token, JWT or raw store string is ever placed in a payload or a log line from this file.
 */
import { accessRepo, auditLogRepo, authzDenialCountsRepo, pinAttemptsRepo, UUID_SHAPE, withOrgPrincipal, type Tx } from '@shareat/db';
import { logger } from '@shareat/core/logger';

const MAX_DENIAL_KEYS = 10_000;
const MAX_LIST_EVENTS = 1_000;
const HOUR_MS = 60 * 60 * 1000;
const MANILA_OFFSET_MS = 8 * HOUR_MS; // Asia/Manila has no daylight saving

interface Denial {
  readonly orgId: string;
  readonly actorPersonId: string;
  readonly capability: string;
  /** The store string exactly as the caller passed it; resolved (or discarded) at flush, never logged. */
  readonly rawStoreId: string | null;
  readonly hour: number;
  count: number;
  readonly firstAt: number;
}

interface ListEvent {
  readonly orgId: string;
  readonly write: (tx: Tx) => Promise<unknown>;
}

let denials = new Map<string, Denial>();
let events: ListEvent[] = [];
let dropped = 0;
let scheduled = false;
let running: Promise<void> | null = null;

/** Keys already written (row or counter) in this process on the current Manila day: skip the lock and the scan. */
let seenDay = '';
const seenToday = new Set<string>();

const manilaDay = (ms: number): string => new Date(ms + MANILA_OFFSET_MS).toISOString().slice(0, 10);

function schedule(): void {
  if (scheduled || running) return;
  scheduled = true;
  setImmediate(() => {
    scheduled = false;
    void runFlush();
  });
}

function pending(): boolean {
  return denials.size > 0 || events.length > 0;
}

function pushEvent(orgId: string, write: (tx: Tx) => Promise<unknown>): void {
  if (events.length >= MAX_LIST_EVENTS) {
    dropped++;
    return;
  }
  events.push({ orgId, write });
  schedule();
}

// ---------------------------------------------------------------------------------------------------------------
// enqueue*() - synchronous, never throws
// ---------------------------------------------------------------------------------------------------------------

/** R9: one authorize() denial. Coalesced; `now` is injectable so a test can cross Manila midnight. */
export function enqueueAuthorizeDenied(
  input: { orgId: string; actorPersonId: string; capability: string; storeId: string | null },
  now: () => number,
): void {
  try {
    const at = now();
    const hour = Math.floor(at / HOUR_MS) * HOUR_MS;
    const raw = input.storeId === null ? null : String(input.storeId).slice(0, 64);
    const key = `${input.orgId}|${input.actorPersonId}|${input.capability}|${raw ?? ''}|${hour}`;
    const existing = denials.get(key);
    if (existing) {
      existing.count++;
    } else if (denials.size >= MAX_DENIAL_KEYS) {
      dropped++;
      return;
    } else {
      denials.set(key, { orgId: input.orgId, actorPersonId: input.actorPersonId, capability: input.capability, rawStoreId: raw, hour, count: 1, firstAt: at });
    }
    schedule();
  } catch (err) {
    logger.error({ err }, 'security event could not be queued');
  }
}

/** R11: a Firebase token that verified, for a KNOWN account that is not allowed in. The actor is null: nobody signed in. */
export function enqueueSigninRefused(orgId: string, personId: string, reason: 'terminal_credential' | 'not_a_firebase_credential'): void {
  pushEvent(orgId, (tx) =>
    auditLogRepo.appendSystem(tx, orgId, {
      action: 'auth.signin_refused',
      storeId: null,
      entityId: personId,
      before: null,
      after: { personId, reason },
      source: 'web',
    }),
  );
}

/** Tier 1 pause, for the path where the charge already committed on its own (`tx === null`). */
export function enqueuePinPaused(orgId: string, storeId: string, deviceId: string | null): void {
  pushEvent(orgId, (tx) =>
    auditLogRepo.appendSystem(tx, orgId, {
      action: 'auth.pin_paused',
      storeId,
      entityId: storeId,
      before: null,
      after: {
        storeId,
        missThreshold: pinAttemptsRepo.MISS_THRESHOLD,
        windowSeconds: pinAttemptsRepo.MISS_WINDOW_SECONDS,
        cooldownSeconds: pinAttemptsRepo.LOCK_COOLDOWN_SECONDS,
      },
      source: 'web',
      deviceId,
    }),
  );
}

/** Tier 2 stop (T-395), for the path where the charge already committed on its own. */
export function enqueuePinStoppedForDay(orgId: string, storeId: string, deviceId: string | null): void {
  pushEvent(orgId, (tx) =>
    auditLogRepo.appendSystem(tx, orgId, {
      action: 'auth.pin_stopped_for_day',
      storeId,
      entityId: storeId,
      before: null,
      after: { storeId, dailyMissBudget: pinAttemptsRepo.DAILY_MISS_BUDGET },
      source: 'web',
      deviceId,
    }),
  );
}

/** A5: a Firebase sign-in whose session committed in the auth door (no org principal there). Never awaited. */
export function enqueueFirebaseSignedIn(orgId: string, result: { personId: string; sessionId: string }): void {
  pushEvent(orgId, (tx) =>
    auditLogRepo.append(tx, orgId, {
      actorPersonId: result.personId,
      action: 'auth.signin_succeeded',
      storeId: null,
      entityId: result.personId,
      before: null,
      after: { sessionId: result.sessionId, credentialKind: 'firebase' },
      source: 'web',
    }),
  );
}

/** A5: a sign-out whose session end committed in the auth door. Never awaited. */
export function enqueueSessionEnded(orgId: string, live: { id: string; personId: string; credentialKind: string }): void {
  pushEvent(orgId, (tx) =>
    auditLogRepo.append(tx, orgId, {
      actorPersonId: live.personId,
      action: 'session.ended',
      storeId: null,
      entityId: live.id,
      before: null,
      after: { reason: 'signed_out', credentialKind: live.credentialKind },
      source: 'web',
    }),
  );
}

// ---------------------------------------------------------------------------------------------------------------
// flush
// ---------------------------------------------------------------------------------------------------------------

/** Drain the buffer and await any flush in flight. For tests (and a graceful shutdown). */
export async function flushSecurityEvents(): Promise<void> {
  for (;;) {
    if (running) {
      await running;
    } else if (pending()) {
      await runFlush();
    } else {
      return;
    }
  }
}

function runFlush(): Promise<void> {
  if (running) return running;
  running = flushOnce().finally(() => {
    running = null;
    if (pending()) schedule();
  });
  return running;
}

async function flushOnce(): Promise<void> {
  const takenDenials = [...denials.values()].sort((a, b) => a.firstAt - b.firstAt);
  const takenEvents = events;
  denials = new Map();
  events = [];
  if (dropped > 0) {
    logger.warn({ dropped }, 'security events were dropped: the outbox buffer is full');
    dropped = 0;
  }
  const orgs = new Set<string>([...takenDenials.map((d) => d.orgId), ...takenEvents.map((e) => e.orgId)]);
  for (const orgId of orgs) {
    try {
      let seen: string[] = [];
      await withOrgPrincipal(orgId, async (tx) => {
        let failed = 0;
        for (const ev of takenEvents) {
          if (ev.orgId !== orgId) continue;
          try {
            await tx.transaction((sp) => ev.write(sp)); // a savepoint: one bad event never poisons the rest
          } catch {
            failed++;
          }
        }
        const r = await writeDenials(tx, orgId, takenDenials.filter((d) => d.orgId === orgId));
        failed += r.failed;
        seen = r.seen;
        if (failed > 0) logger.error({ orgId, failed }, 'security events could not be recorded');
      });
      for (const k of seen) seenToday.add(k); // only once the transaction has committed
    } catch (err) {
      logger.error({ err, orgId }, 'security events could not be recorded');
    }
  }
}

/** A3: resolve each distinct raw store once; a non-uuid, unknown or other-org store is recorded as null / 'unknown'. */
async function writeDenials(tx: Tx, orgId: string, batch: readonly Denial[]): Promise<{ failed: number; seen: string[] }> {
  const storeOk = new Map<string, boolean>();
  for (const d of batch) {
    const s = d.rawStoreId;
    if (s === null || storeOk.has(s)) continue;
    let ok = false;
    if (UUID_SHAPE.test(s)) {
      try {
        ok = await tx.transaction((sp) => accessRepo.storeBelongsToOrg(sp, s, orgId));
      } catch {
        ok = false;
      }
    }
    storeOk.set(s, ok);
  }
  // Re-merge entries that collapse onto the same effective key (several bad stores all become "null / unknown").
  interface Merged {
    d: Denial;
    storeId: string | null;
    unknown: boolean;
    count: number;
    firstAt: number;
  }
  const merged = new Map<string, Merged>();
  for (const d of batch) {
    const valid = d.rawStoreId !== null && storeOk.get(d.rawStoreId) === true;
    const storeId = valid ? d.rawStoreId : null;
    const unknown = d.rawStoreId !== null && !valid;
    const key = `${d.actorPersonId}|${d.capability}|${storeId ?? ''}|${unknown}|${d.hour}`;
    const m = merged.get(key);
    if (m) {
      m.count += d.count;
      m.firstAt = Math.min(m.firstAt, d.firstAt);
    } else {
      merged.set(key, { d, storeId, unknown, count: d.count, firstAt: d.firstAt });
    }
  }
  let failed = 0;
  const seen: string[] = [];
  for (const m of [...merged.values()].sort((a, b) => a.firstAt - b.firstAt)) {
    const day = manilaDay(m.firstAt);
    if (day !== seenDay) {
      seenToday.clear();
      seenDay = day;
    }
    const seenKey = `${orgId}|${m.d.actorPersonId}|${m.d.capability}|${m.storeId ?? ''}|${m.unknown}|${day}`;
    const at = new Date(m.firstAt);
    try {
      await tx.transaction(async (sp) => {
        const { first } = await authzDenialCountsRepo.registerDenial(sp, {
          orgId,
          actorPersonId: m.d.actorPersonId,
          capability: m.d.capability,
          storeId: m.storeId,
          at,
          count: m.count,
          assumeSeen: seenToday.has(seenKey),
        });
        if (!first) return;
        await auditLogRepo.append(sp, orgId, {
          actorPersonId: m.d.actorPersonId,
          action: 'security.authorize_denied',
          storeId: null,
          entityId: m.d.actorPersonId,
          before: null,
          after: m.unknown
            ? { capability: m.d.capability, deniedAtStore: 'unknown' }
            : { capability: m.d.capability, deniedAtStoreId: m.storeId },
          source: 'web',
          occurredAt: at,
        });
      });
      seen.push(seenKey);
    } catch {
      failed++;
    }
  }
  return { failed, seen };
}
