/**
 * T-629 - the one shared way a test inserts a store tender by raw SQL. A tender row needs `payment_option_id` (NOT NULL), so this finds the org's payment option
 * by the same normalised name the app uses (lowercase, a-z0-9 only) or makes it, then inserts the tender. Returns the tender id. The 0277 mirror trigger sets the
 * tender's name and kind from the option, so the name given here is the option's name when the option is new.
 */
import type postgres from 'postgres';

export interface RawTender {
  readonly orgId: string;
  readonly storeId: string;
  readonly name: string;
  readonly kind: string;
  readonly moneyAccountId?: string | null;
  readonly posV1Alias?: string | null;
  readonly isActive?: boolean;
}

export async function insertTenderRaw(sql: postgres.Sql | postgres.TransactionSql, t: RawTender): Promise<string> {
  const key = t.name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const [have] = await sql<{ id: string }[]>`
    select id from payment_options where org_id = ${t.orgId} and regexp_replace(lower(name), '[^a-z0-9]', '', 'g') = ${key}`;
  const optionId =
    have?.id ??
    (
      await sql<{ id: string }[]>`
        insert into payment_options (org_id, name, kind, sort_order) values (${t.orgId}, ${t.name.trim().slice(0, 40)}, ${t.kind}, 100) returning id`
    )[0]!.id;
  const [row] = await sql<{ id: string }[]>`
    insert into tenders (org_id, store_id, payment_option_id, name, kind, money_account_id, pos_v1_alias, is_active)
    values (${t.orgId}, ${t.storeId}, ${optionId}, ${t.name}, ${t.kind}, ${t.moneyAccountId ?? null}, ${t.posV1Alias ?? null}, ${t.isActive ?? true}) returning id`;
  return row!.id;
}
