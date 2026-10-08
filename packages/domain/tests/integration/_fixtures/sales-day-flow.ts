import type postgres from 'postgres';
import type { Actor } from '@shareat/auth';
import { salesDaysRepo, type Tx } from '@shareat/db';

/**
 * T-385 - `docs/tasks/385-verify-only-after-submit.md`: a sales day is verified only after it is submitted, and (S3,
 * Ian 2026-10-09, answer (a)) the person who submitted it may not verify it unless they are a super-admin.
 *
 * ## `submitThenVerify`
 * Submits the day if it is still `open`, then verifies it, and returns `verifySalesDay`'s result. A day that is
 * already `submitted` (or `verified`) is not submitted again, so a test that submitted on purpose keeps its own
 * submitter. Neither call's refusal is swallowed.
 *
 * `submitter` is REQUIRED and must be a different person from `verifier` (S3): a test names both people. The one
 * exception is a test whose subject IS the super-admin exception, which passes the same super-admin twice on purpose.
 * The submitter needs `submit_sales_day` (a manager or admin, or staff holding the position grant).
 *
 * ## `forceVerifiedSql`
 * For raw-SQL fixtures that used to write `UPDATE sales_days SET status = 'verified'` on an `open` row. Migration 0188
 * refuses that jump, so it takes the two legal steps: `open -> submitted` (with submitter) then `submitted ->
 * verified` (with verifier). Works on a `postgres` connection or a transaction handle.
 */
export async function submitThenVerify(tx: Tx, verifier: Actor, salesDayId: string, submitter: Actor) {
  // loaded lazily so a packages/db test can import `forceVerifiedSql` without pulling in the domain package
  const { submitSalesDay, verifySalesDay } = await import('@shareat/domain');
  const day = await salesDaysRepo.getById(tx, verifier.orgId, salesDayId);
  if (day && day.status === 'open') await submitSalesDay(tx, submitter, salesDayId);
  return verifySalesDay(tx, verifier, salesDayId);
}

type SqlLike = postgres.Sql | postgres.TransactionSql;

export async function forceVerifiedSql(
  sql: SqlLike,
  dayId: string,
  verifierId: string,
  submitterId: string = verifierId,
): Promise<void> {
  const q = sql as postgres.Sql;
  await q`update sales_days set status = 'submitted', submitted_by = ${submitterId}, submitted_at = now() where id = ${dayId} and status = 'open'`;
  await q`update sales_days set status = 'verified', verified_by = ${verifierId}, verified_at = now() where id = ${dayId}`;
}

/**
 * A second manager for fixtures that only had one: the person who SUBMITS a day the fixture's manager then verifies
 * (S3 - the submitter may not verify their own day). Scoped to every store named, so it can submit a day on any of them.
 */
export async function mkSubmitter(sql: SqlLike, orgId: string, storeIds: string[], name = 'Submitter'): Promise<Actor> {
  const q = sql as postgres.Sql;
  const [p] = await q<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
  await q`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, 'manager')`;
  for (const s of storeIds) await q`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
  return { personId: p!.id, orgId };
}

/**
 * A balanced, OPEN, typed day (P 1,000 all unli, all cash, Walk-in 1,000) on a fresh UNLINKED store, for the T-385
 * tests that need a day someone can submit and verify. `f` is an `s6Fixture` (its Lipa store is POS-linked, which
 * forbids typing a day, so the typed day gets its own store); every person in `scoped` gets scope on that store.
 */
export async function mkTypedDay(
  sql: SqlLike,
  f: { orgId: string; manager: Actor },
  scoped: string[],
  businessDate = '2027-01-10',
): Promise<{ id: string; storeId: string }> {
  const { createSalesDay, transactionAsOrg } = await loadDomainHelpers();
  const q = sql as postgres.Sql;
  const code = `t385-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [store] = await q<{ id: string }[]>`insert into stores (org_id, code, name) values (${f.orgId}, ${code}, 'Batangas') returning id`;
  for (const p of scoped) await q`insert into person_store_scope (person_id, store_id) values (${p}, ${store!.id})`;
  const [ch] = await q<{ id: string }[]>`
    insert into sales_channels (org_id, store_id, name, is_remitted_daily) values (${f.orgId}, ${store!.id}, 'Walk-in', true) returning id`;
  const day = await transactionAsOrg(f.orgId, (tx) =>
    createSalesDay(tx, f.manager, {
      storeId: store!.id, businessDate, totalSales: '1000.00', unliSales: '0.00', alaCarteSales: '1000.00',
      cashCollected: '1000.00', channels: [{ channelId: ch!.id, amount: '1000.00' }],
    }),
  );
  return { id: day.id, storeId: store!.id };
}

async function loadDomainHelpers() {
  const { createSalesDay } = await import('@shareat/domain');
  const { asOrgOn } = await import('./pos-s6');
  return { createSalesDay, transactionAsOrg: asOrgOn };
}
