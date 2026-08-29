/**
 * The Lane B ingestor: inbox events become punches, or become visible. T-161.
 * `docs/tasks/161-lane-b-ingestor.md`, bible §5.1 and §5.4.
 *
 * ⭐ **Transport-free.** It is handed events and never reads Firestore itself, which is what lets
 * the whole loop be tested without an emulator — and why `packages/sync-firestore` is the only
 * place `firebase-admin` appears.
 *
 * ## The pattern: idempotent consumer
 *
 * The event carries a client-generated key; the consumer writes behind a `UNIQUE` constraint; a
 * replay is a silent no-op. Bible §4.2 rule 10 states it directly — *"This replaces debounce/
 * throttle guesswork"* — and T-156 already built the target: `recordPunch` returns
 * `alreadyProcessed: true` as a **success**, because an ingestor that errors on a re-delivery
 * retries forever.
 */
import { sql } from 'drizzle-orm';
import {
  attendanceConfigRepo,
  clockTerminalsRepo,
  employmentRepo,
  inboxQuarantineRepo,
  type Tx,
} from '@shareat/db';
import type { PunchIntent, PunchMethod, QuarantineReason } from '@shareat/db/schema';
import { PUNCH_INTENTS, PUNCH_METHODS } from '@shareat/db/schema';
import { recordPunch } from '../attendance/punches';
import { toShiftDay } from '../attendance/shift-day';

/** One document from `/inbox`, exactly as it arrived. */
export interface InboxEvent {
  clientPunchId: string;
  occurredAt: number;
  deviceId: string;
  storeId: string;
  employmentId: string;
  method: string;
  assertedIntent: string;
  [key: string]: unknown;
}

export interface IngestReport {
  seen: number;
  ingested: number;
  alreadyProcessed: number;
  quarantined: number;
  /** ⭐ Events that were stuck and are now through, with no human action. */
  healed: number;
  /**
   * ⛔ Re-deliveries of an event a manager already DISCARDED. Counted rather than silently skipped,
   * because a device stuck in a redelivery loop on a discarded event is itself worth seeing.
   */
  refusedDiscarded: number;
  byReason: Partial<Record<QuarantineReason, number>>;
  /** `clientPunchId` -> the punch it became, for the transport to stamp back. */
  processed: Record<string, string>;
}

/** Ordinary device clock skew; beyond it the device is broken, not imprecise. Matches T-156. */
const FUTURE_TOLERANCE_MS = 5 * 60_000;

/**
 * Ingest a batch. Every event is attempted; **one bad event never stops the batch**, because a
 * single malformed document from one tablet must not hold up a whole store's day.
 *
 * ⭐ That promise is kept by a **savepoint per event**, not by the `try` alone — see the comment in
 * the loop for the failure that proved the difference.
 */
export async function ingestEvents(
  tx: Tx,
  events: readonly unknown[],
): Promise<IngestReport> {
  const report: IngestReport = {
    seen: events.length,
    ingested: 0,
    alreadyProcessed: 0,
    quarantined: 0,
    healed: 0,
    refusedDiscarded: 0,
    byReason: {},
    processed: {},
  };

  for (const raw of events) {
    // ⭐ ONE SAVEPOINT PER EVENT — `tx.transaction()` is a nested transaction, which on Postgres is
    // a savepoint. It is what makes the promise above true.
    //
    // ⚠️ Found by T-162, in code T-161 shipped. The catch below contained a LOGIC error fine — a
    // bad method, an unknown terminal — because those are decided in TypeScript before any statement
    // runs. A DATABASE error is different: Postgres aborts the whole transaction on the first
    // failing statement, so the quarantine INSERT in the catch could not run either, and
    // `ingestEvents` THREW instead of quarantining. One tablet sending `employmentId: "y"` would
    // have taken a whole store's day of punches down with it — exactly the failure this ingestor
    // exists to prevent, hiding inside the code meant to prevent it.
    try {
      const outcome = await tx.transaction((inner) => ingestOne(inner as Tx, raw));
      if (outcome.kind === 'ingested') {
        report.ingested++;
        report.processed[outcome.clientPunchId] = outcome.punchId;
        if (outcome.healed) report.healed++;
      } else if (outcome.kind === 'already') {
        report.alreadyProcessed++;
        report.processed[outcome.clientPunchId] = outcome.punchId;
      } else if (outcome.kind === 'discarded') {
        report.refusedDiscarded++;
      } else {
        report.quarantined++;
        report.byReason[outcome.reason] = (report.byReason[outcome.reason] ?? 0) + 1;
      }
    } catch (error) {
      // ⛔ Even an unexpected failure is quarantined rather than lost. §5.4 rule 5.
      // The savepoint has already rolled back by the time we get here, so the OUTER transaction is
      // usable again and the write below actually happens — which is the whole point. Without it
      // this insert is itself refused with "current transaction is aborted", and the evidence is
      // lost along with the rest of the batch.
      const event = raw as Partial<InboxEvent>;
      await quarantine(tx, {
        raw,
        clientPunchId: String(event?.clientPunchId ?? `unparseable-${Date.now()}-${Math.random()}`),
        reason: 'internal_error',
        detail: String(error).slice(0, 500),
      });
      report.quarantined++;
      report.byReason.internal_error = (report.byReason.internal_error ?? 0) + 1;
    }
  }

  return report;
}

