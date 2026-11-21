import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-618 / DEF-926 - a channel that still holds a balance cannot be retired, and the receivable-change guard takes the channel row lock
 * (a sales day verifying at the same moment parks, then posts on the account the edit leaves, or the edit is refused).
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
import { asOrg, fx, sentenceOf } from './_fixtures/t511-s6b-world';
import { submitThenVerify } from './_fixtures/sales-day-flow';
import { heldRace } from './_fixtures/held-race';

const sql = postgres(url, { max: 8 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

type F = Awaited<ReturnType<typeof fx>>;
const activeOf = async (id: string) => (await sql<{ is_active: boolean }[]>`select is_active from sales_channels where id = ${id}`)[0]!.is_active;
const retire = (f: F) => asOrg(f.orgId, (tx) => D.setSalesChannelActive(tx, f.admin, { channelId: f.channelId, isActive: false }));
const edit = (f: F, receivableAccountCode: string) =>
  asOrg(f.orgId, (tx) => D.updateSalesChannel(tx, f.admin, { channelId: f.channelId, name: 'Foodpanda', isRemittedDaily: false, receivableAccountCode, wastageTypeMode: 'tracked' }));

describe('DEF-926 - retiring a channel that still holds a balance', () => {
  it('refused in words, the channel stays active - Mutant: drop the balance check in setSalesChannelActive -> it retires, red', async () => {
    const f = await fx(sql, 'ret', { staff: '10000.00', file: '10000.00' }); // verified: 10,000 sits on 1220
    const s = await sentenceOf(retire(f));
    expect(s).toMatch(/^Foodpanda still has .*10,000\.00 owed on 1220\. Collect or settle that first, then retire the channel\.$/);
    expect(await activeOf(f.channelId)).toBe(true);
  });

  it('positive: a channel with no balance retires', async () => {
    const f = await fx(sql, 'ret0', { staff: '10000.00', file: '10000.00', verified: false });
    await retire(f);
    expect(await activeOf(f.channelId)).toBe(false);
  });
});

describe('DEF-926 - the receivable-change guard and a verify racing it', () => {
  // A non-platform channel on 1210 whose day is not yet verified: nothing is held on 1210 until A commits.
  const world = async (hint: string) => {
    const f = await fx(sql, hint, { staff: '10000.00', file: '10000.00', receivable: '1210', verified: false });
    await sql`update sales_channels set platform = null, platform_store_code = null where id = ${f.channelId}`;
    return f;
  };

  it('A verifies the day (held, 10,000 on 1210); B moves the channel to 1220: B parks on the channel row, then is refused - Mutant: drop the lockChannel in updateSalesChannel (or the share lock in verify) -> B never parks, red', async () => {
    const f = await world('race');
    const [a, b] = await heldRace(
      asOrg,
      f.orgId,
      (tx) => submitThenVerify(tx, f.admin, f.dayId, f.submitter),
      (tx) => sentenceOf(D.updateSalesChannel(tx, f.admin, { channelId: f.channelId, name: 'Foodpanda', isRemittedDaily: false, receivableAccountCode: '1220', wastageTypeMode: 'tracked' })),
      700,
      { sql },
    );
    expect(a.created).toBe(true);
    expect(b).toMatch(/still has .*10,000\.00 owed on 1210/);
    const [row] = await sql<{ receivable_account_code: string }[]>`select receivable_account_code from sales_channels where id = ${f.channelId}`;
    expect(row!.receivable_account_code).toBe('1210');
  });

  it('positive: with nothing held the same edit goes through', async () => {
    const f = await world('nohold');
    await edit(f, '1220');
    const [row] = await sql<{ receivable_account_code: string }[]>`select receivable_account_code from sales_channels where id = ${f.channelId}`;
    expect(row!.receivable_account_code).toBe('1220');
  });
});
