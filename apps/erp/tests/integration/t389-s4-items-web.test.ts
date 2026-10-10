import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

/**
 * T-389 S4 (TESTER) - items/[id]: the four saved-record forms keep what was typed after a refused save (DEF-617).
 * Spec: docs/tasks/389-refused-save-keeps-typing.md; bible row 300. Legs and harness: t389-s4-common.ts.
 *
 * CENSUS (re-run at S4 start, `grep -n "<EditableRecord" items/[id]/page.tsx`: 4, as the spec says):
 *   page form                      action                    record id   refusal driven                                  form key (pinned)
 *   items/[id]  Name and code      renameItemAction          itemId      duplicate name ("already exists")               item.rename
 *   items/[id]  Measured in        changeItemUnitAction      itemId      crafted unit (see QUESTION U)                    item.unit
 *   items/[id]  Org default flags  updateItemFlagsAction     itemId      role revoked mid-page (see QUESTION P)           item.flags
 *   items/[id]  Store sellability  setStoreSellabilityAction storeId     role revoked mid-page (see QUESTION P)           item.storeSellability
 *   (setItemStatusAction / clearStoreSellabilityAction / the add-override plain form are commands or add forms: out of scope.)
 *
 * CONTRACT PINNED HERE (spec silent; the builder matches):
 *  - allow-lists: rename = name, code, adoptSuggestedCode (the checkbox ItemCodeField draws; kept as 'on', or [] when changed
 *    and unticked); unit = baseUnit; flags = isPurchasable, sellableRetail, sellableWholesale; sellability = isPurchasable,
 *    sellableRetail, sellableWholesale (tri-selects, '' = follow the organisation, kept as ''), note. NOT itemId, NOT storeId.
 *  - sellability record id = the STORE id (the page is already one item, so the store is unique on it; the hidden pair
 *    itemId+storeId cannot be the record, 73 chars > the flash's 64). Same call S3 made for budgets (category on one period).
 *  - rename/unit also keep typing in their AuthorizationError branch (spec R2: guard clauses wire the same call).
 *  - the server never draws a typed value; ItemCodeField's tick is a client control (QUESTION I, not testable in node).
 *
 * QUESTION U (unit form): its only DATA refusal is "history appeared since the page loaded"; on the reopened page the form is
 *   not drawn at all (the page shows the "can no longer change" sentence instead), so there is no record to reopen. The legs
 *   drive a crafted unit instead (a unit that is no option), and a control below pins that the history case draws no form and
 *   does not crash with a typed slot in the flash. Decide: is that the intended outcome (nothing to keep), yes/no?
 * QUESTION P (flags, sellability): the domain has no data-dependent refusal for either (updateItem/setStoreSellability only
 *   authorize and write). The only reachable server refusal is a permission one, so the legs revoke the person's role for the
 *   Save and restore it before the page is drawn (harness `around`). The flash slot is bound to the person, who is the same.
 * QUESTION I (ItemCodeField): planApply sets `adoptSuggestedCode.checked` and dispatches change; React's checkbox onChange
 *   listens to `click`, so the component's `adopt` state stays false (the Code box is not greyed/readOnly). Cosmetic (the
 *   server ignores the typed code when the tick is on) but a design call: dispatch a click for checkboxes in planApply,
 *   or have ItemCodeField read `form.elements` on a `change` listener like it does for the Name box.
 */
const h = vi.hoisted(() => ({ actor: null as null | { personId: string; orgId: string } }));
const seen = vi.hoisted(() => ({ records: [] as Array<Record<string, unknown>> }));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => h.actor),
  requireSession: vi.fn(async () => ({ actor: h.actor, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01') })),
}));
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));
vi.mock('@/components/forms', async (orig) => {
  const real = await orig<typeof import('@/components/forms')>();
  const { createElement } = await import('react');
  return {
    ...real,
    EditableRecord: (p: Record<string, unknown>) => {
      seen.records.push(p);
      return createElement(real.EditableRecord as never, p as never);
    },
  };
});

import { createHarness, superFixture, LONG, plain, sql, uid, type BaseCtx, type FormCase } from './t389-s4-common';

type Sib = { label: string; sel: { action: string; hidden: Record<string, string> }; has: string[] };
const { runTypedLegs } = createHarness({ h, seen });

