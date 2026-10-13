/**
 * T-401 S2, I17: every audited write. docs/tasks/401-erp-menu-catalog-master.md section 3 ("every one takes (actor, input, tx?), calls
 * authorize() first, writes one audit_log row") and section 4 I17. TESTER, not BUILDER. Real Postgres, admin actor, one org.
 *
 * One `audited(...)` assertion per mutating function (23), each labelled with the function name, so a function that skips the audit is
 * named by the failure message (mutant: one function skips the audit). Each call must leave EXACTLY ONE new audit_log row for the org (not two: a double write is as wrong as none), naming:
 *   actor_person_id = the actor; entity = the TABLE name of the primary row; entity_id = that row's id;
 *   a non-empty action; before / after = JSON of the row: create -> before null, after set; edit and retire -> both set and different;
 *   unlink and cancel (a DELETE) -> before set, after null.
 * Primary row per function: the create, add and set functions -> the row written (returned `id`); the edit, retire, cancel and unlink functions -> the row named by `id`;
 * setPackageRefills -> entity menu_package_refills, entity_id = the package variant id (it replaces a set, so the package is the subject).
 *
 * ## Assumed signatures (all `(actor, input, tx?)`; ids come back as `{ id }`, createMenuItem also `{ defaultVariantId }`)
 *   createMenuCategory { name } · editMenuCategory { id, name } · retireMenuCategory { id }
 *   createMenuItem { categoryId, name, itemType } · editMenuItem { id, name } · retireMenuItem { id }
 *   addMenuVariant { menuItemId, label } · editMenuVariant { id, label } · retireMenuVariant { id }
 *   createOptionGroup { name, selectionMode, minSelections, maxSelections } · editOptionGroup { id, name }
 *   addOptionValue { optionGroupId, name } · editOptionValue { id, name }
 *   linkOptionGroup { optionGroupId, menuItemId } · unlinkOptionGroup { id }
 *   setPackageRefills { packageVariantId, refillItemIds: string[] }
 *   setDepletionRule { variantId, mode: 'no_stock', effectiveFrom? } · cancelScheduledDepletionRule { id }
 *   setMenuOffer { storeId, variantId, channel, amount, effectiveFrom? } · withdrawMenuOffer { storeId, variantId, channel, effectiveFrom? } · cancelScheduledOffer { id, storeId }
 *   setOptionOffer { storeId, optionValueId, channel, priceDelta, effectiveFrom? } · cancelScheduledOptionOffer { id, storeId }
 * Red today: packages/domain/src/menu does not exist (`x is not a function`).
 */
import { afterAll, describe, expect, it } from 'vitest';

import * as D from '@shareat/domain';

import { asOrg, auditCount, cast, rawItem, rawOption, rawRule, sql, type Cast } from './_fixtures/t401-s2-menu';

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

const HOUR = 3_600_000;
const soon = (h: number) => new Date(Date.now() + h * HOUR);

type Kind = 'create' | 'edit' | 'delete';
interface AuditRow {
  actor_person_id: string | null;
  action: string;
  entity: string;
  entity_id: string;
  before: unknown;
  after: unknown;
}

/** Runs one domain call through the admin and checks the ONE audit row it must leave. Returns the call's result. */
async function audited<R extends { id: string }>(
  c: Cast,
  label: string,
  kind: Kind,
  entity: string,
  entityId: (r: R) => string,
  run: (tx: Parameters<Parameters<typeof asOrg>[1]>[0]) => Promise<R>,
): Promise<R> {
  const before = await auditCount(c.orgId);
  const result = await asOrg(c.orgId, run);
  const rows = await sql<AuditRow[]>`
    select actor_person_id, action, entity, entity_id, before, after from audit_log where org_id = ${c.orgId} order by occurred_at desc, id desc`;
  expect(rows.length - before, `${label}: audit rows written (want exactly 1)`).toBe(1);
  const row = rows[0]!;
  expect(row.actor_person_id, `${label}: actor`).toBe(c.admin.personId);
  expect(row.entity, `${label}: entity`).toBe(entity);
  expect(row.entity_id, `${label}: entity_id`).toBe(entityId(result));
  expect(row.action.trim().length, `${label}: action`).toBeGreaterThan(0);
  if (kind === 'create') {
    expect(row.before, `${label}: create has no before`).toBeNull();
    expect(row.after, `${label}: create has an after`).not.toBeNull();
  } else if (kind === 'edit') {
    expect(row.before, `${label}: before`).not.toBeNull();
    expect(row.after, `${label}: after`).not.toBeNull();
    expect(JSON.stringify(row.after), `${label}: after must differ from before`).not.toBe(JSON.stringify(row.before));
  } else {
    expect(row.before, `${label}: a delete records what went`).not.toBeNull();
    expect(row.after, `${label}: a delete has no after`).toBeNull();
  }
  return result;
}

