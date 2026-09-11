/**
 * T-267 — `systemIsAlreadySetUp` (`src/app/setup/lib.ts:27`) must see every organisation, not just
 * one a principal has been declared for. There is no principal to declare: the whole point of this
 * read is answering *"has this system been set up at all?"* before any organisation, person, or
 * session exists.
 *
 * ⭐ `organizations` is RLS-scoped `self` (`packages/db/src/rls/registry.ts`) — a principal sees its
 * own organisation row and no other. With no principal, `app_current_org()` is NULL and the policy
 * matches nothing, so a bare `transaction()` here reads **zero** organisations regardless of how
 * many exist — reporting "not set up" on a live system. That is exactly DEF-288/bible row 194's
 * shape, and it is what this test would have caught before T-267 routed the read through
 * `systemTransaction()`.
 *
 * `apps/erp/tests/setup-failure-redirect.test.ts` was considered as a home for this and rejected:
 * it is a `unit`-project file testing the pure `setupFailureRedirect` function, deliberately without
 * Postgres. `systemIsAlreadySetUp` needs a real database and the restricted-role harness, so it
 * belongs here, in `apps/erp/tests/integration/` (the glob T-247/DEF-221 added for exactly this).
 */
import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { closeDb } from '@shareat/db';

const sql = postgres(url, { max: 5 });

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

/** ⚠️ Every case starts from a genuinely empty database — "zero organizations" is the fact the
 *  first test turns on, and per-test (not per-file) truncation keeps both tests order-independent
 *  rather than relying on declaration order. Same table list as `organizations.test.ts` and
 *  `email-sign-in.test.ts`. */
beforeEach(async () => {
  await sql`
    truncate table sessions, person_credentials, person_store_scope, person_grants, person_roles,
      stock_locations, location_types, sales_channels, stores, persons,
      expense_categories, accounts, organizations
      restart identity cascade`;
});

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('systemIsAlreadySetUp — the first-run bootstrap read sees every organisation, with no principal', () => {
  it('reports NOT set up when zero organisations exist', async () => {
    const { systemIsAlreadySetUp } = await import('../../src/app/setup/lib');
    expect(await systemIsAlreadySetUp()).toBe(false);
  });

  it('⭐ reports set up once an organisation exists — the read that a bare transaction() cannot make (bible row 194)', async () => {
    // Seeded on the raw owner connection, exactly as `bootstrapOrganization` would have written it
    // — this test is not exercising the write path, only whether the read can see the result.
    const code = uid('t267-setup');
    await sql`insert into organizations (name, code) values (${`Org ${code}`}, ${code})`;

    const { systemIsAlreadySetUp } = await import('../../src/app/setup/lib');
    expect(await systemIsAlreadySetUp()).toBe(true);
  });
});
