/**
 * T-392 S1b (TESTER) - v1 channel receivable from the journal LEGS (docs/tasks/392-dual-run-comparator.md "S1b spec",
 * invariants 32-37). Pure: no database. Synthetic data, invented names.
 *
 * Pinned shapes (the spec names rules, not signatures; builder matches these or reports the one it cannot):
 *  - computeV1Figures: the channel receivable is a `sales_tender` line, key `channel__<C>`, amount = sum(in - out) centavos,
 *    `days` by the leg's businessDate, and it ALSO carries `in`, `out`, `legs` (so the inv-9 sum can include it).
 *  - It is NOT in `scope`. Settlement (`ar_clear`) and manual credit (`ar:<customerId>`) legs stay in `scope`
 *    as NOT_IN_DUAL_RUN_SCOPE / sourceType `sale`.
 *  - V1Snapshot gains optional `channels?: { storeId, channelId, name, isRemittedDaily }[]` and
 *    `receipts?: { id, storeId, receiptNo }[]`; SnapshotExpense gains optional `receiptId`.
 *  - buildSnapshot reads `salesChannels[]` off each roster store doc; `receipts` is a raw collection like the others.
 *  - runDualRunExtract reads `stores/{id}/receipts` and passes the roster's salesChannels through.
 *  - prefillKeys adds an unticked `money` row (v1Key `channel__<C>`) per non-remitted channel / per C seen on a charge leg.
 *  - parseKeysCsv refuses a TICKED `channel__*` money row whose v2_key is not /^channel:[0-9a-f-]{36}$/.
 * Red today: none of the above exists (the legs fall to scope, the snapshot drops channels/receipts, the keys sheet accepts anything).
 */
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSnapshot } from '../src/dual-run/snapshot';
import { computeV1Figures } from '../src/dual-run/v1-figures';
import { parseKeysCsv, prefillKeys, serialiseKeysCsv } from '../src/dual-run/keys';
import { compareStoreWeek } from '../src/dual-run/compare';
import { makeReadOnlyV1Client } from '../src/master-data/snapshot';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const L = 'b9DzsnPbr1BUnY88lyT4';
const WEEK = '2026-10-19';
const CH_UUID = '3f2b8c1e-5d4a-4e7b-9a60-1c2d3e4f5a6b';
const V2_CATALOGUE = { stores: [], money: [], categories: [] };

const leg = (id: string, over: Any): Any => ({
  id, storeId: L, businessDate: '2026-10-21', sourceType: 'sale', sourceId: id, legKey: id, accountId: 'cash__cashier',
  direction: 'in', amount: 0, status: 'posted', ...over,
});
const chLeg = (id: string, date: string, amount: number, over: Any = {}): Any =>
  leg(id, { businessDate: date, sourceId: id, legKey: 'ar:channel_grab1', accountId: 'ar__channel_grab1', amount, ...over });

function journal(): Any[] {
  return [
    chLeg('ch_grab1_2026-10-21', '2026-10-21', 1250),
    chLeg('ch_grab1_2026-10-22', '2026-10-22', 900, { status: 'voided' }),
    chLeg('ch_grab1_2026-10-22__r1', '2026-10-22', 950),
    leg('stl1', { businessDate: '2026-10-23', legKey: 'ar_clear', accountId: 'ar__channel_grab1', direction: 'out', amount: 2000 }),
    leg('ar_cust9_1', { businessDate: '2026-10-22', legKey: 'ar:cust9', accountId: 'ar__cust9', amount: 300 }),
    leg('sale1', { amount: 500 }),
    leg('pay1', { businessDate: '2026-10-23', sourceType: 'expense_payment', legKey: 'p1', accountId: 'ap__sup1', direction: 'out', amount: 100, supplierId: 'sup1' }),
  ];
}
const CHANNELS_RAW = [
  { channelId: 'grab1', name: 'Grab Lipa', isActive: true, isRemittedDaily: false, commissionRate: 0.25, contactPerson: 'PII-CONTACT-PERSON', notes: 'PII-CHANNEL-NOTES' },
  { channelId: 'walkin', name: 'Walk-in', isActive: true, isRemittedDaily: true, commissionRate: 0, contactPerson: 'PII-CONTACT-PERSON-2', notes: 'PII-CHANNEL-NOTES-2' },
];
const rawStores = (withChannels = true): Any[] => [{ id: L, name: 'SharEat Lipa', ...(withChannels ? { salesChannels: CHANNELS_RAW } : {}) }];
const snapOf = (raw: Any): Any => buildSnapshot({ stores: rawStores(), ...raw }, { from: WEEK, through: '2026-10-25', extractedAt: '2026-10-26T01:00:00.000Z' });
const figOf = (snapshot: Any): Any => computeV1Figures(snapshot, { weekStart: WEEK }).stores[L];
const fixtureFig = (): Any => figOf(snapOf({ journal: journal() }));
const tender = (f: Any, key: string): Any => f.lines.find((x: Any) => x.kind === 'sales_tender' && x.key === key);
const scopeSale = (f: Any): Any => f.scope.find((s: Any) => s.class === 'NOT_IN_DUAL_RUN_SCOPE' && s.sourceType === 'sale');

