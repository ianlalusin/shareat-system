import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * T-629 test 5 - the readers keep working: after the payment-option master list the POS snapshot, the X/Z reading and the day close still carry the SAME tender names and amounts
 * (the standard day of T-531's reading test: Cash 2,396.71, GCash 500.00), and each line now also says which payment OPTION it is, so a report can group it (`groupByPaymentOption`).
 * Real Postgres; the sales are made through the real domain (`_fixtures/t531-day-close.ts`).
 *
 * Mutants (proven red by hand): D1 the reading stops carrying `paymentOptionId` (the line says ''); D2 `groupByPaymentOption` keys by tender instead of by option;
 * D3 the snapshot lowercases a tender name (the snapshot assertion).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

import { money } from '@shareat/core/money';
import { buildPosSnapshot } from '../../src/pos/snapshot';
import { groupByPaymentOption } from '../../src/pos/payment-options';
import { D1, RATES, asOrg, closeAll, manila, reading, sql, standardDay, world } from './_fixtures/t531-day-close';

afterAll(closeAll);

type Line = { tenderId: string; paymentOptionId: string; name: string; kind: string; amount: string };

describe('tender names and amounts, and the option behind each line', () => {
  it('the X reading lists Cash 2396.71 and GCash 500.00, each with its payment option; the option is the one the tender switches on', async () => {
    const w = await world();
    await standardDay(w);
    const r = await reading(w, manila(D1, '22:30'));
    const lines = (r.byTender as unknown as Line[]).map((l) => ({ name: l.name, kind: l.kind, amount: l.amount })).sort((a, b) => a.name.localeCompare(b.name));
    expect(lines).toEqual([
      { name: 'Cash', kind: 'cash', amount: '2396.71' },
      { name: 'GCash', kind: 'wallet', amount: '500.00' },
    ]);
    const opts = await sql<{ id: string; option_name: string; payment_option_id: string }[]>`
      select t.id, p.name option_name, t.payment_option_id from tenders t join payment_options p on p.id = t.payment_option_id where t.org_id = ${w.orgId}`;
    for (const l of r.byTender as unknown as Line[]) {
      const row = opts.find((o) => o.id === l.tenderId)!;
      expect(l.paymentOptionId, `${l.name} line carries its option`).toBe(row.payment_option_id);
      expect(l.name, 'the tender name is the option name (mirror)').toBe(row.option_name);
    }
  });

  it('the tablet snapshot lists the same two active tenders by the same names and kinds', async () => {
    const w = await world();
    const snap = await asOrg(w.orgId, (tx) => buildPosSnapshot(tx, { pairing: { pairingId: w.pairingId, orgId: w.orgId, storeId: w.storeId } }, RATES));
    const t = (snap.body.tenders as { name: string; kind: string }[]).map((x) => [x.name, x.kind]).sort();
    expect(t).toEqual([['Cash', 'cash'], ['GCash', 'wallet']]);
  });

  it('groupByPaymentOption sums the same option across stores (two GCash lines are one figure) and keeps different options apart', () => {
    const lines = [
      { paymentOptionId: 'gcash', amount: money('500.00') },
      { paymentOptionId: 'cash', amount: money('2396.71') },
      { paymentOptionId: 'gcash', amount: money('125.50') },
    ];
    expect(groupByPaymentOption(lines).map((g) => [g.paymentOptionId, String(g.amount)])).toEqual([['gcash', '625.50'], ['cash', '2396.71']]);
  });
});
