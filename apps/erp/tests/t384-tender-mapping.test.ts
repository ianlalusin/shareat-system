import { beforeAll, describe, expect, it } from 'vitest';

/**
 * T-384 S1b (TESTER) - `tenderMapping(methods | null, tenders, accounts)` in
 * `apps/erp/src/app/settings/pos-link/lib.ts` (spec R9, M1-M4). Pure; no database.
 *
 * (Tightened 2026-10-09 to the builder's TenderMappingRow.) Originally: R9 named the function, its three inputs and the table's columns (POS method, Tender, Kind, Money account,
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

type Row = {
  posMethod: string | null; tenderId: string | null; tenderName: string | null; kind: 'cash' | 'wallet' | null;
  moneyAccountName: string | null; status: 'mapped' | 'not_mapped' | 'pos_does_not_list' | 'no_pos_name' | 'unchecked'; statusText: string;
};
const run = async (m: string[] | null, t: TenderAdminRow[]) => (await fn())(m, t, ACCOUNTS) as Row[];

describe('M - tenderMapping (R9)', () => {
  it('M1: the alias matches regardless of case and punctuation ("G-Cash" ~ "Gcash")', async () => {
    const gcash = tender({ name: 'Gcash wallet', posV1Alias: 'Gcash', moneyAccountId: 'a-gcash', moneyAccountName: 'GCash - Lipa' });
    const rows = await run(['G-Cash'], [gcash]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ posMethod: 'G-Cash', tenderId: gcash.id, tenderName: 'Gcash wallet', kind: 'wallet', moneyAccountName: 'GCash - Lipa', status: 'mapped' });
  });

  it('M2: a retired tender never maps - the method is not_mapped with no tender, and the tender has no row', async () => {
    const retired = tender({ name: 'Old QR', posV1Alias: 'QRPH', isActive: false, moneyAccountId: 'a-bpi', moneyAccountName: 'BPI' });
    const rows = await run(['QRPH'], [retired]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ posMethod: 'QRPH', tenderId: null, tenderName: null, status: 'not_mapped' });
  });

  it('M3: null methods -> one row per ACTIVE tender: aliased = unchecked, blank = no_pos_name; retired absent', async () => {
    const cash = tender({ name: 'Cash', kind: 'cash', posV1Alias: 'Cash' });
    const bank = tender({ name: 'Bank Transfer', posV1Alias: 'Bank Transfer', moneyAccountId: 'a-bpi', moneyAccountName: 'BPI' });
    const blank = tender({ name: 'Voucher', kind: 'cash' });
    const old = tender({ name: 'Retired one', isActive: false });
    const rows = await run(null, [cash, bank, blank, old]);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.posMethod === null)).toBe(true);
    expect(rows.find((r) => r.tenderName === 'Cash')).toMatchObject({ status: 'unchecked', kind: 'cash', moneyAccountName: null });
    expect(rows.find((r) => r.tenderName === 'Bank Transfer')).toMatchObject({ status: 'unchecked', moneyAccountName: 'BPI' });
    expect(rows.find((r) => r.tenderName === 'Voucher')?.status).toBe('no_pos_name');
    expect(rows.some((r) => r.tenderName === 'Retired one')).toBe(false);
  });

  it('M4: two wallets on one account both appear, each naming the account', async () => {
    const bank = tender({ name: 'Bank Transfer', posV1Alias: 'Bank Transfer', moneyAccountId: 'a-bpi', moneyAccountName: 'BPI' });
    const qr = tender({ name: 'QRPH', posV1Alias: 'QRPH', moneyAccountId: 'a-bpi', moneyAccountName: 'BPI' });
    const rows = await run(['Bank Transfer', 'QRPH'], [bank, qr]);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => [r.tenderName, r.moneyAccountName, r.status])).toEqual([
      ['Bank Transfer', 'BPI', 'mapped'],
      ['QRPH', 'BPI', 'mapped'],
    ]);
  });

  it('M5: POS-method rows come first, then one row per active tender no method names', async () => {
    const named = tender({ name: 'Maya', posV1Alias: 'Maya' });
    const blank = tender({ name: 'Voucher', posV1Alias: null });
    const rows = await run(['Cash'], [named, blank]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ posMethod: 'Cash', tenderId: null, status: 'not_mapped' });
    expect(rows[1]).toMatchObject({ posMethod: null, tenderName: 'Maya', status: 'pos_does_not_list' });
    expect(rows[2]).toMatchObject({ posMethod: null, tenderName: 'Voucher', status: 'no_pos_name' });
    for (const r of rows) expect(r.statusText.length).toBeGreaterThan(0);
  });
});