describe('S1b v1 channel receivable from the journal legs', () => {
  // Mutants: the charge left in scope (no line at all); line keyed by accountId (`ar__channel_grab1`, not `channel__grab1`).
  it('[inv 32] the 21 Oct charge is sales_tender/channel__grab1 = 125000 on 2026-10-21 and is absent from scope', () => {
    const f = fixtureFig();
    const l = tender(f, 'channel__grab1');
    expect(l, 'a sales_tender line keyed channel__grab1').toBeDefined();
    expect(l.days['2026-10-21']).toBe(125000);
    expect(tender(f, 'ar__channel_grab1')).toBeUndefined();
    // Only the manual credit (300.00 in) may remain in the `sale` scope entry as an in-leg.
    expect(scopeSale(f).in).toBe(30000);
  });

  // Mutants: no status filter (the voided 900.00 slot would add 90000); both slots summed (same effect).
  it('[inv 33] the 22 Oct pair is 95000: the voided slot contributes nothing, __r1 is the live one', () => {
    const l = tender(fixtureFig(), 'channel__grab1');
    expect(l, 'a sales_tender line keyed channel__grab1').toBeDefined();
    expect(l.days['2026-10-22']).toBe(95000);
    expect(l.legs).toBe(2);
    expect(l.in).toBe(220000);
    expect(l.out).toBe(0);
    expect(l.amount).toBe(220000);
  });

  // Mutant: account-prefix discriminator (pulls the ar_clear -200000 into the line, and takes ar__cust9 as a channel).
  it('[inv 34] ar_clear and ar:cust9 stay in scope; the channel line + cash_bank + ap_supplier + scope sum to posted', () => {
    const f = fixtureFig();
    const l = tender(f, 'channel__grab1');
    expect(l, 'a sales_tender line keyed channel__grab1').toBeDefined();
    expect(l.amount).toBe(220000);
    expect(l.days['2026-10-23']).toBeUndefined();
    const s = scopeSale(f);
    expect(s.legs).toBe(2);
    expect(s.in).toBe(30000);
    expect(s.out).toBe(200000);
    const lines = f.lines.filter((x: Any) => x.kind === 'cash_bank' || x.kind === 'ap_supplier' || (x.kind === 'sales_tender' && String(x.key).startsWith('channel__')));
    const sum = { legs: 0, in: 0, out: 0 };
    for (const x of lines) { sum.legs += x.legs; sum.in += x.in; sum.out += x.out; }
    for (const e of f.scope) { sum.legs += e.legs; sum.in += e.in; sum.out += e.out; }
    expect(sum).toEqual(f.posted);
    expect(f.posted).toEqual({ legs: 6, in: 300000, out: 210000 });
  });
});

/** A minimal Firestore double: collection(path).get() only, which is all the read-only client needs. */
function fakeFirestore(docs: Record<string, Array<{ id: string; data: Record<string, unknown> }>>) {
  const reads: string[] = [];
  return {
    reads,
    collection: (path: string) => ({
      get: async () => { reads.push(path); return { docs: (docs[path] ?? []).map((d) => ({ id: d.id, data: () => d.data })) }; },
    }),
  };
}
const PII = ['PII-CONTACT-PERSON', 'PII-CHANNEL-NOTES', 'PII-RECEIPT-NOTES', 'PII-PROOF-URL', 'PII-SUBMITTER-UID', 'PII-CUSTOMER-NAME', 'PII-REFNO'];
const expenseRaw = (over: Any = {}): Any => ({
  id: 'ex1', storeId: L, dayKey: '2026-10-21', totalAmount: 250, status: 'posted', supplierId: 'sup1', expenseEntryId: 'ent1',
  expenseEntryGroup: 'OPEX', category: 'Supplies', payments: [], ...over,
});
const receiptsRaw = (): Any[] => [
  { id: 'rc1', storeId: L, receiptNo: 'SI-00123', notes: 'PII-RECEIPT-NOTES', proofUrl: 'PII-PROOF-URL', submittedByUid: 'PII-SUBMITTER-UID', customerName: 'PII-CUSTOMER-NAME', referenceNo: 'PII-REFNO' },
  { id: 'rc2', storeId: L, receiptNo: 'SI-99999', notes: 'PII-RECEIPT-NOTES' },
];
const strip = (o: Any): Any => ({ ...o, id: undefined, storeId: undefined });