const self = (r: { id: string }) => r.id;

describe('I17 -- exactly one audit_log row per menu write, with actor, entity and before/after', () => {
  it('categories: create, edit, retire', async () => {
    const c = await cast('i17-cat');
    const cat = await audited(c, 'createMenuCategory', 'create', 'menu_categories', self, (tx) => D.createMenuCategory(c.admin, { name: 'Pork' }, tx));
    await audited(c, 'editMenuCategory', 'edit', 'menu_categories', () => cat.id, (tx) => D.editMenuCategory(c.admin, { id: cat.id, name: 'Pork cuts' }, tx));
    await audited(c, 'retireMenuCategory', 'edit', 'menu_categories', () => cat.id, (tx) => D.retireMenuCategory(c.admin, { id: cat.id }, tx));
  });

  it('items and variants: create, edit, retire', async () => {
    const c = await cast('i17-item');
    const item = await audited(c, 'createMenuItem', 'create', 'menu_items', self, (tx) =>
      D.createMenuItem(c.admin, { categoryId: c.categoryId, name: 'Samgyupsal', itemType: 'a_la_carte' }, tx));
    await audited(c, 'editMenuItem', 'edit', 'menu_items', () => item.id, (tx) => D.editMenuItem(c.admin, { id: item.id, name: 'Samgyupsal set' }, tx));
    const v = await audited(c, 'addMenuVariant', 'create', 'menu_item_variants', self, (tx) => D.addMenuVariant(c.admin, { menuItemId: item.id, label: 'Large' }, tx));
    await audited(c, 'editMenuVariant', 'edit', 'menu_item_variants', () => v.id, (tx) => D.editMenuVariant(c.admin, { id: v.id, label: 'Jumbo' }, tx));
    await audited(c, 'retireMenuVariant', 'edit', 'menu_item_variants', () => v.id, (tx) => D.retireMenuVariant(c.admin, { id: v.id }, tx));
    await audited(c, 'retireMenuItem', 'edit', 'menu_items', () => item.id, (tx) => D.retireMenuItem(c.admin, { id: item.id }, tx));
  });

  it('option groups and values: create, edit; link, unlink', async () => {
    const c = await cast('i17-opt');
    const { itemId } = await rawItem(c);
    const g = await audited(c, 'createOptionGroup', 'create', 'menu_option_groups', self, (tx) =>
      D.createOptionGroup(c.admin, { name: 'Flavour', selectionMode: 'single', minSelections: 1, maxSelections: 1 }, tx));
    await audited(c, 'editOptionGroup', 'edit', 'menu_option_groups', () => g.id, (tx) => D.editOptionGroup(c.admin, { id: g.id, name: 'Flavours' }, tx));
    const v = await audited(c, 'addOptionValue', 'create', 'menu_option_values', self, (tx) => D.addOptionValue(c.admin, { optionGroupId: g.id, name: 'Original' }, tx));
    await audited(c, 'editOptionValue', 'edit', 'menu_option_values', () => v.id, (tx) => D.editOptionValue(c.admin, { id: v.id, name: 'Garlic' }, tx));
    const link = await audited(c, 'linkOptionGroup', 'create', 'menu_option_group_links', self, (tx) =>
      D.linkOptionGroup(c.admin, { optionGroupId: g.id, menuItemId: itemId }, tx));
    await audited(c, 'unlinkOptionGroup', 'delete', 'menu_option_group_links', () => link.id, (tx) => D.unlinkOptionGroup(c.admin, { id: link.id }, tx));
  });

  it('package refills', async () => {
    const c = await cast('i17-pkg');
    const pkg = await rawItem(c, 'package');
    const refill = await rawItem(c, 'refill');
    await audited(c, 'setPackageRefills', 'create', 'menu_package_refills', () => pkg.variantId, (tx) =>
      D.setPackageRefills(c.admin, { packageVariantId: pkg.variantId, refillItemIds: [refill.itemId] }, tx) as unknown as Promise<{ id: string }>);
  });

  it('depletion rules: set, cancel a scheduled one', async () => {
    const c = await cast('i17-rule');
    const { variantId } = await rawItem(c);
    await audited(c, 'setDepletionRule', 'create', 'menu_depletion_rules', self, (tx) => D.setDepletionRule(c.admin, { variantId, mode: 'no_stock' }, tx));
    const scheduled = await audited(c, 'setDepletionRule (scheduled)', 'create', 'menu_depletion_rules', self, (tx) =>
      D.setDepletionRule(c.admin, { variantId, mode: 'no_stock', effectiveFrom: soon(1) }, tx));
    await audited(c, 'cancelScheduledDepletionRule', 'delete', 'menu_depletion_rules', () => scheduled.id, (tx) =>
      D.cancelScheduledDepletionRule(c.admin, { id: scheduled.id }, tx));
  });

  it('offers: set, withdraw, cancel a scheduled one', async () => {
    const c = await cast('i17-offer');
    const { variantId } = await rawItem(c);
    await rawRule(c, variantId);
    await audited(c, 'setMenuOffer', 'create', 'menu_offers', self, (tx) =>
      D.setMenuOffer(c.admin, { storeId: c.storeA, variantId, channel: 'store', amount: '100.00' }, tx));
    await audited(c, 'withdrawMenuOffer', 'create', 'menu_offers', self, (tx) =>
      D.withdrawMenuOffer(c.admin, { storeId: c.storeA, variantId, channel: 'store', effectiveFrom: soon(2) }, tx));
    const scheduled = await audited(c, 'setMenuOffer (scheduled)', 'create', 'menu_offers', self, (tx) =>
      D.setMenuOffer(c.admin, { storeId: c.storeA, variantId, channel: 'store', amount: '120.00', effectiveFrom: soon(3) }, tx));
    await audited(c, 'cancelScheduledOffer', 'delete', 'menu_offers', () => scheduled.id, (tx) =>
      D.cancelScheduledOffer(c.admin, { id: scheduled.id, storeId: c.storeA }, tx));
  });

  it('option offers: set, cancel a scheduled one', async () => {
    const c = await cast('i17-oo');
    const { valueId } = await rawOption(c);
    await audited(c, 'setOptionOffer', 'create', 'menu_option_offers', self, (tx) =>
      D.setOptionOffer(c.admin, { storeId: c.storeA, optionValueId: valueId, channel: 'store', priceDelta: '5.00' }, tx));
    const scheduled = await audited(c, 'setOptionOffer (scheduled)', 'create', 'menu_option_offers', self, (tx) =>
      D.setOptionOffer(c.admin, { storeId: c.storeA, optionValueId: valueId, channel: 'store', priceDelta: '6.00', effectiveFrom: soon(1) }, tx));
    await audited(c, 'cancelScheduledOptionOffer', 'delete', 'menu_option_offers', () => scheduled.id, (tx) =>
      D.cancelScheduledOptionOffer(c.admin, { id: scheduled.id, storeId: c.storeA }, tx));
  });

  it('the before/after carries the actual change (an edit of a name shows the old and the new name; a price shows its amount)', async () => {
    const c = await cast('i17-content');
    const cat = await asOrg(c.orgId, (tx) => D.createMenuCategory(c.admin, { name: 'Old name' }, tx));
    await asOrg(c.orgId, (tx) => D.editMenuCategory(c.admin, { id: cat.id, name: 'New name' }, tx));
    const [edit] = await sql<AuditRow[]>`
      select before, after from audit_log where org_id = ${c.orgId} and entity = 'menu_categories' and entity_id = ${cat.id} order by occurred_at desc, id desc limit 1`;
    expect(JSON.stringify(edit!.before)).toContain('Old name');
    expect(JSON.stringify(edit!.after)).toContain('New name');

    const { variantId } = await rawItem(c);
    await rawRule(c, variantId);
    const o = await asOrg(c.orgId, (tx) => D.setMenuOffer(c.admin, { storeId: c.storeA, variantId, channel: 'store', amount: '123.45' }, tx));
    const [price] = await sql<AuditRow[]>`select before, after from audit_log where org_id = ${c.orgId} and entity = 'menu_offers' and entity_id = ${o.id}`;
    expect(JSON.stringify(price!.after)).toContain('123.45');
  });

  it('the audit row is in the SAME transaction as the write: a rolled-back write leaves neither (mutant: audit written on another connection)', async () => {
    const c = await cast('i17-tx');
    const before = await auditCount(c.orgId);
    await expect(
      asOrg(c.orgId, async (tx) => {
        await D.createMenuCategory(c.admin, { name: 'Ghost' }, tx);
        throw new Error('rollback on purpose');
      }),
    ).rejects.toThrow('rollback on purpose');
    const [n] = await sql<{ n: number }[]>`select count(*)::int as n from menu_categories where org_id = ${c.orgId} and name = 'Ghost'`;
    expect(n!.n).toBe(0);
    expect(await auditCount(c.orgId)).toBe(before);
  });
});
