/**
 * T-401 S1 audit round - concurrency. TESTER. Two SEPARATE connections, explicit BEGIN, deliberate ordering.
 *
 * Why: every guard in 0196 is a trigger that READS other rows. Under READ COMMITTED two transactions each see the
 * other's work as absent until it commits, so two guards that are each correct alone can both pass and together
 * break the invariant (write skew). The tests assert the FINAL DATABASE STATE, never who lost, so any correct
 * serialisation (row lock, advisory lock, SERIALIZABLE retry) passes and no ordering luck is needed.
 *
 * Mechanics (no flakiness): X holds an open transaction after its statement; Y's statement is launched, then the
 * test sleeps PAUSE_MS so Y either completes (no locking: the bug) or is blocked on X (locking); X commits; Y's
 * outcome is awaited with a hard timeout, and Y commits only if its statement succeeded. lock_timeout bounds a
 * blocked Y so a hang becomes a failure rather than a stuck suite.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

import { insOffer, insRule, menuFixture, newItem, sql, type MenuFx } from './_fixtures/t401-menu';

vi.setConfig({ testTimeout: 45000 });
const PAUSE_MS = 700;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const url = process.env.TEST_DATABASE_URL!;
const cx = postgres(url, { max: 1 });
const cy = postgres(url, { max: 1 });

afterAll(async () => {
  await cx.end({ timeout: 5 });
  await cy.end({ timeout: 5 });
  await sql.end({ timeout: 5 });
});

type Stmt = (c: postgres.Sql) => PromiseLike<unknown>;

/** X runs `first` and holds; Y runs `second` (may block); X commits; Y commits if it succeeded. */
async function race(first: Stmt, second: Stmt): Promise<{ xOk: boolean; yOk: boolean; yErr?: string }> {
  await cx.unsafe('begin');
  await cy.unsafe('begin');
  await cx.unsafe(`set local lock_timeout = '8s'`);
  await cy.unsafe(`set local lock_timeout = '8s'`);
  let xOk = true;
  try {
    await first(cx);
  } catch {
    xOk = false;
  }
  const yP = Promise.resolve(second(cy)).then(
    () => ({ ok: true as const }),
    (e: Error) => ({ ok: false as const, msg: e.message }),
  );
  await sleep(PAUSE_MS);
  if (xOk) {
    try {
      await cx.unsafe('commit');
    } catch {
      xOk = false;
    }
  } else {
    await cx.unsafe('rollback');
  }
  const timeout = sleep(20000).then(() => 'timeout' as const);
  const y = await Promise.race([yP, timeout]);
  if (y === 'timeout') {
    await cy.unsafe('rollback').catch(() => undefined);
    throw new Error('second transaction neither completed nor failed within 20s (hang)');
  }
  let yOk = y.ok;
  if (y.ok) {
    try {
      await cy.unsafe('commit');
    } catch {
      yOk = false;
    }
  } else {
    await cy.unsafe('rollback').catch(() => undefined);
  }
  return { xOk, yOk, yErr: y.ok ? undefined : y.msg };
}

const rulesCovering = async (variantId: string, at: string) =>
  ((await sql`select count(*)::int n from menu_depletion_rules where variant_id = ${variantId} and effective_from <= ${at}`) as unknown as [{ n: number }])[0].n;

describe('C1 -- write skew: two rules each cover the offer; deleting both concurrently', () => {
  it('(a) X deletes R1, Y deletes R2 -> at most one commits; the offer keeps a rule in force', async () => {
    const f = await menuFixture('c1a');
    const [r1] = await insRule(f, f.variantId, '1 hour');
    const [r2] = await insRule(f, f.variantId, '90 minutes');
    const [offer] = await insOffer(f, f.variantId, '10.00', '3 hours');
    const at = (await sql<{ t: string }[]>`select effective_from::text t from menu_offers where id = ${offer!.id}`)[0]!.t;
    const out = await race(
      (c) => c`delete from menu_depletion_rules where id = ${r1!.id}`,
      (c) => c`delete from menu_depletion_rules where id = ${r2!.id}`,
    );
    const left = await rulesCovering(f.variantId, at);
    expect(left, `both deletes committed (xOk=${out.xOk}, yOk=${out.yOk}): the live offer at ${at} has NO rule in force`).toBeGreaterThanOrEqual(1);
    expect(out.xOk && out.yOk).toBe(false);
  });
});

