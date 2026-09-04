/**
 * The Lane B ingestor: inbox events become punches, or become visible. T-182.
 * `docs/tasks/182-lane-b-ingestor.md`, bible §5.1 and §5.4.
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
  attendanceCredentialsRepo,
  clockTerminalsRepo,
  employmentRepo,
  inboxQuarantineRepo,
  type Tx,
} from '@shareat/db';
import type {
  CredentialKind,
  PunchIntent,
  PunchMethod,
  QuarantineReason,
} from '@shareat/db/schema';
import { CREDENTIAL_KINDS, PUNCH_INTENTS, PUNCH_METHODS } from '@shareat/db/schema';

/**
 * Which credential each method implies.
 *
 * ⛔ `face` and `manual` map to **nothing**, on purpose. A face template is never mirrored
 * (bible §5.3), so no device can have matched one locally; and a manual entry is a back-office act
 * with a named human behind it (T-156), not something a terminal files. Neither belongs in the
 * inbox, and the shape check refuses both.
 */
const METHOD_CREDENTIAL: Record<PunchMethod, CredentialKind | null> = {
  nfc: 'card',
  qr: 'card',
  fingerprint: 'fingerprint',
  face: null,
  manual: null,
};
import { recordPunch } from '../attendance/punches';
import { toShiftDay } from '../attendance/shift-day';
import { adjudicateDay } from '../attendance/adjudicate';

/**
 * What a Lane B transport must do. T-204/DEF-132 — this is the missing half T-182's own Contract
 * §2 already named ("packages/sync-firestore — reads /inbox, stamps processedAt, deletes
 * nothing") and never built. Same shape as `MirrorDriver` in `./publisher.ts`: faked in tests,
 * real in `packages/sync-firestore`.
 */
export interface InboxDriver {
  /** Unprocessed /inbox docs, capped at `limit`. No ordering guarantee. */
  readUnprocessed(input: { limit: number }): Promise<{ docId: string; data: unknown }[]>;
  /** Stamp processedAt (+ the punch id, when there is one) on one document. Never deletes. */
  markProcessed(input: { docId: string; punchId: string | null }): Promise<void>;
}

/**
 * One document from `/inbox`, exactly as it arrived.
 *
 * ⭐⭐ **T-185 removed `employmentId` from this shape, and that removal is the point of T-185.**
 *
 * Landmine #22, from discovery 05's known gaps about v1: *"punches are authorized by possession of
 * `matchToken` alone — neither `clockByFingerprintAction` nor `clockByFaceAction` re-runs a
 * biometric match server-side; a leaked token … can punch indefinitely until the token is
 * rotated."* T-182 shipped the shape of the fix and said so in its own comment, but it still took
 * the CONCLUSION from the device: the terminal said who punched, and the server only checked that
 * the person named was real, open and at this store.
 *
 * Now the device reports what it **scanned**, and the server decides whose it is. A tablet can no
 * longer name a colleague.
 */