interface ItemCtx extends BaseCtx {
  itemId: string;
  storedName: string;
  storedCode: string;
  dupName: string; // another item's name: renaming to it is refused
  storeId: string;
  storeB: string; // a second store with its own override (the sibling)
  plainAdmin: import('@shareat/auth').Actor; // an admin who is not a super-admin
}
async function itemCtx(hint: string): Promise<ItemCtx> {
  const f = await superFixture(`it-${hint}`);
  const [pa] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.orgId}, 'Plain Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${pa!.id}, ${f.orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${pa!.id}, ${f.storeId})`;
  const [sb] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${f.orgId}, ${uid('B')}, 'Store Bee') returning id`;
  await sql`insert into person_store_scope (person_id, store_id) values (${f.admin.personId}, ${sb!.id}), (${f.other.personId}, ${sb!.id})`;
  const storedCode = 'STRD-001';
  const mk = async (name: string, code: string) =>
    (await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, created_by, is_purchasable)
      values (${f.orgId}, ${code}, ${name}, 'raw_material', 'kg', ${f.admin.personId}, true) returning id`)[0]!.id;
  const itemId = await mk('Stored Item', storedCode);
  await mk('Other Item', 'OTHR-001');
  for (const [store, note] of [[f.storeId, 'stored note'], [sb!.id, 'bee note']] as const) {
    await sql`
      insert into store_item_sellability (org_id, store_id, item_id, is_purchasable, sellable_retail, sellable_wholesale, note, set_by)
      values (${f.orgId}, ${store}, ${itemId}, null, true, false, ${note}, ${f.admin.personId})`;
  }
  return {
    f, record: itemId, itemId, storedName: 'Stored Item', storedCode,
    dupName: 'Other Item', storeId: f.storeId, storeB: sb!.id, plainAdmin: { personId: pa!.id, orgId: f.orgId },
  };
}

const page = async () => (await import('../../src/app/items/[id]/page')).default as never;
const props = (ctx: ItemCtx, params: Record<string, string>) => ({ params: Promise.resolve({ id: ctx.itemId }) as never, searchParams: Promise.resolve(params) });
const actions = () => import('../../src/app/items/actions');

const fdOf = (base: Record<string, string | string[]>, over: Record<string, string | string[] | null> = {}): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ ...base, ...over })) {
    if (v === null) continue;
    for (const one of Array.isArray(v) ? v : [v]) fd.append(k, one);
  }
  return fd;
};
/** A bare checkbox (no value attribute): is it ticked in this form's markup? */
function ticked(seg: string, name: string): boolean {
  const tag = (seg.match(/<input\b[^>]*>/g) ?? []).find((t) => new RegExp(`\\sname="${name}"`).test(t) && /type="checkbox"/.test(t));
  expect(tag, `a checkbox named ${name}`).toBeDefined();
  return /\schecked(=|\s|\/|>)/.test(tag!);
}
/** A role taken away for the Save and given back before the page is drawn. */
const revoke = {
  before: async (ctx: ItemCtx) => { await sql`update person_roles set role = 'staff' where person_id = ${ctx.f.admin.personId}`; },
  after: async (ctx: ItemCtx) => { await sql`update person_roles set role = 'super_admin' where person_id = ${ctx.f.admin.personId}`; },
};

// ---- rename -----------------------------------------------------------------------------------------------------------
const rename: FormCase<ItemCtx> = {
  label: 'items rename (Name and code)',
  form: 'item.rename',
  setup: itemCtx,
  action: async () => (await actions()).renameItemAction,
  page,
  props,
  sel: (ctx) => ({ action: 'renameItemAction', hidden: { itemId: ctx.itemId } }),
  has: (ctx) => [`name="itemId" value="${ctx.itemId}"`, 'id="rename-name"'],
  hiddenNames: ['itemId'],
  refused: (ctx, over = {}) => fdOf({ itemId: ctx.itemId, name: ctx.dupName, code: 'TYPD-123', adoptSuggestedCode: 'on' }, over),
  refusal: /already exists/i,
  fields: (ctx) => ({ name: ctx.dupName, code: 'TYPD-123', adoptSuggestedCode: 'on' }),
  changed: { list: 'name,code', fields: (ctx) => ({ name: ctx.dupName, code: 'TYPD-123' }) },
  notDrawn: ['TYPD-123'],
  stored: (ctx, seg, m) => {
    expect(m.inputValue(seg, 'name'), 'the stored name is drawn').toBe(ctx.storedName);
    expect(m.inputValue(seg, 'code'), 'the stored code is drawn').toBe(ctx.storedCode);
    expect(ticked(seg, 'adoptSuggestedCode'), 'the adopt tick is drawn unticked (the browser applies the typed tick)').toBe(false);
  },
  tooLong: { code: LONG },
  good: (ctx) => fdOf({ itemId: ctx.itemId, name: 'Stored Item Two', code: ctx.storedCode }),
  ok: /Renamed/,
  guards: [{
    label: 'a non-super-admin rename (the AuthorizationError branch)',
    who: (ctx) => ctx.plainAdmin,
    form: (ctx) => fdOf({ itemId: ctx.itemId, name: 'Whatever', code: ctx.storedCode }),
    refusal: /Only a super-admin can rename/,
  }],
  siblings: async (ctx): Promise<Sib[]> => [
    { label: 'the unit form', sel: { action: 'changeItemUnitAction', hidden: { itemId: ctx.itemId } }, has: [`name="itemId" value="${ctx.itemId}"`, 'name="baseUnit"'] },
    { label: 'the org flags form', sel: { action: 'updateItemFlagsAction', hidden: { itemId: ctx.itemId } }, has: [`name="itemId" value="${ctx.itemId}"`, 'type="checkbox" name="isPurchasable"'] },
  ],
};
runTypedLegs(rename);

