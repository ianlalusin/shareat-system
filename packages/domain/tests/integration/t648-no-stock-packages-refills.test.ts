/**
 * T-648 - one click sets every active package and refill variant to "Uses no stock". docs/tasks/648-no-stock-packages-refills.md.
 * Real Postgres, real authorize(), real RLS principal.
 *
 * Mutants killed: drop the item_type filter (the a-la-carte variant changes); drop the "already no_stock" filter (a duplicate row,
 * and `changed` is too big); drop the item/variant active filter (the inactive package changes); drop the history-clash skip (the batch
 * refuses and rolls back instead of skipping); drop authorize (the manager writes).
 */
import { afterAll, describe, expect, it } from 'vitest';

import { AuthorizationError } from '@shareat/auth';
import { setNoStockForPackagesAndRefills } from '@shareat/domain';
import { menuRepo } from '@shareat/db';

import { asOrg, attempt, auditCount, cast, rawItem, rawRule, sql, type Cast } from './_fixtures/t401-s2-menu';

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

const directRule = (c: Cast, variantId: string, when = 'now()') =>
  sql.unsafe(
    `insert into menu_depletion_rules (org_id, variant_id, mode, item_id, quantity_per_sale, effective_from, created_by)
     values ($1, $2, 'direct', $3, 1, ${when}, $4)`,
    [c.orgId, variantId, c.stockItemId, c.admin.personId],
  );
const rulesOf = async (variantId: string) =>
  sql<{ mode: string }[]>`select mode from menu_depletion_rules where variant_id = ${variantId} order by effective_from, created_at`;

async function world() {
  const c = await cast('t648');
  const pkg = await rawItem(c, 'package');
  await directRule(c, pkg.variantId);
  const refill = await rawItem(c, 'refill'); // no rule at all
  const alc = await rawItem(c, 'a_la_carte');
  await directRule(c, alc.variantId);
  const inactive = await rawItem(c, 'package');
  await directRule(c, inactive.variantId);
  await sql`update menu_items set status = 'retired' where id = ${inactive.itemId}`;
  const already = await rawItem(c, 'package');
  await rawRule(c, already.variantId);
  return { c, pkg, refill, alc, inactive, already };
}

describe('T-648 setNoStockForPackagesAndRefills', () => {
  it('sets package + refill to no_stock; leaves a-la-carte, the inactive package and the already-no_stock one alone', async () => {
    const w = await world();
    const todo = await asOrg(w.c.orgId, (tx) => menuRepo.packageRefillVariantsNeedingNoStock(tx, w.c.orgId));
    expect(todo.map((t) => t.variantId).sort()).toEqual([w.pkg.variantId, w.refill.variantId].sort());
    const audits = await auditCount(w.c.orgId);
    const r = await asOrg(w.c.orgId, (tx) => setNoStockForPackagesAndRefills(w.c.admin, tx));
    expect(r).toEqual({ changed: 2, skipped: [] });
    expect((await rulesOf(w.pkg.variantId)).map((x) => x.mode)).toEqual(['direct', 'no_stock']);
    expect((await rulesOf(w.refill.variantId)).map((x) => x.mode)).toEqual(['no_stock']);
    expect((await rulesOf(w.alc.variantId)).map((x) => x.mode)).toEqual(['direct']);
    expect((await rulesOf(w.inactive.variantId)).map((x) => x.mode)).toEqual(['direct']);
    expect((await rulesOf(w.already.variantId)).map((x) => x.mode)).toEqual(['no_stock']);
    expect(await auditCount(w.c.orgId)).toBe(audits + 2);
    // Run again: nothing left, nothing written.
    const again = await asOrg(w.c.orgId, (tx) => setNoStockForPackagesAndRefills(w.c.admin, tx));
    expect(again).toEqual({ changed: 0, skipped: [] });
  });

  it('a person without set_menu_depletion is refused and nothing is written', async () => {
    const w = await world();
    const before = { audit: await auditCount(w.c.orgId), rules: (await rulesOf(w.refill.variantId)).length };
    const r = await attempt(() => asOrg(w.c.orgId, (tx) => setNoStockForPackagesAndRefills(w.c.manager, tx)));
    expect(r.failed).toBe(true);
    expect(r.error).toBeInstanceOf(AuthorizationError);
    expect((r.error as AuthorizationError).capability).toBe('set_menu_depletion');
    expect((await rulesOf(w.refill.variantId)).length).toBe(before.rules);
    expect(await auditCount(w.c.orgId)).toBe(before.audit);
  });

  it('a variant with a scheduled future rule is skipped and reported; the others still change', async () => {
    const w = await world();
    await directRule(w.c, w.pkg.variantId, `now() + interval '7 days'`);
    const r = await asOrg(w.c.orgId, (tx) => setNoStockForPackagesAndRefills(w.c.admin, tx));
    expect(r.changed).toBe(1);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]).toMatchObject({ variantId: w.pkg.variantId, reason: 'scheduled_change' });
    expect(typeof r.skipped[0]!.itemName).toBe('string');
    expect((await rulesOf(w.pkg.variantId)).map((x) => x.mode)).toEqual(['direct', 'direct']);
    expect((await rulesOf(w.refill.variantId)).map((x) => x.mode)).toEqual(['no_stock']);
  });
});
