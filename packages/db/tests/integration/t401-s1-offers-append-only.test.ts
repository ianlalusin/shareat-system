/**
 * T-401 S1 (migration 0196) - I1 and I1b. docs/tasks/401-erp-menu-catalog-master.md sections 2 (R5, R6) and 4.
 * TESTER, not BUILDER. Real Postgres, raw SQL as the migration role (triggers fire for the owner too).
 *
 * ## Why these are red today
 * The ten menu_* tables do not exist (0196 is not written), so every fixture fails on
 * `relation "menu_categories" does not exist`. That is NOT the red that counts; the assertions below are what
 * must hold once the tables exist. Each names the mutant it kills.
 *
 * ## Where the spec is silent (read, not invented)
 *  - Refusal TEXT is matched loosely on the spec's own words (append-only / back-dat / future); SQLSTATE is
 *    not pinned for trigger refusals because the spec names none.
 *  - A row "in effect" is made by inserting with the now() default and then acting in a LATER statement.
 */
import { afterAll, describe, expect, it } from 'vitest';

import { insOffer, insOptionOffer, insRule, menuFixture, newOption, refusal, sql, asApp, type MenuFx } from './_fixtures/t401-menu';

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

/** Everything needed so an offer can be live: a rule in force for the default variant. */
async function liveFx(hint: string): Promise<MenuFx> {
  const f = await menuFixture(hint);
  await insRule(f, f.variantId);
  return f;
}

type Kind = 'rule' | 'offer' | 'option_offer';
const KINDS: Kind[] = ['rule', 'offer', 'option_offer'];
const TABLE: Record<Kind, string> = { rule: 'menu_depletion_rules', offer: 'menu_offers', option_offer: 'menu_option_offers' };

/** Insert one row of the kind. `at` null = in effect now (the now() default). Returns the id. */
async function put(kind: Kind, f: MenuFx, at: string | null, ctx: { variantId?: string; valueId?: string } = {}): Promise<string> {
  if (kind === 'rule') {
    // A second rule on the fixture variant, so it never collides with liveFx's own (variant, effective_from).
    const [row] = await insRule(f, ctx.variantId ?? f.variantId, at ?? '0 seconds');
    return row!.id as string;
  }
  if (kind === 'offer') {
    const [row] = await insOffer(f, ctx.variantId ?? f.variantId, '99.00', at);
    return row!.id as string;
  }
  const [row] = await insOptionOffer(f, ctx.valueId!, '5.00', at);
  return row!.id as string;
}

async function ctxFor(kind: Kind, f: MenuFx) {
  if (kind === 'option_offer') return { valueId: (await newOption(f)).valueId };
  return {};
}

describe('I1 -- an offer, option offer or depletion rule is never UPDATEd; a row in effect is never DELETEd; a future row may be', () => {
  it.each(KINDS)('%s: UPDATE of a row in effect is refused and the row is unchanged', async (kind) => {
    const f = await liveFx(`i1u-${kind}`);
    const ctx = await ctxFor(kind, f);
    // 'rule' is already in effect via liveFx.
    const id = kind === 'rule' ? ((await sql<{ id: string }[]>`select id from menu_depletion_rules where org_id = ${f.orgId}`)[0]!.id) : await put(kind, f, null, ctx);
    const col = kind === 'rule' ? 'quantity_per_sale' : kind === 'offer' ? 'amount' : 'price_delta';
    const before = (await sql.unsafe(`select ${col}::text as v from ${TABLE[kind]} where id = '${id}'`))[0]!.v;
    const err = await refusal(() => sql.unsafe(`update ${TABLE[kind]} set ${col} = 1.5 where id = '${id}'`));
    expect(err, `${TABLE[kind]}: an UPDATE was accepted`).toBeDefined();
    expect(err!.message).toMatch(/append-only|never updated|immutable/i);
    const after = (await sql.unsafe(`select ${col}::text as v from ${TABLE[kind]} where id = '${id}'`))[0]!.v;
    expect(after).toBe(before);
  });

  it.each(KINDS)('%s: UPDATE of a FUTURE row is refused too (no UPDATE ever, not merely after it takes effect)', async (kind) => {
    const f = await liveFx(`i1uf-${kind}`);
    const ctx = await ctxFor(kind, f);
    const id = await put(kind, f, '1 day', ctx);
    const col = kind === 'rule' ? 'quantity_per_sale' : kind === 'offer' ? 'amount' : 'price_delta';
    const err = await refusal(() => sql.unsafe(`update ${TABLE[kind]} set ${col} = 1.5 where id = '${id}'`));
    expect(err, `${TABLE[kind]}: an UPDATE of a scheduled row was accepted`).toBeDefined();
  });

  it.each(KINDS)('%s: DELETE of a row already in effect is refused and the row survives (mutant: trigger allows DELETE regardless of effective_from)', async (kind) => {
    const f = await liveFx(`i1d-${kind}`);
    const ctx = await ctxFor(kind, f);
    const id = kind === 'rule' ? ((await sql<{ id: string }[]>`select id from menu_depletion_rules where org_id = ${f.orgId}`)[0]!.id) : await put(kind, f, null, ctx);
    // Separate statement, so the row's now() default is strictly in the past.
    const err = await refusal(() => sql.unsafe(`delete from ${TABLE[kind]} where id = '${id}'`));
    expect(err, `${TABLE[kind]}: DELETE of a row in effect was accepted`).toBeDefined();
    expect(err!.message).toMatch(/append-only|in effect|never deleted|future/i);
    const [{ n }] = (await sql.unsafe(`select count(*)::int as n from ${TABLE[kind]} where id = '${id}'`)) as unknown as [{ n: number }];
    expect(n).toBe(1);
  });

  it.each(KINDS)('%s: DELETE of a FUTURE row is allowed, as shareat_app (a cancelled scheduled change)', async (kind) => {
    const f = await liveFx(`i1df-${kind}`);
    const ctx = await ctxFor(kind, f);
    const id = await put(kind, f, '1 day', ctx);
    // A scheduled rule with no live offer relying on it is deletable. The tx rolls back: the owner reads nothing deleted.
    const r = await asApp(f.orgId, async (tx) => {
      const del = await tx.unsafe(`delete from ${TABLE[kind]} where id = '${id}' returning id`);
      return del.length;
    });
    expect(r.err, `${TABLE[kind]}: shareat_app could not DELETE a future row: ${r.err?.message}`).toBeUndefined();
    expect(r.value).toBe(1);
  });

  it('shareat_app holds no UPDATE grant on the three tables (grants: SELECT + INSERT [+ future DELETE] only)', async () => {
    const f = await liveFx('i1grant');
    const [offer] = await insOffer(f, f.variantId, '10.00');
    const r = await asApp(f.orgId, (tx) => tx.unsafe(`update menu_offers set amount = 1 where id = '${offer!.id}'`));
    expect(r.err?.code, 'UPDATE as shareat_app must be a permission error').toBe('42501');
  });
});

