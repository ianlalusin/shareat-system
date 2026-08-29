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
import { randomBytes } from 'node:crypto';
import { authorize, type Actor } from '@shareat/auth';
import {
  attendanceCredentialsRepo,
  employmentRepo,
  type AttendanceCredentialRow,
  type Tx,
} from '@shareat/db';
import type { CredentialKind } from '@shareat/db/schema';

export class CredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialError';
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
  const employment = await requireOpenEmployment(tx, input.employmentId);
  await authorize(tx, actor, 'manage_attendance', { storeId: employment.storeId });

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
    // ⭐ The partial unique index is the real guard; this turns its message into a sentence. Two
    // live cards with one id makes "who punched?" unanswerable, and a check that picks the first
    // match is how the wrong person gets paid.
    if (String(error).includes('attendance_credentials_card_live_unique')) {
      throw new CredentialError(
        'That card is already enrolled to somebody at this organisation. Revoke it there first — ' +
          'a card id belongs to one person at a time.',
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
  const employment = await requireOpenEmployment(tx, input.employmentId);
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

  return attendanceCredentialsRepo.insertCredential(tx, {
    orgId: employment.orgId,
    storeId: employment.storeId,
    employmentId: employment.id,
    kind: 'fingerprint',
    matchToken: newMatchToken(),
    templates,
    enrolledBy: actor.personId,
  });
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
      `That credential was already revoked on ${row.revokedAt.toISOString().slice(0, 10)}.`,
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
  options: { allowEnded?: boolean } = {},
) {
  const employment = await employmentRepo.getEmployment(tx, employmentId);
  if (!employment) throw new CredentialError(`No employment ${employmentId}.`);
  if (!options.allowEnded && employment.endedOn !== null) {
    throw new CredentialError(
      'That employment has ended. Enrolling a badge for somebody who has left is exactly the ' +
        'credential that punches unnoticed.',
    );
  }
  return employment;
}
