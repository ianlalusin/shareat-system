import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-618 / DEF-921 - a channel settlement with a cross-store loan leg posts 1250/2150, and its void reverses them, so both take the store-pair lock a cross-store transfer, its void and a
 * settle-between-stores take (T-594). Each test holds the settlement's (or the void's) transaction open and starts a plain pair-lock taker beside it: the taker must PARK on the advisory
 * lock (heldRace's park proof throws if it never waits, so a writer that skips the lock fails here).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

import { advisoryLocksRepo, closeDb, type Tx } from '@shareat/db';
import { recordChannelSettlement, voidChannelSettlement } from '@shareat/domain';
import { heldRace } from './_fixtures/held-race';
import { asOrg, loanOf, raiseReceivable, settleInput, world } from './_fixtures/t618-settlement-world';

const sql = postgres(url, { max: 8 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('DEF-921 - a settlement with a cross-store loan leg holds the store-pair lock', () => {
  it('record: a pair-lock taker parks behind it, and the 1250/2150 pair is posted - Mutant: drop the lock in recordChannelSettlement -> the taker never waits, red', async () => {
    const w = await world(sql, 'rec');
    const channel = await w.channel('Foodpanda');
    const loan = await loanOf(sql, w, w.other, 'L1');
    await raiseReceivable(w, channel, '20000.00');
    const taker = (tx: Tx) => advisoryLocksRepo.lockInterStorePair(tx, w.other.id, w.paying.id); // the pair, named in the other order: the key is unordered
    const [a] = await heldRace(
      asOrg,
      w.orgId,
      (tx) => recordChannelSettlement(tx, w.manager, settleInput(w, channel, [{ loanId: loan, amount: '2360.00', ownerStoreId: w.other.id }])),
      taker,
      700,
      { sql },
    );
    expect(a.entryId).toBeTruthy();
    const [n] = await sql<{ n: string }[]>`
      select count(*)::text as n from journal_lines jl join accounts a on a.id = jl.account_id where jl.entry_id = ${a.entryId} and a.code in ('1250', '2150')`;
    expect(Number(n!.n)).toBe(2);
  });

  it('void: a pair-lock taker parks behind it - Mutant: drop the lock in voidChannelSettlement -> red', async () => {
    const w = await world(sql, 'void');
    const channel = await w.channel('Foodpanda');
    const loan = await loanOf(sql, w, w.other, 'L1');
    await raiseReceivable(w, channel, '20000.00');
    const posted = await asOrg(w.orgId, (tx) => recordChannelSettlement(tx, w.manager, settleInput(w, channel, [{ loanId: loan, amount: '2360.00', ownerStoreId: w.other.id }])));
    const [a] = await heldRace(
      asOrg,
      w.orgId,
      (tx) => voidChannelSettlement(tx, w.manager, { settlementId: posted.settlementId, reason: 'wrong payout' }),
      (tx) => advisoryLocksRepo.lockInterStorePair(tx, w.paying.id, w.other.id),
      700,
      { sql },
    );
    expect(a.reversedEntryId).toBeTruthy();
  });
});