describe('S1b snapshot whitelist', () => {
  // Mutants: whole channel/receipt object kept (extra keys + PII); a missing optional field throws.
  it('[inv 35] the snapshot holds exactly the whitelisted channel/receipt fields; receiptId survives; a snapshot without them loads', () => {
    const s = snapOf({ journal: journal(), expenses: [expenseRaw({ receiptId: 'rc1' }), expenseRaw({ id: 'ex2', expenseEntryId: 'ent2' })], receipts: receiptsRaw() });
    expect(s.channels, 'snapshot.channels').toEqual([
      { storeId: L, channelId: 'grab1', name: 'Grab Lipa', isRemittedDaily: false },
      { storeId: L, channelId: 'walkin', name: 'Walk-in', isRemittedDaily: true },
    ]);
    expect(Object.keys(s.channels[0]).sort()).toEqual(['channelId', 'isRemittedDaily', 'name', 'storeId']);
    expect(s.receipts, 'snapshot.receipts').toEqual([{ id: 'rc1', storeId: L, receiptNo: 'SI-00123' }]);
    expect(s.expenses.find((e: Any) => e.id === 'ex1').receiptId).toBe('rc1');
    expect(s.expenses.find((e: Any) => e.id === 'ex2').receiptId).toBeUndefined();
    const text = JSON.stringify(s);
    for (const p of PII) expect(text.includes(p), p).toBe(false);

    // A snapshot built with no channels / receipts at all, and a stored one without the fields, both load.
    const bare = buildSnapshot({ stores: rawStores(false), journal: journal() }, { from: WEEK, through: '2026-10-25' }) as Any;
    expect(bare.channels ?? []).toEqual([]);
    expect(bare.receipts ?? []).toEqual([]);
    const stored = JSON.parse(readFileSync(join(__dirname, 'fixtures', 't392-v1-snapshot.json'), 'utf8'));
    expect(stored.channels).toBeUndefined();
    expect(() => computeV1Figures(stored, { weekStart: WEEK })).not.toThrow();
    expect(() => prefillKeys({ snapshot: stored, existing: [], v2: V2_CATALOGUE })).not.toThrow();
  });

  it('[inv 35] extract reads stores/{id}/receipts, passes salesChannels through, whitelists both, and pre-fills the channel row', async () => {
    const fs = fakeFirestore({
      stores: [{ id: L, data: { name: 'SharEat Lipa', salesChannels: CHANNELS_RAW } }],
      [`stores/${L}/journal`]: journal().map((j) => ({ id: j.id, data: strip(j) })),
      [`stores/${L}/expenses`]: [{ id: 'ex1', data: strip(expenseRaw({ receiptId: 'rc1' })) }],
      [`stores/${L}/receipts`]: receiptsRaw().map((r) => ({ id: r.id, data: strip(r) })),
    });
    const outDir = mkdtempSync(join(tmpdir(), 't392-s1b-'));
    const m: Any = await import('../../../scripts/lib/dual-run-extract');
    const result = await m.runDualRunExtract(makeReadOnlyV1Client(fs as Any), {
      from: WEEK, through: '2026-10-25', outDir, env: { NODE_ENV: 'development' }, now: new Date('2026-10-26T01:00:00.000Z'),
    });
    expect(fs.reads).toContain(`stores/${L}/receipts`);
    expect(result.snapshot.channels).toEqual([
      { storeId: L, channelId: 'grab1', name: 'Grab Lipa', isRemittedDaily: false },
      { storeId: L, channelId: 'walkin', name: 'Walk-in', isRemittedDaily: true },
    ]);
    expect(result.snapshot.receipts).toEqual([{ id: 'rc1', storeId: L, receiptNo: 'SI-00123' }]);
    const text = readdirSync(outDir).map((f) => readFileSync(join(outDir, f), 'utf8')).join('\n');
    for (const p of PII) expect(text.includes(p), p).toBe(false);
    const rows = parseKeysCsv(readFileSync(join(outDir, 'dual-run-keys.csv'), 'utf8'));
    expect(rows.find((r) => r.section === 'money' && r.v1Key === 'channel__grab1')).toMatchObject({ v1Store: L, v1Label: 'Grab Lipa', ticked: false });
    expect(rows.find((r) => r.v1Key === 'channel__walkin')).toBeUndefined();
  });
});

