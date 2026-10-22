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
  uuid,
  foreignKey,
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
    // NOTE: T-321/DEF-363 Contract 1 — `attendance_credentials_scan_value_live_unique`
    // (the name is `ATTENDANCE_CREDENTIALS_SCAN_VALUE_LIVE_UNIQUE` above; that export is the ONE
    // definition of it) is a unique index on `(org_id, coalesce(card_id, match_token))
    // where revoked_at is null`, hand-added in migration 0153. It REPLACED the two former
    // per-column partial unique indexes below (`attendance_credentials_card_live_unique` and
    // `attendance_credentials_token_live_unique`) — `attendance_credentials_shape_check` means a
    // live row only ever contributed to one of those two anyway, so any violation of either old
    // index is also a violation of this one; net index count went DOWN by one.
    // ⭐ WHY THIS MATTERS, carried forward from the index this replaces: two live rows sharing one
    // scanned value makes "who punched?" unanswerable, and an ambiguous credential check that
    // picks the first match is how the wrong person gets paid. That is true whether the two rows
    // share a column (the old indexes' job) or share only the scan value across columns (this
    // index's own reason to exist) — do not relax this later for convenience.
    // ⭐ WHY PARTIAL, on `revoked_at is null`, also carried forward: a revoked value must be
    // reissuable — a lost card gets reprinted with the same number, a fingerprint gets re-enrolled
    // onto the same rotated slot — and only a LIVE collision is what the hazard above describes. A full
    // (non-partial) unique index would refuse that reissue outright, which is not this index's job.
    // ⛔ The underlying `coalesce(card_id, match_token)` value is deliberately NOT declared as a
    // column here, even though Drizzle's `generatedAlwaysAs()` could express it. Doing so would
    // hand it to every caller of `insertCredential`/`listLiveForEmployment` — Drizzle only ever
    // emits the columns it declares (never `select *`/`returning *`), so a column absent from
    // this table can never appear in either query, by construction rather than by caller
    // discipline. `packages/domain/src/attendance/credentials.ts`'s `summarise()` exists
    // specifically to keep the card id and match token from travelling past enrolment; an
    // undeclared, un-typed generated column here would duplicate that same secret under a new
    // name that no existing projection knows to strip. If a future change adds this column back,
    // it must also audit every consumer of those two functions for exactly that.

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

    /**
     * ⛔ A revocation with no human, no reason, or a BLANK reason is not an audit trail.
     * T-339 slice 5 / DEF-236 (migration 0158) widened this from "not null" to "not null and not
     * blank" — same clause shape as sibling `person_credentials_revoke_check` (0138). The explicit
     * `is not null` stays ahead of `btrim(...) <> ''` deliberately: dropping it would be NULL-blind
     * (a CHECK passes on NULL, so a missing reason would slip through the same gap 0138 already
     * documents).
     */
    check(
      'attendance_credentials_revoke_check',
      sql`(${t.revokedAt} is null and ${t.revokedBy} is null and ${t.revokeReason} is null)
          or (${t.revokedAt} is not null and ${t.revokedBy} is not null and ${t.revokeReason} is not null and btrim(${t.revokeReason}) <> '')`,
    ),
    // T-398 S1 / DEF-491, migration 0194 - same-org twins of the single-column persons/stores FKs
    // above: RLS checks only this row's own org_id and the FK check runs as the table owner, so a
    // cross-org person/store was accepted. They reference `persons_org_id_id_unique` /
    // `stores_org_id_id_unique` (hand-added in migration 0194, see schema/persons.ts, schema/stores.ts).
    foreignKey({
      columns: [t.orgId, t.enrolledBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'attendance_credentials_enrolled_by_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.revokedBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'attendance_credentials_revoked_by_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'attendance_credentials_store_id_same_org_fk',
    }).onDelete('restrict'),
    // T-398 S3 / DEF-491, migration 0212 - same-org twin of the single-column `employment_id` FK (RLS checks only this row's org_id); references `employments_org_id_id_unique`.
    foreignKey({
      columns: [t.orgId, t.employmentId],
      foreignColumns: [employments.orgId, employments.id],
      name: 'attendance_credentials_employment_id_same_org_fk',
    }).onDelete('restrict'),
  ],
);
