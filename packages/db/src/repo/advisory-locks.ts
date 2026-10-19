/**
 * Transaction-scoped advisory locks for the cash-custody paths. T-366 S1 / DEF-374.
 *
 * ⛔ The defect: createRemittance and distributeServiceCharge read a cap ("what the day still owes",
 * "what the float still holds") with no lock under READ COMMITTED, so two concurrent callers both
 * pass a cap that only one may. The remedy is to serialise per store BEFORE the first cap read;
 * the second caller then reads the state the first committed.
 *
 * ⭐ EVERY advisory key in the repo, so the next one cannot collide silently:
 *   - `organizations.ts` `lockFirstRun`: `pg_advisory_xact_lock(232002)` (single bigint);
 *   - `access.ts` `lockOrgAccess`: `pg_advisory_xact_lock(hashtext(orgId))` (single bigint);
 *   - migration 0160: `pg_advisory_xact_lock(hashtextextended('fiscal_periods:' || org_id, 0))`
 *     (single bigint);
 *   - THIS file: the two-int4 form `pg_advisory_xact_lock(namespace, hashtext(storeId))`. It is a
 *     SEPARATE key space (`pg_locks.objsubid` 2 vs 1), so it never collides with the three above.
 *     Namespaces taken here: 366001 (cash custody), 366002 (service-charge float), 369001
 *     (reimbursement payee, keyed on the employee id rather than a store id), 369002 (supplier
 *     return credit, keyed on the supplier id), 369003 (inter-store pair settlement, keyed on the
 *     UNORDERED pair of store ids), 392001 (dual-run store-week, keyed on org:store:week), 436001 (a
 *     person's leave: caps, SIL balance, one-leave-day-per-date, keyed on the person id).
 *   - Migration 0211: namespace 443001 (item family structure, keyed on org id).
 *   - A `hashtext(storeId)` collision only serialises two stores for a moment; it never gives a
 *     wrong answer (the same reasoning as `access.ts` `lockOrgAccess`).
 *
 * Transaction-scoped (`_xact_`): released at COMMIT or ROLLBACK, so it cannot outlive the request on
 * a pooled connection. Callers take it AFTER `authorize` so a refused caller never queues.
 */
import { sql } from 'drizzle-orm';
import type { Tx } from '../client';

/** Namespace (first int4) for the per-store cash-custody lock: remittance create, reverse and
 *  variance resolution. */
const CASH_CUSTODY_LOCK_NAMESPACE = 366001;
/** Namespace (first int4) for the per-store service-charge float lock. */
const SERVICE_CHARGE_FLOAT_LOCK_NAMESPACE = 366002;

/** Serialises everything that reads or moves a store's remittance cap. */
export async function lockStoreCashCustody(tx: Tx, storeId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(${CASH_CUSTODY_LOCK_NAMESPACE}::int4, hashtext(${storeId}))`,
  );
}

/** Namespace (first int4) for the per-payee reimbursement-payout lock. T-369 S1 / N3. */
const REIMBURSEMENT_PAYEE_LOCK_NAMESPACE = 369001;

/** Serialises everything that reads or pays down one person's reimbursement liability (2130), so
 *  two payouts in flight cannot both pass the cap. Keyed on the payee, not the store: one person's
 *  liability can sit at several stores and the cap each payout reads is theirs. */
export async function lockReimbursementPayee(tx: Tx, employeeId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(${REIMBURSEMENT_PAYEE_LOCK_NAMESPACE}::int4, hashtext(${employeeId}))`,
  );
}

/** Serialises everything that reads or draws down a store's service-charge float (2160). */
export async function lockServiceChargeFloat(tx: Tx, storeId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(${SERVICE_CHARGE_FLOAT_LOCK_NAMESPACE}::int4, hashtext(${storeId}))`,
  );
}

/** Namespace (first int4) for the per-supplier credit lock. T-369 S0 / DEF-550. (369001 is
 *  `REIMBURSEMENT_PAYEE_LOCK_NAMESPACE`.) */
const SUPPLIER_CREDIT_LOCK_NAMESPACE = 369002;

/** Serialises everything that reads or moves one supplier's return credit (`1240`): spending it in
 *  `recordPayment`, and voiding a payment whose overpayment put it there. Without it the check and
 *  the draw race, and the credit goes negative. Keyed on the supplier. */
export async function lockSupplierCredit(tx: Tx, supplierId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(${SUPPLIER_CREDIT_LOCK_NAMESPACE}::int4, hashtext(${supplierId}))`,
  );
}

/** Namespace (first int4) for the inter-store settlement lock. T-369 S9 / DEF-557. */
const INTER_STORE_PAIR_LOCK_NAMESPACE = 369003;

/** Serialises everything that reads or clears what ONE pair of stores owes each other (1250/2150), so two
 *  settlements in flight cannot both pass the "no more than is owed" cap. Keyed on the UNORDERED pair
 *  (`least:greatest`), so Lipa repaying Malvar and Malvar repaying Lipa serialise together while a different
 *  pair does not wait. ⚠️ The guarantee is exactly that: settlements serialise AGAINST EACH OTHER. Only
 *  settlement takes the lock; a cross-store void (which can lower a position) racing a settlement does not, and
 *  can leave the position reversed - the same end state as a void after a settlement, which the spec accepts. */
export async function lockInterStorePair(tx: Tx, storeA: string, storeB: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(${INTER_STORE_PAIR_LOCK_NAMESPACE}::int4, hashtext(least(${storeA}::text, ${storeB}::text) || ':' || greatest(${storeA}::text, ${storeB}::text)))`,
  );
}

/** Namespace (first int4) for the dual-run store-week lock. T-392 S4. */
const DUAL_RUN_WEEK_LOCK_NAMESPACE = 392001;

/** Serialises every dual-run apply for one (org, store, week), so two identical runs racing for the same R8 identity
 *  cannot both pass the identity check and then fight on the unique. The loser waits, then reads the winner's row. */
export async function lockDualRunWeek(tx: Tx, orgId: string, storeId: string, weekStart: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(${DUAL_RUN_WEEK_LOCK_NAMESPACE}::int4, hashtext(${orgId}::text || ':' || ${storeId}::text || ':' || ${weekStart}::text))`,
  );
}

/** Namespace (first int4) for the per-person leave lock. T-436. */
const PERSON_LEAVE_LOCK_NAMESPACE = 436001;

/** Serialises everything that reads or moves one PERSON's leave: the monthly/yearly cap counts, the Service Incentive Leave
 *  balance and the one-leave-day-per-date rule. Keyed on the person (not the employment, not the store): a person with two
 *  jobs has one balance, so approvals at two stores must queue behind each other. Take it AFTER `authorize`. */
export async function lockPersonLeave(tx: Tx, personId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(${PERSON_LEAVE_LOCK_NAMESPACE}::int4, hashtext(${personId}))`,
  );
}