describe('I1b -- no back-dating: effective_from < now() is refused on all three tables; the now() default passes', () => {
  it('menu_offers: now() - 1 minute refused, no row written; omitted effective_from accepted', async () => {
    const f = await liveFx('i1b-o');
    const err = await refusal(
      () => sql`insert into menu_offers (org_id, store_id, variant_id, channel, effective_from, amount, withdrawn, created_by)
                values (${f.orgId}, ${f.storeId}, ${f.variantId}, 'store', now() - interval '1 minute', 50, false, ${f.personId})`,
    );
    expect(err, 'a back-dated offer was accepted').toBeDefined();
    expect(err!.message).toMatch(/back-?dat|past|effective_from/i);
    const n = (await sql<{ n: number }[]>`select count(*)::int n from menu_offers where org_id = ${f.orgId}`)[0]!.n;
    expect(n).toBe(0);
    const ok = await refusal(() => insOffer(f, f.variantId, '50.00'));
    expect(ok, `the now() default must pass: ${ok?.message}`).toBeUndefined();
  });

  it('menu_option_offers: now() - 1 minute refused; omitted effective_from accepted', async () => {
    const f = await menuFixture('i1b-oo');
    const { valueId } = await newOption(f);
    const err = await refusal(
      () => sql`insert into menu_option_offers (org_id, store_id, option_value_id, channel, effective_from, price_delta, withdrawn, created_by)
                values (${f.orgId}, ${f.storeId}, ${valueId}, 'store', now() - interval '1 minute', 5, false, ${f.personId})`,
    );
    expect(err, 'a back-dated option offer was accepted').toBeDefined();
    expect(err!.message).toMatch(/back-?dat|past|effective_from/i);
    const ok = await refusal(() => insOptionOffer(f, valueId, '5.00'));
    expect(ok, `the now() default must pass: ${ok?.message}`).toBeUndefined();
  });

  it('menu_depletion_rules: now() - 1 minute refused; omitted effective_from accepted', async () => {
    const f = await menuFixture('i1b-r');
    const err = await refusal(
      () => sql`insert into menu_depletion_rules (org_id, variant_id, effective_from, mode, item_id, quantity_per_sale, created_by)
                values (${f.orgId}, ${f.variantId}, now() - interval '1 minute', 'direct', ${f.stockItemId}, 0.2, ${f.personId})`,
    );
    expect(err, 'a back-dated rule was accepted').toBeDefined();
    expect(err!.message).toMatch(/back-?dat|past|effective_from/i);
    const ok = await refusal(() => insRule(f, f.variantId));
    expect(ok, `the now() default must pass: ${ok?.message}`).toBeUndefined();
  });

  it('a future-dated insert (now() + 1 day) is accepted on all three tables (control: the guard is one-sided)', async () => {
    const f = await liveFx('i1b-fut');
    const { valueId } = await newOption(f);
    expect(await refusal(() => insOffer(f, f.variantId, '60.00', '1 day'))).toBeUndefined();
    expect(await refusal(() => insOptionOffer(f, valueId, '5.00', '1 day'))).toBeUndefined();
    expect(await refusal(() => insRule(f, f.variantId, '1 day'))).toBeUndefined();
  });
});
