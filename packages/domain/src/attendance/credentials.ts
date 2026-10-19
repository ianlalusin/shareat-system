/**
 * Enrolling and revoking what a terminal scans. T-185.
 * `docs/tasks/185-credential-enrolment-and-mirror.md`, bible §5.3 and §13 row 164.
 *
 * ## What this module is for
 *
 * D1 (§13 row 165) settled the credential set: **fingerprint, face and card, never a PIN.** Of the
 * three, only the **card** works offline in a plain browser — face is online-only permanently after
 * the 2026-07-04 exfiltration finding, and fingerprint needs the native reader in the APK that D2
 * parked. Phase 4's exit gate is *"a terminal clocks in with the network pulled"*, so the card is
 * the credential that meets it, and this is where one comes from.
 *
 * ## ⛔ Enrolment ACCEPTS a template. Nothing ever returns one.
 *
 * Discovery 05 on v1's widest credential hole:
 *
 * > *"`listFingerprintTemplatesAction` is gated only to `requireStoreMember` (**any** authenticated
 * > store member, not manager/admin) and returns every enrolled staffer's raw template +
 * > matchToken — an explicitly-flagged interim gap … the read is now **audited** but not yet
 * > blocked."*
 *
 * ⭐ In v2 that hole is closed by **not building the endpoint**. The credential mirror is the only
 * consumer of a template, it is terminal-only, and no function here returns one. `listCredentials`
 * returns metadata a manager needs — which fingers are enrolled, when, by whom — and never the
 * secret itself.
 */
import { toBusinessDate } from '@shareat/core/datetime';
import { humanDate } from '../shared/refusal';
import { assertFieldRules } from '../shared/field-rules-assert';
import { STAFF_CARD_RULES } from '../field-rules/staff';
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { authorize, type Actor } from '@shareat/auth';
import {
  attendanceCredentialsRepo,
  employmentRepo,
  prerequisiteRefusalsRepo,
  withOrgPrincipal,
  type AttendanceCredentialRow,
  type Tx,
} from '@shareat/db';
import type { CredentialKind } from '@shareat/db/schema';
import { logger } from '@shareat/core/logger';
import { isScanValueCollision } from './scan-value-collision';

export class CredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialError';
  }
}

/**
 * T-245 — records a prerequisite-shaped refusal on an INDEPENDENT transaction, never the
 * throwing caller's own `tx`. docs/tasks/245-prerequisite-refusal-counter.md §3.
 *
 * ⛔ **Why not just `prerequisiteRefusalsRepo.record(tx, …)` on the caller's `tx`:** proved wrong
 * empirically, not merely reasoned about. The caller's transaction is about to abort on the
 * `throw` right after this call — Drizzle rolls the whole transaction back, taking a same-tx
 * INSERT with it (silent data loss). Worse, at a site where the refusal was DETECTED by a failed
 * SQL statement (a unique-constraint violation, as at `enrolCard`'s catch block below), the tx is
 * already in Postgres's own aborted state by the time this runs — a same-tx write there doesn't
 * even get a chance to execute; postgres.js rejects it with the ORIGINAL failing statement's error
 * instead, which silently replaces the domain's `CredentialError` with a raw `PostgresError` at
 * the caller. Both failure modes were reproduced against this exact call site before this fix.
 *
 * `withOrgPrincipal` opens that independent transaction on a fresh pooled connection — the
 * existing, single blessed way an application or a job opens one under an org's principal
 * (`packages/db/src/rls/principal.ts`), already used the same way from
 * `packages/domain/src/scheduler/index.ts`. Its cost, accepted deliberately: the row commits even
 * if the caller's transaction later aborts for a reason unrelated to this refusal — correct here,
 * because a refusal is a real event a person hit, independent of what happens afterward.
 *
 * Recording must never become a NEW way for the real refusal to fail or change shape — a failure
 * here is logged and swallowed (bible §15.6: never `catch {}`), never rethrown in place of the
 * `CredentialError` the caller is about to throw regardless.
 */
async function recordPrerequisiteRefusal(input: {
  orgId: string;
  storeId: string | null;
  reasonCode: string;
  actorPersonId: string | null;
}): Promise<void> {
  try {
    await withOrgPrincipal(input.orgId, async (freshTx) => {
      // ⚠️ Defence in depth against the FK-lock contention class the orchestrator flagged: the
      // caller's transaction may hold a lock (e.g. a FOR UPDATE via `allocateStaffCode`) that
      // conflicts with this INSERT's own FK-check lock on the same org/store/person row. Bounded
      // so a genuine conflict fails fast and gets logged rather than hanging the request
      // indefinitely — the caught error below still lets the real refusal throw regardless.
      await freshTx.execute(sql`set local lock_timeout = '2s'`);
      return prerequisiteRefusalsRepo.record(freshTx, { ...input, domain: 'attendance' });
    });
  } catch (err) {
    logger.error({ err, reasonCode: input.reasonCode }, 'failed to record prerequisite refusal');
  }
}

