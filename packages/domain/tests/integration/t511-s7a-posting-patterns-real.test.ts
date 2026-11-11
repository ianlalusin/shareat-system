import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-511 S7a - the two approve worked examples in docs/POSTING-PATTERNS.md and tests/worked-examples/fixtures.ts are the REAL lines: the settlement entry that
 * `approveDay` posts for each, read back from the books, equals the fixture's `expect` (per account and side, as the worked examples speak of one 6400 amount).
 * Real Postgres, real ingest, real posting. The fixture is the source of truth; this test is the proof that it is not an invention.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { closeDb } from '@shareat/db';
import { inMemoryDriver, setStorageDriver } from '@shareat/domain';
import { WORKED_EXAMPLES } from '../../../../tests/worked-examples/fixtures';
import { D3, aggText, approve, fpWeek, grabWorld, postCharge, settlementFull } from './_fixtures/t511-s7a-world';

const sql = postgres(url, { max: 10 });
beforeEach(() => setStorageDriver(inMemoryDriver()));
afterAll(async () => {
  setStorageDriver(null);
  await closeDb();
  await sql.end({ timeout: 5 });
});

/** The fixture's lines as money per account and side, in the same text form `aggText` uses ('Dr 6400 2300.00'), sorted. */
function fixtureText(id: string): string[] {
  const fx = WORKED_EXAMPLES.find((f) => f.id === id);
  if (!fx) throw new Error(`no worked example ${id}`);
  const sum = new Map<string, bigint>();
  const cents = (t: string): bigint => BigInt(t.replace('.', ''));
  for (const l of fx.expect) sum.set(l.accountCode, (sum.get(l.accountCode) ?? 0n) + cents(l.debit ?? '0.00') - cents(l.credit ?? '0.00'));
  const text = (n: bigint): string => `${n / 100n}.${String(n % 100n).padStart(2, '0')}`;
  return [...sum.entries()].filter(([, n]) => n !== 0n).map(([code, n]) => (n > 0n ? `Dr ${code} ${text(n)}` : `Cr ${code} ${text(-n)}`)).sort();
}

describe('S7a - the POSTING-PATTERNS approve examples are the real lines', () => {
  it('grab_day_after_correction: the settlement approveDay posts after the correction equals the fixture', async () => {
    const g = await grabWorld(sql, 'pp-grab');
    const r = await approve(g.w, g.w.managerA2, g.lineId);
    expect(await aggText(sql, (await settlementFull(sql, r.settlementId)).journal_entry_id!)).toEqual(fixtureText('channel_settlement.grab_day_after_correction'));
  });

  it('foodpanda_week_with_charge: the carrier day approveDay posts equals the fixture, and the week banks the invoice total', async () => {
    const f = await fpWeek(sql, 'pp-fp', { charge: true });
    const w = f.w;
    await postCharge(w, w.admin, f.chargeLineId!);
    await approve(w, w.managerA2, f.lines['2026-10-12']!);
    await approve(w, w.managerA2, f.lines['2026-10-13']!);
    const r3 = await approve(w, w.managerA2, f.lines[D3]!);
    expect(await aggText(sql, (await settlementFull(sql, r3.settlementId)).journal_entry_id!)).toEqual(fixtureText('channel_settlement.foodpanda_week_with_charge'));
  });
});
