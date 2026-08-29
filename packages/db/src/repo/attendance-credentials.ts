/**
 * The only place SQL is written for attendance credentials. T-164.
 *
 * ⛔ **There is no `listTemplates`, and there never should be.** Discovery 05 flags v1's
 * `listFingerprintTemplatesAction` as its widest credential hole — gated to *any* authenticated
 * store member and returning every enrolled staffer's raw template and match token, audited rather
 * than blocked. In v2 the credential mirror is the only consumer and it is terminal-only, so the
 * read simply does not exist. A hole you cannot reach through an API nobody wrote.
 *
 * `getForMirror` below is the single exception and it is not a general read: it fetches ONE
 * credential by its own id, for the publisher, which is a system principal.
 */
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { attendanceCredentials, type CredentialKind } from '../../schema/attendance-credentials';

export interface AttendanceCredentialRow {
  id: string;
  orgId: string;
  storeId: string;
  employmentId: string;
  kind: CredentialKind;
  cardId: string | null;
  matchToken: string | null;
  templates: string[] | null;
  enrolledBy: string;
  enrolledAt: Date;
  revokedAt: Date | null;
  revokedBy: string | null;
  revokeReason: string | null;
}

export async function insertCredential(
  tx: Tx,
  input: {
    orgId: string;
    storeId: string;
    employmentId: string;
    kind: CredentialKind;
    cardId?: string | null;
    matchToken?: string | null;
    templates?: string[] | null;
    enrolledBy: string;
  },
): Promise<AttendanceCredentialRow> {
  const [row] = await tx
    .insert(attendanceCredentials)
    .values({
      orgId: input.orgId,
      storeId: input.storeId,
      employmentId: input.employmentId,
      kind: input.kind,
      cardId: input.cardId ?? null,
      matchToken: input.matchToken ?? null,
      templates: input.templates ?? null,
      enrolledBy: input.enrolledBy,
    })
    .returning();
  return row as AttendanceCredentialRow;
}

export async function getCredential(
  tx: Tx,
  id: string,
): Promise<AttendanceCredentialRow | undefined> {
  const [row] = await tx
    .select()
    .from(attendanceCredentials)
    .where(eq(attendanceCredentials.id, id))
    .limit(1);
  return row as AttendanceCredentialRow | undefined;
}

/**
 * ⭐⭐ The server-side resolution that closes landmine #22, and the whole point of T-164.
 *
 * v1 authorises a punch by **possession of a match token alone** — no server-side re-check — so a
 * leaked token punches indefinitely. Here the device reports what it *scanned*, and this query says
 * who that belongs to.
 *
 * ⚠️ **Judged as of `atMs`, not as of now.** A punch made at 14:00 on a card revoked at 15:00 is
 * valid: it was a real person with a live badge, and the revocation had not happened yet. That is
 * the same rule the method kill switch already follows (the config *in force on the punch's own
 * shift day*), so the module keeps one principle instead of two.
 *
 * ⛔ The converse is the half that matters: a badge revoked at 15:00 **cannot punch at 15:01**, even
 * from a terminal that has been offline for a week and still holds it in its mirror. The mirror
 * resolves a scan; the server decides whether that credential was alive at that moment.
 */
export async function resolveCredentialAt(
  tx: Tx,
  input: { storeId: string; kind: CredentialKind; ref: string; at: Date },
): Promise<AttendanceCredentialRow | undefined> {
  const column = input.kind === 'card' ? sql`card_id` : sql`match_token`;
  const rows = (await tx.execute(sql`
    select id, org_id as "orgId", store_id as "storeId", employment_id as "employmentId",
           kind, card_id as "cardId", match_token as "matchToken", templates,
           enrolled_by as "enrolledBy", enrolled_at as "enrolledAt",
           revoked_at as "revokedAt", revoked_by as "revokedBy", revoke_reason as "revokeReason"
    from attendance_credentials
    where store_id = ${input.storeId}::uuid
      and kind = ${input.kind}
      and ${column} = ${input.ref}
      and enrolled_at <= ${input.at.toISOString()}::timestamptz
      and (revoked_at is null or revoked_at > ${input.at.toISOString()}::timestamptz)
    limit 1`)) as unknown as AttendanceCredentialRow[];
  return rows[0];
}

/** Live credentials for one employment — what the enrolment screen shows, without the secrets. */
export async function listLiveForEmployment(
  tx: Tx,
  employmentId: string,
): Promise<AttendanceCredentialRow[]> {
  const rows = await tx
    .select()
    .from(attendanceCredentials)
    .where(
      and(
        eq(attendanceCredentials.employmentId, employmentId),
        isNull(attendanceCredentials.revokedAt),
      ),
    )
    .orderBy(asc(attendanceCredentials.enrolledAt));
  return rows as AttendanceCredentialRow[];
}

/**
 * ⛔ Never a delete. A credential that once existed is part of the audit trail for every punch it
 * authorised, and the constraint refuses a revocation missing either the human or the reason.
 *
 * ⚠️ `isNull(revokedAt)` in the WHERE is the double-submit guard: two managers revoking the same
 * badge produce one revocation, not a silent overwrite of the first one's reason and timestamp —
 * and the timestamp is load-bearing, because it is what `resolveCredentialAt` compares against.
 */
export async function revokeCredential(
  tx: Tx,
  input: { id: string; at: Date; by: string; reason: string },
): Promise<AttendanceCredentialRow | undefined> {
  const [row] = await tx
    .update(attendanceCredentials)
    .set({ revokedAt: input.at, revokedBy: input.by, revokeReason: input.reason })
    .where(
      and(eq(attendanceCredentials.id, input.id), isNull(attendanceCredentials.revokedAt)),
    )
    .returning();
  return row as AttendanceCredentialRow | undefined;
}

/** Every live credential at a store — the publisher's re-enqueue path, not an app read. */
export async function listLiveForStore(
  tx: Tx,
  storeId: string,
): Promise<AttendanceCredentialRow[]> {
  const rows = await tx
    .select()
    .from(attendanceCredentials)
    .where(
      and(eq(attendanceCredentials.storeId, storeId), isNull(attendanceCredentials.revokedAt)),
    );
  return rows as AttendanceCredentialRow[];
}
