/**
 * T-391 S4 (TESTER) - the PARTIES planner (suppliers and customers). Pure: no database.
 * docs/tasks/391-production-master-data-load.md, rulings P1-P8 (+R4, R11, R12), test 13, invariants I1, I7, I8.
 *
 * CONTRACT these tests pin (the spec names the file, not the signature - the builder builds to this):
 *   packages/etl/src/master-data/parties-plan.ts
 *     planParties({ snapshot, map, orgCode, storeCodes?, existingSuppliers, existingCustomers, links, answers })
 *       -> { writes, sheets, stale, drift, held }
 *       snapshot : the v1 snapshot (R10 shape: suppliers[] and arCustomers[], see the helpers below)
 *       map      : parseStoreMap rows;  existingSuppliers / existingCustomers: [{ id, name, status, ...v2 columns }]
 *       links    : [{ entity:'supplier'|'customer', v1StoreId, v1Id, v2Id }]   (no unit, no factor)
 *       answers  : { [sheetName]: Row[] }   (parsed CSV rows; a tick is 'yes')
 *     writes (no other op exists, I7):
 *       { op:'create', entity:'supplier', name, address, contactNo, email, representativeName, tin, vatStatus,
 *         classification, issuesOfficialReceipt, creditTermsDays, bankName, bankAccountName, bankAccountNumber (MASKED only),
 *         status:'active'|'inactive', counterpartyV1StoreId: string|null (the v1 store id the mirror points at),
 *         links:[{ v1StoreId, v1Id }] }
 *       { op:'create', entity:'customer', name, address, contactNo, group:'wholesale'|'internal'|'staff'|'other',
 *         status:'active'|'inactive', counterpartyV1StoreId: string|null, links:[...] }
 *       { op:'link', entity, v2Id, links:[...] }
 *     sheets (all four always present, as arrays):
 *       'suppliers-twins' | 'customers-twins': ['row_key','group','name','stores','same_or_different','keep_name','note']
 *       'suppliers-tax': ['row_key','supplier','stores','vat_status','tin','note']   (Ian fills vat_status and tin)
 *       'parties-held':  ['row_key','entity','name','stores','reason','note']        (nothing to answer: waiting on something outside)
 *     drift: [{ entity, v1Id, ... }] - a LINKED v1 record whose v1 value differs from the linked v2 row (R13: reported, never written)
 *     held : rows Ian still has to answer (twins and tax). 0 = nothing held.
 *
 * Red today: the module does not exist, so each test fails on its dynamic import, inside the test.
 */
import { describe, expect, it } from 'vitest';
import { parseStoreMap } from '../src/master-data/store-map';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const L = 'b9DzsnPbr1BUnY88lyT4';
const M = 'dZUyvX4q824JBSVDAfE9';
const B = 'iGOW7q2pZbeHWV832UNh';
const P = 'y1DMgfisuTHBF57cNL6i';

const MAP_CSV = [
  'v1_store_id,name,role,org_code,store_code',
  `${L},SharEat Lipa,own,SE,LIPA`,
  `${M},SharEat Malvar,own,SE,MLVR`,
  `${B},SharEat Banay-Banay,own,SE,BNBN`,
  `${P},SharEat Padre Garcia,franchise,SEPG,PGAR`,
].join('\r\n');

let n = 0;
const sup = (store: string, name: string, over: Record<string, unknown> = {}): Any => ({
  id: `s${++n}`,
  store,
  businessName: name,
  classification: 'Corporate',
  isActive: true,
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});
const cust = (store: string, name: string, over: Record<string, unknown> = {}): Any => ({
  id: `c${++n}`,
  store,
  name,
  classification: 'corporate',
  status: 'active',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});
const snap = (suppliers: Any[] = [], arCustomers: Any[] = []): Any => ({
  version: 1, stores: [], items: [], suppliers, arCustomers, staff: [], staffIdentities: [],
});

async function plan(snapshot: Any, over: Record<string, unknown> = {}): Promise<Any> {
  const mod: Any = await import('../src/master-data/parties-plan');
  return mod.planParties({
    snapshot,
    map: parseStoreMap(MAP_CSV),
    orgCode: 'SE',
    existingSuppliers: [],
    existingCustomers: [],
    links: [],
    answers: {},
    ...over,
  });
}

