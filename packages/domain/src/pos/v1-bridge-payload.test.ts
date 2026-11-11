/**
 * T-531 R5 (TESTER) - the pure builder of the December bridge document (row 436). docs/tasks/531-pos-day-close.md R5, R8 "Bridge".
 * No database, no Firestore: the builder turns the Zs of one business date into the ONE document v1's `api/external/sales` reads.
 *
 * ASSUMED API (packages/domain/src/pos/v1-bridge-payload.ts):
 *   V1_BRIDGE_LAST_DATE = '2026-12-31'
 *   buildV1BridgePayload({ posStoreId, businessDate, closes: [{ receiptCount, grossTotal, discountTotal, unliSales, heads, packageSessions,
 *                          tenders: [{ name, kind: 'cash' | 'wallet', v1Alias: string | null, amount }] }] })
 *       -> { path: 'stores/<posStoreId>/analytics/<yyyymmdd>', merge: false, data: { payments, sales, guests } }
 *   Money arrives as decimal strings and leaves as JSON numbers (v1 reads numbers; R5 does not say, hand-back Q7). Cash is keyed 'cash' (R5), every other
 *   tender by its v1 method name = tenders.pos_v1_alias (the map the T-396 import resolves with, in reverse). Refusals are RefusalErrors; only the
 *   no-mapping sentence is fixed by the spec: "Tender <name> has no v1 method mapping."
 */
import { describe, expect, it } from 'vitest';
import { RefusalError } from '@shareat/db';
import { V1_WIRE_KEYS } from './v1-bridge-payload';

type Tender = { name: string; kind: 'cash' | 'wallet'; v1Alias: string | null; amount: string };
type Close = { receiptCount: number; grossTotal: string; discountTotal: string; unliSales: string; heads: number; packageSessions: number; tenders: Tender[] };
type Built = { path: string; merge: boolean; data: Record<string, unknown> };
type Mod = { buildV1BridgePayload: (i: { posStoreId: string; businessDate: string; closes: Close[] }) => Built; V1_BRIDGE_LAST_DATE: string };

async function mod(): Promise<Mod> {
  const m = (await import(/* @vite-ignore */ './v1-bridge-payload').catch(() => null)) as Mod | null;
  if (!m || typeof m.buildV1BridgePayload !== 'function') throw new Error('MISSING EXPORT: packages/domain/src/pos/v1-bridge-payload.ts does not export buildV1BridgePayload (T-531 not built).');
  return m;
}
const build = async (businessDate: string, closes: Close[], posStoreId = 'lipa-v1') => (await mod()).buildV1BridgePayload({ posStoreId, businessDate, closes });
async function refusal(p: Promise<unknown>) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, 'expected a refusal, got success').not.toBeNull();
  expect(err).toBeInstanceOf(RefusalError);
  return (err as RefusalError).userMessage;
}

/** The standard day of `_fixtures/t531-day-close.ts`: 3 receipts, gross 2,896.71, discounts 178.29, unli 2,245.00, 5 heads in 2 package sessions. */
const standard = (): Close => ({
  receiptCount: 3, grossTotal: '2896.71', discountTotal: '178.29', unliSales: '2245.00', heads: 5, packageSessions: 2,
  tenders: [
    { name: 'Cash', kind: 'cash', v1Alias: 'Cash', amount: '2396.71' },
    { name: 'GCash', kind: 'wallet', v1Alias: 'GCash', amount: '500.00' },
  ],
});

