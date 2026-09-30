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

/** Serialises everything that reads or draws down a store's service-charge float (2160). */
export async function lockServiceChargeFloat(tx: Tx, storeId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(${SERVICE_CHARGE_FLOAT_LOCK_NAMESPACE}::int4, hashtext(${storeId}))`,
  );
}