const lc = (s: string): string => s.trim().toLowerCase();
const creates = (p: Any, entity: string): Any[] => p.writes.filter((w: Any) => w.op === 'create' && w.entity === entity);
const linksW = (p: Any, entity: string): Any[] => p.writes.filter((w: Any) => w.op === 'link' && w.entity === entity);
const createOf = (p: Any, entity: string, name: string): Any => creates(p, entity).find((w: Any) => lc(w.name) === lc(name));
const sheet = (p: Any, name: string): Any[] => p.sheets?.[name] ?? [];
const rowsFor = (p: Any, name: string, field: string, value: string): Any[] => sheet(p, name).filter((r: Any) => lc(r[field] ?? '') === lc(value));

describe('13a. P1 exact duplicates are one party, every store linked', () => {
  it('a supplier typed "Acme Foods" at Lipa and "acme foods " at Malvar is one create with two links. Mutant: one create per store record', async () => {
    const p = await plan(snap([sup(L, 'Acme Foods'), sup(M, 'acme foods ')]));
    const c = creates(p, 'supplier');
    expect(c).toHaveLength(1);
    expect(c[0].links.map((l: Any) => l.v1StoreId).sort()).toEqual([L, M].sort());
    expect(p.held).toBe(0);
  });

  it('the same for customers', async () => {
    const p = await plan(snap([], [cust(L, 'Mang Tonyo Eatery'), cust(M, 'mang tonyo eatery')]));
    const c = creates(p, 'customer');
    expect(c).toHaveLength(1);
    expect(c[0].links).toHaveLength(2);
  });

  it('I7: no write but create and link exists; every write names its entity', async () => {
    const p = await plan(snap([sup(L, 'Acme Foods')], [cust(L, 'Tonyo')]), {
      existingSuppliers: [{ id: 'v2-x', name: 'Other Co', status: 'active' }],
    });
    expect(p.writes.length).toBeGreaterThan(0);
    for (const w of p.writes) {
      expect(['create', 'link']).toContain(w.op);
      expect(['supplier', 'customer']).toContain(w.entity);
    }
  });
});

describe('13b. P3 survivorship: newest non-empty, per field', () => {
  it('supplier: the newer copy wins a field both have; an empty field in the newer copy is filled from the older. Mutant: oldest wins', async () => {
    const older = sup(L, 'Acme Foods', { address: 'Old Street', email: 'old@acme.test', updatedAt: '2026-01-01T00:00:00.000Z' });
    const newer = sup(M, 'Acme Foods', { address: 'New Street', email: '', updatedAt: '2026-06-01T00:00:00.000Z' });
    for (const order of [[older, newer], [newer, older]]) {
      const w = createOf(await plan(snap(order)), 'supplier', 'Acme Foods');
      expect(w.address).toBe('New Street');
      expect(w.email).toBe('old@acme.test');
    }
  });

  it('customer: by updatedAt, same rule', async () => {
    const older = cust(L, 'Tonyo Eatery', { address: 'Old Road', contactNo: '0917-111', updatedAt: '2026-02-01T00:00:00.000Z' });
    const newer = cust(M, 'Tonyo Eatery', { address: 'New Road', contactNo: '', updatedAt: '2026-07-01T00:00:00.000Z' });
    const w = createOf(await plan(snap([], [older, newer])), 'customer', 'Tonyo Eatery');
    expect(w.address).toBe('New Road');
    expect(w.contactNo).toBe('0917-111');
  });
});