/** ⚠️ At most two fingers, matching v1's `MAX_FINGERS` and the ZK9500 enrolment flow. */
export const MAX_TEMPLATES = 2;

/**
 * What a manager may see about a credential. ⛔ **Note what is absent**: no `cardId`, no
 * `matchToken`, no `templates`. A screen needs to know a badge exists, not what is written on it.
 */
export interface CredentialSummary {
  id: string;
  employmentId: string;
  kind: CredentialKind;
  /** The last four characters of a card id, so a manager can tell two badges apart. */
  cardHint: string | null;
  fingerCount: number;
  enrolledAt: Date;
  enrolledBy: string;
}

export function summarise(row: AttendanceCredentialRow): CredentialSummary {
  return {
    id: row.id,
    employmentId: row.employmentId,
    kind: row.kind,
    // ⚠️ A hint, never the value. Enough to distinguish two badges on a screen; not enough to clone
    // one — which is the only reason a card id would otherwise need to be shown at all.
    cardHint: row.cardId ? `…${row.cardId.slice(-4)}` : null,
    fingerCount: row.templates?.length ?? 0,
    enrolledAt: row.enrolledAt,
    enrolledBy: row.enrolledBy,
  };
}

/**
 * Enrol a card against an employment.
 *
 * ⚠️ The card id is stored and mirrored **as-is, not hashed**, and that is considered rather than
 * lazy: the terminal must match a scan against it while offline, so any transformation the device
 * cannot itself compute would defeat the purpose — and one it *can* compute is not a hash. The
 * bearer risk is named in §13 row 164 and accepted; the mitigation is the terminal-only mirror
 * path, not obfuscation.
 */
export async function enrolCard(
  tx: Tx,
  actor: Actor,
  input: { employmentId: string; cardId: string },
): Promise<AttendanceCredentialRow> {
  const employment = await requireOpenEmployment(tx, input.employmentId, {
    actorPersonId: actor.personId,
  });
  await authorize(tx, actor, 'manage_attendance', { storeId: employment.storeId });
  // T-440 S9 (ii): the screen's own rules, only once the gate has passed.
  assertFieldRules(STAFF_CARD_RULES, { cardId: input.cardId });

  const cardId = input.cardId.trim();
  if (!cardId) throw new CredentialError('A card needs an id — that is the whole credential.');

  try {
    return await attendanceCredentialsRepo.insertCredential(tx, {
      orgId: employment.orgId,
      storeId: employment.storeId,
      employmentId: employment.id,
      kind: 'card',
      cardId,
      enrolledBy: actor.personId,
    });
  } catch (error) {
    // ⭐ The partial unique index is the real guard; this turns its message into a sentence.
    // ⛔⛔ T-321/DEF-363 Contract 5 — matches by CODE + constraint name (see `isScanValueCollision`),
    // never a hand-typed literal. After T-321's migration this value belongs to one person at a
    // time regardless of KIND: the other live credential holding it may now be a fingerprint, not
    // another card, so the message no longer assumes it is.
    if (isScanValueCollision(error)) {
      // T-245 — recorded on an INDEPENDENT transaction; see recordPrerequisiteRefusal's own
      // comment for why this cannot be `prerequisiteRefusalsRepo.record(tx, …)` on this same `tx`.
      await recordPrerequisiteRefusal({
        orgId: employment.orgId,
        storeId: employment.storeId,
        actorPersonId: actor.personId,
        reasonCode: 'attendance.credential.already_enrolled_elsewhere',
      });
      throw new CredentialError(
        'That value is already enrolled to somebody at this organisation, as a card or a ' +
          'fingerprint. Revoke it there first — a scanned value belongs to one person at a time.',
      );
    }
    throw error;
  }
}

/**
 * Enrol (or re-enrol) a fingerprint.
 *
 * ⭐ **Re-enrolling rotates the match token**, carried over from v1's own M5 fix — so a template
 * lifted from a device stops resolving the moment the finger is enrolled again. The old credential
 * is revoked rather than updated, because the token that authorised past punches has to stay
 * readable against them.
 */
