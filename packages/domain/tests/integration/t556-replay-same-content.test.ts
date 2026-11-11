import { afterAll, describe, expect, it } from 'vitest';
import { RefusalError } from '@shareat/db';
import { addLineDiscount, addLines, completeSale, openStand } from '../../src/pos';
import { applyPosEvents } from '../../src/pos/inbox';
import {
  asOrg, closeAll, counts, ev, fixture, HOLDER, newStand, nowIso, plainDay, RATES, receiptOfSession, salePayload, seniorEntry, signedIn, sql, stateVersionOf, uuid,
  type Fx,
} from './_fixtures/t525-pos';
import { insOffer, insOptionOffer, insRule, newItem, newOption } from '../../../db/tests/integration/_fixtures/t401-menu';

/**
 * T-556 (audit P-001) - a replay is acknowledged only when it carries the SAME content. docs/tasks/556-replay-same-content.md.
 * T-524 R9: the same id with the same content is a no-op, different content is refused. completeSale looked at ids only; addLines' `sameLine` ignored
 * the variant, the options and a bundle's head count. Real PostgreSQL; fixture shared with T-525 (_fixtures/t525-pos.ts).
 */
afterAll(closeAll);

const DIFFERENT = 'This change was already recorded differently on the till.';
const base = (f: Fx) => ({ storeId: f.storeId, pairingId: f.pairingId });
const money = async (f: Fx) => ({
  ...(await counts(f)),
  payments: Number((await sql`select count(*)::int n from pos_sales_receipt_payments where org_id = ${f.orgId}`)[0]!.n),
  receiptLines: Number((await sql`select count(*)::int n from pos_sales_receipt_lines where org_id = ${f.orgId}`)[0]!.n),
  sv: await stateVersionOf(f),
});

async function expectDifferent(p: Promise<unknown>) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, 'expected a refusal, got success (the replay was acknowledged)').not.toBeNull();
  expect(err, `expected a RefusalError, got ${String((err as Error)?.message)}`).toBeInstanceOf(RefusalError);
  expect((err as RefusalError).userMessage).toBe(DIFFERENT);
}

// ---------------------------------------------------------------------------------------------------------------------
// completeSale
// ---------------------------------------------------------------------------------------------------------------------
async function openWithPork(f: Fx, o: { senior?: boolean } = {}) {
  const st = await newStand(f);
  const sessionId = uuid();
  const porkLineId = uuid();
  await asOrg(f.orgId, async (tx) => {
    await openStand(tx, f.counter, { ...base(f), sessionId, mode: 'dine_in', standId: st.id, headsCashier: 2, openedAtDevice: nowIso() });
    await addLines(tx, f.counter, { ...base(f), sessionId, lines: [{ lineId: porkLineId, menuItemId: f.menu.pork.itemId, variantId: f.menu.pork.variantId, qty: 2, addedAtDevice: nowIso() }] });
    if (o.senior) await addLineDiscount(tx, f.counter, { ...base(f), discountId: uuid(), lineId: porkLineId, kind: 'senior', qty: 1, dinerNo: 1, appliedAtDevice: nowIso() }, RATES);
  });
  return { sessionId, porkLineId };
}
const sale = (f: Fx, input: unknown) => asOrg(f.orgId, (tx) => completeSale(tx, f.counter, input as Parameters<typeof completeSale>[2], RATES));

/** The sale as the tablet sent it (500.00 in cash), already recorded once. */
async function paidSale(f: Fx, o: { senior?: boolean; over?: Record<string, unknown> } = {}) {
  const s = await openWithPork(f, o);
  const payload = salePayload(f, { sessionId: s.sessionId, porkLineId: s.porkLineId, ...(o.senior ? { cashPaid: '1000.00', seniors: [seniorEntry(1)] } : {}) });
  const input = { ...base(f), ...payload, ...o.over } as Record<string, unknown>;
  expect(await sale(f, input)).toMatchObject({ wrote: true });
  return { ...s, input, receiptId: payload.receiptId as string };
}