export interface InboxEvent {
  clientPunchId: string;
  occurredAt: number;
  deviceId: string;
  storeId: string;
  /** `card` or `fingerprint` — the two a device can match locally. */
  credentialKind: string;
  /** The card id scanned, or the match token the reader resolved. Never a person. */
  credentialRef: string;
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
  /**
   * T-204/DEF-134 — a genuinely NEW punch (never a replay) recomputes the `attendance_days` row
   * for the day it lands in. This is the count of times that recompute actually ran.
   */
  adjudicated: number;
  /**
   * The recompute FAILED — most commonly because the day is already frozen by a paid pay run.
   * ⛔ The punch itself is still safely recorded either way; a failed recompute is counted here,
   * never thrown, never silently dropped (bible §15.6).
   */
  adjudicationFailed: number;
  adjudicationFailures: { clientPunchId: string; detail: string }[];
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
    adjudicated: 0,
    adjudicationFailed: 0,
    adjudicationFailures: [],
  };

  for (const raw of events) {
    // ⭐ ONE SAVEPOINT PER EVENT — `tx.transaction()` is a nested transaction, which on Postgres is
    // a savepoint. It is what makes the promise above true.
    //
    // ⚠️ Found by T-183, in code T-182 shipped. The catch below contained a LOGIC error fine — a
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
        if (outcome.adjudicated) report.adjudicated++;
        if (outcome.adjudicationFailure) {
          report.adjudicationFailed++;
          report.adjudicationFailures.push({
            clientPunchId: outcome.clientPunchId,
            detail: outcome.adjudicationFailure,
          });
        }
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
  | {
      kind: 'ingested';
      clientPunchId: string;
      punchId: string;
      healed: boolean;
      /** T-204/DEF-134 — see `IngestReport.adjudicated`. */
      adjudicated: boolean;
      /** Set only when the recompute failed. See `IngestReport.adjudicationFailed`. */
      adjudicationFailure: string | null;
    }
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

  // ⛔ T-183 invariant 4. A manager already looked at this event, discarded it, and gave a reason.
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

  // ---- 3. The credential, resolved SERVER-SIDE ----------------------------------------
  //
  // ⭐⭐ This is what closes landmine #22. The device says what it scanned; the server says whose
  // it is.
  //
  // ⚠️ Resolved as of the punch's OWN timestamp, not as of now. A punch made at 14:00 on a card
  // revoked at 15:00 is valid — a real person with a live badge, before the revocation existed. It
  // is the same rule the kill switch below already follows (the config in force on the punch's own
  // shift day), so this module keeps one principle instead of two.
  //
  // ⛔ The converse is the half that matters: a badge revoked at 15:00 cannot punch at 15:01, even
  // from a terminal that has been offline for a week and still holds it in its mirror.
  const credential = await attendanceCredentialsRepo.resolveCredentialAt(tx, {
    storeId: terminal.storeId,
    kind: event.credentialKind as CredentialKind,
    ref: String(event.credentialRef),
    at: occurredAt,
  });
  if (!credential) {
    return quarantineAnd(tx, raw, clientPunchId, 'unknown_credential',
      `No ${event.credentialKind} credential at this store was live at ${occurredAt.toISOString()}. ` +
        'It may not be enrolled yet, or it may have been revoked before the punch was made.',
      terminal.storeId, terminal.id);
  }

  const employment = await employmentRepo.getEmployment(tx, credential.employmentId);
  if (!employment || employment.endedOn !== null) {
    return quarantineAnd(tx, raw, clientPunchId, 'unknown_credential',
      'That credential resolves to an employment that has ended. The badge outlived the job — ' +
        'revoke it.', terminal.storeId, terminal.id);
  }
  if (employment.storeId !== terminal.storeId) {
    return quarantineAnd(tx, raw, clientPunchId, 'store_mismatch',
      'The credential this event names belongs to an employment at a different store.',
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

  // ⭐⭐ T-204/DEF-134: this is the ONLY place in the running system that computes an
  // `attendance_days` row for a day nobody has touched before — the ingestor is where a punch
  // first lands, so it is also where the day it belongs to should first get computed.
  //
  // ⛔ Gated on `!alreadyProcessed` — a REPLAY must not re-adjudicate. The day was already
  // computed when the punch first arrived, and `adjudicateDay` refuses to recompute a FROZEN day
  // (one already locked into a pay run). A redelivered old punch must never throw on a day
  // payroll has already closed — it must just quietly do nothing more, exactly like the rest of
  // this function's replay handling.
  let adjudicated = false;
  let adjudicationFailure: string | null = null;
  if (!alreadyProcessed) {
    try {
      // ⭐ ANOTHER SAVEPOINT — same reasoning as the outer loop's own comment in `ingestEvents`:
      // `adjudicateDay` touches the database, and a thrown error already aborts the enclosing
      // transaction on Postgres. Without this nested savepoint, a frozen-day refusal here would
      // abort the SAME transaction `recordPunch` just committed within, discarding the punch that
      // was correctly recorded a moment ago. The punch write must survive even when the recompute
      // doesn't — `tx.transaction()` is a SAVEPOINT (as it already is one level up), so the outer
      // transaction stays usable after this one rolls back.
      await tx.transaction((inner) =>
        adjudicateDay(inner as Tx, { employmentId: employment.id, shiftDay }),
      );
      adjudicated = true;
    } catch (error) {
      // Not fatal to the punch — it is already safely recorded. Counted, not thrown, not
      // silently dropped either (bible §15.6).
      adjudicationFailure = String(error).slice(0, 300);
    }
  }

  return alreadyProcessed
    ? { kind: 'already', clientPunchId, punchId: punch.id }
    : { kind: 'ingested', clientPunchId, punchId: punch.id, healed, adjudicated, adjudicationFailure };
}

function shapeErrors(event: Partial<InboxEvent>): string | null {
  const problems: string[] = [];
  if (typeof event.occurredAt !== 'number' || !Number.isFinite(event.occurredAt)) {
    problems.push('occurredAt is not a timestamp');
  }
  if (typeof event.deviceId !== 'string' || !event.deviceId) problems.push('deviceId is missing');
  if (typeof event.storeId !== 'string' || !event.storeId) problems.push('storeId is missing');
  if (!CREDENTIAL_KINDS.includes(event.credentialKind as CredentialKind)) {
    problems.push(
      `credentialKind "${String(event.credentialKind)}" is not one of ${CREDENTIAL_KINDS.join(', ')}`,
    );
  }
  if (typeof event.credentialRef !== 'string' || !event.credentialRef) {
    problems.push('credentialRef is missing — the event says nothing was scanned');
  }
  if (!PUNCH_METHODS.includes(event.method as PunchMethod)) {
    problems.push(`method "${String(event.method)}" is not one of ${PUNCH_METHODS.join(', ')}`);
  } else if (METHOD_CREDENTIAL[event.method as PunchMethod] !== event.credentialKind) {
    // ⛔ A device cannot file a `manual` entry — that is a back-office act with a named human
    // behind it (T-156) — and it cannot file a `face` punch either, because face templates are
    // never mirrored (bible §5.3), so no device can have matched one locally. Both map to null
    // above and are refused here rather than silently accepted with a credential they cannot have.
    problems.push(
      `method "${String(event.method)}" cannot carry a ${String(event.credentialKind)} credential`,
    );
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
