import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-618 / DEF-927 - the sales-channel receivable is a receivable: the picker lists only 1210 and 1220, and the server refuses a cash, payable or equity account.
 * World: the t511-s6b fixture (an org with the seeded chart and a Foodpanda channel at Lipa).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

import { closeDb } from '@shareat/db';
import * as D from '@shareat/domain';
import { asOrg, fx, sentenceOf } from './_fixtures/t511-s6b-world';

const sql = postgres(url, { max: 8 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

// Cash (1120), e-wallet (1140), advances (1230, 1240), due from store (1250), due from owners (1260), a payable (2110) and equity (3200): all carry a party, so only the allow-list (1210, 1220) keeps them out.
const NOT_RECEIVABLES = ['1120', '1140', '1230', '1240', '1250', '1260', '2110', '3200'];

describe('DEF-927 - the receivable picker and the server check', () => {
  it('the picker offers receivables only - Mutant: drop the type/group filter -> cash, payable and equity are listed, red', async () => {
    const f = await fx(sql, 'pick', { staff: '100.00', file: '100.00', verified: false });
    const codes = (await asOrg(f.orgId, (tx) => D.receivableAccountOptions(tx, f.admin))).map((o) => o.code);
    expect(codes).toEqual(expect.arrayContaining(['1210', '1220']));
    for (const c of NOT_RECEIVABLES) expect(codes, c).not.toContain(c);
  });

  it.each(NOT_RECEIVABLES)('creating a channel on %s is refused in words - Mutant: drop the server check -> it is created, red', async (code) => {
    const f = await fx(sql, `mk${code}`, { staff: '100.00', file: '100.00', verified: false });
    const s = await sentenceOf(asOrg(f.orgId, (tx) => D.createSalesChannel(tx, f.admin, { storeId: f.storeA, name: `Credit ${code}`, isRemittedDaily: false, receivableAccountCode: code })));
    expect(s).toMatch(new RegExp(`^Account ${code} .* is not a receivable account, so a channel's sales cannot be owed on it\. Pick a receivable such as 1210 or 1220\.$`));
  });

  it('editing a channel onto an equity account is refused, and the setting stays', async () => {
    const f = await fx(sql, 'edit', { staff: '100.00', file: '100.00', verified: false });
    await sql`update sales_channels set platform = null, platform_store_code = null where id = ${f.channelId}`;
    const s = await sentenceOf(asOrg(f.orgId, (tx) => D.updateSalesChannel(tx, f.admin, { channelId: f.channelId, name: 'Foodpanda', isRemittedDaily: false, receivableAccountCode: '3200', wastageTypeMode: 'tracked' })));
    expect(s).toMatch(/is not a receivable account/);
    expect((await sql<{ c: string }[]>`select receivable_account_code as c from sales_channels where id = ${f.channelId}`)[0]!.c).toBe('1220');
  });

  it('positive: a channel on 1210 is created', async () => {
    const f = await fx(sql, 'ok', { staff: '100.00', file: '100.00', verified: false });
    const { channelId } = await asOrg(f.orgId, (tx) => D.createSalesChannel(tx, f.admin, { storeId: f.storeA, name: 'Wholesale', isRemittedDaily: false, receivableAccountCode: '1210' }));
    expect(channelId).toBeTruthy();
  });
});