// ---- unit -------------------------------------------------------------------------------------------------------------
const unit: FormCase<ItemCtx> = {
  label: 'items unit (Measured in)',
  form: 'item.unit',
  setup: itemCtx,
  action: async () => (await actions()).changeItemUnitAction,
  page,
  props,
  sel: (ctx) => ({ action: 'changeItemUnitAction', hidden: { itemId: ctx.itemId } }),
  has: (ctx) => [`name="itemId" value="${ctx.itemId}"`, 'name="baseUnit"'],
  hiddenNames: ['itemId'],
  refused: (ctx, over = {}) => fdOf({ itemId: ctx.itemId, baseUnit: 'furlong' }, over),
  refusal: /Choose the unit this item is measured in/,
  fields: () => ({ baseUnit: 'furlong' }),
  changed: { list: 'baseUnit', fields: () => ({ baseUnit: 'furlong' }) },
  notDrawn: ['furlong'],
  stored: (_ctx, seg, m) => expect(m.selectedValue(seg, 'baseUnit'), 'the stored unit is selected').toBe('kg'),
  tooLong: { baseUnit: LONG },
  good: (ctx) => fdOf({ itemId: ctx.itemId, baseUnit: 'g' }),
  ok: /Unit changed to g/,
  note: 'QUESTION U: crafted unit; the history refusal draws no form on reopen',
  guards: [{
    label: 'a non-super-admin unit change (the AuthorizationError branch)',
    who: (ctx) => ctx.plainAdmin,
    form: (ctx) => fdOf({ itemId: ctx.itemId, baseUnit: 'g' }),
    refusal: /Only a super-admin can change an item's unit/,
  }],
};
runTypedLegs(unit);

// ---- org flags --------------------------------------------------------------------------------------------------------
const flags: FormCase<ItemCtx> = {
  label: 'items org flags (What it may be bought and sold as)',
  form: 'item.flags',
  setup: itemCtx,
  action: async () => (await actions()).updateItemFlagsAction,
  page,
  props,
  sel: (ctx) => ({ action: 'updateItemFlagsAction', hidden: { itemId: ctx.itemId } }),
  has: (ctx) => [`name="itemId" value="${ctx.itemId}"`, 'type="checkbox" name="isPurchasable"'],
  hiddenNames: ['itemId'],
  // stored: bought yes, retail no, wholesale no. Typed: purchasable UNticked, retail and wholesale ticked.
  refused: (ctx, over = {}) => fdOf({ itemId: ctx.itemId, sellableRetail: 'on', sellableWholesale: 'on' }, over),
  refusal: /can't manage the organisation-wide item list/,
  fields: () => ({ sellableRetail: 'on', sellableWholesale: 'on' }),
  changed: { list: 'isPurchasable,sellableRetail', fields: () => ({ isPurchasable: [], sellableRetail: 'on' }) },
  notDrawn: [],
  stored: (_ctx, seg) => {
    expect(ticked(seg, 'isPurchasable'), 'the stored "bought" tick is drawn ticked').toBe(true);
    expect(ticked(seg, 'sellableRetail'), 'the typed retail tick is NOT drawn by the server').toBe(false);
    expect(ticked(seg, 'sellableWholesale'), 'the typed wholesale tick is NOT drawn by the server').toBe(false);
  },
  // A checkbox group holds no free text: a hand-crafted 6,000-character value is the only way to overflow (QUESTION P's cousin).
  tooLong: { sellableRetail: LONG },
  good: (ctx) => fdOf({ itemId: ctx.itemId, isPurchasable: 'on', sellableRetail: 'on' }),
  ok: /Saved\. Every store follows this/,
  around: revoke,
  note: 'QUESTION P: permission refusal (role revoked for the Save)',
  siblings: async (ctx): Promise<Sib[]> => [
    { label: 'the store override form', sel: { action: 'setStoreSellabilityAction', hidden: { itemId: ctx.itemId, storeId: ctx.storeId } }, has: [`name="storeId" value="${ctx.storeId}"`, '<select name="isPurchasable"'] },
    { label: 'the rename form', sel: { action: 'renameItemAction', hidden: { itemId: ctx.itemId } }, has: [`name="itemId" value="${ctx.itemId}"`, 'id="rename-name"'] },
  ],
};
runTypedLegs(flags);

