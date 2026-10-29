/**
 * T-454 S4 (TESTER) - the Banay-Banay close-out check. docs/tasks/454-drop-banay-banay.md section 4 S4, tests T9-T12,
 * as RULED by the planner in section 10: account balances (cash 1110, stock 1310-1330, equipment) are INFORMATION and never fail;
 * only an open PARTY balance (supplier, customer; also employee advances) fails. T10 and T11 are re-ruled accordingly.
 *
 * CONTRACT these tests pin (the spec names the CLI flag, not a function; scripts/audit.ts is a DB-bound script and cannot be
 * unit-tested, so the logic lives in a pure module and the CLI only calls it):
 *   packages/etl/src/audit/expect-zero.ts
 *     checkExpectZero(docs: LandedDocLike[], opts: { storeId: string; asOf: string; storeName?: string;
 *                                                      partyNames?: Record<string, string> })
 *       -> { exitCode: 0 | 1; lines: string[] }
 *   exitCode 0 only when EVERY party (each on its own, never netted) in that store has a zero balance at asOf.
 *   lines on success: 'Banay-Banay: every supplier and customer balance is zero at 2026-12-31' (matched loosely: store name,
 *     'zero', the date). Any non-zero ACCOUNT balance is printed under the heading "Handled offline, carried in Lipa's opening"
 *     as code + amount, and does not change the exit code.
 *   lines on failure: one line per open party, naming the party (partyNames[id] when given, else the id), account code, amount.
 *   It is pure: no I/O, no writes, input documents untouched; it imports no Firestore client.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { OPERATING_STORES, type LandedDocLike } from '../../src/audit/balances';

// ESM namespace exports cannot be spied on, so the write functions are replaced with mocks (original reads kept).
vi.mock('node:fs', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs')>();
  return { ...orig, writeFileSync: vi.fn(), appendFileSync: vi.fn(), mkdirSync: vi.fn() };
});

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const BANAY = 'iGOW7q2pZbeHWV832UNh';
const LIPA = 'b9DzsnPbr1BUnY88lyT4';
const AS_OF = '2026-12-31';
const HANDLED_OFFLINE = /Handled offline, carried in Lipa's opening/;

let seq = 0;
function leg(storeCode: string, overrides: Record<string, unknown> = {}): LandedDocLike {
  seq += 1;
  const sourceType = 'expense_payment';
  const sourceId = `src-${seq}`;
  const legKey = `leg-${seq}`;
  const docId = `${sourceType}:${sourceId}:${legKey}`;
  return {
    docPath: `stores/${storeCode}/journal/${docId}`,
    collectionPath: `stores/${storeCode}/journal`,
    storeCode,
    payload: {
      id: docId, storeId: storeCode, sourceType, sourceId, legKey,
      direction: 'in', amount: 100, businessDate: '2026-12-01',
      supplierId: null, customerId: null, employeeId: null,
      ...overrides,
    },
  };
}

async function check(docs: LandedDocLike[], extra: Record<string, unknown> = {}): Promise<{ exitCode: number; lines: string[] }> {
  const mod: Any = await import('../../src/audit/expect-zero');
  return mod.checkExpectZero(docs, { storeId: BANAY, asOf: AS_OF, storeName: 'Banay-Banay', ...extra });
}
const text = (r: { lines: string[] }) => r.lines.join('\n');

describe('T9. every party is zero', () => {
  // the passing case; also proves a fully-settled party (in then out) nets to zero
  it('exit 0 and the zero line, even though an account has activity', async () => {
    const r = await check([
      leg(BANAY, { accountId: 'ap__SUP1', direction: 'in', amount: 500, supplierId: 'SUP1' }),
      leg(BANAY, { accountId: 'ap__SUP1', direction: 'out', amount: 500, supplierId: 'SUP1' }),
    ]);
    expect(r.exitCode).toBe(0);
    expect(text(r)).toMatch(/Banay-Banay[\s\S]*zero[\s\S]*2026-12-31/i);
  });
  // wording (auditor D): the check covers employees too, so the success line must say so
  it('the success line names suppliers, customers AND employees', async () => {
    const r = await check([
      leg(BANAY, { accountId: 'ap__SUP1', direction: 'in', amount: 5, supplierId: 'SUP1' }),
      leg(BANAY, { accountId: 'ap__SUP1', direction: 'out', amount: 5, supplierId: 'SUP1' }),
    ]);
    expect(text(r)).toMatch(/supplier/i);
    expect(text(r)).toMatch(/customer/i);
    expect(text(r)).toMatch(/employee/i);
  });
});

describe('T10 (re-ruled). a cash balance alone is information, never a failure', () => {
  // mutant killed: account balances treated as failures (the pre-ruling check)
  it('+100.00 in 1110 only: exit 0, printed under the offline heading with the code and amount', async () => {
    const r = await check([leg(BANAY, { accountId: 'cash__cashier', direction: 'in', amount: 100 })]);
    expect(r.exitCode).toBe(0);
    expect(text(r)).toMatch(HANDLED_OFFLINE);
    expect(text(r)).toMatch(/1110/);
    expect(text(r)).toMatch(/100\.00/);
  });
  it('equipment (1510) is also information only', async () => {
    const r = await check([leg(BANAY, { accountId: 'asset__AST1', direction: 'in', amount: 2500 })]);
    expect(r.exitCode).toBe(0);
  });
});

describe('T11. an open party balance fails, party by party', () => {
  // mutant killed: party balances not checked
  it('a P1.00 supplier balance: exit 1 and the supplier is named', async () => {
    const r = await check(
      [leg(BANAY, { accountId: 'ap__SUP1', direction: 'in', amount: 1, supplierId: 'SUP1' })],
      { partyNames: { SUP1: 'Acme Meats' } },
    );
    expect(r.exitCode).toBe(1);
    expect(text(r)).toContain('Acme Meats');
    expect(text(r)).toMatch(/1\.00/);
    expect(text(r)).toMatch(/2110/);
  });
  it('an open customer balance fails too', async () => {
    const r = await check(
      [leg(BANAY, { accountId: 'ar__CUST1', direction: 'in', amount: 250, customerId: 'CUST1' })],
      { partyNames: { CUST1: 'Corner Cafe' } },
    );
    expect(r.exitCode).toBe(1);
    expect(text(r)).toContain('Corner Cafe');
  });
  // mutant killed: party balances netted together (or checked at the control-account total)
  it('two parties that cancel each other still fail: each is checked on its own', async () => {
    const r = await check([
      leg(BANAY, { accountId: 'ap__SUP1', direction: 'in', amount: 100, supplierId: 'SUP1' }),
      leg(BANAY, { accountId: 'ap__SUP2', direction: 'out', amount: 100, supplierId: 'SUP2' }),
    ]);
    expect(r.exitCode).toBe(1);
    expect(text(r)).toContain('SUP1');
    expect(text(r)).toContain('SUP2');
  });
  // mutant killed: store filter ignored (another store's open party fails Banay-Banay)
  it('another store\'s open party balance is not Banay-Banay\'s', async () => {
    const r = await check([
      leg(LIPA, { accountId: 'ap__SUP9', direction: 'in', amount: 900, supplierId: 'SUP9' }),
      leg(BANAY, { accountId: 'ap__SUP1', direction: 'in', amount: 30, supplierId: 'SUP1' }),
      leg(BANAY, { accountId: 'ap__SUP1', direction: 'out', amount: 30, supplierId: 'SUP1' }),
    ]);
    expect(r.exitCode).toBe(0);
  });
  // mutant killed: asOf ignored (a leg dated after 31 Dec counts)
  it('a leg dated after the as-of date is not counted', async () => {
    const r = await check([
      leg(BANAY, { accountId: 'cash__cashier', direction: 'in', amount: 1 }),
      leg(BANAY, { accountId: 'ap__SUP1', direction: 'in', amount: 50, supplierId: 'SUP1', businessDate: '2027-01-02' }),
    ]);
    expect(r.exitCode).toBe(0);
  });
  it('a party failure and a cash balance together: exit 1, both listed', async () => {
    const r = await check([
      leg(BANAY, { accountId: 'cash__cashier', direction: 'in', amount: 100 }),
      leg(BANAY, { accountId: 'ap__SUP1', direction: 'in', amount: 5, supplierId: 'SUP1' }),
    ]);
    expect(r.exitCode).toBe(1);
    expect(text(r)).toMatch(HANDLED_OFFLINE);
  });
});

describe('T12. the check writes nothing', () => {
  // mutant killed: a writer client / file write used
  it('the module source has no file write, no Firestore or database client', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'audit', 'expect-zero.ts'), 'utf8');
    expect(src).not.toMatch(/writeFile|appendFile|mkdirSync|createWriteStream|firebase|firestore|postgres|\.set\(|\.update\(|\.delete\(/i);
  });
  it('calling it touches no filesystem write and leaves the input documents unchanged', async () => {
    const fs = await import('node:fs');
    const docs = [leg(BANAY, { accountId: 'ap__SUP1', direction: 'in', amount: 1, supplierId: 'SUP1' })];
    const frozen = JSON.stringify(docs);
    await check(docs);
    expect(vi.mocked(fs.writeFileSync)).not.toHaveBeenCalled();
    expect(vi.mocked(fs.appendFileSync)).not.toHaveBeenCalled();
    expect(vi.mocked(fs.mkdirSync)).not.toHaveBeenCalled();
    expect(JSON.stringify(docs)).toBe(frozen);
  });
});

describe('guard (fence). the audit keeps Banay-Banay in OPERATING_STORES', () => {
  it('is still a named operating store of the v1 audit', () => {
    expect(OPERATING_STORES[BANAY]).toMatch(/Banay-Banay/);
  });
});

describe('C. boundary and size pins', () => {
  // mutant killed: the as-of date made exclusive (> becomes >=)
  it('a party leg dated exactly 2026-12-31 is included (exit 1)', async () => {
    const r = await check([leg(BANAY, { accountId: 'ap__SUP1', direction: 'in', amount: 50, supplierId: 'SUP1', businessDate: '2026-12-31' })]);
    expect(r.exitCode).toBe(1);
  });
  // v1 normalises every businessDate to bare YYYY-MM-DD (ERP-rebuild src/lib/financial/journal/journal-writer.ts:35,87), so a
  // time part cannot occur; the bare 31 Dec leg above is the guard for that boundary. No time-part leg is tested.
  // mutant killed: a tolerance / rounding that hides small balances
  it('a P0.01 open supplier balance fails', async () => {
    const r = await check([leg(BANAY, { accountId: 'ap__SUP1', direction: 'in', amount: 0.01, supplierId: 'SUP1' })]);
    expect(r.exitCode).toBe(1);
    expect(text(r)).toMatch(/0.01/);
  });
  // mutant killed: employee parties left out of the open-party test
  it.each([
    ['1230 staff advance', { accountId: 'staff_advance__EMP1', employeeId: 'EMP1' }],
    ['2130 staff reimbursable', { accountId: 'staff_reimbursable__EMP1', employeeId: 'EMP1' }],
  ])('an open employee party (%s) fails', async (_n, o) => {
    const r = await check([leg(BANAY, { direction: 'in', amount: 300, ...o })]);
    expect(r.exitCode).toBe(1);
    expect(text(r)).toContain('EMP1');
  });
});

describe('B. data findings and typo guard', () => {
  // mutant killed: findings ignored / only party balances inspected
  const offsetting = (o: Record<string, unknown>) => [
    leg(BANAY, { direction: 'in', amount: 10, ...o }),
    leg(BANAY, { direction: 'out', amount: 10, ...o }),
  ];
  const cases: Array<[string, LandedDocLike[]]> = [
    ['missing_business_date', offsetting({ accountId: 'cash__cashier', businessDate: null })],
    ['unresolvable_account', offsetting({ accountId: 'totally__unknown_thing' })],
    ['party_id_mismatch', offsetting({ accountId: 'ap__SUP-ENCODED', supplierId: 'SUP-REAL' })],
    ['missing_party_field', offsetting({ accountId: 'ap__SUP1', supplierId: null })],
    ['precision_loss', offsetting({ accountId: 'cash__cashier', amount: 10.005 })],
    ['unadaptable_leg', offsetting({ accountId: 'cash__cashier', amount: 'abc' })],
    [
      'malformed_leg',
      [
        leg(BANAY, { accountId: 'cash__cashier', direction: 'in', amount: 1 }),
        { docPath: `stores/${BANAY}/journal/broken`, collectionPath: `stores/${BANAY}/journal`, storeCode: BANAY, payload: { direction: 'in' } },
      ],
    ],
  ];
  it.each(cases)('a %s finding makes it exit 1 and is printed', async (type, docs) => {
    const r = await check(docs);
    expect(r.exitCode).toBe(1);
    expect(text(r)).toContain(type);
  });
  // mutant killed: an empty store passes (a mistyped store id would "prove" zero)
  it('a store with no legs in scope exits 1 and says no v1 records were found', async () => {
    const r = await check([]);
    expect(r.exitCode).toBe(1);
    expect(text(r)).toMatch(new RegExp(`no v1 records found for ${BANAY}`));
  });
  it('legs of other stores only: also exit 1 with the same sentence', async () => {
    const r = await check([leg(LIPA, { accountId: 'cash__cashier', direction: 'in', amount: 5 })]);
    expect(r.exitCode).toBe(1);
    expect(text(r)).toMatch(/no v1 records found/);
  });
});