describe('completeSale - a replay must carry what the frozen receipt recorded', () => {
  it('the identical replay is a no-op: wrote false, nothing written, state version unchanged', async () => {
    const f = await fixture();
    const p = await paidSale(f);
    const before = await money(f);
    expect(await sale(f, { ...p.input })).toEqual({ wrote: false, receiptId: p.receiptId });
    expect(await money(f)).toEqual(before);
  });

  it('the identical replay of a senior sale (card details, change, mismatching tablet total) is a no-op', async () => {
    const f = await fixture();
    const p = await paidSale(f, { senior: true });
    const before = await money(f);
    expect(await sale(f, { ...p.input })).toEqual({ wrote: false, receiptId: p.receiptId });
    expect(await money(f)).toEqual(before);
  });

  const other: [string, (f: Fx, input: Record<string, unknown>) => Record<string, unknown>][] = [
    ['another cash amount', (_f, i) => ({ ...i, payments: [{ tenderId: (i.payments as { tenderId: string }[])[0]!.tenderId, amount: '600.00', toCheck: false }] })],
    ['another tender', (f, i) => ({ ...i, payments: [{ tenderId: f.gcash, amount: '500.00', referenceNo: 'GC-1234567', toCheck: false }] })],
    ['payments split differently', (f, i) => ({ ...i, payments: [{ tenderId: f.cash, amount: '300.00', toCheck: false }, { tenderId: f.cash, amount: '200.00', toCheck: false }] })],
    ['another offline flag', (_f, i) => ({ ...i, offline: true })],
    ['another time of sale', (_f, i) => ({ ...i, issuedAtDevice: new Date(Date.parse(i.issuedAtDevice as string) + 60_000).toISOString() })],
    ['another tablet total', (_f, i) => ({ ...i, device: { ...(i.device as object), total: '499.00' } })],
  ];
  for (const [what, change] of other) {
    it(`same receipt, session and terminal ids but ${what}: refused as recorded differently, nothing written`, async () => {
      const f = await fixture();
      const p = await paidSale(f);
      const before = await money(f);
      await expectDifferent(sale(f, change(f, p.input)));
      expect(await money(f)).toEqual(before);
    });
  }

  it('a wallet payment: another reference is refused; an offline sale with the "to check" flag changed is refused; the same wallet replay is a no-op', async () => {
    const f = await fixture();
    const wallet = (ref: string) => [{ tenderId: f.gcash, amount: '500.00', referenceNo: ref, toCheck: false }];
    const p = await paidSale(f, { over: { payments: wallet('GC-1234567') } });
    expect(await sale(f, { ...p.input })).toMatchObject({ wrote: false });
    await expectDifferent(sale(f, { ...p.input, payments: wallet('GC-7654321') }));

    const q = await paidSale(f, { over: { offline: true, payments: [{ tenderId: f.gcash, amount: '500.00', referenceNo: 'GC-1234567', toCheck: true }] } });
    expect(await sale(f, { ...q.input })).toMatchObject({ wrote: false });
    await expectDifferent(sale(f, { ...q.input, payments: [{ tenderId: f.gcash, amount: '500.00', referenceNo: 'GC-1234567', toCheck: false }] }));
  });

  it('a senior sale replayed with other card details, another diner number or no card is refused; nothing is written', async () => {
    const f = await fixture();
    const p = await paidSale(f, { senior: true });
    const before = await money(f);
    const card = seniorEntry(1);
    await expectDifferent(sale(f, { ...p.input, seniors: [{ ...card, idNumber: 'OSCA-0000001' }] }));
    await expectDifferent(sale(f, { ...p.input, seniors: [{ ...card, holderName: `${HOLDER} Jr` }] }));
    await expectDifferent(sale(f, { ...p.input, seniors: [{ ...card, dinerNo: 2 }] }));
    await expectDifferent(sale(f, { ...p.input, seniors: [] }));
    expect(await money(f)).toEqual(before);
  });

  it('inbox: a NEW sequence with the same receipt ids and other payments is quarantined, never acknowledged applied; a resend of the original is a duplicate', async () => {
    const f = await fixture();
    await signedIn(f, f.counterId);
    const day = plainDay(f);
    const deps = RATES;
    const run = (events: ReturnType<typeof ev>[]) => applyPosEvents({ pairing: { pairingId: f.pairingId, orgId: f.orgId, storeId: f.storeId }, events }, deps);
    expect((await run(day.events)).results.map((r) => r.status)).toEqual(['applied', 'applied', 'applied']);
    const before = await money(f);
    const changed = salePayload(f, { sessionId: day.sessionId, porkLineId: day.porkLineId, terminalSeq: day.terminalSeq, receiptId: day.receiptId, cashPaid: '600.00' });
    const r = await run([ev(4, 'sale.completed', f.counterId, changed)]);
    expect(r.results).toHaveLength(1);
    expect(r.results[0]!.status).toBe('quarantined');
    expect(r.results[0]!.error ?? '').toContain('RECORDED_DIFFERENTLY');
    const after = await money(f);
    expect({ ...after, events: before.events }).toEqual({ ...before, events: before.events });
    expect(after.events).toBe(before.events + 1); // the quarantined event row only
    expect((await receiptOfSession(day.sessionId))?.id).toBe(day.receiptId);
    expect((await run(day.events)).results.map((x) => x.status)).toEqual(['duplicate', 'duplicate', 'duplicate']);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// addLines
// ---------------------------------------------------------------------------------------------------------------------
async function extras(f: Fx) {
  const largeVariantId = (await sql<{ id: string }[]>`
    insert into menu_item_variants (org_id, menu_item_id, label, is_default, sort_order, status, created_by)
    values (${f.orgId}, ${f.menu.pork.itemId}, 'Large', false, 1, 'active', ${f.personId}) returning id`)[0]!.id;
  await insRule(f, largeVariantId);
  await insOffer(f, largeVariantId, '300.00');
  const a = await newOption(f);
  await insOptionOffer(f, a.valueId, '30.00');
  const b = (await sql<{ id: string }[]>`
    insert into menu_option_values (org_id, option_group_id, name, sort_order, status, created_by) values (${f.orgId}, ${a.groupId}, 'Extra sauce', 1, 'active', ${f.personId}) returning id`)[0]!.id;
  await insOptionOffer(f, b, '10.00');
  await sql`insert into menu_option_group_links (org_id, option_group_id, menu_item_id, status, created_by) values (${f.orgId}, ${a.groupId}, ${f.menu.pork.itemId}, 'active', ${f.personId})`;
  const family = await newItem(f, 'package', 'Family Pack');
  await insRule(f, family.variantId);
  await sql`insert into menu_offers (org_id, store_id, variant_id, channel, daypart_id, amount, bundle_heads, extra_head_amount, withdrawn, created_by)
            values (${f.orgId}, ${f.storeId}, ${family.variantId}, 'store', ${null}, '1000.00', 4, '100.00', false, ${f.personId})`;
  await sql`insert into kitchen_routes (org_id, store_id, menu_item_id, station_id, created_by) values (${f.orgId}, ${f.storeId}, ${family.itemId}, ${f.grill}, ${f.personId})`;
  return { largeVariantId, optA: a.valueId, optB: b, family };
}

type L = { lineId: string; menuItemId: string; variantId?: string; qty: number; addedAtDevice: string; optionValueIds?: string[] };
const lines = (f: Fx, sessionId: string, ls: L[]) => asOrg(f.orgId, (tx) => addLines(tx, f.counter, { ...base(f), sessionId, lines: ls }));
const lineCount = async (sessionId: string) => Number((await sql`select count(*)::int n from table_session_lines where session_id = ${sessionId}`)[0]!.n);
async function dineIn(f: Fx, heads: number) {
  const st = await newStand(f);
  const sessionId = uuid();
  await asOrg(f.orgId, (tx) => openStand(tx, f.counter, { ...base(f), sessionId, mode: 'dine_in', standId: st.id, headsCashier: heads, openedAtDevice: nowIso() }));
  return sessionId;
}

describe('addLines - a replay of a line id must carry the same variant, options and head count', () => {
  it('the identical replay of a line with a variant and an option is a no-op (wrote false, no new line)', async () => {
    const f = await fixture();
    const x = await extras(f);
    const sessionId = await dineIn(f, 2);
    const l: L = { lineId: uuid(), menuItemId: f.menu.pork.itemId, variantId: x.largeVariantId, qty: 1, addedAtDevice: nowIso(), optionValueIds: [x.optA] };
    expect(await lines(f, sessionId, [l])).toEqual({ wrote: true });
    const before = await money(f);
    expect(await lines(f, sessionId, [{ ...l }])).toEqual({ wrote: false });
    expect(await lineCount(sessionId)).toBe(1);
    expect(await money(f)).toEqual(before);
  });

  it('the same line id with another variant is refused', async () => {
    const f = await fixture();
    const x = await extras(f);
    const sessionId = await dineIn(f, 2);
    const l: L = { lineId: uuid(), menuItemId: f.menu.pork.itemId, variantId: f.menu.pork.variantId, qty: 1, addedAtDevice: nowIso() };
    await lines(f, sessionId, [l]);
    await expectDifferent(lines(f, sessionId, [{ ...l, variantId: x.largeVariantId }]));
    const m: L = { lineId: uuid(), menuItemId: f.menu.pork.itemId, variantId: x.largeVariantId, qty: 1, addedAtDevice: nowIso() };
    await lines(f, sessionId, [m]);
    await expectDifferent(lines(f, sessionId, [{ ...m, variantId: f.menu.pork.variantId }]));
    expect(await lineCount(sessionId)).toBe(2);
  });

  it('the same line id with another option set (other option, none instead of one, one instead of none) is refused', async () => {
    const f = await fixture();
    const x = await extras(f);
    const sessionId = await dineIn(f, 2);
    const withA: L = { lineId: uuid(), menuItemId: f.menu.pork.itemId, variantId: f.menu.pork.variantId, qty: 1, addedAtDevice: nowIso(), optionValueIds: [x.optA] };
    const plain: L = { lineId: uuid(), menuItemId: f.menu.pork.itemId, variantId: f.menu.pork.variantId, qty: 1, addedAtDevice: nowIso() };
    await lines(f, sessionId, [withA, plain]);
    await expectDifferent(lines(f, sessionId, [{ ...withA, optionValueIds: [x.optB] }]));
    await expectDifferent(lines(f, sessionId, [{ ...withA, optionValueIds: [] }]));
    await expectDifferent(lines(f, sessionId, [{ ...plain, optionValueIds: [x.optA] }]));
    expect(await lines(f, sessionId, [{ ...withA }, { ...plain }]), 'the identical pair is still a replay').toEqual({ wrote: false });
    expect(await lineCount(sessionId)).toBe(2);
  });

  it('a bundle (up to 4): the identical replay with extra heads is a no-op; another head count is refused', async () => {
    const f = await fixture();
    const x = await extras(f);
    const sessionId = await dineIn(f, 6);
    const l: L = { lineId: uuid(), menuItemId: x.family.itemId, variantId: x.family.variantId, qty: 6, addedAtDevice: nowIso() };
    expect(await lines(f, sessionId, [l])).toEqual({ wrote: true });
    expect(await lineCount(sessionId), 'bundle line + derived extra-heads line').toBe(2);
    const before = await money(f);
    expect(await lines(f, sessionId, [{ ...l }])).toEqual({ wrote: false });
    await expectDifferent(lines(f, sessionId, [{ ...l, qty: 5 }]));
    await expectDifferent(lines(f, sessionId, [{ ...l, qty: 3 }]));
    await expectDifferent(lines(f, sessionId, [{ ...l, qty: 8 }]));
    expect(await lineCount(sessionId)).toBe(2);
    expect(await money(f)).toEqual(before);
  });

  it('a bundle that fit its heads (no extra line): the identical replay is a no-op; a replay with more heads is refused', async () => {
    const f = await fixture();
    const x = await extras(f);
    const sessionId = await dineIn(f, 3);
    const l: L = { lineId: uuid(), menuItemId: x.family.itemId, variantId: x.family.variantId, qty: 3, addedAtDevice: nowIso() };
    await lines(f, sessionId, [l]);
    expect(await lineCount(sessionId)).toBe(1);
    expect(await lines(f, sessionId, [{ ...l }])).toEqual({ wrote: false });
    await expectDifferent(lines(f, sessionId, [{ ...l, qty: 6 }]));
    expect(await lineCount(sessionId)).toBe(1);
  });
});