describe('13c. P3 tax fields are held, never merged', () => {
  const disagree = (): Any =>
    snap([
      sup(L, 'Acme Foods', { vatStatus: 'VAT Reg', tin: '123-456-789-000', updatedAt: '2026-01-01T00:00:00.000Z' }),
      sup(M, 'Acme Foods', { vatStatus: 'Non-VAT Reg', tin: '123-456-789-000', updatedAt: '2026-09-01T00:00:00.000Z' }),
    ]);

  it('a vat_status disagreement is one row on suppliers-tax, no create for it, and counts as held. Mutant: tax fields survivorship-merged (newest wins)', async () => {
    const p = await plan(disagree());
    expect(creates(p, 'supplier')).toHaveLength(0);
    expect(rowsFor(p, 'suppliers-tax', 'supplier', 'Acme Foods')).toHaveLength(1);
    expect(p.held).toBeGreaterThan(0);
  });

  it('a tin disagreement is held the same way', async () => {
    const p = await plan(snap([
      sup(L, 'Acme Foods', { vatStatus: 'VAT Reg', tin: '123-456-789-000' }),
      sup(M, 'Acme Foods', { vatStatus: 'VAT Reg', tin: '999-888-777-000', updatedAt: '2026-09-01T00:00:00.000Z' }),
    ]));
    expect(creates(p, 'supplier')).toHaveLength(0);
    expect(rowsFor(p, 'suppliers-tax', 'supplier', 'Acme Foods')).toHaveLength(1);
    expect(p.held).toBeGreaterThan(0);
  });

  it("Ian's answer (vat_status + tin) releases it, and the create carries exactly his values; links stay whole", async () => {
    const first = await plan(disagree());
    const row = rowsFor(first, 'suppliers-tax', 'supplier', 'Acme Foods')[0];
    const p = await plan(disagree(), { answers: { 'suppliers-tax': [{ ...row, vat_status: 'non_vat', tin: '123-456-789-000' }] } });
    expect(p.held).toBe(0);
    const w = createOf(p, 'supplier', 'Acme Foods');
    expect(w.vatStatus).toBe('non_vat');
    expect(w.tin).toBe('123-456-789-000');
    expect(w.links).toHaveLength(2);
  });

  it('R11: an answer whose row_key no longer matches is ignored, listed stale, and the row is held again', async () => {
    const first = await plan(disagree());
    const row = rowsFor(first, 'suppliers-tax', 'supplier', 'Acme Foods')[0];
    const p = await plan(disagree(), { answers: { 'suppliers-tax': [{ ...row, row_key: 'kdeadbeef0000', vat_status: 'non_vat', tin: '123-456-789-000' }] } });
    expect(creates(p, 'supplier')).toHaveLength(0);
    expect(p.stale.length).toBeGreaterThan(0);
    expect(p.held).toBeGreaterThan(0);
  });

  it('R12: a held supplier holds back only itself', async () => {
    const s = disagree();
    s.suppliers.push(sup(L, 'Clean Co'));
    const p = await plan(s);
    expect(createOf(p, 'supplier', 'Clean Co')).toBeTruthy();
    expect(createOf(p, 'supplier', 'Acme Foods')).toBeUndefined();
  });
});

describe('13d. P5 own-store links', () => {
  it('a supplier whose linkedStoreId is an own store is a create carrying counterpartyV1StoreId (the mirror writer sets it after)', async () => {
    const p = await plan(snap([sup(L, 'SharEat Malvar', { linkedStoreId: M })]));
    const w = createOf(p, 'supplier', 'SharEat Malvar');
    expect(w.counterpartyV1StoreId).toBe(M);
  });

  it('an AR customer with linkedStoreId on an own store is group internal with the store link', async () => {
    const p = await plan(snap([], [cust(L, 'SharEat Malvar', { classification: 'corporate', linkedStoreId: M })]));
    const w = createOf(p, 'customer', 'SharEat Malvar');
    expect(w.group).toBe('internal');
    expect(w.counterpartyV1StoreId).toBe(M);
  });

  it('an ordinary supplier carries counterpartyV1StoreId null', async () => {
    const w = createOf(await plan(snap([sup(L, 'Acme Foods')])), 'supplier', 'Acme Foods');
    expect(w.counterpartyV1StoreId ?? null).toBeNull();
  });

  it('a customer pointing at the franchise store is held: listed on parties-held, no write. Mutant: written as an internal customer', async () => {
    const p = await plan(snap([], [cust(L, 'SharEat Padre Garcia', { linkedStoreId: P })]));
    expect(creates(p, 'customer')).toHaveLength(0);
    expect(linksW(p, 'customer')).toHaveLength(0);
    expect(rowsFor(p, 'parties-held', 'name', 'SharEat Padre Garcia')).toHaveLength(1);
  });

  it('a supplier pointing at the franchise store stays held with no v2 target. Mutant: written with the franchise store as counterparty', async () => {
    const p = await plan(snap([sup(L, 'SharEat Padre Garcia', { linkedStoreId: P })]));
    expect(creates(p, 'supplier')).toHaveLength(0);
    expect(p.writes.filter((w: Any) => w.counterpartyV1StoreId === P)).toHaveLength(0);
    expect(rowsFor(p, 'parties-held', 'name', 'SharEat Padre Garcia')).toHaveLength(1);
  });
});