describe('S1b keys sheet', () => {
  // Mutants: a remitted channel pre-filled; a bad ticked row accepted.
  it('[inv 36] pre-fill adds an unticked money row channel__grab1 labelled "Grab Lipa" and none for walkin; a channel seen only on a leg is labelled by its id', () => {
    const snapshot = snapOf({ journal: [...journal(), chLeg('ch_ghost_1', '2026-10-24', 10, { legKey: 'ar:channel_ghost', accountId: 'ar__channel_ghost' })] });
    const rows = prefillKeys({ snapshot, existing: [], v2: V2_CATALOGUE });
    expect(rows.find((r) => r.v1Key === 'channel__grab1')).toEqual({ section: 'money', v1Store: L, v1Key: 'channel__grab1', v1Label: 'Grab Lipa', v2Key: '', ticked: false });
    expect(rows.find((r) => r.v1Key === 'channel__walkin')).toBeUndefined();
    expect(rows.find((r) => r.v1Key === 'channel__ghost')).toMatchObject({ section: 'money', v1Label: 'ghost', ticked: false });
  });

  it('[inv 36] a ticked channel__grab1 row with v2_key none, a bare UUID or 1220 is refused; channel:<uuid> and an unrelated "none" row are accepted', () => {
    const row = (v1Key: string, v2Key: string, ticked = true): Any => ({ section: 'money', v1Store: L, v1Key, v1Label: 'x', v2Key, ticked });
    for (const bad of ['none', CH_UUID, '1220']) {
      expect(() => parseKeysCsv(serialiseKeysCsv([row('channel__grab1', bad)])), bad).toThrow();
    }
    expect(parseKeysCsv(serialiseKeysCsv([row('channel__grab1', `channel:${CH_UUID}`)]))[0]).toMatchObject({ v2Key: `channel:${CH_UUID}`, ticked: true });
    expect(() => parseKeysCsv(serialiseKeysCsv([row('channel__grab1', 'none', false)]))).not.toThrow();
    expect(() => parseKeysCsv(serialiseKeysCsv([row('other', 'none')]))).not.toThrow();
  });
});

describe('S1b through the comparator', () => {
  const input = (keyMap: Record<string, string>): Any => {
    const f = figOf(snapOf({ journal: [chLeg('ch_grab1_2026-10-21', '2026-10-21', 1250)] }));
    return {
      orgId: 'org-1', storeId: 'LIPA', weekStart: WEEK, through: '2026-10-25',
      v1: { lines: f.lines, tradingDays: ['2026-10-21'], cashResidual: {}, scope: f.scope },
      v2: { lines: [{ kind: 'sales_tender', key: `channel:${CH_UUID}`, amount: 125000, days: { '2026-10-21': 125000 } }], tradingDays: ['2026-10-21'] },
      keyMap, v1Docs: [], v2Docs: [], dispositions: [],
    };
  };
  const ln = (r: Any, key: string): Any => {
    const l = r.lines.find((x: Any) => x.kind === 'sales_tender' && x.key === key);
    if (!l) throw new Error(`no result line sales_tender/${key}; have ${r.lines.map((x: Any) => `${x.kind}/${x.key}`).join(', ')}`);
    return l;
  };

  // Mutant: the unmapped key merged into the v2 line (the v1 figure would silently tie a receivable nobody mapped).
  it('[inv 37] a ticked row mapping channel__grab1 to channel:<uuid>: v1 125000 vs v2 125000 same day is TIES', () => {
    const r = compareStoreWeek(input({ 'sales_tender|channel__grab1': `channel:${CH_UUID}` }));
    const l = ln(r, `channel:${CH_UUID}`);
    expect(l.v1).toBe(125000);
    expect(l.v2).toBe(125000);
    expect(l.delta).toBe(0);
    expect(l.class).toBe('TIES');
    expect(r.verdict).toBe('ties');
  });

  it('[inv 37] with no row the v1 line is UNMAPPED_KEY on v1:channel__grab1 and the v2 line is UNEXPLAINED; never merged', () => {
    const r = compareStoreWeek(input({}));
    const a = ln(r, 'v1:channel__grab1');
    expect(a.v1).toBe(125000);
    expect(a.class).toBe('UNMAPPED_KEY');
    const b = ln(r, `channel:${CH_UUID}`);
    expect(b.v1).toBe(0);
    expect(b.v2).toBe(125000);
    expect(b.class).toBe('UNEXPLAINED');
    expect(r.verdict).toBe('open');
  });
});

