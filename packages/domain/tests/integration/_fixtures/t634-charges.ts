/**
 * T-634 (0278) - a store charge row needs its org charge option (charge_option_id is NOT NULL). Tests that used to insert a `pos_charge_presets` row straight away
 * call this instead: it finds or makes the org's option of that name (same a-z0-9 key as the unique index) at that amount / per unit, then inserts the store's
 * switch row for it. The 0278 trigger copies the option's name, amount and per unit onto the row, as in production.
 */
type Sql = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;

export async function chargePresetRow(
  sql: Sql,
  o: { orgId: string; storeId: string; name: string; amount: string; perUnit?: boolean; status?: 'active' | 'retired'; createdBy: string },
): Promise<string> {
  const perUnit = o.perUnit ?? false;
  const key = o.name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const found = (await sql`
    select id from charge_options where org_id = ${o.orgId} and coalesce(nullif(regexp_replace(lower(name), '[^a-z0-9]', '', 'g'), ''), lower(btrim(name))) = ${key}`) as { id: string }[];
  const optionId =
    found[0]?.id ??
    ((await sql`insert into charge_options (org_id, name, amount, per_unit) values (${o.orgId}, ${o.name}, ${o.amount}, ${perUnit}) returning id`) as { id: string }[])[0]!.id;
  const [row] = (await sql`
    insert into pos_charge_presets (org_id, store_id, charge_option_id, name, amount, per_unit, status, created_by)
    values (${o.orgId}, ${o.storeId}, ${optionId}, ${o.name}, ${o.amount}, ${perUnit}, ${o.status ?? 'active'}, ${o.createdBy}) returning id`) as { id: string }[];
  return row!.id;
}

/** The option id behind a store charge row. */
export async function optionOf(sql: Sql, presetId: string): Promise<string> {
  return ((await sql`select charge_option_id as id from pos_charge_presets where id = ${presetId}`) as { id: string }[])[0]!.id;
}
