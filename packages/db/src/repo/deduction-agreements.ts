/**
 * The only place SQL is written for staff deduction agreements. T-519 S1, docs/tasks/519-staff-deduction-agreements.md.
 *
 * ## What "recovered" means
 *
 * An agreement never stores how much it has recovered (the app role may not UPDATE a money column). What it recovered is the sum of its
 * `staff_deduction_recoveries` rows whose journal entry is still LIVE (see `entryLive`): a voided pay run reverses the payslip entry, the
 * entry stops being live, and the agreement's remaining amount comes back by itself. `syncStatuses` then moves the stored status to match.
 */
import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { Tx } from '../client';
import type { Money } from '@shareat/core/money';
import { staffDeductionAgreements, staffDeductionRecoveries, type DeductionAgreementStatus, type DeductionSourceType } from '../../schema/staff-deduction-agreements';

/**
 * SQL: is the journal entry whose id is the column `col` LIVE? An entry is live when its reversal chain
 * (E -> R1 -> R2 ...; one reversal per entry) has an even length: no reversal (0) is live, R1 cancels it, a reversal of R1 re-states it.
 * A draft is never live. Same parity rule as `interStoreLineUnmatched` (findings.ts, T-374 S3), read from the root's side.
 */
export const entryLive = (col: SQL) => sql`(
  (select x.status from journal_entries x where x.id = ${col}) <> 'draft'
  and coalesce((
    with recursive down(id, depth) as (
      select ${col}, 0
      union all
      select c.id, d.depth + 1 from down d join journal_entries c on c.reversal_of_entry_id = d.id
    ) select max(depth) from down
  ), 0) % 2 = 0
)`;

export interface AgreementRow {
  id: string;
  orgId: string;
  personId: string;
  storeId: string;
  sourceType: DeductionSourceType;
  sourceEntryId: string;
  amount: string;
  perPayrollLimit: string;
  noticeGivenAt: string;
  employeeExplanation: string;
  signedOn: string;
  evidenceFileId: string | null;
  /** Date of the charge entry (`sourceEntryId`). */
  chargeDate: string | null;
  recordedBy: string;
  recordedAt: Date;
  status: DeductionAgreementStatus;
  /** Sum of this agreement's recoveries whose journal entry is still live. */
  recovered: string;
  /** Whether the charge entry (`sourceEntryId`) is still live; a reversed charge is no longer owed, so nothing may be recovered on it. */
  chargeLive: boolean;
}

/** The agreement columns plus `recovered`, as one select list. `a` is the agreements alias. */
const SELECT_ROW = sql`
  a.id, a.org_id as "orgId", a.person_id as "personId", a.store_id as "storeId", a.source_type as "sourceType",
  a.source_entry_id as "sourceEntryId", a.amount::text as amount, a.per_payroll_limit::text as "perPayrollLimit",
  a.notice_given_at::text as "noticeGivenAt", a.employee_explanation as "employeeExplanation", a.signed_on::text as "signedOn",
  a.evidence_file_id as "evidenceFileId",
  (select je.entry_date::text from journal_entries je where je.org_id = a.org_id and je.id = a.source_entry_id) as "chargeDate", a.recorded_by as "recordedBy", a.recorded_at as "recordedAt", a.status,
  coalesce((
    select sum(r.amount) from staff_deduction_recoveries r
    where r.org_id = a.org_id and r.agreement_id = a.id and ${entryLive(sql`r.journal_entry_id`)}
  ), 0)::text as recovered,
  ${entryLive(sql`a.source_entry_id`)} as "chargeLive"
`;

export async function insertAgreement(
  tx: Tx,
  input: {
    orgId: string;
    personId: string;
    storeId: string;
    sourceType: DeductionSourceType;
    sourceEntryId: string;
    amount: Money;
    perPayrollLimit: Money;
    noticeGivenAt: string;
    employeeExplanation: string;
    signedOn: string;
    evidenceFileId: string | null;
    recordedBy: string;
  },
): Promise<{ id: string }> {
  const [row] = await tx.insert(staffDeductionAgreements).values(input).returning({ id: staffDeductionAgreements.id });
  return row!;
}

export async function getById(tx: Tx, orgId: string, id: string): Promise<AgreementRow | null> {
  const rows = (await tx.execute(
    sql`select ${SELECT_ROW} from staff_deduction_agreements a where a.org_id = ${orgId} and a.id = ${id}`,
  )) as unknown as AgreementRow[];
  return rows[0] ?? null;
}

