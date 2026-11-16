/**
 * T-533 S1 - a store the pre-flight finds NOTHING wrong with, on the T-525 fixture (made-up data, a fresh org per call).
 * The same additions the S3 pre-flight test makes (`t533-s3-preflight.test.ts` `ready()`): the four POS business-rule rows, a v1 name on each
 * active tender, and a PIN for the manager, the cashier and the kitchen person. Keep the two in step.
 */
import { fixture, pinOf, sql, type Fx } from './t525-pos';

const RULE_KEYS: [string, string][] = [
  ['tax.vat_percent', '12.00'],
  ['pos.senior_pwd_discount_percent', '20.00'],
  ['pos.business_day_start_hour', '4.00'],
  ['pos.table_warn_minutes', '90.00'],
];

/** `mode` is the stored mode the store starts in. `rules: false` leaves the rule rows out (the table is append-only, so they cannot be taken back). */
export async function readyStore(mode: 'off' | 'test' | 'live' = 'test', o: { rules?: boolean } = {}): Promise<Fx> {
  const f = await fixture(mode);
  if (o.rules !== false) {
    for (const [key, value] of RULE_KEYS) {
      await sql`insert into business_rule_values (org_id, key, value, effective_from, set_by, reason)
                values (${f.orgId}, ${key}, ${value}, '2026-01-01', ${f.adminId}, 'seed for the test')`;
    }
  }
  await sql`update tenders set pos_v1_alias = lower(name) where store_id = ${f.storeId} and is_active`;
  for (const id of [f.managerId, f.counterId, f.kitchenId]) await pinOf(f, id);
  return f;
}
