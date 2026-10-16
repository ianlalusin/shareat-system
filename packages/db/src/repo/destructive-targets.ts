/**
 * T-412 - the record behind a destructive button: its STORE (and name, and status where the screen needs them), loaded by
 * the server action itself, never read from the form (docs/tasks/412-confirm-destructive-tiers.md V6, V8).
 *
 * One whitelisted map, one query shape. The identifiers below are a closed constant set - nothing from a caller is ever
 * spliced into the SQL; the id and org are bound parameters. The read runs under the caller's org principal (RLS), and
 * filters by org again where the table carries `org_id` (bible §15.11: no layer may be the only one).
 */
import { sql, type SQL } from 'drizzle-orm';
import type { Tx } from '../client';

interface TargetDef {
  readonly table: string;
  /** SQL for the record's store, over alias `t`; null when the record has none (an organisation-level record). */
  readonly store: SQL | null;
  /** SQL for the record's display name (Tier R retype), over alias `t`. */
  readonly name?: SQL;
  /** SQL for the record's status text, over alias `t`. */
  readonly status?: SQL;
  /** false for the few tables without an `org_id` column (RLS reaches them through a parent). */
  readonly org?: false;
}

export const DESTRUCTIVE_TARGETS = {
  // ---- Tier P ----
  expense: { table: 'expenses', store: sql`t.store_id` },
  supplier_invoice: { table: 'supplier_invoices', store: sql`t.store_id` },
  ap_payment: { table: 'ap_payments', store: sql`t.store_id` },
  attendance_day: { table: 'attendance_days', store: sql`t.store_id` },
  channel_settlement: { table: 'channel_settlements', store: sql`t.store_id` },
  trade_order: { table: 'trade_orders', store: sql`t.store_id`, status: sql`t.status` },
  ar_charge: { table: 'ar_charges', store: sql`t.store_id` },
  owner: { table: 'owners', store: sql`t.store_id` },
  ar_collection: { table: 'ar_collections', store: sql`t.store_id` },
  recurring_expense: { table: 'recurring_expenses', store: sql`t.store_id` },
  fixed_asset: { table: 'fixed_assets', store: sql`t.store_id` },
  pos_usage_pull: { table: 'pos_usage_pulls', store: sql`t.store_id` },
  production_record: { table: 'production_records', store: sql`t.store_id` },
  supplier_return: { table: 'supplier_returns', store: sql`t.store_id` },
  stock_transfer: { table: 'stock_transfers', store: sql`t.store_id` },
  stock_usage_record: { table: 'stock_usage_records', store: sql`t.store_id` },
  liability: { table: 'liabilities', store: sql`t.store_id`, name: sql`t.name` },
  loan: { table: 'loans', store: sql`t.store_id` },
  money_transfer: { table: 'money_transfers', store: sql`t.store_id` },
  pay_run: { table: 'pay_runs', store: sql`t.store_id` },
  separation: { table: 'separations', store: sql`t.store_id` },
  thirteenth_month_run: { table: 'thirteenth_month_runs', store: sql`t.store_id` },
  prepaid_item: { table: 'prepaid_items', store: sql`t.store_id` },
  remittance: { table: 'remittances', store: sql`t.store_id` },
  sales_day: { table: 'sales_days', store: sql`t.store_id`, status: sql`t.status` },
  employment: { table: 'employments', store: sql`t.store_id` },
  statutory_discount: { table: 'statutory_discount_records', store: sql`t.store_id` },
  customer_return: { table: 'customer_returns', store: sql`t.store_id` },
  order_wastage: { table: 'order_wastages', store: sql`t.store_id` },
  // ---- Tier R: the NAME the person must retype, loaded here, never taken from the form ----
  store_position: { table: 'positions', store: null, name: sql`t.name` },
  person_grant: { table: 'person_grants', store: null, name: sql`t.grant_name`, org: false },
  person_credential: {
    table: 'person_credentials',
    store: null,
    name: sql`(select p.display_name from persons p where p.id = t.person_id)`,
    org: false,
  },
  clock_terminal: { table: 'clock_terminals', store: sql`t.store_id`, name: sql`t.label` },
  expense_budget: { table: 'expense_budgets', store: sql`t.store_id`, name: sql`(select c.category from expense_categories c where c.id = t.category_id)` },
  commissary_item_map: { table: 'commissary_item_map', store: sql`t.branch_store_id`, name: sql`(select i.name from items i where i.id = t.branch_item_id)` },
  item: { table: 'items', store: null, name: sql`t.name` },
  menu_category: { table: 'menu_categories', store: null, name: sql`t.name` },
  production_recipe: { table: 'production_recipes', store: null, name: sql`t.name` },
  money_account: { table: 'money_accounts', store: null, name: sql`t.name` },
  store: { table: 'stores', store: null, name: sql`t.name` },
  person: { table: 'persons', store: null, name: sql`t.display_name` },
  tender: { table: 'tenders', store: sql`t.store_id`, name: sql`t.name` },
  attendance_credential: {
    table: 'attendance_credentials',
    store: sql`t.store_id`,
    name: sql`(select p.display_name from employments e join persons p on p.id = e.person_id where e.id = t.employment_id)`,
  },
  stock_location: { table: 'stock_locations', store: sql`t.store_id`, name: sql`t.name` },
} as const satisfies Record<string, TargetDef>;

export type DestructiveEntity = keyof typeof DESTRUCTIVE_TARGETS;

export interface DestructiveTarget {
  storeId: string | null;
  name: string | null;
  status: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The record's store / name / status, or null when it does not exist (or is not this org's). */
export async function targetOf(tx: Tx, orgId: string, entity: DestructiveEntity, id: string): Promise<DestructiveTarget | null> {
  if (!UUID.test(id)) return null;
  const def: TargetDef = DESTRUCTIVE_TARGETS[entity];
  const rows = (await tx.execute(sql`
    select ${def.store ?? sql`null`}::text as store_id,
           ${def.name ?? sql`null`}::text as name,
           ${def.status ?? sql`null`}::text as status
      from ${sql.identifier(def.table)} t
     where t.id = ${id}::uuid ${def.org === false ? sql`` : sql`and t.org_id = ${orgId}::uuid`}
  `)) as unknown as { store_id: string | null; name: string | null; status: string | null }[];
  const r = rows[0];
  return r ? { storeId: r.store_id, name: r.name, status: r.status } : null;
}
