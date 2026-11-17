/**
 * T-589 B5 (d) - the opening tie-out names an account as `1400 · Prepaid expenses`, never as a bare code.
 * The repo is faked (one query for the chart, no database); the sentences are the real ones from tie-out.ts.
 */
import { describe, expect, it, vi } from 'vitest';

const NAMES = new Map([['1400', 'Prepaid expenses'], ['1510', 'Fixed assets at cost'], ['3900', 'Opening balance equity'], ['6100', 'Rent expense']]);
const line = (accountCode: string, debit: string, credit: string, entryDate = '2027-01-01') => ({
  entryId: 'e1', entryDate, accountCode, storeId: 's1', debit, credit, partyType: null, partyId: null, partyName: null,
  partyStoreId: null, partyGlCode: null, partyActive: null, employedAtStore: null,
});
const chart = vi.hoisted(() => ({ names: new Map<string, string>() }));
vi.mock('@shareat/db', () => ({
  cutoverRepo: {
    storeNamesOf: async () => new Map([['s1', 'Lipa']]),
    accountNamesOf: async () => chart.names,
    openingLines: async () => [line('1400', '500.00', '0.00'), line('1510', '300.00', '0.00'), line('1400', '10.00', '0.00', '2026-12-30'), line('3900', '0.00', '800.00'), line('6100', '42.00', '0.00')],
    countsForStore: async () => [],
    openingAssetCostByStore: async () => [],
    pendingAssetShells: async () => [],
    activePrepaidTotalByStore: async () => [],
    activeLoans: async () => [],
    partiesWithOpeningAndPreCutoverDocs: async () => [],
  },
}));

async function sentences(names: Map<string, string>): Promise<string[]> {
  chart.names = names;
  const { openingTieOut } = await import('../src/cutover/tie-out');
  return (await openingTieOut({} as never, 'org')).lines.map((l) => l.sentence);
}

describe('tie-out sentences name the account', () => {
  // MUTANT: make `acct` return the bare code -> "the opening figure on 1400 apart" with no name.
  it('prepaids, fixed assets, equity and dates print `code · name`', async () => {
    const all = (await sentences(NAMES)).join('\n');
    expect(all).toContain('opening figure on 1400 · Prepaid expenses is');
    expect(all).toContain('opening figure on 1510 · Fixed assets at cost is');
    expect(all).toContain('The opening figure for 1400 · Prepaid expenses (Lipa) is dated 2026-12-30');
    expect(all).toContain('3900 · Opening balance equity at Lipa carries');
  });

  // MUTANT: put "the 1400 opening figure" back into the T3 sentence.
  it('no sentence has an account code that is not followed by its name', async () => {
    const all = (await sentences(NAMES)).join('\n');
    expect(all).not.toMatch(/the 1400 opening/);
    expect(all).not.toMatch(/\b(1400|1510|3900)\b(?! · )/);
  });

  // MUTANT: accountLabel: account (bare code) -> red
  it('the not-checked list names an account with no register as `code · name`', async () => {
    chart.names = NAMES;
    const { openingTieOut } = await import('../src/cutover/tie-out');
    const tie = await openingTieOut({} as never, 'org');
    expect(tie.notChecked.find((n) => n.account === '6100')?.accountLabel).toBe('6100 · Rent expense');
  });

  it('an account missing from the chart falls back to the bare code instead of failing', async () => {
    expect((await sentences(new Map())).join('\n')).toContain('opening figure on 1400 is');
  });
});
