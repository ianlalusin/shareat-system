import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T-369 S8 · T7 — the pure arithmetic of `withInterStoreLegs(tx, orgId, { owingStoreId, lines, memo })`
 * (`packages/domain/src/ledger/inter-store.ts`, new; `docs/tasks/369-unwired-money-screens.md` §S8).
 *
 *   for each store ≠ the owing store whose lines net to a CREDIT X (X > 0): append DR 1250 at THAT store (party = the OWING
 *   store's code) and CR 2150 at the owing store (party = THAT store's code), each X. Lines all at the owing store come back
 *   `===` unchanged. A non-owing store netting to a DEBIT (money landed there, S8b) gets the MIRRORED pair. Sums are exact to the centavo (I8).
 *
 * ⛔ TESTER. RED TODAY BECAUSE THE MODULE DOES NOT EXIST: every leg loads it through `load()` so each fails on its own
 * assertion ("ledger/inter-store.ts does not exist yet") rather than the whole file failing at import. `storeCodes` is
 * stubbed: the helper resolves codes once with `moneyTransfersRepo.storeCodes(tx, orgId, storeIds)` -> `Map<storeId, code>`,
 * the call `commissary` and `money-transfers` already make.
 */
const CODES = new Map<string, string>([
  ['store-lipa', 'LIPA'],
  ['store-malvar', 'MLV'],
  ['store-batangas', 'BTG'],
]);
const storeCodes = vi.fn(async (_tx: unknown, _orgId: string, ids: string[]) => new Map(ids.filter((i) => CODES.has(i)).map((i) => [i, CODES.get(i)!])));
vi.mock('@shareat/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shareat/db')>();
  return { ...actual, moneyTransfersRepo: { ...actual.moneyTransfersRepo, storeCodes: (...a: Parameters<typeof storeCodes>) => storeCodes(...a) } };
});

interface L {
  accountCode: string;
  storeId: string;
  debit?: string;
  credit?: string;
  partyType?: string | null;
  partyId?: string | null;
  lineMemo?: string | null;
}
type WithLegs = (tx: unknown, orgId: string, input: { owingStoreId: string; lines: L[]; memo: string }) => Promise<L[]>;

async function load(): Promise<WithLegs> {
  try {
    const mod = (await import('../../src/ledger/inter-store')) as unknown as { withInterStoreLegs?: WithLegs };
    if (typeof mod.withInterStoreLegs !== 'function') throw new Error('withInterStoreLegs is not exported');
    return mod.withInterStoreLegs;
  } catch (err) {
    throw new Error(`packages/domain/src/ledger/inter-store.ts does not exist yet (or lacks withInterStoreLegs): ${String((err as Error).message).split('\n')[0]}`);
  }
}

const LIPA = 'store-lipa';
const MALVAR = 'store-malvar';
const BATANGAS = 'store-batangas';
const ORG = 'org-1';
const cents = (v: string | undefined) => Math.round(Number(v ?? '0') * 100);
const added = (before: L[], after: L[]) => after.filter((l) => !before.includes(l));

beforeEach(() => { storeCodes.mockClear(); });

