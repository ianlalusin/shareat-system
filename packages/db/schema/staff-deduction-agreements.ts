/**
 * T-519 S1 (migration 0236) - a staff charge is recovered from pay only under a signed deduction agreement. DEF-813.
 * docs/tasks/519-staff-deduction-agreements.md (R1-R6).
 *
 * The charge stays a receivable on 1230 (R1). An agreement records that the employee was told, explained themselves and signed;
 * payroll, 13th month and separation then recover only what an ACTIVE agreement covers (domain: payroll/deduction-agreements.ts).
 *
 * `staff_deduction_recoveries` is ADDED BEYOND R2: one row per (agreement, payroll journal entry). Nothing is ever updated or deleted;
 * "how much has this agreement recovered" is the sum of its rows whose journal entry is still 'posted', so a voided run (entry
 * 'reversed') reopens the agreement by itself.
 *
 * NOTE: hand-added in migration 0236 - ENABLE + FORCE RLS and `<table>_org_isolation` (app_current_org()); the grants (SELECT, INSERT; on
 * the agreements COLUMN-LEVEL UPDATE on status, completed_at, cancelled_at, cancelled_by, cancel_reason only; no DELETE). The partial
 * unique index, the checks and the finite checks are mirrored below. `amount <= the charge`, recorder != charged person and the R5
 * self-agreement are domain rules.
 */
import { sql } from 'drizzle-orm';
import { check, date, foreignKey, index, numeric, pgTable, text, timestamp, unique, uniqueIndex, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { journalEntries } from './journal';
import { organizations } from './organizations';
import { persons } from './persons';
import { storedFiles } from './stored-files';
import { stores } from './stores';

export const DEDUCTION_SOURCE_TYPES = [
  'cash_request_shortage',
  'tillcountshortage',
  'remittance_variance',
  'trade_discrepancy',
  'order_wastage',
  'owner_pay_recovery',
] as const;
export type DeductionSourceType = (typeof DEDUCTION_SOURCE_TYPES)[number];

export const DEDUCTION_AGREEMENT_STATUSES = ['active', 'completed', 'cancelled'] as const;
export type DeductionAgreementStatus = (typeof DEDUCTION_AGREEMENT_STATUSES)[number];

const finite = (col: AnyPgColumn) => sql`${col} > '-Infinity'::numeric and ${col} < 'Infinity'::numeric`;

export const staffDeductionAgreements = pgTable(
  'staff_deduction_agreements',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    personId: uuid('person_id').notNull(),
    storeId: uuid('store_id').notNull(),
    sourceType: text('source_type', { enum: DEDUCTION_SOURCE_TYPES }).notNull(),
    /** The charge's journal entry (a debit to 1230 against the person). */
    sourceEntryId: uuid('source_entry_id').notNull(),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    perPayrollLimit: numeric('per_payroll_limit', { precision: 14, scale: 2 }).notNull(),
    noticeGivenAt: date('notice_given_at').notNull(),
    employeeExplanation: text('employee_explanation').notNull(),
    signedOn: date('signed_on').notNull(),
    /** The scan of the signed paper (purpose `staff_deduction_agreement`). NULL only for an owner's own R5 self-agreement. */
    evidenceFileId: uuid('evidence_file_id'),
    recordedBy: uuid('recorded_by').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    status: text('status', { enum: DEDUCTION_AGREEMENT_STATUSES }).notNull().default('active'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelledBy: uuid('cancelled_by'),
    cancelReason: text('cancel_reason'),
  },
  (t) => [
    unique('staff_deduction_agreements_org_id_id_unique').on(t.orgId, t.id),
    uniqueIndex('staff_deduction_agreements_active_charge_key').on(t.orgId, t.sourceEntryId).where(sql`${t.status} = 'active'`),
    index('staff_deduction_agreements_org_person_idx').on(t.orgId, t.personId),
    check('staff_deduction_agreements_source_type_check', sql`${t.sourceType} in ('cash_request_shortage', 'tillcountshortage', 'remittance_variance', 'trade_discrepancy', 'order_wastage', 'owner_pay_recovery')`),
    check('staff_deduction_agreements_status_check', sql`${t.status} in ('active', 'completed', 'cancelled')`),
    check('staff_deduction_agreements_amount_positive_check', sql`${t.amount} > 0`),
    check('staff_deduction_agreements_per_payroll_limit_positive_check', sql`${t.perPayrollLimit} > 0`),
    check('staff_deduction_agreements_amount_finite_check', finite(t.amount)),
    check('staff_deduction_agreements_per_payroll_limit_finite_check', finite(t.perPayrollLimit)),
    check('staff_deduction_agreements_notice_before_signed_check', sql`${t.noticeGivenAt} <= ${t.signedOn}`),
    check('staff_deduction_agreements_explanation_not_blank_check', sql`length(trim(${t.employeeExplanation})) > 0`),
    check(
      'staff_deduction_agreements_status_stamps_check',
      sql`(${t.status} = 'completed') = (${t.completedAt} is not null) and (${t.status} = 'cancelled') = (${t.cancelledAt} is not null)`,
    ),
    foreignKey({ columns: [t.orgId, t.personId], foreignColumns: [persons.orgId, persons.id], name: 'staff_deduction_agreements_person_id_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.storeId], foreignColumns: [stores.orgId, stores.id], name: 'staff_deduction_agreements_store_id_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.sourceEntryId], foreignColumns: [journalEntries.orgId, journalEntries.id], name: 'staff_deduction_agreements_source_entry_id_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.evidenceFileId], foreignColumns: [storedFiles.orgId, storedFiles.id], name: 'staff_deduction_agreements_evidence_file_id_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.recordedBy], foreignColumns: [persons.orgId, persons.id], name: 'staff_deduction_agreements_recorded_by_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.cancelledBy], foreignColumns: [persons.orgId, persons.id], name: 'staff_deduction_agreements_cancelled_by_same_org_fk' }).onDelete('restrict'),
  ],
);

export const staffDeductionRecoveries = pgTable(
  'staff_deduction_recoveries',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    agreementId: uuid('agreement_id').notNull(),
    /** The payslip / 13th-month payout / separation entry whose 1230 credit this covered. */
    journalEntryId: uuid('journal_entry_id').notNull(),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('staff_deduction_recoveries_agreement_entry_key').on(t.orgId, t.agreementId, t.journalEntryId),
    index('staff_deduction_recoveries_org_entry_idx').on(t.orgId, t.journalEntryId),
    check('staff_deduction_recoveries_amount_positive_check', sql`${t.amount} > 0`),
    check('staff_deduction_recoveries_amount_finite_check', finite(t.amount)),
    foreignKey({ columns: [t.orgId, t.agreementId], foreignColumns: [staffDeductionAgreements.orgId, staffDeductionAgreements.id], name: 'staff_deduction_recoveries_agreement_id_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.journalEntryId], foreignColumns: [journalEntries.orgId, journalEntries.id], name: 'staff_deduction_recoveries_journal_entry_id_same_org_fk' }).onDelete('restrict'),
  ],
);
