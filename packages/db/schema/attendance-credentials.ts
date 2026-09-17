/**
 * attendance_credentials — what a terminal scans, and who it belongs to. T-185.
 * `docs/tasks/185-credential-enrolment-and-mirror.md`, bible §5.3 and §13 row 164.
 *
 * ## ⛔ Why this is a NEW table rather than a `person_credentials.kind`
 *
 * `person_credentials` invites exactly that, and this task declines the invitation:
 *
 * > *"⭐ The extension point. `pin` and `firebase` are live; `biometric` is declared now so that
 * > adding it in Phase 4 is a row and a service, not a schema change and a rewrite."*
 *
 * **The reason is the mirror.** A publisher that read `person_credentials` to build the credential
 * mirror would be one wrong `where` clause away from mirroring a **PIN verifier** to every terminal
 * in the store. Keeping clock-in credentials in their own relation means the publisher *cannot
 * reach a sign-in secret* — structural rather than careful, which is what bible §12 asks for.
 *
 * The bible already draws the line in prose (§13 row 165): *"signing in to the app and clocking in
 * are different acts, and only the second is closed."* Two acts, two tables, two revocation paths.
 */
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { employments } from './employment';
import { organizations } from './organizations';
import { persons } from './persons';
import { stores } from './stores';

/**
 * ⛔ **`face` IS NOT HERE, AND ITS ABSENCE IS THE POINT.**
 *
 * Bible §5.3, after the 2026-07-04 exfiltration finding: face templates are *"never mirrored, never
 * cached, never bundled."* Everything in this table is published to the credential mirror, so a
 * face row would be a face template on a tablet by construction.
 *
 * ⭐ Because the CHECK below permits only these two, the publisher **cannot leak a face template
 * even if a future change tries to** — there is no row it could read. That is the difference
 * between "we remembered not to" and "it cannot be expressed", and it is the same reasoning that
 * made the PIN unrepresentable in `attendance_punches.method` (§13 row 165).
 */
export const CREDENTIAL_KINDS = ['card', 'fingerprint'] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

/**
 * T-321/DEF-363 Contract 6 — the ONE place this name is written. Both `enrolCard`'s catch and
 * `enrolFingerprint`'s new one import this rather than typing the literal, because a hand-typed
 * copy that drifts from what the migration actually created fails OPEN: the catch stops matching
 * and a raw Postgres violation escapes the domain again (the exact DEF-362 shape).
 */
export const ATTENDANCE_CREDENTIALS_SCAN_VALUE_LIVE_UNIQUE =
  'attendance_credentials_scan_value_live_unique';

export const attendanceCredentials = pgTable(
  'attendance_credentials',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** Denormalised from the employment so the mirror publisher and the RLS policy need no join. */
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),

    /**
     * ⭐ Per **EMPLOYMENT**, not per person. Somebody who works two stores carries two badges, and
     * revoking the Lipa one must not silently kill the Malvar one — they are different jobs that
     * happen to belong to the same human.
     */
    employmentId: uuid('employment_id')
      .notNull()
      .references(() => employments.id, { onDelete: 'restrict' }),

    kind: text('kind', { enum: CREDENTIAL_KINDS }).notNull(),

    /**
     * The badge value the terminal scans — v1's `assignId` / `nfcCardId`, which its NFC plugin
     * writes to the tag and its QR badge encodes.
     *
     * ⚠️ Stored and mirrored **as-is, not hashed**, and that is a considered choice rather than an
     * oversight. The terminal must match a scan against this while offline, so any transformation
     * it cannot itself compute would defeat the purpose; a hash the device can compute is not a
     * hash. The bearer risk is real, named in §13 row 164, and accepted — the mitigation is the
     * terminal-only mirror path, not obfuscation.
     */
    cardId: text('card_id'),

    /**
     * 32 hex characters. ⭐ **Rotated on every re-enrolment**, carried over from v1's own M5 fix —
     * so a template captured from a device stops resolving the moment the finger is re-enrolled.
     */
    matchToken: text('match_token'),

    /** 1–2 base64 ZKFinger templates, ~2.7 KB each. `fingerprint` only. */
    templates: text('templates').array(),

    /** ⭐ Attributed. A credential that authorises pay names who created it. */
    enrolledBy: uuid('enrolled_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    enrolledAt: timestamp('enrolled_at', { withTimezone: true }).notNull().defaultNow(),

    /** ⛔ Revocation is a timestamp, never a delete — as `person_credentials` already does. */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by').references(() => persons.id, { onDelete: 'restrict' }),
    revokeReason: text('revoke_reason'),
  },
  (t) => [
    /**
     * ⭐ Two live cards with the same id makes *"who punched?"* unanswerable, and an ambiguous
     * credential check that picks the first match is how the wrong person gets paid.
     *
     * ⚠️ PARTIAL, on `revoked_at is null` — a **revoked** card id may be reissued, which is what
     * happens when a badge is lost and reprinted with the same number.
     *
     * ⚠️ T-321/DEF-363 — BOTH `attendance_credentials_card_live_unique` AND
     * `attendance_credentials_token_live_unique` below are pending replacement by ONE cross-column
     * index (`ATTENDANCE_CREDENTIALS_SCAN_VALUE_LIVE_UNIQUE` above) in a later migration (0153).
     * Left standing here deliberately for now: `packages/domain/src/attendance/credentials.ts`'s
     * `enrolCard`/`enrolFingerprint` catches already tolerate EITHER of these two names alongside
     * the new one, so the code is safe to ship BEFORE the schema change lands (expand/contract,
     * bible §15.5) — do not remove EITHER index until 0153 replaces both in the same pass as the
     * code that stops tolerating their names. Dropping just one early re-opens the fail-open on
     * that half exactly as dropping both would.
     */
    uniqueIndex('attendance_credentials_card_live_unique')
      .on(t.orgId, t.cardId)
      .where(sql`${t.revokedAt} is null and ${t.cardId} is not null`),
    uniqueIndex('attendance_credentials_token_live_unique')
      .on(t.orgId, t.matchToken)
      .where(sql`${t.revokedAt} is null and ${t.matchToken} is not null`),

    /** The ingestor's lookup: a scanned value, at a store, live. */
    index('attendance_credentials_lookup_idx').on(t.storeId, t.kind, t.revokedAt),
    index('attendance_credentials_employment_idx').on(t.employmentId),

    check('attendance_credentials_kind_check', sql`${t.kind} in ('card','fingerprint')`),

    /**
     * ⛔ Each kind's shape, enforced here rather than hoped for in a service — the same pattern
     * `person_credentials_shape_check` already uses.
     */
    check(
      'attendance_credentials_shape_check',
      sql`
        (${t.kind} = 'card' and ${t.cardId} is not null
           and ${t.matchToken} is null and ${t.templates} is null)
        or (${t.kind} = 'fingerprint' and ${t.matchToken} is not null
           and ${t.templates} is not null and array_length(${t.templates}, 1) between 1 and 2
           and ${t.cardId} is null)
      `,
    ),

    /** ⛔ A revocation with no human or no reason is not an audit trail. */
    check(
      'attendance_credentials_revoke_check',
      sql`(${t.revokedAt} is null and ${t.revokedBy} is null and ${t.revokeReason} is null)
          or (${t.revokedAt} is not null and ${t.revokedBy} is not null and ${t.revokeReason} is not null)`,
    ),
  ],
);