describe('R5 - the exact document', () => {
  it('a known day: every field R5 names, including the unli gross field (without it v1 books the whole day as take-out), and NOTHING else', async () => {
    const out = await build('2026-11-02', [standard()]);
    expect(out.path).toBe('stores/lipa-v1/analytics/20261102');
    expect(out.data).toEqual({
      payments: {
        totalGross: 2896.71, txCount: 3, byMethod: { cash: 2396.71, GCash: 500 }, discountsTotal: 178.29, chargesTotal: 0, [V1_WIRE_KEYS.voidRetainedCash]: 0,
      },
      sales: { [V1_WIRE_KEYS.unliGross]: 2245 },
      guests: { guestCountFinalTotal: 5, packageSessionsCount: 2 },
    });
  });

  it('a FULL overwrite, never an increment or a merge: merge is false', async () => {
    expect((await build('2026-11-02', [standard()])).merge).toBe(false);
  });

  it('the document id is the Z\'s business_date as yyyymmdd (the 31st: 20261231)', async () => {
    expect((await build('2026-12-31', [standard()])).path).toBe('stores/lipa-v1/analytics/20261231');
  });

  it('the unli gross field is the unli figure STATED by the Z, not a residual: a day of only a la carte sends 0, and no take-out field exists', async () => {
    const c = standard();
    const out = await build('2026-11-02', [{ ...c, unliSales: '0.00', heads: 0, packageSessions: 0 }]);
    expect((out.data.sales as Record<string, number>)).toEqual({ [V1_WIRE_KEYS.unliGross]: 0 });
    expect(JSON.stringify(out.data)).not.toMatch(/takeOut/i);
  });
});

describe('R5 - several Zs on one business date sum into ONE document', () => {
  it('two Zs: counts, gross, discounts, unli, heads and sessions add; byMethod adds per method; one path', async () => {
    const a: Close = { receiptCount: 1, grossTotal: '250.00', discountTotal: '0.00', unliSales: '0.00', heads: 0, packageSessions: 0, tenders: [{ name: 'Cash', kind: 'cash', v1Alias: 'Cash', amount: '250.00' }] };
    const b: Close = {
      receiptCount: 2, grossTotal: '700.00', discountTotal: '50.00', unliSales: '449.00', heads: 1, packageSessions: 1,
      tenders: [{ name: 'Cash', kind: 'cash', v1Alias: 'Cash', amount: '500.00' }, { name: 'GCash', kind: 'wallet', v1Alias: 'GCash', amount: '200.00' }],
    };
    const out = await build('2026-11-02', [a, b]);
    expect(out.data).toEqual({
      payments: { totalGross: 950, txCount: 3, byMethod: { cash: 750, GCash: 200 }, discountsTotal: 50, chargesTotal: 0, [V1_WIRE_KEYS.voidRetainedCash]: 0 },
      sales: { [V1_WIRE_KEYS.unliGross]: 449 },
      guests: { guestCountFinalTotal: 1, packageSessionsCount: 1 },
    });
  });

  it('two wallets that map to the same v1 method are summed under it', async () => {
    const c = standard();
    c.tenders = [
      { name: 'Cash', kind: 'cash', v1Alias: 'Cash', amount: '2396.71' },
      { name: 'GCash', kind: 'wallet', v1Alias: 'GCash', amount: '300.00' },
      { name: 'GCash QR', kind: 'wallet', v1Alias: 'GCash', amount: '200.00' },
    ];
    expect(((await build('2026-11-02', [c])).data.payments as { byMethod: Record<string, number> }).byMethod).toEqual({ cash: 2396.71, GCash: 500 });
  });
});

describe('R5 - the refusals', () => {
  it('a wallet tender with no v1 method mapping refuses with the exact sentence', async () => {
    const c = standard();
    c.tenders[1] = { name: 'GCash', kind: 'wallet', v1Alias: null, amount: '500.00' };
    expect(await refusal(build('2026-11-02', [c]))).toBe('Tender GCash has no v1 method mapping.');
  });

  it('Σ byMethod must equal totalGross to the centavo: one centavo short or over is refused, exact is not', async () => {
    const short = standard();
    short.tenders[1] = { ...short.tenders[1]!, amount: '499.99' };
    await refusal(build('2026-11-02', [short]));
    const over = standard();
    over.tenders[1] = { ...over.tenders[1]!, amount: '500.01' };
    await refusal(build('2026-11-02', [over]));
    await expect(build('2026-11-02', [standard()])).resolves.toBeDefined();
  });

  it('a business date after 2026-12-31 is refused IN CODE; the 31st itself is written', async () => {
    expect((await mod()).V1_BRIDGE_LAST_DATE).toBe('2026-12-31');
    await expect(build('2026-12-31', [standard()])).resolves.toBeDefined();
    await refusal(build('2027-01-01', [standard()]));
    await refusal(build('2027-03-15', [standard()]));
  });
});