describe('C2 -- an offer INSERT racing a rule DELETE never leaves a live offer without a rule', () => {
  it.each([
    ['rule delete first, offer insert second', true],
    ['offer insert first, rule delete second', false],
  ])('(b) %s', async (_label, deleteFirst) => {
    const f = await menuFixture('c2');
    const [rule] = await insRule(f, f.variantId, '1 hour');
    const del: Stmt = (c) => c`delete from menu_depletion_rules where id = ${rule!.id}`;
    const ins: Stmt = (c) =>
      c`insert into menu_offers (org_id, store_id, variant_id, channel, effective_from, amount, withdrawn, created_by)
        values (${f.orgId}, ${f.storeId}, ${f.variantId}, 'store', now() + interval '2 hours', 10, false, ${f.personId})`;
    const out = deleteFirst ? await race(del, ins) : await race(ins, del);
    const [{ rules }] = (await sql`select count(*)::int rules from menu_depletion_rules where variant_id = ${f.variantId}`) as unknown as [{ rules: number }];
    const [{ offers }] = (await sql`select count(*)::int offers from menu_offers where variant_id = ${f.variantId} and not withdrawn`) as unknown as [{ offers: number }];
    expect(
      offers === 0 || rules >= 1,
      `both committed (xOk=${out.xOk}, yOk=${out.yOk}): ${offers} live offer(s) and ${rules} rule(s) - an orphaned offer`,
    ).toBe(true);
  });
});

describe('C3 -- retiring a variant racing a live-offer INSERT never leaves a retired variant with a live offer', () => {
  async function fixtureWithSibling(): Promise<{ f: MenuFx; variantId: string }> {
    const f = await menuFixture('c3');
    const sib = await newItem(f, 'a_la_carte');
    const [v] = await sql<{ id: string }[]>`
      insert into menu_item_variants (org_id, menu_item_id, label, is_default, sort_order, status, created_by)
      values (${f.orgId}, ${sib.itemId}, 'Large', false, 1, 'active', ${f.personId}) returning id`;
    await insRule(f, v!.id);
    return { f, variantId: v!.id };
  }
  it.each([
    ['retire first, offer insert second', true],
    ['offer insert first, retire second', false],
  ])('(c) %s', async (_label, retireFirst) => {
    const { f, variantId } = await fixtureWithSibling();
    const retire: Stmt = (c) => c`update menu_item_variants set status = 'retired' where id = ${variantId}`;
    const ins: Stmt = (c) =>
      c`insert into menu_offers (org_id, store_id, variant_id, channel, amount, withdrawn, created_by)
        values (${f.orgId}, ${f.storeId}, ${variantId}, 'store', 10, false, ${f.personId})`;
    const out = retireFirst ? await race(retire, ins) : await race(ins, retire);
    const [{ bad }] = (await sql`
      select count(*)::int bad from menu_item_variants v
       where v.id = ${variantId} and v.status = 'retired'
         and exists (select 1 from menu_offers o where o.variant_id = v.id and not o.withdrawn)`) as unknown as [{ bad: number }];
    expect(bad, `both committed (xOk=${out.xOk}, yOk=${out.yOk}): a retired variant holds a live offer`).toBe(0);
  });
});