describe('13e. P4, P6, P7 mapping', () => {
  it('supplier classification, vat status and credit terms map to the v2 vocabulary', async () => {
    const p = await plan(snap([
      sup(L, 'Corp Co', { classification: 'Corporate', vatStatus: 'VAT Reg', lastCreditDueDays: 30 }),
      sup(L, 'Solo Person', { classification: 'Individual', vatStatus: 'Non-VAT Reg', lastCreditDueDays: 0 }),
      sup(L, 'Misc Vendor', { classification: 'Other' }),
    ]));
    expect(createOf(p, 'supplier', 'Corp Co')).toMatchObject({ classification: 'corporate', vatStatus: 'vat_registered', creditTermsDays: 30 });
    expect(createOf(p, 'supplier', 'Solo Person')).toMatchObject({ classification: 'individual', vatStatus: 'non_vat', creditTermsDays: 0 });
    expect(createOf(p, 'supplier', 'Misc Vendor')).toMatchObject({ classification: 'other' });
  });

  it('AR classification maps to the customer group: staff to staff, individual and corporate to wholesale, other to other', async () => {
    const p = await plan(snap([], [
      cust(L, 'A Staff Member', { classification: 'staff' }),
      cust(L, 'A Person', { classification: 'individual' }),
      cust(L, 'A Company', { classification: 'corporate' }),
      cust(L, 'A Misc', { classification: 'other' }),
    ]));
    expect(createOf(p, 'customer', 'A Staff Member').group).toBe('staff');
    expect(createOf(p, 'customer', 'A Person').group).toBe('wholesale');
    expect(createOf(p, 'customer', 'A Company').group).toBe('wholesale');
    expect(createOf(p, 'customer', 'A Misc').group).toBe('other');
  });

  it('P7: inactive v1 records are planned as status inactive, active ones as active (the create, then a status writer)', async () => {
    const p = await plan(snap(
      [sup(L, 'Dead Supplier', { isActive: false }), sup(L, 'Live Supplier', { isActive: true })],
      [cust(L, 'Dead Customer', { status: 'inactive' }), cust(L, 'Live Customer', { status: 'active' })],
    ));
    expect(createOf(p, 'supplier', 'Dead Supplier').status).toBe('inactive');
    expect(createOf(p, 'supplier', 'Live Supplier').status).toBe('active');
    expect(createOf(p, 'customer', 'Dead Customer').status).toBe('inactive');
    expect(createOf(p, 'customer', 'Live Customer').status).toBe('active');
  });

  it('first contact phone becomes contactNo; representative and email carry over', async () => {
    const w = createOf(await plan(snap([sup(L, 'Acme Foods', {
      contacts: [{ name: 'Ana', phone: '0917-123-4567' }], representative: 'Ana Cruz', email: 'ana@acme.test', address: '1 Main St',
    })])), 'supplier', 'Acme Foods');
    expect(w).toMatchObject({ contactNo: '0917-123-4567', representativeName: 'Ana Cruz', email: 'ana@acme.test', address: '1 Main St' });
  });
});