/** Every agreement for the person, oldest first (the order recoveries are allocated in). */
export async function listForPerson(tx: Tx, orgId: string, personId: string): Promise<AgreementRow[]> {
  return (await tx.execute(
    sql`select ${SELECT_ROW} from staff_deduction_agreements a
        where a.org_id = ${orgId} and a.person_id = ${personId}
        order by a.recorded_at, a.id`,
  )) as unknown as AgreementRow[];
}

/**
 * The person's ACTIVE agreements, oldest first. With `lock`, the rows are locked first (`for update`, in the same order), so two payroll
 * posts for one person cannot both spend the same unpaid amount.
 */
export async function listActiveForPerson(tx: Tx, orgId: string, personId: string, lock = false): Promise<AgreementRow[]> {
  if (lock) {
    await tx.execute(
      sql`select id from staff_deduction_agreements
          where org_id = ${orgId} and person_id = ${personId} and status = 'active'
          order by recorded_at, id for update`,
    );
  }
  return (await tx.execute(
    sql`select ${SELECT_ROW} from staff_deduction_agreements a
        where a.org_id = ${orgId} and a.person_id = ${personId} and a.status = 'active'
        order by a.recorded_at, a.id`,
  )) as unknown as AgreementRow[];
}

/** What the person owes on 1230 right now, from the ledger (every non-draft entry). Same figure as payroll's `outstandingAdvance`. */
export async function balanceOn1230(tx: Tx, orgId: string, personId: string): Promise<string> {
  const rows = (await tx.execute(
    sql`
      select coalesce(sum(jl.debit - jl.credit), 0)::text as total
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id
      join accounts a on a.id = jl.account_id
      where je.org_id = ${orgId} and je.status <> 'draft' and a.code = '1230' and jl.party_type = 'employee' and jl.party_id = ${personId}
    `,
  )) as unknown as { total: string }[];
  return rows[0]?.total ?? '0';
}

export interface ChargeRow {
  sourceType: string;
  entryStatus: string;
  /** The entry is still live (not reversed, or its reversal was itself reversed). */
  live: boolean;
  /** Debits less credits to 1230 against the person in this entry, as numeric text. Above 0 for a charge. */
  amount: string;
  /** The store of the 1230 line(s); null when the lines name different stores or none. */
  storeId: string | null;
}

/** What a journal entry charged this person on 1230, or null when the entry does not exist in the org. */
export async function chargeOfEntry(tx: Tx, orgId: string, entryId: string, personId: string): Promise<ChargeRow | null> {
  const rows = (await tx.execute(
    sql`
      select je.source_type as "sourceType", je.status as "entryStatus", ${entryLive(sql`je.id`)} as live,
             coalesce(sum(jl.debit - jl.credit) filter (where a.code = '1230' and jl.party_type = 'employee' and jl.party_id = ${personId}), 0)::text as amount,
             case when count(distinct jl.store_id) filter (where a.code = '1230' and jl.party_type = 'employee' and jl.party_id = ${personId}) = 1
                  then (array_agg(jl.store_id) filter (where a.code = '1230' and jl.party_type = 'employee' and jl.party_id = ${personId}))[1] end as "storeId"
      from journal_entries je
      left join journal_lines jl on jl.entry_id = je.id
      left join accounts a on a.id = jl.account_id
      where je.org_id = ${orgId} and je.id = ${entryId}
      group by je.id
    `,
  )) as unknown as ChargeRow[];
  return rows[0] ?? null;
}

/** How much of this charge entry earlier agreements (any status) already recovered from pay, counting only entries still live. */
export async function recoveredOnCharge(tx: Tx, orgId: string, entryId: string): Promise<string> {
  const rows = (await tx.execute(
    sql`
      select coalesce(sum(r.amount), 0)::text as total
      from staff_deduction_agreements a
      join staff_deduction_recoveries r on r.org_id = a.org_id and r.agreement_id = a.id
      where a.org_id = ${orgId} and a.source_entry_id = ${entryId} and ${entryLive(sql`r.journal_entry_id`)}
    `,
  )) as unknown as { total: string }[];
  return rows[0]?.total ?? '0';
}

