import { config } from 'dotenv';
import { beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-349 S2c (DEF-456), finding 2, item 3 — `docs/tasks/349-def-456-store-scoped-hold-own-right.md`
 * §4c, leg R1.
 *
 * ⛔ TESTER, not BUILDER. `accessRepo.grantsForPerson` (`packages/db/src/repo/access.ts:929-946`)
 * has no `ORDER BY` — a plain sequential scan, whose row order after an `UPDATE` (a new heap tuple
 * version, not necessarily reusing the old slot) is unspecified rather than insertion order. The
 * `/admin/users` page list is built straight from this read, so an admin picker-granting or
 * superseding a row (S2c finding 1) can watch the list reorder itself with every action.
 *
 * ⚠️ Postgres heap order after an UPDATE is a real-engine detail, not a guaranteed reproduction of
 * "moved to the end" — if the unordered read happens to still return t1/t2/t3, this leg is a GREEN
 * guard rather than a red, and P8 (apps/erp/tests/t349-s2c-fold-and-banner.test.ts) is the
 * load-bearing red for finding 2. Report whichever this measures; do not force it either way.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

import { accessRepo, transaction, APP_ROLE, type Tx } from '@shareat/db';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

async function fixture(hint: string) {
  const code = uid(`t349s2c-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [person] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Grant Order Target') returning id`;
  return { orgId, personId: person!.id };
}

describe('R1 — grantsForPerson stays in granted_at/id order across an UPDATE', () => {
  it(
    'ids come back t1, t2, t3 even after the t1 row is rank-upgraded (was red today: no ORDER BY — heap order after UPDATE, guard if the scan still happens to agree)',
    async () => {
      const f = await fixture('r1');
      const t1 = new Date('2026-01-01T00:00:00Z');
      const t2 = new Date('2026-01-02T00:00:00Z');
      const t3 = new Date('2026-01-03T00:00:00Z');

      const [row1] = await sql<{ id: string }[]>`
        insert into person_grants (person_id, grant_name, grant_source, granted_at)
        values (${f.personId}, 'manage_fixed_assets', 'elevation', ${t1}) returning id`;
      const [row2] = await sql<{ id: string }[]>`
        insert into person_grants (person_id, grant_name, grant_source, granted_at)
        values (${f.personId}, 'manage_users', 'grant', ${t2}) returning id`;
      const [row3] = await sql<{ id: string }[]>`
        insert into person_grants (person_id, grant_name, grant_source, granted_at)
        values (${f.personId}, 'run_payroll', 'grant', ${t3}) returning id`;

      // The rank-upgrade UPDATE finding 2's own sibling (finding 1) fixes elsewhere in S2c — here
      // it is just the mechanism that moves t1's row to a new heap tuple version.
      await sql`update person_grants set grant_source = 'grant' where id = ${row1!.id}`;

      const rows = await asOrg(f.orgId, (tx) => accessRepo.grantsForPerson(tx, f.personId));
      const ids = rows.map((r) => r.id);
      expect(ids, 'wanted: stable granted_at order regardless of UPDATE-induced heap reordering').toEqual([
        row1!.id,
        row2!.id,
        row3!.id,
      ]);
    },
  );
});
