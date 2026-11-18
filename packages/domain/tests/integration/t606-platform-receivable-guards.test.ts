import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-606 audit - a delivery-platform channel posts to the channel receivable or not at all:
 *  - a sales day cannot be VERIFIED for a platform channel on any other receivable (nothing posted, the day unchanged);
 *  - a platform channel cannot be turned back ON while its receivable is wrong;
 *  - channels with NO platform (dine-in, a wholesale buyer, branch sales) are completely unaffected.
 * World: the t511-s6b fixture (a Foodpanda channel at Lipa and one typed sales day).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

import { closeDb } from '@shareat/db';
import * as D from '@shareat/domain';
import { asOrg, fx, netDebit, sentenceOf } from './_fixtures/t511-s6b-world';
import { submitThenVerify } from './_fixtures/sales-day-flow';

const sql = postgres(url, { max: 8 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const SENTENCE = "Foodpanda is a delivery platform channel but is not set to Channel receivable. Fix it in Settings › Sales channels, then verify this day.";
const dayRow = async (dayId: string) =>
  (await sql<{ status: string; journal_entry_id: string | null }[]>`select status, journal_entry_id::text from sales_days where id = ${dayId}`)[0]!;
const verify = (f: Awaited<ReturnType<typeof fx>>) => asOrg(f.orgId, (tx) => submitThenVerify(tx, f.admin, f.dayId, f.submitter));

describe('T-606 audit - verifying a sales day for a platform channel', () => {
  it('a platform channel on 1210 is refused in words, nothing is posted, the day stays open - Mutant: drop the check in verifySalesDay -> the day posts to 1210, red', async () => {
    const f = await fx(sql, 'v1210', { staff: '10000.00', file: '10000.00', receivable: '1210', verified: false });
    expect(await sentenceOf(verify(f))).toBe(SENTENCE);
    expect(await dayRow(f.dayId)).toEqual({ status: 'open', journal_entry_id: null });
    expect(Number(await netDebit(sql, f.orgId, '1210'))).toBe(0);
  });

  it('positive: a platform channel on the channel receivable verifies and posts to 1220', async () => {
    const f = await fx(sql, 'v1220', { staff: '10000.00', file: '10000.00', verified: false });
    await verify(f);
    expect((await dayRow(f.dayId)).status).toBe('verified');
    expect(Number(await netDebit(sql, f.orgId, '1220'))).toBe(10000);
  });

  it('a channel with NO platform (a wholesale buyer on 1210) still verifies, exactly as before', async () => {
    const f = await fx(sql, 'vnoplat', { staff: '10000.00', file: '10000.00', receivable: '1210', verified: false });
    await sql`update sales_channels set platform = null, platform_store_code = null where id = ${f.channelId}`;
    await verify(f);
    expect((await dayRow(f.dayId)).status).toBe('verified');
    expect(Number(await netDebit(sql, f.orgId, '1210'))).toBe(10000);
  });
});

describe('T-606 audit - turning a platform channel back on', () => {
  const retire = (f: Awaited<ReturnType<typeof fx>>) => sql`update sales_channels set is_active = false where id = ${f.channelId}`;
  const activeOf = async (id: string) => (await sql<{ is_active: boolean }[]>`select is_active from sales_channels where id = ${id}`)[0]!.is_active;
  const turnOn = (f: Awaited<ReturnType<typeof fx>>) => asOrg(f.orgId, (tx) => D.setSalesChannelActive(tx, f.admin, { channelId: f.channelId, isActive: true }));

  it('a platform channel on 1210 cannot be re-activated - Mutant: drop the check in setSalesChannelActive -> it switches on, red', async () => {
    const f = await fx(sql, 'a1210', { staff: '10000.00', file: '10000.00', receivable: '1210', verified: false });
    await retire(f);
    expect(await sentenceOf(turnOn(f))).toBe('Foodpanda is a delivery platform channel but is not set to Channel receivable. Fix it in Settings › Sales channels, then turn it back on.');
    expect(await activeOf(f.channelId)).toBe(false);
  });

  it('positive: a platform channel on the channel receivable turns back on; a channel with no platform is not asked', async () => {
    const f = await fx(sql, 'a1220', { staff: '10000.00', file: '10000.00', verified: false });
    await retire(f);
    await turnOn(f);
    expect(await activeOf(f.channelId)).toBe(true);

    const g = await fx(sql, 'anoplat', { staff: '10000.00', file: '10000.00', receivable: '1210', verified: false });
    await sql`update sales_channels set platform = null, platform_store_code = null where id = ${g.channelId}`;
    await retire(g);
    await turnOn(g);
    expect(await activeOf(g.channelId)).toBe(true);
  });
});
