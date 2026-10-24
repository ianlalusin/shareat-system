/**
 * period_overrides — T-264 slice 3 (docs/tasks/264-def-284-fiscal-period-lock.md, the
 * "SLICE 3 BUILD NOTE"; docs/plans/264-slice3-plan.md is the SPEC this table implements).
 *
 * ⛔ **What a row MEANS — stated here so a future reader never over-reads it:** *"the
 * `override_period_lock` capability was invoked for this entry"* — **NOT** *"the period lock was
 * bypassed."* Those two statements differ exactly when `periodStatusAtPost = 'open'`: `postEntry`
 * runs `authorize()` and writes this row unconditionally whenever a caller passes
 * `periodOverride`, even if the period turns out to already be open by the time the row is
 * written (a deliberate choice — the period status can be closed by a concurrent transaction
 * between postEntry's read and this row's write, so the app can never reliably know in advance
 * whether the exemption will actually be consumed; writing the row whenever the capability was
 * invoked never under-records, and over-recording is the safe direction for an audit trail).
 * Filter on `periodStatusAtPost = 'closed'` to find the rows that actually bypassed a lock.
 *
 * `locked` periods can never appear in `periodStatusAtPost` — a locked period is refused before
 * any row is written; the override does not reach `locked` at all (system32-85's ruling,
 * docs/plans/264-slice3-plan.md).
 */
import { sql } from 'drizzle-orm';
import { check, pgTable, text, timestamp, uuid, foreignKey } from 'drizzle-orm/pg-core';
import { fiscalPeriods } from './fiscal-periods';
import { journalEntries } from './journal';
import { organizations } from './organizations';
import { persons } from './persons';

/**
 * Typed, CHECK-constrained (system32-85's ruling on the SPEC's proposal, 2026-09-12) — never
 * free text, never a boolean. ⛔ **Adding a 5th member later is a MIGRATION**, not a one-line
 * edit: `reason` is enforced by a CHECK constraint in the database, not only by this TS union.
 *
 * ⚠️ `data_entry_error` does NOT mean the whole correction routes through the override. Reversals
 * of entries in already-closed periods are already legitimate and need no exemption at all
 * (migration 0003 lines 202-208 say so in terms) — only the RE-POST of the corrected entry needs
 * `periodOverride`. Never wrap the reversal half of a correction in an override: that applies a
 * break-glass capability to a path that never needed one, and leaves a row here for something
 * ordinary.
 */
export const PERIOD_OVERRIDE_REASONS = [
  'late_supplier_invoice',
  'regulatory_correction',
  'data_entry_error',
  'other',
] as const;

export type PeriodOverrideReason = (typeof PERIOD_OVERRIDE_REASONS)[number];

export const periodOverrides = pgTable(
  'period_overrides',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    periodId: uuid('period_id')
      .notNull()
      .references(() => fiscalPeriods.id, { onDelete: 'restrict' }),
    // ON DELETE CASCADE, mirroring journal_lines.entry_id (0003_journal_entries_and_lines.sql:82):
    // this is the property that makes "an override with no entry" structurally unrepresentable,
    // which was the whole reason `audit_log` (a single jsonb-backed entity_id) did not fit.
    entryId: uuid('entry_id')
      .notNull()
      .references(() => journalEntries.id, { onDelete: 'cascade' }),
    // NOT NULL, unlike audit_log's actor column — there is no system-actor case here; a machine
    // can never hold override_period_lock (build note, "the audit table" section).
    actorPersonId: uuid('actor_person_id')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    reason: text('reason', { enum: PERIOD_OVERRIDE_REASONS }).notNull(),
    note: text('note'),
    // Captured from the period status postEntry already resolved, at the moment this row is
    // written. 'locked' can never appear — see the table-level comment above.
    periodStatusAtPost: text('period_status_at_post', { enum: ['open', 'closed'] }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'period_overrides_reason_check',
      sql`${t.reason} in ('late_supplier_invoice', 'regulatory_correction', 'data_entry_error', 'other')`,
    ),
    // 'other' needs its own sentence, not a checkbox — same shape as
    // ar_write_offs_reason_not_blank_check (0049_t131_accounts_receivable.sql:123).
    check(
      'period_overrides_other_needs_note_check',
      sql`${t.reason} <> 'other' or (${t.note} is not null and btrim(${t.note}) <> '')`,
    ),
    check(
      'period_overrides_status_at_post_check',
      sql`${t.periodStatusAtPost} in ('open', 'closed')`,
    ),
    // T-398 S1 / DEF-491, migration 0194 - same-org twins of the single-column persons/stores FKs
    // above: RLS checks only this row's own org_id and the FK check runs as the table owner, so a
    // cross-org person/store was accepted. They reference `persons_org_id_id_unique` /
    // `stores_org_id_id_unique` (hand-added in migration 0194, see schema/persons.ts, schema/stores.ts).
    foreignKey({
      columns: [t.orgId, t.actorPersonId],
      foreignColumns: [persons.orgId, persons.id],
      name: 'period_overrides_actor_person_id_same_org_fk',
    }).onDelete('restrict'),
    // T-398 S3 / DEF-491, migration 0213 - same-org twin of the single-column `entry_id` FK (RLS checks only this row's org_id); references `journal_entries_org_id_id_unique`.
    foreignKey({
      columns: [t.orgId, t.entryId],
      foreignColumns: [journalEntries.orgId, journalEntries.id],
      name: 'period_overrides_entry_id_same_org_fk',
    }).onDelete('cascade'),
    // T-398 S3 / DEF-491, migration 0213 - same-org twin of the single-column `period_id` FK (RLS checks only this row's org_id); references `fiscal_periods_org_id_id_unique`.
    foreignKey({
      columns: [t.orgId, t.periodId],
      foreignColumns: [fiscalPeriods.orgId, fiscalPeriods.id],
      name: 'period_overrides_period_id_same_org_fk',
    }).onDelete('restrict'),
  ],
);
