import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-380 S2-R1 - the store opening-date confirm names at most 10 assets, and its totals are for ALL of them.
 * docs/tasks/380-no-typed-values-in-urls.md (S2-R1); `describeStoreReversal` / `CONFIRM_NAMED_ASSETS` in
 * packages/domain/src/fixed-assets/in-service.ts, used by `setStoreOpeningDate`.
 *
 * 12 followers, created in reverse name order with different costs (so a total over the named 10 differs
 * from the total over all 12, and creation order differs from name order). Each posts Feb-Apr (3 entries).
 *
 * Mutants this kills:
 *  - count only the named 10 -> "In all: 30 entries" instead of 36 (and the reversal count check goes red);
 *  - total over the named 10 -> the peso total differs from the sum of what confirm actually reverses;
 *  - no sort (repo order is created_at DESC = K..A, not name order) -> the named list is wrong;
 *  - sort without the entry-id tiebreak -> the other "Unit J" (6,000.00) is named.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, withOrgPrincipal } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { createAsset, runDepreciationAsSystem, setStoreOpeningDate, CONFIRM_NAMED_ASSETS } from '@shareat/domain';

const sql = postgres(url, { max: 5 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const peso = (n: number) => `\u20b1${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

describe('S2-R1 - 12 affected assets: names the first 10, counts and totals all 12', () => {
  it('sentence = first 10 by name, "and 2 more", entries and total equal what the confirm then reverses', async () => {
    const code = `t380s2r1-${Date.now()}`;
    const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
    const orgId = org!.id;
    await seedChartOfAccounts(sql, orgId);
    const [store] = await sql<{ id: string }[]>`
      insert into stores (org_id, code, name, opening_date) values (${orgId}, ${`s-${Date.now()}`}, 'Store', '2026-02-01') returning id`;
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, 'admin')`;
    const admin: Actor = { personId: p!.id, orgId };
    for (let m = 1; m <= 7; m++) {
      const end = new Date(Date.UTC(2026, m, 0)).toISOString().slice(0, 10);
      await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, ${`2026-${String(m).padStart(2, '0')}-01`}, ${end}, 'open')`;
    }

    // `listAssets` orders by created_at DESC (db repo fixed-assets.ts:301), so arrival order is the REVERSE of
    // creation order. Creation is A..K (arrives K..A), which is NOT name order, so a missing sort is visible.
    // Two assets are both named "Unit J" and sit on the 10th/11th boundary: only the entry-id tiebreak decides
    // which is named. dupX is created FIRST and depreciated FIRST (smaller entry ids, though it arrives LAST in
    // repo order); dupY is created later. Tiebreak -> dupX is named; "no tiebreak" -> arrival order -> dupY.
    const make = async (name: string, cost: string) =>
      (
        await withOrgPrincipal(orgId, (tx) =>
          createAsset(tx, admin, {
            storeId: store!.id,
            name,
            category: 'equipment',
            acquiredOn: '2026-01-01',
            cost,
            salvageValue: '0',
            usefulLifeMonths: 12,
            interval: 'monthly',
          } as Parameters<typeof createAsset>[2]),
        )
      ).id;
    const dupX = await make('Unit J', '12000.00'); // 1,000.00 / month
    await runDepreciationAsSystem(orgId, { through: '2026-04' });
    const distinct = 'ABCDEFGHIK'.split('');
    for (const [i, l] of distinct.entries()) await make(`Unit ${l}`, `${13200 + i * 1200}.00`);
    const dupY = await make('Unit J', '24000.00'); // 2,000.00 / month
    await runDepreciationAsSystem(orgId, { through: '2026-04' }); // Feb, Mar, Apr each; dupX is idempotent
    const letters = [...distinct, 'J', 'J'];
    const nameOf = (l: string) => `Unit ${l}`;
    const firstEntry = async (assetId: string) =>
      (await sql<{ id: string }[]>`select id from journal_entries where org_id = ${orgId} and idempotency_key = ${`asset:${assetId}:depreciation:2026-02`}`)[0]!.id;
    const [idX, idY] = [await firstEntry(dupX), await firstEntry(dupY)];
    expect(idX.localeCompare(idY), 'fixture: dupX must sort first by entry id').toBeLessThan(0);

    const posted = await sql<{ debit: string }[]>`
      select jl.debit::text as debit from journal_lines jl
      join journal_entries je on je.id = jl.entry_id join accounts a on a.id = jl.account_id
      where je.org_id = ${orgId} and je.source_type = 'depreciation' and a.code = '6700' and jl.debit > 0`.catch(() => []);
    // Source type name is not assumed: fall back to every depreciation key.
    const rows = posted.length
      ? posted
      : await sql<{ debit: string }[]>`
          select jl.debit::text as debit from journal_lines jl
          join journal_entries je on je.id = jl.entry_id join accounts a on a.id = jl.account_id
          where je.org_id = ${orgId} and je.idempotency_key like 'asset:%:depreciation:%' and a.code = '6700' and jl.debit > 0`;
    expect(rows).toHaveLength(36);
    const totalCents = rows.reduce((s, r) => s + Math.round(Number(r.debit) * 100), 0);

    const ask = async (confirmedPlan?: string) =>
      withOrgPrincipal(orgId, (tx) =>
        setStoreOpeningDate(tx, admin, store!.id, { openingDate: '2026-07-01', ...(confirmedPlan ? { confirmedPlan } : {}) } as never),
      );
    const refusal = async () => {
      try {
        await ask();
      } catch (e) {
        return e as Error & { planToken?: string };
      }
      throw new Error('expected a confirm refusal');
    };
    const r1 = await refusal();
    const r2 = await refusal();
    expect(r2.message, 'the sentence is stable across calls').toBe(r1.message);
    expect(r1.planToken).toMatch(/^[0-9a-f]{16}$/);

    // Named: exactly the first 10 by name, in name order (not repo/arrival order), the tiebreak picking dupX.
    expect(CONFIRM_NAMED_ASSETS).toBe(10);
    const named = [...r1.message.matchAll(/(Unit [A-Z]) — 3 depreciation entries/g)].map((m) => m[1]);
    expect(named).toEqual(['Unit A', 'Unit B', 'Unit C', 'Unit D', 'Unit E', 'Unit F', 'Unit G', 'Unit H', 'Unit I', 'Unit J']);
    expect(r1.message).toContain('12 asset(s)');
    expect(r1.message).toContain('and 2 more asset(s).');
    expect(r1.message).not.toContain('Unit K');
    // The named "Unit J" is dupX (1,000.00 x 3 = 3,000.00), not dupY (6,000.00): the entry-id tiebreak decided.
    expect(r1.message).toMatch(/Unit J — 3 depreciation entries \(2026-02–2026-04\), ₱3,000\.00/);
    expect(r1.message).not.toMatch(/Unit J — 3 depreciation entries \(2026-02–2026-04\), ₱6,000\.00/);
    void letters;

    // "In all" covers EVERY entry, not the named 10.
    expect(r1.message).toContain(`In all: 36 depreciation entries, ${peso(totalCents / 100)}`);

    // And it is exactly what the confirm then reverses.
    await ask(r1.planToken);
    const reversed = await sql<{ amount: string }[]>`
      select jl.debit::text as amount from journal_entries rev
      join journal_entries orig on orig.id = rev.reversal_of_entry_id
      join journal_lines jl on jl.entry_id = orig.id
      join accounts a on a.id = jl.account_id
      where rev.org_id = ${orgId} and a.code = '6700' and jl.debit > 0`;
    expect(reversed).toHaveLength(36);
    expect(reversed.reduce((s, r) => s + Math.round(Number(r.amount) * 100), 0)).toBe(totalCents);
  }, 120_000);
});