// ---- audit round additions -------------------------------------------------------------------------------------------
// Item 1 (run parsed rows through the domain keyMapFor) is NOT written: keyMapFor is module-private in
// packages/domain/src/dual-run/index.ts (not exported), and the tester may not edit source. Reported as a question.
const M = 'dZUyvX4q824JBSVDAfE9';
const twoStores = (): Any[] => [
  { id: L, name: 'SharEat Lipa', salesChannels: CHANNELS_RAW },
  { id: M, name: 'SharEat Malvar', salesChannels: [{ channelId: 'grab1', name: 'Grab Malvar', isRemittedDaily: false }] },
];
const snapTwo = (raw: Any): Any => buildSnapshot({ stores: twoStores(), ...raw }, { from: WEEK, through: '2026-10-25', extractedAt: '2026-10-26T01:00:00.000Z' });
const figStore = (snapshot: Any, id: string): Any => computeV1Figures(snapshot, { weekStart: WEEK }).stores[id];

describe('S1b discriminator negatives (item 2)', () => {
  it('a sale leg on ar__channel_grab1 with legKey ar:channel_other, and charge-shaped expense_payment / adjustment legs, stay in scope', () => {
    const legs = [
      chLeg('x1', '2026-10-21', 10, { legKey: 'ar:channel_other' }),
      chLeg('x2', '2026-10-21', 20, { sourceType: 'expense_payment' }),
      chLeg('x3', '2026-10-21', 40, { sourceType: 'adjustment' }),
    ];
    const f = figOf(snapOf({ journal: legs }));
    expect(f.lines.filter((x: Any) => String(x.key).startsWith('channel__')), 'no channel line').toEqual([]);
    const sc = (t: string): Any => f.scope.find((s: Any) => s.sourceType === t);
    expect(sc('sale')).toMatchObject({ legs: 1, in: 1000 });
    expect(sc('expense_payment')).toMatchObject({ legs: 1, in: 2000 });
    expect(sc('adjustment')).toMatchObject({ legs: 1, in: 4000 });
    expect(f.posted).toEqual({ legs: 3, in: 7000, out: 0 });
  });
});

describe('S1b channel line edges (item 3)', () => {
  it('an out charge (reversal) gives a negative day', () => {
    const f = figOf(snapOf({ journal: [chLeg('c1', '2026-10-21', 1250), chLeg('c2', '2026-10-24', 100, { direction: 'out' })] }));
    const l = tender(f, 'channel__grab1');
    expect(l, 'channel line').toBeDefined();
    expect(l.days['2026-10-24']).toBe(-10000);
    expect(l.out).toBe(10000);
    expect(l.amount).toBe(115000);
  });

  it('a charge outside the window is excluded, and another store never leaks in; two stores with the same channelId stay separate', () => {
    const snapshot = snapTwo({
      journal: [
        chLeg('in1', '2026-10-21', 1250),
        chLeg('far', '2026-12-05', 777),
        chLeg('late', '2026-10-27', 555),
        chLeg('m1', '2026-10-21', 300, { storeId: M }),
      ],
    });
    expect(snapshot.journal.find((j: Any) => j.id === 'far')).toBeUndefined();
    const l = tender(figStore(snapshot, L), 'channel__grab1');
    expect(l, 'Lipa channel line').toBeDefined();
    expect(l.amount).toBe(125000);
    expect(l.legs).toBe(1);
    const m = tender(figStore(snapshot, M), 'channel__grab1');
    expect(m, 'Malvar channel line').toBeDefined();
    expect(m.amount).toBe(30000);
    expect(m.legs).toBe(1);
  });
});

