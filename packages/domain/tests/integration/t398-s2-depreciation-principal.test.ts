import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-398 S2b T4 - `runDepreciation(null, ...)` over two assets runs under the org principal and succeeds.
 * `docs/tasks/398-padre-garcia-franchise-org.md` S2 T4, D5 ("T4 is a regression guard, already green").
 * Mutant killed: `withOrgPrincipal` replaced by a bare `transaction` in runDepreciation / runDepreciationCore ->
 * the staff-principal authorize() sees no role (DEF-417 / DEF-287) or the per-asset reads see zero rows, so `posted` is not 2.
 * Fresh org + ids per run; never truncates; works on any `_test` database.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { type Actor } from '@shareat/auth';
import { createAsset, runDepreciation } from '@shareat/domain';

const sql = postgres(url, { max: 3 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}-${Math.floor(Math.random() * 1e6)}`;

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

describe('T-398 S2b T4: runDepreciation(null) opens org-scoped transactions', () => {
  it('posts both assets of the actor org under the app role, each entry visible only through that org', async () => {
    const code = uid('s2b-dep');
    const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
    const orgId = org!.id;
    await seedChartOfAccounts(sql, orgId);
    for (let m = 1; m <= 12; m++) {
      const mm = String(m).padStart(2, '0');
      const last = new Date(Date.UTC(2026, m, 0)).getUTCDate();
      await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, ${`2026-${mm}-01`}, ${`2026-${mm}-${last}`}, 'open')`;
    }
    const [store] = await sql<{ id: string }[]>`
      insert into stores (org_id, code, name, opening_date) values (${orgId}, ${uid('st')}, 'Store s2b', '2020-01-01') returning id`;
    const storeId = store!.id;
    const [person] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'S2b Admin') returning id`;
    const adminId = person!.id;
    await sql`insert into person_roles (person_id, org_id, role) values (${adminId}, ${orgId}, 'admin')`;
    await sql`insert into person_store_scope (person_id, store_id) values (${adminId}, ${storeId})`;
    const actor: Actor = { personId: adminId, orgId };

    const ids: string[] = [];
    for (const name of ['Freezer A', 'Freezer B']) {
      const { id } = await asOrg(orgId, (tx) =>
        createAsset(tx, actor, {
          storeId, name, category: 'appliances', acquiredOn: '2026-01-15', cost: '120000.00', usefulLifeMonths: 24,
        } as Parameters<typeof createAsset>[2]),
      );
      ids.push(id);
    }

    // The call under test: tx === null, so runDepreciation must open its OWN org-principal transactions.
    const result = await runDepreciation(null, actor, { through: '2026-01' });

    expect(result.failed).toEqual([]);
    expect(result.posted.map((p) => p.assetId).sort()).toEqual([...ids].sort());

    // Visible under RLS as this org, invisible as another (so the rows carry the actor's org_id).
    const countAs = (o: string) =>
      asOrg(o, async (tx) => {
        const r = await tx.execute(
          dsql`select count(*)::int as n from journal_entries where source_type = 'depreciation' and source_id in (${dsql.join(ids.map((i) => dsql`${i}`), dsql`, `)})`,
        );
        return ((r as unknown as { n: number }[])[0] ?? { n: -1 }).n;
      });
    expect(await countAs(orgId)).toBe(2);
    const [other] = await sql<{ id: string }[]>`insert into organizations (name, code) values ('Other', ${uid('oth')}) returning id`;
    expect(await countAs(other!.id)).toBe(0);
  }, 60_000);
});