/** The 1230 charges against a person that no active or completed agreement covers yet (R7 "waiting for the employee's signed agreement"). */
export async function chargesWaitingForAgreement(
  tx: Tx,
  orgId: string,
  personId: string,
): Promise<{ entryId: string; sourceType: string; entryDate: string; amount: string }[]> {
  return (await tx.execute(
    sql`
      select je.id as "entryId", je.source_type as "sourceType", je.entry_date::text as "entryDate", sum(jl.debit - jl.credit)::text as amount
      from journal_entries je
      join journal_lines jl on jl.entry_id = je.id
      join accounts a on a.id = jl.account_id
      where je.org_id = ${orgId} and ${entryLive(sql`je.id`)} and je.status <> 'draft' and a.code = '1230' and jl.party_type = 'employee' and jl.party_id = ${personId}
        and je.source_type in ('cash_request_shortage', 'tillcountshortage', 'remittance_variance', 'trade_discrepancy', 'order_wastage', 'owner_pay_recovery')
        and not exists (select 1 from staff_deduction_agreements d where d.org_id = je.org_id and d.source_entry_id = je.id and d.status <> 'cancelled')
      group by je.id
      having sum(jl.debit - jl.credit) > 0
      order by je.entry_date, je.id
    `,
  )) as unknown as { entryId: string; sourceType: string; entryDate: string; amount: string }[];
}

export async function insertRecovery(
  tx: Tx,
  input: { orgId: string; agreementId: string; journalEntryId: string; amount: Money },
): Promise<void> {
  await tx.insert(staffDeductionRecoveries).values(input);
}

/** What each given payroll entry recovered under which agreement (R7: the payslip's "Charge repayment (agreement of <date>)" lines). */
export async function recoveriesForEntries(
  tx: Tx,
  orgId: string,
  entryIds: string[],
): Promise<{ journalEntryId: string; amount: string; signedOn: string }[]> {
  if (entryIds.length === 0) return [];
  return (await tx.execute(
    sql`select r.journal_entry_id as "journalEntryId", r.amount::text as amount, a.signed_on::text as "signedOn"
        from staff_deduction_recoveries r
        join staff_deduction_agreements a on a.org_id = r.org_id and a.id = r.agreement_id
        where r.org_id = ${orgId} and r.journal_entry_id in (${sql.join(entryIds.map((e) => sql`${e}`), sql`, `)})
        order by a.signed_on, a.id`,
  )) as unknown as { journalEntryId: string; amount: string; signedOn: string }[];
}

/** Active -> cancelled. Returns false when the row was not active (nothing is written). */
export async function cancel(
  tx: Tx,
  orgId: string,
  id: string,
  by: { cancelledBy: string; reason: string },
): Promise<boolean> {
  const rows = await tx
    .update(staffDeductionAgreements)
    .set({ status: 'cancelled', cancelledAt: sql`now()`, cancelledBy: by.cancelledBy, cancelReason: by.reason })
    .where(and(eq(staffDeductionAgreements.orgId, orgId), eq(staffDeductionAgreements.id, id), eq(staffDeductionAgreements.status, 'active')))
    .returning({ id: staffDeductionAgreements.id });
  return rows.length === 1;
}

/**
 * R6: bring the stored status in line with what was recovered, for one person. active -> completed once the posted recoveries reach the amount;
 * completed -> active again when a void took some back. Cancelled rows are never touched. Called in the transaction that posts or voids payroll.
 */
export async function syncStatuses(tx: Tx, orgId: string, personId: string): Promise<void> {
  const t = staffDeductionAgreements;
  const recovered = sql`coalesce((
    select sum(r.amount) from staff_deduction_recoveries r
    where r.org_id = staff_deduction_agreements.org_id and r.agreement_id = staff_deduction_agreements.id and ${entryLive(sql`r.journal_entry_id`)}
  ), 0)`;
  await tx
    .update(staffDeductionAgreements)
    .set({ status: 'completed', completedAt: sql`now()` })
    .where(and(eq(t.orgId, orgId), eq(t.personId, personId), eq(t.status, 'active'), sql`${recovered} >= ${t.amount}`));
  await tx
    .update(staffDeductionAgreements)
    .set({ status: 'active', completedAt: null })
    .where(and(eq(t.orgId, orgId), eq(t.personId, personId), eq(t.status, 'completed'), sql`${recovered} < ${t.amount}`));
}

/** The distinct persons whose payroll entries (given by id) carried a recovery: who to `syncStatuses` after a void. */
export async function personsRecoveredBy(tx: Tx, orgId: string, entryIds: string[]): Promise<string[]> {
  if (entryIds.length === 0) return [];
  const rows = (await tx.execute(
    sql`select distinct a.person_id as "personId"
        from staff_deduction_recoveries r
        join staff_deduction_agreements a on a.org_id = r.org_id and a.id = r.agreement_id
        where r.org_id = ${orgId} and r.journal_entry_id in (${sql.join(entryIds.map((e) => sql`${e}`), sql`, `)})`,
  )) as unknown as { personId: string }[];
  return rows.map((r) => r.personId);
}