describe('S1b PII, receipts, re-run, key shape, remitted-field flag', () => {
  it('[item 4] customerName / notes / referenceNo on a journal leg and an expense never reach the snapshot or the files', async () => {
    const pii = { customerName: 'PII-CUSTOMER-NAME', notes: 'PII-LEG-NOTES', referenceNo: 'PII-REFNO' };
    const fs = fakeFirestore({
      stores: [{ id: L, data: { name: 'SharEat Lipa', salesChannels: CHANNELS_RAW } }],
      [`stores/${L}/journal`]: journal().map((j, i) => ({ id: j.id, data: strip(i < 3 ? { ...j, ...pii } : j) })),
      [`stores/${L}/expenses`]: [{ id: 'ex1', data: strip(expenseRaw({ receiptId: 'rc1', ...pii })) }],
      [`stores/${L}/receipts`]: receiptsRaw().map((r) => ({ id: r.id, data: strip(r) })),
    });
    const outDir = mkdtempSync(join(tmpdir(), 't392-s1b-pii-'));
    const m: Any = await import('../../../scripts/lib/dual-run-extract');
    const result = await m.runDualRunExtract(makeReadOnlyV1Client(fs as Any), {
      from: WEEK, through: '2026-10-25', outDir, env: { NODE_ENV: 'development' }, now: new Date('2026-10-26T01:00:00.000Z'),
    });
    expect(result.snapshot.journal.find((j: Any) => j.id === 'ch_grab1_2026-10-21')).toBeDefined();
    const text = readdirSync(outDir).map((f) => readFileSync(join(outDir, f), 'utf8')).join('\n');
    for (const p of [...PII, 'PII-LEG-NOTES']) expect(text.includes(p), p).toBe(false);
  });

  it('[item 5] an existing TICKED channel__grab1 row with a v2 key survives pre-fill unchanged', () => {
    const existing = [{ section: 'money' as const, v1Store: L, v1Key: 'channel__grab1', v1Label: 'my own label', v2Key: `channel:${CH_UUID}`, ticked: true }];
    const rows = prefillKeys({ snapshot: snapOf({ journal: journal() }), existing, v2: V2_CATALOGUE });
    expect(rows.filter((r) => r.v1Key === 'channel__grab1')).toEqual(existing);
  });

  it('[item 6] an expense in store A pointing at a receipt id that exists only in store B drops that receipt', () => {
    const s = snapTwo({
      expenses: [expenseRaw({ receiptId: 'rcB' })],
      receipts: [{ id: 'rcB', storeId: M, receiptNo: 'SI-B-1' }],
    });
    expect(s.expenses.find((e: Any) => e.id === 'ex1').receiptId).toBe('rcB');
    expect(s.receipts ?? []).toEqual([]);
  });

  it('[item 7] a ticked channel__ row whose v2_key is not a real UUID shape is refused (36 hyphens, 36 hex digits, short hex)', () => {
    const row = (v2Key: string): Any => ({ section: 'money', v1Store: L, v1Key: 'channel__grab1', v1Label: 'x', v2Key, ticked: true });
    for (const bad of ['channel:' + '-'.repeat(36), 'channel:' + 'a'.repeat(36), 'channel:3f2b8c1e-5d4a-4e7b-9a60-1c2d3e4f5a6']) {
      expect(() => parseKeysCsv(serialiseKeysCsv([row(bad)])), bad).toThrow();
    }
    expect(() => parseKeysCsv(serialiseKeysCsv([row(`channel:${CH_UUID}`)]))).not.toThrow();
  });

  it('[item 8] a day whose only sale leg is a channel charge (dineInSales 0) does NOT raise V1_REMITTED_FIELD_ZERO', () => {
    const snapshot = snapOf({
      journal: [chLeg('ch_grab1_2026-10-21', '2026-10-21', 1250)],
      salesDays: [{ id: '2026-10-21', storeId: L, status: 'verified', dineInSales: 0, onlineBreakdown: {}, creditSales: 0, otherPaymentSales: 0 }],
    });
    const f = figOf(snapshot);
    expect(f.tradingDays).toEqual(['2026-10-21']);
    expect(f.flags.filter((x: Any) => x.code === 'V1_REMITTED_FIELD_ZERO')).toEqual([]);
    expect(f.cashResidual['2026-10-21']).toBe(0);
  });
});
