import { afterAll, describe, expect, it } from 'vitest';

/**
 * T-627 (test 2) - the store charges through the inbox: `charge.added` / `charge.removed` replayed in order (as an offline tablet sends them), the receipt rows and
 * `charge_total` the sale writes, the server's recompute against the tablet's, and the rules (once per bill, a retired charge, a paid table, a replay).
 * docs/tasks/627-pos-charges.md. Real Postgres on a scratch "_test" database, through the same T-525 fixture as the inbox tests.
 */
import { applyPosEvents } from '../../src/pos/inbox';
import { buildPosSnapshot } from '../../src/pos/snapshot';
import { createChargeOption, getSessionBill, removeCharge } from '../../src/pos';
import { chargePresetRow } from './_fixtures/t634-charges';
import {
  asOrg, auditRows, closeAll, ev, fixture, linesAddedPayload, nowIso, RATES, salePayload, signedIn, sql, standOpenedPayload, uuid, type Ev, type Fx,
} from './_fixtures/t525-pos';

afterAll(closeAll);

/** A fresh org with the counter and the manager signed in on the tablet (the inbox refuses an event from a person who has not). */
async function world(): Promise<Fx> {
  const f = await fixture();
  await signedIn(f, f.counterId, f.managerId);
  return f;
}

const send = (f: Fx, events: Ev[]) => applyPosEvents({ pairing: { pairingId: f.pairingId, orgId: f.orgId, storeId: f.storeId }, events }, RATES);
const statuses = (r: Awaited<ReturnType<typeof send>>) => r.results.map((x) => (x.status === 'applied' || x.status === 'duplicate' ? x.status : `${x.status}: ${x.error}`));

/** T-634 (0278): a store charge row is the store's switch for an org charge option; the helper makes the option too. */
async function preset(f: Fx, name: string, amount: string, perUnit: boolean, status: 'active' | 'retired' = 'active') {
  return chargePresetRow(sql as never, { orgId: f.orgId, storeId: f.storeId, name, amount, perUnit, status, createdBy: f.adminId });
}
const chargeAdded = (sessionId: string, o: { chargeId?: string; presetId?: string; name?: string; unitAmount?: string; qty?: number; addedAtDevice?: string }) => ({
  chargeId: o.chargeId ?? uuid(), sessionId, qty: o.qty ?? 1, addedAtDevice: o.addedAtDevice ?? nowIso(),
  ...(o.presetId ? { presetId: o.presetId } : { name: o.name ?? 'Corkage', unitAmount: o.unitAmount ?? '50.00' }),
});

/** A table of 2 pork (500.00) and its first two events (seq 1, 2). */
function table(f: Fx) {
  const sessionId = uuid();
  const porkLineId = uuid();
  return {
    sessionId, porkLineId,
    open: [
      ev(1, 'stand.opened', f.counterId, standOpenedPayload(sessionId, f.stand7)),
      ev(2, 'lines.added', f.counterId, linesAddedPayload(sessionId, [{ lineId: porkLineId, item: f.menu.pork, qty: 2 }])),
    ],
  };
}
/** The sale.completed of that table: device goods 500.00, device chargeTotal as given, cash as given. */
function sale(f: Fx, t: { sessionId: string; porkLineId: string }, o: { chargeTotal?: string | null; cash: string; seq?: number }) {
  const p = salePayload(f, { sessionId: t.sessionId, porkLineId: t.porkLineId, cashPaid: o.cash, ...(o.seq ? { terminalSeq: o.seq } : {}) });
  if (o.chargeTotal !== null) (p.device as Record<string, unknown>).chargeTotal = o.chargeTotal ?? '0.00';
  return { receiptId: p.receiptId as string, event: p };
}