describe('13k. rulings: franchise rows are informational, blank tax is not a disagreement, any active copy keeps the party active', () => {
  it('franchise-pointing rows are on parties-held with reason franchise, are NOT counted in held, and never block the other parties', async () => {
    const p = await plan(snap(
      [sup(L, 'SharEat Padre Garcia', { linkedStoreId: P }), sup(L, 'Acme Foods')],
      [cust(L, 'SharEat Padre Garcia', { linkedStoreId: P }), cust(L, 'Tonyo')],
    ));
    expect(p.held).toBe(0);
    const rows = rowsFor(p, 'parties-held', 'name', 'SharEat Padre Garcia');
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(lc(r.reason)).toContain('franchise');
    expect(createOf(p, 'supplier', 'Acme Foods')).toBeTruthy();
    expect(createOf(p, 'customer', 'Tonyo')).toBeTruthy();
    expect(createOf(p, 'supplier', 'SharEat Padre Garcia')).toBeUndefined();
    expect(createOf(p, 'customer', 'SharEat Padre Garcia')).toBeUndefined();
  });

  it('a blank tin on one copy is not a disagreement: not held, the non-blank tin wins', async () => {
    const p = await plan(snap([
      sup(L, 'Acme Foods', { vatStatus: 'VAT Reg', tin: '123-456-789-000', updatedAt: '2026-01-01T00:00:00.000Z' }),
      sup(M, 'Acme Foods', { vatStatus: 'VAT Reg', tin: '', updatedAt: '2026-09-01T00:00:00.000Z' }),
    ]));
    expect(p.held).toBe(0);
    expect(sheet(p, 'suppliers-tax')).toHaveLength(0);
    expect(createOf(p, 'supplier', 'Acme Foods').tin).toBe('123-456-789-000');
  });

  it('a blank vat_status on one copy is not a disagreement: not held, the non-blank status wins', async () => {
    const p = await plan(snap([
      sup(L, 'Acme Foods', { vatStatus: 'Non-VAT Reg', tin: '1', updatedAt: '2026-01-01T00:00:00.000Z' }),
      sup(M, 'Acme Foods', { tin: '1', updatedAt: '2026-09-01T00:00:00.000Z' }),
    ]));
    expect(p.held).toBe(0);
    expect(sheet(p, 'suppliers-tax')).toHaveLength(0);
    expect(createOf(p, 'supplier', 'Acme Foods').vatStatus).toBe('non_vat');
  });

  it('merged copies, one active one inactive: the party is active, whichever is newer or listed first. Mutant: newest status wins', async () => {
    for (const order of [0, 1]) {
      const act = sup(L, 'Acme Foods', { isActive: true, updatedAt: '2026-01-01T00:00:00.000Z' });
      const ina = sup(M, 'Acme Foods', { isActive: false, updatedAt: '2026-09-01T00:00:00.000Z' });
      const w = createOf(await plan(snap(order ? [ina, act] : [act, ina])), 'supplier', 'Acme Foods');
      expect(w.status).toBe('active');
      const ca = cust(L, 'Tonyo', { status: 'active', updatedAt: '2026-01-01T00:00:00.000Z' });
      const ci = cust(M, 'Tonyo', { status: 'inactive', updatedAt: '2026-09-01T00:00:00.000Z' });
      const c = createOf(await plan(snap([], order ? [ci, ca] : [ca, ci])), 'customer', 'Tonyo');
      expect(c.status).toBe('active');
    }
  });

  it('both copies inactive: the party is inactive', async () => {
    const w = createOf(await plan(snap([sup(L, 'Old Co', { isActive: false }), sup(M, 'Old Co', { isActive: false })])), 'supplier', 'Old Co');
    expect(w.status).toBe('inactive');
  });
});

describe('13f. P8 / I8 a bank account number never appears in a sheet', () => {
  const FULL = '1234567890123456';
  const bank = { bankName: 'BDO', accountName: 'Acme', accountNumberMasked: '************3456', accountNumber: FULL };
  it('even if a full number is in the snapshot record, no sheet and no write carries it (only the last four digits may). Mutant: all bank accounts written to the sheet', async () => {
    const held = await plan(snap([
      sup(L, 'Acme Foods', { vatStatus: 'VAT Reg', tin: '111', bankAccount: bank }),
      sup(M, 'Acme Foods', { vatStatus: 'Non-VAT Reg', tin: '111', bankAccount: bank }),
    ]));
    expect(sheet(held, 'suppliers-tax').length).toBeGreaterThan(0);
    expect(JSON.stringify(held.sheets)).not.toContain(FULL);
    expect(JSON.stringify(held.writes)).not.toContain(FULL);
    const clean = await plan(snap([sup(L, 'Beta Co', { bankAccount: bank })]));
    expect(JSON.stringify(clean.sheets)).not.toContain(FULL);
    expect(JSON.stringify(clean.writes)).not.toContain(FULL);
    const w = createOf(clean, 'supplier', 'Beta Co');
    expect(w.bankName).toBe('BDO');
    expect(String(w.bankAccountNumber ?? '').replace(/[^0-9]/g, '').length).toBeLessThanOrEqual(4);
    expect(w.bankAccountNumber).toBe('************3456');
  });

  it('the run report (plan.listed) says the number is masked and must be re-entered, and names the supplier', async () => {
    const p = await plan(snap([sup(L, 'Beta Co', { bankAccount: bank })]));
    const text = JSON.stringify(p.listed ?? []);
    expect(text).toMatch(/masked/i);
    expect(text).toMatch(/re-?enter/i);
    expect(text).toContain('Beta Co');
    expect(text).not.toContain(FULL);
  });
});

