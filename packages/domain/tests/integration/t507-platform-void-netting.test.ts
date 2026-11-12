import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-507 / platformAging - a VOIDED sales day's reversal credit must net against the debit it reverses, not FIFO-consume the
 * OLDEST open debit. World: Batangas Foodpanda 700 on 02-20 (31-60 bucket). A newer 300 day (03-22) is verified then voided.
 * The 700 must stay 700 in 31-60; the 300 and its reversal vanish.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

import { closeDb } from '@shareat/db';
import { createSalesDay, getArAgingReport, voidSalesDay } from '../../src';
import { ASOF, asOrg, buildPlatformWorld } from './_fixtures/t507-platform-ar';
import { submitThenVerify } from './_fixtures/sales-day-flow';

const sql = postgres(url, { max: 5 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('T-507 platformAging: a voided day nets against itself', () => {
  it('older unsettled 700 stays in 31-60 after a newer 300 day is verified and voided', async () => {
    const w = await buildPlatformWorld(sql);
    const { id } = await asOrg(w.orgId, (tx) =>
      createSalesDay(tx, w.submitter, {
        storeId: w.bat, businessDate: '2027-03-22', totalSales: '1300.00', unliSales: '1300.00', alaCarteSales: '0.00', cashCollected: '1000.00',
        channels: [{ channelId: w.ch.batWalk, amount: '1000.00' }, { channelId: w.ch.batFp, amount: '300.00' }],
      }),
    );
    await asOrg(w.orgId, (tx) => submitThenVerify(tx, w.admin, id, w.submitter));
    await asOrg(w.orgId, (tx) => voidSalesDay(tx, w.admin, id, 'entered twice'));
    const r = await asOrg(w.orgId, (tx) => getArAgingReport(tx, { orgId: w.orgId, storeId: w.bat, asOfDate: ASOF }));
    const fp = (r as { platform: { rows: Array<{ channelId: string; d1to30: string; d31to60: string; total: string }> } }).platform.rows.find((x) => x.channelId === w.ch.batFp);
    expect(fp, 'Batangas Foodpanda row').toBeDefined();
    expect({ d1to30: fp!.d1to30, d31to60: fp!.d31to60, total: fp!.total }).toEqual({ d1to30: '0.00', d31to60: '700.00', total: '700.00' });
  });
});
