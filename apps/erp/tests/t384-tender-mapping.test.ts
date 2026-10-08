import { beforeAll, describe, expect, it } from 'vitest';

/**
 * T-384 S1b (TESTER) - `tenderMapping(methods | null, tenders, accounts)` in
 * `apps/erp/src/app/settings/pos-link/lib.ts` (spec R9, M1-M4). Pure; no database.
 *
 * SPEC GAP: R9 names the function, its three inputs and the table's columns (POS method, Tender, Kind, Money account,
 * Status) but NOT the shape of a returned row. These tests therefore read each row as `JSON.stringify(row)` and assert
 * only on the facts the spec fixes (which tenders and accounts appear in which row, how many rows). Row count and
 * grouping are pinned; the field names are the builder's. If the orchestrator pins a row type, tighten this file.
 *
 * Red on HEAD: `tenderMapping` is not exported -> "tenderMapping is not a function".
 */
import type { TenderAdminRow } from '../src/app/settings/pos-link/lib';

type Mapping = (methods: readonly string[] | null, tenders: readonly TenderAdminRow[], accounts: readonly { id: string; name: string }[]) => unknown[];
async function fn(): Promise<Mapping> {
  const mod = (await import('../src/app/settings/pos-link/lib')) as unknown as Record<string, unknown>;
  const f = mod['tenderMapping'];
  if (typeof f !== 'function') throw new TypeError('tenderMapping is not a function (not exported from settings/pos-link/lib.ts)');
  return f as Mapping;
}

// Cold import of lib.ts (db + domain) is slow; do it once, outside any 5 s test budget.
beforeAll(async () => {
  await import('../src/app/settings/pos-link/lib');
}, 120_000);

const ACCOUNTS = [
  { id: 'a-bpi', name: 'BPI' },
  { id: 'a-gcash', name: 'GCash - Lipa' },
];
let n = 0;
function tender(o: Partial<TenderAdminRow> & { name: string }): TenderAdminRow {
  return {
    id: `t-${++n}`,
    kind: 'wallet',
    moneyAccountId: null,
    moneyAccountName: null,
    posV1Alias: null,
    isActive: true,
    version: '1',
    ...o,
  };
}
const text = (rows: unknown[]) => rows.map((r) => JSON.stringify(r));

describe('M - tenderMapping (R9)', () => {
  it('M1: the alias matches regardless of case and punctuation ("G-Cash" ~ "Gcash")', async () => {
    const map = await fn();
    const gcash = tender({ name: 'Gcash wallet', posV1Alias: 'Gcash', moneyAccountId: 'a-gcash', moneyAccountName: 'GCash - Lipa' });
    const rows = text(map(['G-Cash'], [gcash], ACCOUNTS));
    expect(rows, 'one POS method, one matching tender: exactly one row').toHaveLength(1);
    expect(rows[0]).toContain('Gcash wallet');
    expect(rows[0]).toContain('GCash - Lipa');
    expect(rows[0], 'and it is not a "Not mapped" row').not.toMatch(/Not mapped/i);
  });

  it('M2: a retired tender never maps - its method has a row with no tender, and the tender has no row', async () => {
    const map = await fn();
    const retired = tender({ name: 'Old QR', posV1Alias: 'QRPH', isActive: false, moneyAccountId: 'a-bpi', moneyAccountName: 'BPI' });
    const rows = text(map(['QRPH'], [retired], ACCOUNTS));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('QRPH');
    expect(rows[0], 'the retired tender is not shown as the answer').not.toContain('Old QR');
    expect(rows[0]).toMatch(/Not mapped/i);
  });

  it('M3: null methods (POS not answering, or store not linked) -> tender rows only, one per ACTIVE tender', async () => {
    const map = await fn();
    const cash = tender({ name: 'Cash', kind: 'cash', posV1Alias: 'Cash' });
    const bank = tender({ name: 'Bank Transfer', posV1Alias: 'Bank Transfer', moneyAccountId: 'a-bpi', moneyAccountName: 'BPI' });
    const old = tender({ name: 'Retired one', isActive: false });
    const rows = text(map(null, [cash, bank, old], ACCOUNTS));
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.includes('Cash'))).toBe(true);
    expect(rows.some((r) => r.includes('Bank Transfer') && r.includes('BPI'))).toBe(true);
    expect(rows.some((r) => r.includes('Retired one'))).toBe(false);
  });

  it('M4: two wallets on one account both appear, each naming the account', async () => {
    const map = await fn();
    const bank = tender({ name: 'Bank Transfer', posV1Alias: 'Bank Transfer', moneyAccountId: 'a-bpi', moneyAccountName: 'BPI' });
    const qr = tender({ name: 'QRPH', posV1Alias: 'QRPH', moneyAccountId: 'a-bpi', moneyAccountName: 'BPI' });
    const rows = text(map(['Bank Transfer', 'QRPH'], [bank, qr], ACCOUNTS));
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.includes('BPI'))).toHaveLength(2);
    expect(rows.some((r) => r.includes('Bank Transfer') && r.includes('BPI'))).toBe(true);
    expect(rows.some((r) => r.includes('QRPH') && r.includes('BPI'))).toBe(true);
  });

  it('M5: an active tender no POS method names gets its own row ("POS doesn\'t list this name" / "No POS name")', async () => {
    const map = await fn();
    const named = tender({ name: 'Maya', posV1Alias: 'Maya' });
    const blank = tender({ name: 'Voucher', posV1Alias: null });
    const rows = text(map(['Cash'], [named, blank], ACCOUNTS));
    expect(rows, 'one POS method row + one row per unanswered active tender').toHaveLength(3);
    expect(rows.find((r) => r.includes('Maya'))).toMatch(/doesn.{0,6}t list this name/i);
    expect(rows.find((r) => r.includes('Voucher'))).toMatch(/No POS name/i);
    expect(rows.find((r) => !r.includes('Maya') && !r.includes('Voucher')), "POS's own method row").toMatch(/Not mapped/i);
  });
});