describe('13g. P2 look-alike names are held on the twins sheet', () => {
  const twins = (): Any => snap([sup(L, 'Acme Foods Inc'), sup(M, 'ACME FOODS INC.')]);

  it('supplier look-alikes are held, nothing created for either. Mutant: twin check missing (two suppliers created)', async () => {
    const p = await plan(twins());
    expect(creates(p, 'supplier')).toHaveLength(0);
    expect(sheet(p, 'suppliers-twins').length).toBeGreaterThanOrEqual(2);
    expect(p.held).toBeGreaterThan(0);
  });

  it('same: one supplier, both records linked; different: two suppliers', async () => {
    const first = await plan(twins());
    const rows = sheet(first, 'suppliers-twins');
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const same = await plan(twins(), { answers: { 'suppliers-twins': rows.map((r: Any) => ({ ...r, same_or_different: 'same' })) } });
    expect(creates(same, 'supplier')).toHaveLength(1);
    expect(creates(same, 'supplier')[0].links).toHaveLength(2);
    expect(same.held).toBe(0);
    const diff = await plan(twins(), { answers: { 'suppliers-twins': rows.map((r: Any) => ({ ...r, same_or_different: 'different' })) } });
    expect(creates(diff, 'supplier')).toHaveLength(2);
  });

  it('customer look-alikes go to customers-twins', async () => {
    const p = await plan(snap([], [cust(L, 'Mang Tonyo'), cust(M, 'Mang  Tonyo.')]));
    expect(creates(p, 'customer')).toHaveLength(0);
    expect(sheet(p, 'customers-twins').length).toBeGreaterThanOrEqual(2);
  });

  it('a look-alike of an EXISTING v2 supplier is held, not created next to it', async () => {
    const p = await plan(snap([sup(L, 'Acme Foods Inc.')]), { existingSuppliers: [{ id: 'v2-acme', name: 'Acme Foods Inc', status: 'active' }] });
    expect(creates(p, 'supplier')).toHaveLength(0);
    expect(sheet(p, 'suppliers-twins').length).toBeGreaterThan(0);
  });
});

describe('13h. R4 existing rows and links', () => {
  it('an exact-name match in v2 is LINKED, not duplicated (supplier and customer)', async () => {
    const p = await plan(snap([sup(L, 'Acme Foods')], [cust(L, 'Tonyo Eatery')]), {
      existingSuppliers: [{ id: 'v2-acme', name: 'acme foods', status: 'active' }],
      existingCustomers: [{ id: 'v2-tonyo', name: 'Tonyo Eatery', status: 'active' }],
    });
    expect(creates(p, 'supplier')).toHaveLength(0);
    expect(creates(p, 'customer')).toHaveLength(0);
    expect(linksW(p, 'supplier')[0]).toMatchObject({ v2Id: 'v2-acme' });
    expect(linksW(p, 'customer')[0]).toMatchObject({ v2Id: 'v2-tonyo' });
  });

  it('a v2 row is never changed: against an existing row the only write is a link', async () => {
    const p = await plan(snap([sup(L, 'Acme Foods', { address: 'Different St' })]), {
      existingSuppliers: [{ id: 'v2-acme', name: 'Acme Foods', status: 'active', address: 'Real St' }],
    });
    expect(p.writes.length).toBe(1);
    expect(p.writes.every((w: Any) => w.op === 'link')).toBe(true);
  });

  it('a record already linked is not written again; the whole plan is empty', async () => {
    const s = snap([sup(L, 'Acme Foods')], [cust(L, 'Tonyo Eatery')]);
    const p = await plan(s, {
      links: [
        { entity: 'supplier', v1StoreId: L, v1Id: s.suppliers[0].id, v2Id: 'v2-acme' },
        { entity: 'customer', v1StoreId: L, v1Id: s.arCustomers[0].id, v2Id: 'v2-tonyo' },
      ],
      existingSuppliers: [{ id: 'v2-acme', name: 'Acme Foods', status: 'active' }],
      existingCustomers: [{ id: 'v2-tonyo', name: 'Tonyo Eatery', status: 'active' }],
    });
    expect(p.writes).toEqual([]);
    expect(p.held).toBe(0);
  });

  it('R13 drift: a linked supplier whose v1 contact changed is listed and nothing is written. Mutant: survivorship re-applied to linked rows', async () => {
    const s = snap([sup(L, 'Acme Foods', { contacts: [{ name: 'Ana', phone: '0917-999-9999' }] })]);
    const p = await plan(s, {
      links: [{ entity: 'supplier', v1StoreId: L, v1Id: s.suppliers[0].id, v2Id: 'v2-acme' }],
      existingSuppliers: [{ id: 'v2-acme', name: 'Acme Foods', status: 'active', contactNo: '0917-111-1111' }],
    });
    expect(p.writes).toEqual([]);
    expect(p.drift.some((d: Any) => d.entity === 'supplier' && d.v1Id === s.suppliers[0].id)).toBe(true);
  });
});

