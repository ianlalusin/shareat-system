import { sql as dsql } from 'drizzle-orm';
import type postgres from 'postgres';
import { transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { recordDeductionAgreement } from '@shareat/domain';

/**
 * T-519 - test-only fixture. Since T-519 payroll, 13th month and separation recover a staff charge ONLY under a signed agreement, so a test that
 * means to recover seeds (1) a charge entry on 1230 with one of the six charge source types, (2) the scan of the signed paper, and (3) the agreement
 * itself, recorded through the domain function by a payroll user who is not the charged person.
 */
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

export async function asOrgT519<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

/** A posted charge: Dr 1230 (party = the person) / Cr 1130, dated 2026-01-02, with a real charge source type. Returns the entry id. */
export async function chargeEntry(
  sql: postgres.Sql,
  f: { orgId: string; storeId: string },
  personId: string,
  amount: string,
  sourceType = 'tillcountshortage',
): Promise<string> {
  const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${f.orgId} limit 1`;
  const [adv] = await sql<{ id: string }[]>`select id from accounts where org_id = ${f.orgId} and code = '1230'`;
  const [cash] = await sql<{ id: string }[]>`select id from accounts where org_id = ${f.orgId} and code = '1130'`;
  return sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${f.orgId}, '2026-01-02', ${period!.id}, ${sourceType}, ${uid('chg')}, 'draft') returning id`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit, party_type, party_id)
             values (${e!.id}, 1, ${adv!.id}, ${f.storeId}, ${amount}, '0', 'employee', ${personId})`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
             values (${e!.id}, 2, ${cash!.id}, ${f.storeId}, '0', ${amount})`;
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
    return e!.id;
  });
}

/** The scan of a signed agreement, uploaded by `uploadedBy` just now. */
export async function scanFor(sql: postgres.Sql, f: { orgId: string; storeId: string }, uploadedBy: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${f.orgId}, ${f.storeId}, 'staff_deduction_agreement', ${`orgs/${f.orgId}/stores/${f.storeId}/staff_deduction_agreement/${uid('f')}.pdf`},
            'application/pdf', 1024, ${uid('sum')}, ${uploadedBy})
    returning id`;
  return row!.id;
}

/** Records an agreement through the domain function as `recorder` (a payroll user, never the charged person). */
export async function agree(
  sql: postgres.Sql,
  f: { orgId: string; storeId: string },
  recorder: Actor,
  personId: string,
  entryId: string,
  over: Partial<{ amount: string; perPayrollLimit: string; noticeGivenAt: string; signedOn: string; explanation: string }> = {},
): Promise<{ id: string }> {
  const evidenceFileId = await scanFor(sql, f, recorder.personId);
  return asOrgT519(f.orgId, (tx) =>
    recordDeductionAgreement(tx, recorder, {
      personId,
      storeId: f.storeId,
      sourceEntryId: entryId,
      amount: over.amount ?? '1000.00',
      perPayrollLimit: over.perPayrollLimit ?? over.amount ?? '1000.00',
      noticeGivenAt: over.noticeGivenAt ?? '2026-01-03',
      employeeExplanation: over.explanation ?? 'none given',
      signedOn: over.signedOn ?? '2026-01-04',
      evidenceFileId,
    }),
  );
}