// ---- store sellability ------------------------------------------------------------------------------------------------
const sellability: FormCase<ItemCtx> = {
  label: 'items store sellability (Where a store differs)',
  form: 'item.storeSellability',
  setup: async (hint) => {
    const c = await itemCtx(hint);
    return { ...c, record: c.storeId };
  },
  action: async () => (await actions()).setStoreSellabilityAction,
  page,
  props,
  sel: (ctx) => ({ action: 'setStoreSellabilityAction', hidden: { itemId: ctx.itemId, storeId: ctx.storeId } }),
  has: (ctx) => [`name="storeId" value="${ctx.storeId}"`, '<select name="isPurchasable"'],
  hiddenNames: ['itemId', 'storeId'],
  refused: (ctx, over = {}) =>
    fdOf({ itemId: ctx.itemId, storeId: ctx.storeId, isPurchasable: 'yes', sellableRetail: 'no', sellableWholesale: '', note: 'typed note' }, over),
  refusal: /can't manage the organisation-wide item list/,
  fields: () => ({ isPurchasable: 'yes', sellableRetail: 'no', sellableWholesale: '', note: 'typed note' }),
  changed: { list: 'note,sellableRetail', fields: () => ({ note: 'typed note', sellableRetail: 'no' }) },
  notDrawn: ['typed note'],
  stored: (_ctx, seg, m) => {
    expect(m.selectedValue(seg, 'isPurchasable'), 'stored: follows the organisation').toBe('');
    expect(m.selectedValue(seg, 'sellableRetail'), 'stored: yes here').toBe('yes');
    expect(m.selectedValue(seg, 'sellableWholesale'), 'stored: no here').toBe('no');
    expect(m.inputValue(seg, 'note'), 'the stored note is drawn').toBe('stored note');
  },
  tooLong: { note: LONG },
  good: (ctx) => fdOf({ itemId: ctx.itemId, storeId: ctx.storeId, isPurchasable: 'yes', sellableRetail: '', sellableWholesale: '', note: 'stored note' }),
  ok: /Store override saved/,
  around: revoke,
  note: 'QUESTION P: permission refusal (role revoked for the Save)',
  siblings: async (ctx): Promise<Sib[]> => [
    { label: 'the other store override', sel: { action: 'setStoreSellabilityAction', hidden: { itemId: ctx.itemId, storeId: ctx.storeB } }, has: [`name="storeId" value="${ctx.storeB}"`, '<select name="isPurchasable"'] },
    { label: 'the org flags form', sel: { action: 'updateItemFlagsAction', hidden: { itemId: ctx.itemId } }, has: [`name="itemId" value="${ctx.itemId}"`, 'type="checkbox" name="isPurchasable"'] },
  ],
};
runTypedLegs(sellability);

// ---- control for QUESTION U: the real data refusal draws no unit form on reopen ----------------------------------------
it('control (green today): history appearing under an open unit form -> refused in words; the reopened page draws no unit form and does not fail', async () => {
  const ctx = await itemCtx('hist');
  await sql`insert into store_item_thresholds (org_id, store_id, item_id, low_stock_threshold, set_by) values (${ctx.f.orgId}, ${ctx.storeId}, ${ctx.itemId}, '5', ${ctx.f.admin.personId})`;
  h.actor = ctx.f.admin;
  const { captureRedirect, outcomeOf, pageParamsOf, resetJar } = await import('../helpers/flash-jar');
  resetJar();
  const signal = await captureRedirect(async () => (await actions()).changeItemUnitAction(fdOf({ itemId: ctx.itemId, baseUnit: 'g' })));
  expect(outcomeOf(signal).flash.error).toMatch(/unit can no longer change/i);
  seen.records = [];
  const Page = (await page()) as unknown as (p: unknown) => Promise<unknown>;
  const html = renderToStaticMarkup((await Page(props(ctx, pageParamsOf(signal.url)))) as never);
  expect(plain(html)).toMatch(/unit can no longer change/i);
  expect(html).not.toContain('name="baseUnit"');
});