describe('13i. org boundary and scope (R5, R6, R7)', () => {
  it('a Padre Garcia record is never written for the main org (I1), and does not merge with a same-named own-store record', async () => {
    const p = await plan(snap([sup(L, 'Acme Foods'), sup(P, 'Acme Foods'), sup(P, 'Franchise Only Co')], [cust(P, 'PG Diner')]));
    expect(creates(p, 'supplier').map((w: Any) => lc(w.name))).toEqual(['acme foods']);
    expect(creates(p, 'supplier')[0].links.map((l: Any) => l.v1StoreId)).toEqual([L]);
    expect(creates(p, 'customer')).toHaveLength(0);
  });

  it('--stores LIPA writes only parties that have a Lipa record, but merges over the whole org: Malvar newer data still survives', async () => {
    const s = snap([
      sup(L, 'Acme Foods', { address: 'Old Street', updatedAt: '2026-01-01T00:00:00.000Z' }),
      sup(M, 'Acme Foods', { address: 'New Street', updatedAt: '2026-06-01T00:00:00.000Z' }),
      sup(M, 'Malvar Only'),
    ]);
    const p = await plan(s, { storeCodes: ['LIPA'] });
    expect(creates(p, 'supplier').map((w: Any) => lc(w.name))).toEqual(['acme foods']);
    expect(createOf(p, 'supplier', 'Acme Foods').address).toBe('New Street');
    expect(createOf(p, 'supplier', 'Acme Foods').links.map((l: Any) => l.v1StoreId)).toEqual([L]); // only Lipa's record is linked this run
  });
});

describe('13j. sheets shape', () => {
  it('all four sheets are present as arrays even when empty', async () => {
    const p = await plan(snap());
    for (const name of ['suppliers-twins', 'suppliers-tax', 'customers-twins', 'parties-held']) {
      expect(Array.isArray(p.sheets[name])).toBe(true);
    }
    expect(p.held).toBe(0);
  });

  it('every emitted row carries a row_key of the items shape (k + 12 hex), and a note column', async () => {
    const p = await plan(snap([sup(L, 'Acme Foods Inc'), sup(M, 'ACME FOODS INC.'), sup(L, 'SharEat Padre Garcia', { linkedStoreId: P })]));
    const rows = [...sheet(p, 'suppliers-twins'), ...sheet(p, 'parties-held')];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.row_key).toMatch(/^k[0-9a-f]{12}$/);
      expect('note' in r).toBe(true);
    }
  });
});

