import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * T-440 S5 (TESTER) - one refusal per rule the S5 sweep newly enforces on the server (Q5: a field marked required or bounded on
 * screen but never checked by the action). Each case runs the REAL server action with a bad value and proves two things: the
 * person is told the rule's exact sentence (the line the screen shows live, imported from the rule set so the expectation is
 * never a copy), and NOTHING was written.
 *
 * Session mocked (t412 idiom); redirects captured; the banner read through the flash jar. Every case names the mutant it kills;
 * the mutant is "the assertFieldRules call is removed from that action" unless stated otherwise. The ids posted are made up on
 * purpose: if the assert were missing, the action would fail LATER with a different sentence (or a lookup error), so an exact
 * sentence match proves the field check ran first.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - name must contain "_test".`);
}

const h = vi.hoisted(() => ({ actor: null as null | { personId: string; orgId: string } }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', async () => (await import('../../../../tests/helpers/flash-jar-core')).nextNavigationMock());
vi.mock('../../../../apps/erp/src/lib/session', () => ({
  requireActor: vi.fn(async () => h.actor),
  requireSession: vi.fn(async () => ({ actor: h.actor, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01') })),
}));

import { closeDb } from '@shareat/db';
import { captureRedirect, outcomeOf, resetJar } from '../../../../tests/helpers/flash-jar';
import { moneyFixture } from './_fixtures/t402-s3-money';
import { WASTAGE_RECORD_RULES, WASTAGE_REVERSE_RULES } from '../../src/field-rules/wastage';
import { ITEMS_REJECT_RULES, ITEMS_RENAME_RULES, ITEMS_UNIT_RULES } from '../../src/field-rules/items';
import { MENU_CATEGORY_RULES, MENU_ITEM_ADD_RULES, MENU_REQUEST_RULES } from '../../src/field-rules/menu';
import { INVENTORY_LOCATION_RULES, INVENTORY_POS_MAP_RULES, INVENTORY_TRANSFER_RULES } from '../../src/field-rules/inventory';
import { COMMISSARY_LINK_RULES } from '../../src/field-rules/commissary';
import { CUTOVER_COUNT_RULES, CUTOVER_FIGURE_RULES } from '../../src/field-rules/cutover';
import { checkField } from '../../src/field-rules/check';
import { RefusalError } from '../../src/shared/refusal';

const sql = postgres(url, { max: 5 });
const APP = '../../../../apps/erp/src/app';
const FAKE_ID = '00000000-0000-4000-8000-000000000000';

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

type Fx = Awaited<ReturnType<typeof moneyFixture>>;
let fxPromise: Promise<Fx> | null = null;
const fixture = () => (fxPromise ??= moneyFixture(sql, 't440s5'));

/** The sentence the SCREEN shows for this value: the rule set's own, so client === server is the thing under test. */
function sentence(rule: Parameters<typeof checkField>[0], value: string): string {
  const c = checkField(rule, value);
  if (c.ok) throw new Error(`the fixture value ${JSON.stringify(value.slice(0, 12))} passes ${rule.name}; pick a failing one`);
  return c.requirement;
}

async function load(mod: string, name: string): Promise<(fd: FormData) => Promise<void>> {
  const act = ((await import(/* @vite-ignore */ `${APP}/${mod}`)) as Record<string, (fd: FormData) => Promise<void>>)[name];
  if (!act) throw new Error(`${mod} exports no ${name}`);
  return act;
}
function formOf(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

/** Runs the action as the org's administrator and returns the banner it redirected with. */
async function run(mod: string, name: string, fields: Record<string, string>) {
  const f = await fixture();
  const act = await load(mod, name);
  resetJar();
  h.actor = f.admin;
  return outcomeOf(await captureRedirect(() => act(formOf(fields))));
}

async function count(table: string, orgId: string): Promise<number> {
  const rows = await sql.unsafe<{ n: number }[]>(`select count(*)::int as n from ${table} where org_id = '${orgId}'`);
  return rows[0]?.n ?? 0;
}

/** Runs `go`, proves the banner is the rule's sentence and that the table did not grow. */
async function refused(table: string, go: (f: Fx) => Promise<{ flash: { error?: string } }>, want: string) {
  const f = await fixture();
  const before = await count(table, f.orgId);
  const o = await go(f);
  expect(o.flash.error).toBe(want);
  expect(await count(table, f.orgId)).toBe(before);
}

describe('T-440 S5: a bad value is refused with the rule sentence and nothing is written', () => {
  it('wastage recordOrderWastageAction: a blank reason is refused; no wastage row (mutant: assert removed from recordOrderWastageAction)', async () => {
    await refused(
      'order_wastages',
      (f) => run('wastage/actions', 'recordOrderWastageAction', { storeId: f.storeId, channel: 'dine_in', businessDate: '2026-01-15', amount: '100', reason: '   ' }),
      sentence(WASTAGE_RECORD_RULES.reason, ''),
    );
  });

  it('wastage recordOrderWastageAction: an amount of 0 is refused; no wastage row (mutant: money min 0.01 dropped)', async () => {
    await refused(
      'order_wastages',
      (f) => run('wastage/actions', 'recordOrderWastageAction', { storeId: f.storeId, channel: 'dine_in', businessDate: '2026-01-15', amount: '0', reason: 'Dropped tray' }),
      sentence(WASTAGE_RECORD_RULES.amount, '0'),
    );
  });

  it('wastage reverseAutoChargeAction: a blank reason is refused before any lookup (mutant: assert removed from reverseAutoChargeAction)', async () => {
    await refused(
      'order_wastages',
      (f) => run('wastage/actions', 'reverseAutoChargeAction', { id: FAKE_ID, storeId: f.storeId, reason: '' }),
      sentence(WASTAGE_REVERSE_RULES.reason, ''),
    );
  });

  it('items rejectItemRequestAction: a blank note is refused before any lookup (mutant: assert removed from rejectItemRequestAction)', async () => {
    await refused('item_requests', () => run('items/actions', 'rejectItemRequestAction', { requestId: FAKE_ID, note: '  ' }), sentence(ITEMS_REJECT_RULES.note, ''));
  });

  it('items renameItemAction: a blank code is refused before any lookup (mutant: assert removed from renameItemAction)', async () => {
    await refused('items', () => run('items/actions', 'renameItemAction', { itemId: FAKE_ID, name: 'Pork belly', code: '' }), sentence(ITEMS_RENAME_RULES.code, ''));
  });

  it('items changeItemUnitAction: a blank unit is refused before any lookup (mutant: assert removed from changeItemUnitAction)', async () => {
    await refused('items', () => run('items/actions', 'changeItemUnitAction', { itemId: FAKE_ID, baseUnit: '' }), sentence(ITEMS_UNIT_RULES.baseUnit, ''));
  });

  it('menu createCategoryAction: a blank name is refused; no category (mutant: assert removed from createCategoryAction)', async () => {
    await refused('menu_categories', () => run('menu/actions', 'createCategoryAction', { name: '   ' }), sentence(MENU_CATEGORY_RULES.name, ''));
  });

  it('menu createCategoryAction: a fractional sort order is refused; no category (mutant: integer dropped from the sort-order rule)', async () => {
    await refused('menu_categories', () => run('menu/actions', 'createCategoryAction', { name: 'Drinks', sortOrder: '1.5' }), sentence(MENU_CATEGORY_RULES.sortOrder, '1.5'));
  });

  it('menu createItemAction: no category chosen is refused; no menu item (mutant: assert removed from createItemAction)', async () => {
    await refused('menu_items', () => run('menu/actions', 'createItemAction', { categoryId: '', name: 'Halo-halo', itemType: 'a_la_carte' }), sentence(MENU_ITEM_ADD_RULES.categoryId, ''));
  });

  it('menu submitItemRequestAction: a blank name is refused; no request row (mutant: assert removed from submitItemRequestAction)', async () => {
    await refused(
      'menu_item_requests',
      (f) => run('menu/requests/actions', 'submitItemRequestAction', { storeId: f.storeId, name: '', itemType: 'a_la_carte' }),
      sentence(MENU_REQUEST_RULES.name, ''),
    );
  });

  it('inventory createLocationAction: a blank room code is refused; no room (mutant: assert removed from createLocationAction)', async () => {
    await refused(
      'stock_locations',
      (f) => run('inventory/locations/actions', 'createLocationAction', { storeId: f.storeId, code: ' ', name: 'Walk-in', typeId: FAKE_ID, role: 'storage' }),
      sentence(INVENTORY_LOCATION_RULES.code, ''),
    );
  });

  it('inventory upsertPosItemMapAction: a blank POS item key is refused; no map (mutant: assert removed from upsertPosItemMapAction)', async () => {
    await refused(
      'pos_item_maps',
      (f) => run('inventory/pos-map/actions', 'upsertPosItemMapAction', { storeId: f.storeId, posItemKey: '', posItemName: 'Halo-halo', mode: 'no_stock' }),
      sentence(INVENTORY_POS_MAP_RULES.posItemKey, ''),
    );
  });

  it('commissary upsertLinkAction: no branch chosen is refused; no link (mutant: assert removed from upsertLinkAction)', async () => {
    await refused(
      'commissary_links',
      (f) => run('commissary/catalogue/actions', 'upsertLinkAction', { commissaryStoreId: f.storeId, branchStoreId: '' }),
      sentence(COMMISSARY_LINK_RULES.branchStoreId, ''),
    );
  });

  it('cutover addOpeningFigureAction: an amount of 0 is refused; no opening entry (mutant: assert removed / money min 0.01 dropped)', async () => {
    await refused(
      'journal_entries',
      (f) => run('cutover/actions', 'addOpeningFigureAction', { accountCode: '1110', storeId: f.storeId, direction: 'debit', amount: '0', entryDate: '2026-01-01' }),
      sentence(CUTOVER_FIGURE_RULES.amount, '0'),
    );
  });

  it('cutover recordCountAction: a negative count is refused; no count line (mutant: assert removed from recordCountAction)', async () => {
    await refused(
      'stock_movements',
      (f) => run('cutover/actions', 'recordCountAction', { storeId: f.storeId, itemId: FAKE_ID, quantity: '-1' }),
      sentence(CUTOVER_COUNT_RULES.quantity, '-1'),
    );
  });

  it('inventory createTransferAction: a negative quantity throws the rule sentence as a refusal; no transfer (mutant: assert removed from createTransferAction)', async () => {
    const f = await fixture();
    const act = await load('inventory/transfers/actions', 'createTransferAction');
    const before = await count('stock_transfers', f.orgId);
    resetJar();
    h.actor = f.admin;
    let thrown: unknown;
    try {
      await act(formOf({ storeId: f.storeId, fromLocationId: FAKE_ID, toLocationId: FAKE_ID, itemId: FAKE_ID, quantity: '-1', mode: 'now' }));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RefusalError);
    expect((thrown as RefusalError).userMessage).toBe(sentence(INVENTORY_TRANSFER_RULES.quantity, '-1'));
    expect(await count('stock_transfers', f.orgId)).toBe(before);
  });
});