export async function enrolFingerprint(
  tx: Tx,
  actor: Actor,
  input: { employmentId: string; templates: string[] },
): Promise<AttendanceCredentialRow> {
  const employment = await requireOpenEmployment(tx, input.employmentId, {
    actorPersonId: actor.personId,
  });
  await authorize(tx, actor, 'manage_attendance', { storeId: employment.storeId });

  const templates = input.templates.map((t) => t.trim()).filter(Boolean);
  if (templates.length === 0) {
    throw new CredentialError('A fingerprint enrolment needs at least one captured template.');
  }
  if (templates.length > MAX_TEMPLATES) {
    throw new CredentialError(
      `At most ${MAX_TEMPLATES} fingers per staffer — the reader's own enrolment flow captures two.`,
    );
  }

  // Retire any live fingerprint first, so the rotation is a fact rather than an intention.
  for (const existing of await attendanceCredentialsRepo.listLiveForEmployment(tx, employment.id)) {
    if (existing.kind === 'fingerprint') {
      await attendanceCredentialsRepo.revokeCredential(tx, {
        id: existing.id,
        at: new Date(),
        by: actor.personId,
        reason: 'Superseded by a re-enrolment — the match token rotates.',
      });
    }
  }

  try {
    return await attendanceCredentialsRepo.insertCredential(tx, {
      orgId: employment.orgId,
      storeId: employment.storeId,
      employmentId: employment.id,
      kind: 'fingerprint',
      matchToken: newMatchToken(),
      templates,
      enrolledBy: actor.personId,
    });
  } catch (error) {
    // ⛔⛔ T-321/DEF-362 Contract 4 — a raw Postgres violation must never escape the domain, same as
    // `enrolCard`'s own catch (Contract 5), matched the same way (`isScanValueCollision`). ⚠️ Not a
    // retry-until-unique: a minted token is 128 random bits, so THIS CATCH IS UNREACHABLE IN
    // PRACTICE — landing on a live card id is no likelier than landing on a live token by chance,
    // both are 2^-128, and neither is reachable deliberately (a token this function mints cannot be
    // predicted or chosen in advance by whoever enrolled the colliding card). It exists so the
    // practically-impossible case still cannot escape the domain as a raw constraint violation —
    // DEF-362's own framing — not because either branch is expected to fire.
    if (isScanValueCollision(error)) {
      // T-245 — recorded on an INDEPENDENT transaction; see recordPrerequisiteRefusal's own
      // comment for why this cannot be `prerequisiteRefusalsRepo.record(tx, …)` on this same `tx`.
      await recordPrerequisiteRefusal({
        orgId: employment.orgId,
        storeId: employment.storeId,
        actorPersonId: actor.personId,
        reasonCode: 'attendance.credential.already_enrolled_elsewhere',
      });
      throw new CredentialError(
        'That fingerprint minted a value already enrolled to somebody at this organisation, as a ' +
          'card or a fingerprint. Try enrolling again — a scanned value belongs to one person at a time.',
      );
    }
    throw error;
  }
}

/** 16 random bytes as 32 hex characters — v1's `generateFingerprintMatchToken`, kept verbatim. */
function newMatchToken(): string {
  return randomBytes(16).toString('hex');
}

/**
 * ⛔ Revoking is the operational half of the whole design.
 *
 * It needs a reason and a human, refused by the table's own constraint otherwise. The **timestamp**
 * is load-bearing rather than decorative: `resolveCredentialAt` compares a punch's own time against
 * it, so this is the moment after which the badge stops being able to clock anybody in — including
 * from a terminal that has been offline for a week and still holds it.
 */
export async function revokeCredential(
  tx: Tx,
  actor: Actor,
  input: { credentialId: string; reason: string },
): Promise<AttendanceCredentialRow> {
  const row = await attendanceCredentialsRepo.getCredential(tx, input.credentialId);
  if (!row) throw new CredentialError(`No credential ${input.credentialId}.`);
  await authorize(tx, actor, 'manage_attendance', { storeId: row.storeId, orgId: row.orgId });

  if (row.revokedAt) {
    throw new CredentialError(
      `That credential was already revoked on ${humanDate(toBusinessDate(row.revokedAt))}.`,
    );
  }

  const reason = input.reason.trim();
  if (!reason) {
    throw new CredentialError(
      'Revoking a credential needs a reason — a dead badge nobody can explain is not an audit trail.',
    );
  }

  const revoked = await attendanceCredentialsRepo.revokeCredential(tx, {
    id: row.id,
    at: new Date(),
    by: actor.personId,
    reason,
  });
  if (!revoked) throw new CredentialError('That credential was revoked by somebody else.');
  return revoked;
}

/** ⛔ Metadata only — see `CredentialSummary`. No secret leaves this module. */
export async function listCredentials(
  tx: Tx,
  actor: Actor,
  input: { employmentId: string },
): Promise<CredentialSummary[]> {
  const employment = await requireOpenEmployment(tx, input.employmentId, { allowEnded: true });
  await authorize(tx, actor, 'manage_attendance', { storeId: employment.storeId });
  const rows = await attendanceCredentialsRepo.listLiveForEmployment(tx, employment.id);
  return rows.map(summarise);
}

async function requireOpenEmployment(
  tx: Tx,
  employmentId: string,
  options: { allowEnded?: boolean; actorPersonId?: string } = {},
) {
  const employment = await employmentRepo.getEmployment(tx, employmentId);
  if (!employment) throw new CredentialError(`No employment ${employmentId}.`);
  if (!options.allowEnded && employment.endedOn !== null) {
    // T-245 — recorded on an INDEPENDENT transaction; see recordPrerequisiteRefusal.
    await recordPrerequisiteRefusal({
      orgId: employment.orgId,
      storeId: employment.storeId,
      actorPersonId: options.actorPersonId ?? null,
      reasonCode: 'attendance.credential.employment_ended',
    });
    throw new CredentialError(
      'That employment has ended. Enrolling a badge for somebody who has left is exactly the ' +
        'credential that punches unnoticed.',
    );
  }
  return employment;
}