type Outcome =
  | { kind: 'ingested'; clientPunchId: string; punchId: string; healed: boolean }
  | { kind: 'already'; clientPunchId: string; punchId: string }
  | { kind: 'discarded'; clientPunchId: string }
  | { kind: 'quarantined'; reason: QuarantineReason };

async function ingestOne(tx: Tx, raw: unknown): Promise<Outcome> {
  // ---- 1. Shape ---------------------------------------------------------------------
  const event = raw as Partial<InboxEvent>;
  const clientPunchId = typeof event?.clientPunchId === 'string' ? event.clientPunchId.trim() : '';
  if (!clientPunchId) {
    // Without the idempotency key there is nothing to key a quarantine row on either, so a
    // synthetic one is minted. ⚠️ It cannot heal — nothing will ever re-deliver under that id —
    // which is exactly why the key is required by the security rules before the write happens.
    await quarantine(tx, {
      raw,
      clientPunchId: `no-key-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      reason: 'malformed',
      detail: 'The event carries no clientPunchId, so it has no identity and cannot be deduplicated.',
    });
    return { kind: 'quarantined', reason: 'malformed' };
  }

  // ⛔ T-162 invariant 4. A manager already looked at this event, discarded it, and gave a reason.
  // Another delivery of the same key must not quietly resurrect it as a punch — the decision to
  // lose a shift is a human one, and re-running the checks after it would overturn that decision
  // on nobody's authority.
  const discarded = await inboxQuarantineRepo.findDiscarded(tx, clientPunchId);
  if (discarded) return { kind: 'discarded', clientPunchId };

  const missing = shapeErrors(event);
  if (missing) {
    return quarantineAnd(tx, raw, clientPunchId, 'malformed', missing);
  }

  const occurredAt = new Date(event.occurredAt as number);
  if (occurredAt.getTime() > Date.now() + FUTURE_TOLERANCE_MS) {
    return quarantineAnd(
      tx, raw, clientPunchId, 'future_timestamp',
      `Punched at ${occurredAt.toISOString()}, which is more than five minutes ahead of this server. ` +
        'The device clock is wrong.',
    );
  }

  // ---- 2. The terminal --------------------------------------------------------------
  const terminal = await clockTerminalsRepo.getTerminal(tx, String(event.deviceId));
  if (!terminal) {
    return quarantineAnd(tx, raw, clientPunchId, 'unknown_device',
      `No clock terminal ${event.deviceId}. It was never provisioned, or belongs to another org.`);
  }
  if (terminal.revokedAt) {
    return quarantineAnd(tx, raw, clientPunchId, 'revoked_device',
      `Terminal "${terminal.label}" was revoked on ${terminal.revokedAt.toISOString().slice(0, 10)} ` +
        `(${terminal.revokeReason}).`, terminal.storeId, terminal.id);
  }
  if (terminal.storeId !== event.storeId) {
    return quarantineAnd(tx, raw, clientPunchId, 'store_mismatch',
      `Terminal "${terminal.label}" belongs to another store than the one this event claims.`,
      terminal.storeId, terminal.id);
  }

  // ---- 3. The employment ------------------------------------------------------------
  //
  // ⚠️ This is the server-side re-verification landmine #22 asks for — v1 authorises a punch by
  // possession of a `matchToken` alone and never re-checks. It is not yet the FULL check: matching
  // a credential (card id, fingerprint token) to a person server-side needs credentials to exist,
  // and enrolment is T-164. What is verified here is that the employment the terminal resolved is
  // real, open, and at this store.
  const employment = await employmentRepo.getEmployment(tx, String(event.employmentId));
  if (!employment || employment.endedOn !== null) {
    return quarantineAnd(tx, raw, clientPunchId, 'unknown_credential',
      `No open employment ${event.employmentId} at this store. The staffer may not be enrolled yet, ` +
        'or may have left.', terminal.storeId, terminal.id);
  }
  if (employment.storeId !== terminal.storeId) {
    return quarantineAnd(tx, raw, clientPunchId, 'store_mismatch',
      'The employment this event names belongs to a different store than the terminal.',
      terminal.storeId, terminal.id);
  }

  // ---- 4. The kill switch, read from the config IN FORCE ON THE PUNCH'S OWN DAY -------
  //
  // ⭐ Re-checked on EVERY event, replays included. v1's `assertMethodEnabled` carries the scar:
  // the check "was previously skippable by supplying atMs", so a backdated replay could use a
  // method an admin had disabled.
  const shiftDay = toShiftDay(occurredAt);
  const config = await attendanceConfigRepo.findForDay(tx, terminal.storeId, shiftDay);
  if (!config) {
    return quarantineAnd(tx, raw, clientPunchId, 'internal_error',
      `No attendance config governed ${shiftDay} at this store, so no punch can be judged against it.`,
      terminal.storeId, terminal.id);
  }
  const method = event.method as PunchMethod;
  if (!methodEnabled(method, config)) {
    return quarantineAnd(tx, raw, clientPunchId, 'method_disabled',
      `"${method}" clock-in was switched off for this store on ${shiftDay}.`,
      terminal.storeId, terminal.id);
  }

  // ---- 5. Record ---------------------------------------------------------------------
  const { punch, alreadyProcessed } = await recordPunch(tx, {
    clientPunchId,
    employmentId: employment.id,
    occurredAt,
    method,
    assertedIntent: event.assertedIntent as PunchIntent,
    source: 'offline_replay',
    deviceId: terminal.id,
  });

  await clockTerminalsRepo.touchLastSeen(tx, terminal.id, new Date());

  // ⭐ If this event was previously stuck, it just healed — with no human action. That is the
  // difference between a quarantine and a dead letter.
  const healed = await inboxQuarantineRepo.resolveIngested(tx, clientPunchId);

  return alreadyProcessed
    ? { kind: 'already', clientPunchId, punchId: punch.id }
    : { kind: 'ingested', clientPunchId, punchId: punch.id, healed };
}

function shapeErrors(event: Partial<InboxEvent>): string | null {
  const problems: string[] = [];
  if (typeof event.occurredAt !== 'number' || !Number.isFinite(event.occurredAt)) {
    problems.push('occurredAt is not a timestamp');
  }
  if (typeof event.deviceId !== 'string' || !event.deviceId) problems.push('deviceId is missing');
  if (typeof event.storeId !== 'string' || !event.storeId) problems.push('storeId is missing');
  if (typeof event.employmentId !== 'string' || !event.employmentId) {
    problems.push('employmentId is missing');
  }
  if (!PUNCH_METHODS.includes(event.method as PunchMethod)) {
    problems.push(`method "${String(event.method)}" is not one of ${PUNCH_METHODS.join(', ')}`);
  }
  if (!PUNCH_INTENTS.includes(event.assertedIntent as PunchIntent)) {
    problems.push(`assertedIntent "${String(event.assertedIntent)}" is not recognised`);
  }
  return problems.length ? problems.join('; ') : null;
}

function methodEnabled(method: PunchMethod, config: { credentialNfc: boolean; credentialFingerprint: boolean; credentialFace: boolean }): boolean {
  // ⭐ `manual` is a back-office entry by a manager, not a terminal credential, and has no switch.
  if (method === 'manual') return true;
  if (method === 'fingerprint') return config.credentialFingerprint;
  if (method === 'face') return config.credentialFace;
  // `nfc` and `qr` are both the CARD, which is one operational thing with one switch.
  return config.credentialNfc;
}

async function quarantineAnd(
  tx: Tx,
  raw: unknown,
  clientPunchId: string,
  reason: QuarantineReason,
  detail: string,
  storeId?: string,
  deviceId?: string,
): Promise<Outcome> {
  await quarantine(tx, { raw, clientPunchId, reason, detail, storeId, deviceId });
  return { kind: 'quarantined', reason };
}

/**
 * Insert, or bump an existing row. ⭐ Keyed on `clientPunchId`, so a device that keeps re-sending a
 * doomed event produces ONE row with a rising `attempts` rather than a growing pile — and the same
 * key is what lets it heal later.
 */
async function quarantine(
  tx: Tx,
  input: {
    raw: unknown;
    clientPunchId: string;
    reason: QuarantineReason;
    detail: string;
    storeId?: string;
    deviceId?: string;
  },
): Promise<void> {
  await inboxQuarantineRepo.upsertQuarantine(tx, {
    orgId: await currentOrg(tx),
    storeId: input.storeId ?? null,
    clientPunchId: input.clientPunchId,
    deviceId: input.deviceId ?? null,
    rawEvent: input.raw,
    reasonCode: input.reason,
    reasonDetail: input.detail,
  });
}

async function currentOrg(tx: Tx): Promise<string> {
  const r = (await tx.execute(sql`select app_current_org() as org`)) as unknown as { org: string }[];
  return String(r[0]!.org);
}
