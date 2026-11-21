import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-618 / DEF-922 - a hand-recorded channel settlement takes the sales DAY first and the loan rows second, the order approve-day uses (its sales correction locks the day,
 * then it records the settlement). The DEF was filed against loans-then-day; since DEF-881 (T-595) the settlement reads the day `for share` (`salesDayForSettlement`) before the
 * loan rows, so main already has one order. This test pins it: the mutant is that read losing its share lock, which sends the settlement to the loan rows first.
 *
 * The test builds the crossing exactly: A holds the day (as the correction does) and later asks for the loan; B is a hand-recorded settlement on ANOTHER channel of the same day
 * docking the SAME loan, started while A holds the day. With the day first B parks at the day holding no loan, A takes the loan and commits, B finishes. With loans first B
 * holds the loan while parked at the day, A's loan request closes the cycle, and Postgres aborts one of them (40P01).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

import { closeDb, loansRepo, salesDaysRepo } from '@shareat/db';
import { recordChannelSettlement } from '@shareat/domain';
import { asOrg, loanOf, raiseReceivable, settleInput, world } from './_fixtures/t618-settlement-world';

const sql = postgres(url, { max: 8 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

/** Polls until some backend is waiting on a lock it has not been granted. */
async function waitForParkedBackend(timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [r] = await sql<{ n: string }[]>`select count(*)::text as n from pg_locks where not granted`;
    if (Number(r!.n) > 0) return;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error('no backend ever waited on a lock: the settlement did not park, so this was not a race');
}

describe('DEF-922 - day, then loans', () => {
  it('a settlement and a day-first holder asking for the same loan do not deadlock - Mutant: drop the `for share` of salesDayForSettlement (loans before the day) -> 40P01, red', async () => {
    const w = await world(sql, 'lockorder');
    const channelB = await w.channel('Foodpanda');
    const loan = await loanOf(sql, w, w.paying, 'L1');
    await raiseReceivable(w, channelB, '20000.00');

    const aHoldsDay = Promise.withResolvers<void>();
    const aGo = Promise.withResolvers<void>();
    const a = asOrg(w.orgId, async (tx) => {
      await salesDaysRepo.getByIdForUpdate(tx, w.orgId, w.salesDayId); // what approve-day's sales correction does first
      aHoldsDay.resolve();
      await aGo.promise;
      await loansRepo.lockForPayment(tx, w.orgId, loan); // ...and what its settlement then asks for
    }).then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));

    await aHoldsDay.promise;
    const b = asOrg(w.orgId, (tx) => recordChannelSettlement(tx, w.manager, settleInput(w, channelB, [{ loanId: loan, amount: '2360.00' }]))).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await waitForParkedBackend();
    aGo.resolve();

    const [ra, rb] = await Promise.all([a, b]);
    expect(ra, `A: ${String((ra as { error?: unknown }).error)}`).toEqual({ ok: true });
    expect(rb.ok, `B: ${String((rb as { error?: unknown }).error)}`).toBe(true);
    const [row] = await sql<{ n: string }[]>`select count(*)::text as n from channel_settlements where org_id = ${w.orgId} and status = 'posted'`;
    expect(Number(row!.n)).toBe(1);
  });
});