describe('13l. audit round: unmapped tax values, bad credit terms, franchise name clash, linked rows', () => {
  // contract addition: plan.listed is [{ entity, name, note }] - rows the run reports without asking Ian to answer
  const taxHeld = (p: Any, name: string) => rowsFor(p, 'suppliers-tax', 'supplier', name);

  it.each(['Exempt', 'Zero-rated', 'Vta Reg'])('copy A "VAT Reg" + copy B "%s" (unmapped, non-blank) is a distinct value: held on suppliers-tax. Mutant: unmapped treated as blank', async (odd) => {
    const p = await plan(snap([
      sup(L, 'Acme Foods', { vatStatus: 'VAT Reg', tin: '1' }),
      sup(M, 'Acme Foods', { vatStatus: odd, tin: '1', updatedAt: '2026-09-01T00:00:00.000Z' }),
    ]));
    expect(creates(p, 'supplier')).toHaveLength(0);
    expect(taxHeld(p, 'Acme Foods')).toHaveLength(1);
    expect(p.held).toBeGreaterThan(0);
  });

  it('a single copy with only an unmapped vat_status is held for Ian, never silently null', async () => {
    const p = await plan(snap([sup(L, 'Acme Foods', { vatStatus: 'Exempt', tin: '1' })]));
    expect(creates(p, 'supplier')).toHaveLength(0);
    expect(taxHeld(p, 'Acme Foods')).toHaveLength(1);
    expect(p.held).toBeGreaterThan(0);
  });

  it('P10: a blank vat_status stays not-a-disagreement and not held', async () => {
    const p = await plan(snap([sup(L, 'Acme Foods', { tin: '1' }), sup(M, 'Acme Foods', { vatStatus: 'VAT Reg', tin: '1' })]));
    expect(p.held).toBe(0);
    expect(createOf(p, 'supplier', 'Acme Foods').vatStatus).toBe('vat_registered');
  });

  it.each([Number.NaN, -5, 7.5])('lastCreditDueDays %s: creditTermsDays null, the supplier is created and LISTED with its name. Mutant: the bad number passed through', async (bad) => {
    const p = await plan(snap([sup(L, 'Acme Foods', { lastCreditDueDays: bad })]));
    const w = createOf(p, 'supplier', 'Acme Foods');
    expect(w).toBeTruthy();
    expect(w.creditTermsDays).toBeNull();
    expect(p.held).toBe(0);
    expect(JSON.stringify(p.listed ?? [])).toContain('Acme Foods');
  });

  it('a franchise-pointing record whose name matches an own-store record stays OUT of the merge: the own party is created without it, the franchise row is on parties-held', async () => {
    const p = await plan(snap(
      [sup(L, 'Acme Foods'), sup(L, 'Acme Foods', { linkedStoreId: P })],
      [cust(L, 'Tonyo'), cust(L, 'Tonyo', { linkedStoreId: P })],
    ));
    const s = creates(p, 'supplier');
    expect(s).toHaveLength(1);
    expect(s[0].links).toHaveLength(1);
    expect(s[0].counterpartyV1StoreId ?? null).toBeNull();
    expect(rowsFor(p, 'parties-held', 'name', 'Acme Foods').length).toBeGreaterThan(0);
    const c = creates(p, 'customer');
    expect(c).toHaveLength(1);
    expect(c[0].links).toHaveLength(1);
    expect(c[0].group).not.toBe('internal');
    expect(rowsFor(p, 'parties-held', 'name', 'Tonyo').length).toBeGreaterThan(0);
    expect(p.held).toBe(0);
  });

  it('e: a twin row and a tax row whose records are all already linked are not counted in held', async () => {
    const s = snap(
      [sup(L, 'Acme Foods Inc'), sup(M, 'ACME FOODS INC.'), sup(L, 'Tax Co', { vatStatus: 'VAT Reg', tin: '1' }), sup(M, 'Tax Co', { vatStatus: 'Non-VAT Reg', tin: '1' })],
      [cust(L, 'Mang Tonyo'), cust(M, 'Mang  Tonyo.')],
    );
    const links = [
      ...s.suppliers.map((r: Any, i: number) => ({ entity: 'supplier', v1StoreId: r.store, v1Id: r.id, v2Id: `v2s${i < 2 ? 0 : 1}` })),
      ...s.arCustomers.map((r: Any) => ({ entity: 'customer', v1StoreId: r.store, v1Id: r.id, v2Id: 'v2c0' })),
    ];
    const p = await plan(s, {
      links,
      existingSuppliers: [{ id: 'v2s0', name: 'Acme Foods Inc', status: 'active' }, { id: 'v2s1', name: 'Tax Co', status: 'active' }],
      existingCustomers: [{ id: 'v2c0', name: 'Mang Tonyo', status: 'active' }],
    });
    expect(p.held).toBe(0);
    expect(p.writes).toEqual([]);
  });
});

describe('13m. re-audit: non-numeric credit terms', () => {
  it.each([[' '], [''], [true]])('lastCreditDueDays %j: creditTermsDays null (never 0 or 1) and the supplier is listed by name', async (bad) => {
    const p = await plan(snap([sup(L, 'Acme Foods', { lastCreditDueDays: bad })]));
    const w = createOf(p, 'supplier', 'Acme Foods');
    expect(w).toBeTruthy();
    expect(w.creditTermsDays).toBeNull();
    expect(p.held).toBe(0);
    expect(JSON.stringify(p.listed ?? [])).toContain('Acme Foods');
  });
});
