/**
 * The only place SQL is written for the service-charge float's OWN balance. T-187 slice 1.
 * docs/tasks/187-service-charge-distribution.md §7 invariant 1.
 *
 * ⛔ **No stored total** — same discipline as `liabilitiesRepo.positionOf` (2500), applied to
 * `2160`, but PER STORE: a store may not spend another store's float, so the balance is scoped to
 * `journal_lines.store_id`, never summed org-wide.
 */
import { sql } from 'drizzle-orm';
import type { Tx } from '../client';

export const SERVICE_CHARGE_FLOAT_CODE = '2160';

/**
 * That store's own `2160` balance, derived from the ledger — credits minus debits, non-draft
 * entries only. Returns the database's own `numeric(14,2)::text` value UNCONVERTED, the same
 * "the repo hands back what the database computed" shape as `liabilitiesRepo.positionOf` — the
 * domain layer converts once, the same way it already does for every other control-account
 * balance in this codebase (`payLiability`, `ap`, `ar`).
 */
export async function floatBalance(tx: Tx, orgId: string, storeId: string): Promise<string> {
  const [row] = (await tx.execute(sql`
    select coalesce(sum(jl.credit - jl.debit), 0)::text as balance
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a        on a.id = jl.account_id
    where je.org_id = ${orgId}
      and jl.store_id = ${storeId}
      and a.code = ${SERVICE_CHARGE_FLOAT_CODE}
      and je.status <> 'draft'
  `)) as unknown as Record<string, string>[];
  return row?.balance ?? '0';
}