describe('T-627 store charges through the inbox', () => {
  it('an offline replay in order: add a preset (per unit) and a custom charge, remove one, pay the amount due; the receipt holds the rest, the totals match, nothing is flagged', async () => {
    const f = await world();
    const leftover = await preset(f, 'Leftover', '100.00', true);
    const t = table(f);
    const keep = uuid();
    const drop = uuid();
    const s = sale(f, t, { chargeTotal: '350.00', cash: '1000.00' }); // 500.00 + Leftover 3 x 100 + Corkage 50 = 850.00; the removed 25.00 is not in it
    const t0 = Date.now();
    const r = await send(f, [
      ...t.open,
      // distinct device times: receipt charge order is (device time, id), so equal times made the order random
      ev(3, 'charge.added', f.counterId, chargeAdded(t.sessionId, { chargeId: keep, presetId: leftover, qty: 3, addedAtDevice: new Date(t0 - 3000).toISOString() })),
      ev(4, 'charge.added', f.counterId, chargeAdded(t.sessionId, { chargeId: drop, name: 'Oops', unitAmount: '25.00', addedAtDevice: new Date(t0 - 2000).toISOString() })),
      ev(5, 'charge.added', f.counterId, chargeAdded(t.sessionId, { name: 'Corkage', unitAmount: '50.00', addedAtDevice: new Date(t0 - 1000).toISOString() })),
      ev(6, 'charge.removed', f.counterId, { chargeId: drop, removedAtDevice: nowIso() }),
      ev(7, 'sale.completed', f.counterId, s.event),
    ]);
    expect(statuses(r)).toEqual(Array(7).fill('applied'));

    const [rec] = await sql<{ total: string; charge_total: string; subtotal: string }[]>`select total::text, charge_total::text, subtotal::text from pos_sales_receipts where id = ${s.receiptId}`;
    expect(rec).toEqual({ total: '500.00', charge_total: '350.00', subtotal: '500.00' });
    const rows = await sql<{ name: string; qty: number; amount: string }[]>`select name, qty, amount::text from pos_sales_receipt_charges where receipt_id = ${s.receiptId} order by charge_no`;
    expect(rows).toEqual([{ name: 'Leftover', qty: 3, amount: '300.00' }, { name: 'Corkage', qty: 1, amount: '50.00' }]);
    expect((await sql<{ status: string }[]>`select status from table_session_charges where id = ${drop}`)[0]!.status).toBe('removed');
    expect(await auditRows(f, 'pos.sale_recompute_mismatch')).toHaveLength(0);
    expect(await auditRows(f, 'pos.sale_payment_variance')).toHaveLength(0);
    expect(await auditRows(f, 'pos.charge_added')).toHaveLength(3);
    const removed = await auditRows(f, 'pos.charge_removed');
    expect(removed).toHaveLength(1);
    expect(removed[0]!.actor_person_id).toBe(f.counterId); // who took it off
  });

  it('a replay of the whole batch (same seqs) changes nothing: every event is a duplicate', async () => {
    const f = await world();
    const t = table(f);
    const s = sale(f, t, { chargeTotal: '50.00', cash: '550.00' });
    const events = [...t.open, ev(3, 'charge.added', f.counterId, chargeAdded(t.sessionId, { name: 'Corkage', unitAmount: '50.00' })), ev(4, 'sale.completed', f.counterId, s.event)];
    expect(statuses(await send(f, events))).toEqual(Array(4).fill('applied'));
    expect(statuses(await send(f, events))).toEqual(Array(4).fill('duplicate'));
    expect(await sql`select 1 from pos_sales_receipt_charges where org_id = ${f.orgId}`).toHaveLength(1);
    expect(await sql`select 1 from table_session_charges where org_id = ${f.orgId}`).toHaveLength(1);
  });

  it('the same chargeId under a NEW seq: the same content is a no-op (nothing written, nothing audited twice), different content is refused as recorded differently', async () => {
    const f = await world();
    const leftover = await preset(f, 'Leftover', '100.00', true);
    const t = table(f);
    const id = uuid();
    const original = chargeAdded(t.sessionId, { chargeId: id, name: 'Corkage', unitAmount: '50.00' });
    expect(statuses(await send(f, [...t.open, ev(3, 'charge.added', f.counterId, original)]))).toEqual(['applied', 'applied', 'applied']);
    // same id, same content, a new seq: applied (handled) as a no-op
    expect(statuses(await send(f, [ev(4, 'charge.added', f.counterId, { ...original, addedAtDevice: nowIso() })]))).toEqual(['applied']);
    expect(await sql`select 1 from table_session_charges where org_id = ${f.orgId}`).toHaveLength(1);
    expect(await auditRows(f, 'pos.charge_added')).toHaveLength(1);
    // same id, other amount / other name / now a preset: recorded differently, nothing changes
    const differing = [
      { ...original, unitAmount: '60.00' },
      { ...original, name: 'Other' },
      { chargeId: id, sessionId: t.sessionId, qty: 3, addedAtDevice: nowIso(), presetId: leftover },
    ];
    const r = await send(f, differing.map((p, i) => ev(5 + i, 'charge.added', f.counterId, p)));
    expect(statuses(r)).toHaveLength(3);
    for (const line of statuses(r)) expect(line).toMatch(/^quarantined: RECORDED_DIFFERENTLY: This change was already recorded differently/);
    expect((await sql<{ name: string; unit_amount: string; qty: number }[]>`select name, unit_amount::text, qty from table_session_charges where id = ${id}`)[0]).toEqual({ name: 'Corkage', unit_amount: '50.00', qty: 1 });
  });

  it('the server recomputes: a tablet that left the charges out of its total is recorded with the server charge_total and a mismatch row (never refused)', async () => {
    const f = await world();
    const t = table(f);
    const s = sale(f, t, { chargeTotal: '0.00', cash: '550.00' });
    const r = await send(f, [...t.open, ev(3, 'charge.added', f.counterId, chargeAdded(t.sessionId, { name: 'Corkage', unitAmount: '50.00' })), ev(4, 'sale.completed', f.counterId, s.event)]);
    expect(statuses(r)).toEqual(Array(4).fill('applied'));
    expect((await sql<{ charge_total: string }[]>`select charge_total::text from pos_sales_receipts where id = ${s.receiptId}`)[0]!.charge_total).toBe('50.00');
    const mismatch = await auditRows(f, 'pos.sale_recompute_mismatch');
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0]!.after).toMatchObject({ chargeTotal: '50.00' });
    expect(mismatch[0]!.before).toMatchObject({ chargeTotal: '0.00' });
  });

  it('a sale queued before charges existed (no chargeTotal in the payload, no charges) applies as before with no flag', async () => {
    const f = await world();
    const t = table(f);
    const s = sale(f, t, { chargeTotal: null, cash: '500.00' });
    expect(statuses(await send(f, [...t.open, ev(3, 'sale.completed', f.counterId, s.event)]))).toEqual(['applied', 'applied', 'applied']);
    expect((await sql<{ charge_total: string }[]>`select charge_total::text from pos_sales_receipts where id = ${s.receiptId}`)[0]!.charge_total).toBe('0.00');
    expect(await auditRows(f, 'pos.sale_recompute_mismatch')).toHaveLength(0);
  });

  it('what the customer owes is total + charges: paying only the goods leaves the charges short (a recorded variance, not a refusal)', async () => {
    const f = await world();
    const t = table(f);
    const s = sale(f, t, { chargeTotal: '50.00', cash: '500.00' });
    const r = await send(f, [...t.open, ev(3, 'charge.added', f.counterId, chargeAdded(t.sessionId, { name: 'Corkage', unitAmount: '50.00' })), ev(4, 'sale.completed', f.counterId, s.event)]);
    expect(statuses(r)).toEqual(Array(4).fill('applied'));
    const gap = [...(await auditRows(f, 'pos.sale_payment_variance')), ...(await auditRows(f, 'pos.sale_payment_shortfall'))];
    expect(gap).toHaveLength(1);
    expect(gap[0]!.after).toMatchObject({ gap: '50.00', serverTotal: '550.00' });
  });

  it('the rules: a once-per-bill charge takes no quantity, a retired charge and an unknown one are refused, a custom charge needs a name and an amount, none of it written', async () => {
    const f = await world();
    const once = await preset(f, 'Extra griller', '150.00', false);
    const gone = await preset(f, 'Old fee', '10.00', false, 'retired');
    const t = table(f);
    await send(f, t.open);
    const bad = [
      chargeAdded(t.sessionId, { presetId: once, qty: 2 }),
      chargeAdded(t.sessionId, { presetId: gone }),
      chargeAdded(t.sessionId, { presetId: uuid() }),
      chargeAdded(t.sessionId, { name: '  ', unitAmount: '10.00' }),
      chargeAdded(t.sessionId, { name: 'Zero', unitAmount: '0.00' }),
      chargeAdded(t.sessionId, { name: 'Two', unitAmount: '10.00', qty: 2 }),
    ];
    const r = await send(f, bad.map((p, i) => ev(3 + i, 'charge.added', f.counterId, p)));
    expect(statuses(r)).toEqual([
      'quarantined: POS_EVENT_REFUSED: Extra griller is charged once per bill.',
      'quarantined: POS_EVENT_REFUSED: That charge is not available at this store.',
      'quarantined: POS_EVENT_REFUSED: That charge is not available at this store.',
      'quarantined: POS_EVENT_REFUSED: A charge name must be 1 to 40 characters.',
      'quarantined: POS_EVENT_REFUSED: A charge must be more than 0.',
      'quarantined: POS_EVENT_REFUSED: A custom charge is added once. Type the full amount.',
    ]);
    expect(await sql`select 1 from table_session_charges where org_id = ${f.orgId}`).toHaveLength(0);
  });

  it('a paid table takes no charge: the event is quarantined, and the database guard refuses a direct write (23001); a receipt charge cannot be changed', async () => {
    const f = await world();
    const t = table(f);
    const s = sale(f, t, { chargeTotal: '0.00', cash: '500.00' });
    await send(f, [...t.open, ev(3, 'sale.completed', f.counterId, s.event)]);
    const late = await send(f, [ev(4, 'charge.added', f.counterId, chargeAdded(t.sessionId, { name: 'Late', unitAmount: '10.00' }))]);
    expect(statuses(late)).toEqual(['quarantined: POS_EVENT_REFUSED: This table is already paid.']);
    await expect(
      sql`insert into table_session_charges (org_id, store_id, session_id, name, unit_amount, qty, added_by, added_at_device)
          values (${f.orgId}, ${f.storeId}, ${t.sessionId}, 'Sneaky', 10, 1, ${f.counterId}, now())`,
    ).rejects.toMatchObject({ code: '23001' });
    // a receipt's frozen charge row is append-only
    const t2 = table(f);
    const s2 = sale(f, t2, { chargeTotal: '50.00', cash: '550.00', seq: 9001 });
    await send(f, [ev(10, 'stand.opened', f.counterId, standOpenedPayload(t2.sessionId, f.stand7)), ev(11, 'lines.added', f.counterId, linesAddedPayload(t2.sessionId, [{ lineId: t2.porkLineId, item: f.menu.pork, qty: 2 }])), ev(12, 'charge.added', f.counterId, chargeAdded(t2.sessionId, { name: 'Corkage', unitAmount: '50.00' })), ev(13, 'sale.completed', f.counterId, s2.event)]);
    await expect(sql`update pos_sales_receipt_charges set qty = 9 where receipt_id = ${s2.receiptId}`).rejects.toMatchObject({ code: '23001' });
    await expect(sql`delete from pos_sales_receipt_charges where receipt_id = ${s2.receiptId}`).rejects.toMatchObject({ code: '23001' });
  });

  it('voiding a table takes its charges off with it; the table bill lists only active charges, priced after VAT', async () => {
    const f = await world();
    const t = table(f);
    const r = await send(f, [...t.open, ev(3, 'charge.added', f.counterId, chargeAdded(t.sessionId, { name: 'Corkage', unitAmount: '50.00' }))]);
    expect(statuses(r)).toEqual(['applied', 'applied', 'applied']);
    const bill = await asOrg(f.orgId, (tx) => getSessionBill(tx, f.counter, { storeId: f.storeId, sessionId: t.sessionId }, RATES));
    expect(bill.charges).toMatchObject([{ name: 'Corkage', unitAmount: '50.00', qty: 1 }]);
    expect(bill.pricing).toMatchObject({ total: '500.00', chargeTotal: '50.00', amountDue: '550.00' });
    const v = await send(f, [ev(4, 'session.voided', f.managerId, { sessionId: t.sessionId, reason: 'walked out', voidedAtDevice: nowIso(), offline: false })]);
    expect(statuses(v)).toEqual(['applied']);
    expect((await sql<{ status: string }[]>`select status from table_session_charges where session_id = ${t.sessionId}`)[0]!.status).toBe('removed');
  });

  it('the snapshot carries the store\'s ACTIVE charges (not the retired ones)', async () => {
    const f = await world();
    await preset(f, 'Leftover', '100.00', true);
    await preset(f, 'Old fee', '10.00', false, 'retired');
    const snap = await asOrg(f.orgId, (tx) => buildPosSnapshot(tx, { pairing: { pairingId: f.pairingId, orgId: f.orgId, storeId: f.storeId } }, RATES));
    expect(snap.body.chargePresets).toMatchObject([{ name: 'Leftover', amount: '100.00', perUnit: true }]);
    expect(snap.body.chargePresets).toHaveLength(1);
  });

  it('the caps: a unit above 100,000 is refused (custom, and in the org list), exactly 100,000 is fine, the database says it too, 1001 units is refused', async () => {
    const f = await world();
    const per = await preset(f, 'Leftover', '100.00', true);
    const t = table(f);
    const r = await send(f, [
      ...t.open,
      ev(3, 'charge.added', f.counterId, chargeAdded(t.sessionId, { name: 'Huge', unitAmount: '100000.01' })),
      ev(4, 'charge.added', f.counterId, chargeAdded(t.sessionId, { name: 'Limit', unitAmount: '100000.00' })),
      ev(5, 'charge.added', f.counterId, chargeAdded(t.sessionId, { presetId: per, qty: 1001 })),
    ]);
    expect(statuses(r)).toEqual([
      'applied',
      'applied',
      'quarantined: POS_EVENT_REFUSED: A charge can be at most 100,000 pesos.',
      'applied',
      'quarantined: POS_EVENT_REFUSED: The quantity must be a whole number from 1 to 1000.',
    ]);
    // the org's charge list (T-634): the same limit, in the domain's words ...
    const err = await asOrg(f.orgId, (tx) => createChargeOption(tx, f.admin, { name: 'Big', amount: '100000.01', perUnit: false })).then(() => null, (e: unknown) => e);
    expect((err as { userMessage?: string }).userMessage).toBe('A charge can be at most 100,000 pesos.');
    expect((await asOrg(f.orgId, (tx) => createChargeOption(tx, f.admin, { name: 'Edge', amount: '100000', perUnit: false }))).id).toBeTruthy();
    // ... and the database CHECK, even for a writer that skips the domain (the store row's amount is the option's, so the option holds the cap)
    await expect(sql`insert into charge_options (org_id, name, amount) values (${f.orgId}, 'Sneaky', 100000.01)`).rejects.toMatchObject({ code: '23514' });
    await expect(
      sql`insert into table_session_charges (org_id, store_id, session_id, name, unit_amount, qty, added_by, added_at_device) values (${f.orgId}, ${f.storeId}, ${t.sessionId}, 'Sneaky', 100000.01, 1, ${f.counterId}, now())`,
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('the table cap: 50 active charges is the most; the 51st is refused with a sentence, and taking one off makes room', async () => {
    const f = await world();
    const t = table(f);
    const ids = Array.from({ length: 50 }, () => uuid());
    const r = await send(f, [...t.open, ...ids.map((chargeId, i) => ev(3 + i, 'charge.added', f.counterId, chargeAdded(t.sessionId, { chargeId, name: `Fee ${i}`, unitAmount: '10.00' })))]);
    expect(statuses(r).every((x) => x === 'applied')).toBe(true);
    const over = await send(f, [ev(60, 'charge.added', f.counterId, chargeAdded(t.sessionId, { name: 'One too many', unitAmount: '10.00' }))]);
    expect(statuses(over)).toEqual(['quarantined: POS_EVENT_REFUSED: A table can have at most 50 charges. Remove one first.']);
    expect(await sql`select 1 from table_session_charges where session_id = ${t.sessionId} and status = 'active'`).toHaveLength(50);
    expect(statuses(await send(f, [ev(61, 'charge.removed', f.counterId, { chargeId: ids[0], removedAtDevice: nowIso() }), ev(62, 'charge.added', f.counterId, chargeAdded(t.sessionId, { name: 'Fits now', unitAmount: '10.00' }))]))).toEqual(['applied', 'applied']);
  });

  it('charge.removed twice is a no-op the second time (wrote: false, one audit row); on a paid table it is refused and the charge stays', async () => {
    const f = await world();
    const t = table(f);
    const keep = uuid();
    const gone = uuid();
    const s = sale(f, t, { chargeTotal: '50.00', cash: '550.00' });
    await send(f, [
      ...t.open,
      ev(3, 'charge.added', f.counterId, chargeAdded(t.sessionId, { chargeId: gone, name: 'Oops', unitAmount: '25.00' })),
      ev(4, 'charge.added', f.counterId, chargeAdded(t.sessionId, { chargeId: keep, name: 'Corkage', unitAmount: '50.00' })),
      ev(5, 'charge.removed', f.counterId, { chargeId: gone, removedAtDevice: nowIso() }),
    ]);
    const again = await asOrg(f.orgId, (tx) => removeCharge(tx, f.counter, { storeId: f.storeId, pairingId: f.pairingId, chargeId: gone, removedAtDevice: nowIso() }));
    expect(again).toEqual({ wrote: false });
    expect(statuses(await send(f, [ev(6, 'charge.removed', f.counterId, { chargeId: gone, removedAtDevice: nowIso() })]))).toEqual(['applied']);
    expect(await auditRows(f, 'pos.charge_removed')).toHaveLength(1);
    // pay the table, then try to take the other charge off
    expect(statuses(await send(f, [ev(7, 'sale.completed', f.counterId, s.event)]))).toEqual(['applied']);
    const late = await send(f, [ev(8, 'charge.removed', f.counterId, { chargeId: keep, removedAtDevice: nowIso() })]);
    expect(statuses(late)).toEqual(['quarantined: POS_EVENT_REFUSED: This table is already paid.']);
    expect((await sql<{ status: string }[]>`select status from table_session_charges where id = ${keep}`)[0]!.status).toBe('active');
  });
});