describe('T7 — withInterStoreLegs', () => {
  it('one paying store: DR 1250 at it (party = the OWING store\'s code) and CR 2150 at the owing store (party = the paying store\'s code), each the credited amount', async () => {
    const withLegs = await load();
    const lines: L[] = [
      { accountCode: '2130', storeId: LIPA, debit: '650.00', partyType: 'employee', partyId: 'ana' },
      { accountCode: '1130', storeId: MALVAR, credit: '650.00' },
    ];
    const out = await withLegs(null, ORG, { owingStoreId: LIPA, lines, memo: 'm' });
    const extra = added(lines, out);
    expect(extra).toHaveLength(2);
    expect(extra.find((l) => l.accountCode === '1250')).toMatchObject({ storeId: MALVAR, debit: '650.00', partyType: 'store', partyId: 'LIPA' });
    expect(extra.find((l) => l.accountCode === '2150')).toMatchObject({ storeId: LIPA, credit: '650.00', partyType: 'store', partyId: 'MLV' });
    expect(out.slice(0, lines.length), 'the original lines are kept, in order').toEqual(lines);
    expect(storeCodes, 'codes resolved once').toHaveBeenCalledTimes(1);
  });

  it('two paying stores in one entry -> two pairs, each for its own store\'s credit', async () => {
    const withLegs = await load();
    const lines: L[] = [
      { accountCode: '6200', storeId: LIPA, debit: '1000.00' },
      { accountCode: '1130', storeId: MALVAR, credit: '400.00' },
      { accountCode: '1130', storeId: BATANGAS, credit: '250.00' },
      { accountCode: '1110', storeId: LIPA, credit: '350.00' },
    ];
    const extra = added(lines, await withLegs(null, ORG, { owingStoreId: LIPA, lines, memo: 'm' }));
    expect(extra).toHaveLength(4);
    expect(extra.find((l) => l.accountCode === '1250' && l.storeId === MALVAR)).toMatchObject({ debit: '400.00', partyId: 'LIPA' });
    expect(extra.find((l) => l.accountCode === '1250' && l.storeId === BATANGAS)).toMatchObject({ debit: '250.00', partyId: 'LIPA' });
    const owed = extra.filter((l) => l.accountCode === '2150');
    expect(owed.every((l) => l.storeId === LIPA)).toBe(true);
    expect(owed.map((l) => [l.partyId, l.credit]).sort()).toEqual([['BTG', '250.00'], ['MLV', '400.00']]);
  });

  it('all lines at the owing store: the SAME array is returned (===), and no code lookup is needed', async () => {
    const withLegs = await load();
    const lines: L[] = [{ accountCode: '2130', storeId: LIPA, debit: '650.00' }, { accountCode: '1130', storeId: LIPA, credit: '650.00' }];
    expect(await withLegs(null, ORG, { owingStoreId: LIPA, lines, memo: 'm' })).toBe(lines);
  });

  // T-369 S8b (DEF-556) — REPLACES S8's "a non-owing store that nets to a DEBIT is an internal fault". Money that LANDS at another
  // store (a collection or a loan drawn into its safe) makes THAT store the debtor, so the pair runs the other way.
  it('T8 — a non-owing store netting to a DEBIT (money landed there) gets the MIRRORED pair: CR 2150 at it (party = the OWING store code), DR 1250 at the owing store (party = its code); no throw', async () => {
    const withLegs = await load();
    const lines: L[] = [
      { accountCode: '1210', storeId: LIPA, credit: '2000.00', partyType: 'customer', partyId: 'resto' },
      { accountCode: '1130', storeId: MALVAR, debit: '2000.00' },
    ];
    const out = await withLegs(null, ORG, { owingStoreId: LIPA, lines, memo: 'm' });
    const extra = added(lines, out);
    expect(extra).toHaveLength(2);
    expect(extra.find((l) => l.accountCode === '2150')).toMatchObject({ storeId: MALVAR, credit: '2000.00', partyType: 'store', partyId: 'LIPA' });
    expect(extra.find((l) => l.accountCode === '1250')).toMatchObject({ storeId: LIPA, debit: '2000.00', partyType: 'store', partyId: 'MLV' });
    expect(out.slice(0, lines.length), 'the original lines are kept, in order').toEqual(lines);
  });

  it('T8 — one entry with a PAYING store and a RECEIVING store -> two pairs, in opposite directions', async () => {
    const withLegs = await load();
    const lines: L[] = [
      { accountCode: '6200', storeId: LIPA, debit: '300.00' },
      { accountCode: '1130', storeId: MALVAR, credit: '300.00' },
      { accountCode: '1210', storeId: LIPA, credit: '500.00' },
      { accountCode: '1130', storeId: BATANGAS, debit: '500.00' },
    ];
    const extra = added(lines, await withLegs(null, ORG, { owingStoreId: LIPA, lines, memo: 'm' }));
    expect(extra).toHaveLength(4);
    // Malvar PAID 300: DR 1250 at Malvar (party LIPA) / CR 2150 at Lipa (party MLV)
    expect(extra.find((l) => l.accountCode === '1250' && l.storeId === MALVAR)).toMatchObject({ debit: '300.00', partyId: 'LIPA' });
    expect(extra.find((l) => l.accountCode === '2150' && l.storeId === LIPA)).toMatchObject({ credit: '300.00', partyId: 'MLV' });
    // Batangas RECEIVED 500: CR 2150 at Batangas (party LIPA) / DR 1250 at Lipa (party BTG)
    expect(extra.find((l) => l.accountCode === '2150' && l.storeId === BATANGAS)).toMatchObject({ credit: '500.00', partyId: 'LIPA' });
    expect(extra.find((l) => l.accountCode === '1250' && l.storeId === LIPA)).toMatchObject({ debit: '500.00', partyId: 'BTG' });
  });

  it('T8 — centavo sums stay exact for the receiving direction: debits of 0.10 and 0.20 at one receiving store give a mirrored pair of exactly 0.30', async () => {
    const withLegs = await load();
    const lines: L[] = [
      { accountCode: '1210', storeId: LIPA, credit: '0.30' },
      { accountCode: '1130', storeId: MALVAR, debit: '0.10' },
      { accountCode: '1110', storeId: MALVAR, debit: '0.20' },
    ];
    const extra = added(lines, await withLegs(null, ORG, { owingStoreId: LIPA, lines, memo: 'm' }));
    expect(extra).toHaveLength(2);
    expect(cents(extra.find((l) => l.accountCode === '2150')?.credit)).toBe(30);
    expect(cents(extra.find((l) => l.accountCode === '1250')?.debit)).toBe(30);
  });

  it('a store code that cannot be resolved is an internal fault (the pair would carry no party)', async () => {
    const withLegs = await load();
    storeCodes.mockResolvedValueOnce(new Map([[LIPA, 'LIPA']]));
    const lines: L[] = [{ accountCode: '6200', storeId: LIPA, debit: '10.00' }, { accountCode: '1130', storeId: MALVAR, credit: '10.00' }];
    await expect(withLegs(null, ORG, { owingStoreId: LIPA, lines, memo: 'm' })).rejects.toThrow();
  });

  it('centavo sums are exact: credits of 0.10 and 0.20 at one paying store give a pair of exactly 0.30', async () => {
    const withLegs = await load();
    const lines: L[] = [
      { accountCode: '6200', storeId: LIPA, debit: '0.30' },
      { accountCode: '1130', storeId: MALVAR, credit: '0.10' },
      { accountCode: '1110', storeId: MALVAR, credit: '0.20' },
    ];
    const extra = added(lines, await withLegs(null, ORG, { owingStoreId: LIPA, lines, memo: 'm' }));
    expect(extra).toHaveLength(2);
    expect(extra.find((l) => l.accountCode === '1250')?.debit).toBe('0.30');
    expect(extra.find((l) => l.accountCode === '2150')?.credit).toBe('0.30');
    expect(cents(extra.find((l) => l.accountCode === '1250')?.debit)).toBe(30);
  });

  it('a paying store whose lines net to zero (a credit and an equal debit) gets no pair', async () => {
    const withLegs = await load();
    const lines: L[] = [
      { accountCode: '6200', storeId: LIPA, debit: '100.00' },
      { accountCode: '1130', storeId: LIPA, credit: '100.00' },
      { accountCode: '1130', storeId: MALVAR, credit: '40.00' },
      { accountCode: '1110', storeId: MALVAR, debit: '40.00' },
    ];
    expect(await withLegs(null, ORG, { owingStoreId: LIPA, lines, memo: 'm' })).toEqual(lines);
  });
});