describe('C4 -- retiring an ITEM racing a live-offer INSERT on one of its variants', () => {
  it.each([
    ['retire first, offer insert second', true],
    ['offer insert first, retire second', false],
  ])('(c4) %s', async (_label, retireFirst) => {
    const f = await menuFixture('c4');
    await insRule(f, f.variantId);
    const retire: Stmt = (c) => c`update menu_items set status = 'retired' where id = ${f.itemId}`;
    const ins: Stmt = (c) =>
      c`insert into menu_offers (org_id, store_id, variant_id, channel, amount, withdrawn, created_by)
        values (${f.orgId}, ${f.storeId}, ${f.variantId}, 'store', 10, false, ${f.personId})`;
    const out = retireFirst ? await race(retire, ins) : await race(ins, retire);
    const [{ bad }] = (await sql`
      select count(*)::int bad from menu_items i
       where i.id = ${f.itemId} and i.status = 'retired'
         and exists (select 1 from menu_offers o join menu_item_variants v on v.id = o.variant_id
                      where v.menu_item_id = i.id and not o.withdrawn)`) as unknown as [{ bad: number }];
    expect(bad, `both committed (xOk=${out.xOk}, yOk=${out.yOk}): a retired item holds a live offer`).toBe(0);
  });
});

describe('C5 -- item_type change racing the rows whose validity depends on it', () => {
  it.each([
    ['type change first, offer insert second', true],
    ['offer insert first, type change second', false],
  ])('(a) item becomes refill while an offer with an amount lands: %s', async (_label, changeFirst) => {
    const f = await menuFixture('c5a');
    await insRule(f, f.variantId);
    const change: Stmt = (c) => c`update menu_items set item_type = 'refill', sold_a_la_carte = false where id = ${f.itemId}`;
    const ins: Stmt = (c) =>
      c`insert into menu_offers (org_id, store_id, variant_id, channel, amount, withdrawn, created_by)
        values (${f.orgId}, ${f.storeId}, ${f.variantId}, 'store', 10, false, ${f.personId})`;
    const out = changeFirst ? await race(change, ins) : await race(ins, change);
    const [{ bad }] = (await sql`
      select count(*)::int bad from menu_offers o join menu_item_variants v on v.id = o.variant_id join menu_items i on i.id = v.menu_item_id
       where i.id = ${f.itemId} and i.item_type = 'refill' and not o.withdrawn and o.amount is not null`) as unknown as [{ bad: number }];
    expect(bad, `both committed (xOk=${out.xOk}, yOk=${out.yOk}): a refill carries a priced offer (I3)`).toBe(0);
  });

  it.each([
    ['package stops being a package', 'package', true],
    ['package stops being a package (refills insert first)', 'package', false],
    ['refill stops being a refill', 'refill', true],
    ['refill stops being a refill (refills insert first)', 'refill', false],
  ] as const)('(b) %s, racing a menu_package_refills insert', async (_label, side, changeFirst) => {
    const f = await menuFixture('c5b');
    const pkg = await newItem(f, 'package');
    const refill = await newItem(f, 'refill');
    const target = side === 'package' ? pkg.itemId : refill.itemId;
    const change: Stmt = (c) => c`update menu_items set item_type = 'a_la_carte', sold_a_la_carte = true where id = ${target}`;
    const ins: Stmt = (c) =>
      c`insert into menu_package_refills (org_id, package_variant_id, refill_item_id, created_by)
        values (${f.orgId}, ${pkg.variantId}, ${refill.itemId}, ${f.personId})`;
    const out = changeFirst ? await race(change, ins) : await race(ins, change);
    const [{ bad }] = (await sql`
      select count(*)::int bad from menu_package_refills r
        join menu_item_variants v on v.id = r.package_variant_id join menu_items pi on pi.id = v.menu_item_id
        join menu_items ri on ri.id = r.refill_item_id
       where r.org_id = ${f.orgId} and (pi.item_type <> 'package' or ri.item_type <> 'refill')`) as unknown as [{ bad: number }];
    expect(bad, `both committed (xOk=${out.xOk}, yOk=${out.yOk}): a package_refills row pairs the wrong types (I10)`).toBe(0);
  });
});
