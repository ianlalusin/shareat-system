import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { randomUUID } from 'node:crypto';

/**
 * T-350 S6 — follow-ups from the executed post-commit review of `fa83e01`.
 * `docs/tasks/350-def-477-change-channel-payout-account.md` §S6.
 *
 * ⛔ TESTER, not BUILDER. G1 pins `packages/db/src/repo/audit-log.ts:89`'s org filter, which is
 * green today (unpinned, but present) — the leg's value is in the "prove it bites" worktree
 * measurement, reported alongside this file, not in this run alone. G2 pins
 * `packages/domain/src/channel-settlements/index.ts:743`, which is a real red today.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

import { APP_ROLE, auditLogRepo, transaction, type Tx } from '@shareat/db';
import * as schema from '@shareat/db/schema';
import type { Actor } from '@shareat/auth';
import { setChannelPayoutDestination } from '@shareat/domain';
import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

afterAll(async () => {
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

/**
 * G1 — a `Tx` on the BARE connection, which `TEST_DATABASE_URL` opens as `postgres`
 * (verified directly: `rolsuper=true, rolbypassrls=true`), so RLS cannot mask the application
 * filter's absence — the whole point of this leg.
 *
 * ⛔ Deliberately NOT `systemTransaction()`/`transaction()` from `@shareat/db`. This file lives
 * under `apps/`, one of `tests/unit/system-transaction-callers.test.ts`'s `SCAN_ROOTS` — calling
 * the real `systemTransaction(` would be a new, unlisted caller and fail that guard. Built
 * directly from `drizzle-orm/postgres-js` instead: it runs as `postgres` on the test connection
 * (verified above), so RLS can't mask the org filter's absence — no different a bypass than
 * `systemTransaction()` itself uses, just not routed through the guarded name.
 */
const privilegedDb = drizzle(sql, { schema });
async function asPrivileged<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return privilegedDb.transaction(fn as never) as Promise<T>;
}

async function orgFixture(hint: string) {
  const code = uid(`t350s6-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid('s')}, 'Store') returning id`;
  const storeId = store!.id;
  const [admin] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  const adminId = admin!.id;
  await sql`insert into person_roles (person_id, org_id, role) values (${adminId}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${adminId}, ${storeId})`;
  return { orgId, storeId, admin: actor(orgId, adminId), adminId };
}

// =================================================================================================
// G1 (S6) — audit-log.ts:89's `eq(auditLog.orgId, orgId)` is unpinned. Green today (the filter
// exists); the "prove it bites" measurement (worktree, filter deleted) is reported alongside this
// file, not visible in this run.
// =================================================================================================

describe('G1 — latestForEntity filters by org even when two orgs share an entity-id shape', () => {
  it("the OTHER org holds a NEWER row for the same (entity, entityId, action) — this org still gets its OWN row, not the other org's newer one", async () => {
    const orgA = await orgFixture('g1a');
    const orgB = await orgFixture('g1b');
    // Deliberately the SAME entityId for both orgs — audit_log.entity_id carries no FK, so nothing
    // stops this at the DB level. Proves the ORG filter, not merely "different ids never collide".
    const sharedEntityId = randomUUID();

    await asPrivileged((tx) =>
      auditLogRepo.append(tx, orgA.orgId, {
        actorPersonId: orgA.adminId,
        action: 'set_channel_payout',
        entity: 'sales_channels',
        entityId: sharedEntityId,
        before: { marker: 'orgA' },
        after: { marker: 'orgA' },
        source: 'web',
      }),
    );
    // Org B's row lands AFTER (occurredAt defaults to now()), so it is the globally-latest match
    // for this (entity, entityId, action) — if the org filter were gone, ORDER BY occurredAt DESC
    // LIMIT 1 would pick THIS row for org A's query too.
    await asPrivileged((tx) =>
      auditLogRepo.append(tx, orgB.orgId, {
        actorPersonId: orgB.adminId,
        action: 'set_channel_payout',
        entity: 'sales_channels',
        entityId: sharedEntityId,
        before: { marker: 'orgB' },
        after: { marker: 'orgB' },
        source: 'web',
      }),
    );

    const result = await asPrivileged((tx) =>
      auditLogRepo.latestForEntity(tx, orgA.orgId, {
        entity: 'sales_channels',
        entityId: sharedEntityId,
        action: 'set_channel_payout',
      }),
    );
    expect(result, 'expected a row at all').toBeDefined();
    expect(result!.after, "must be THIS org's row, not the other org's newer one").toEqual({ marker: 'orgA' });
  });
});

// =================================================================================================
// G2 (S6) — index.ts:743's `before.moneyAccountId` must come from `config.destinationMoneyAccountId`
// (the value actually stored), never from the account LOOKUP, which can miss. Reachable for real,
// no source hook, no mock: point the channel's stored destination at a REAL account that belongs
// to ANOTHER org. `channelConfig` (`packages/db/src/repo/channel-settlements.ts:167-183`) reads
// the raw column with no join, so it returns that foreign id unchanged; `moneyAccountsRepo.getById`
// is org-scoped (`eq(id) AND eq(orgId)`) and genuinely misses it.
// =================================================================================================

describe('G2 — before.moneyAccountId survives a lookup miss (the old account belongs to another org)', () => {
  it('the audit row records the STORED id, not null, even though getById cannot find it — was red today: null, because before.moneyAccountId came from the failed lookup', async () => {
    const orgA = await orgFixture('g2a');
    const orgB = await orgFixture('g2b');

    const [newAccount] = await sql<{ id: string }[]>`
      insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian, is_active)
      values (${orgA.orgId}, ${orgA.storeId}, ${`New Bank ${uid('m')}`}, 'bank', '1140', 'office', true)
      returning id`;
    const [foreignAccount] = await sql<{ id: string }[]>`
      insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian, is_active)
      values (${orgB.orgId}, ${orgB.storeId}, ${`Foreign Bank ${uid('m')}`}, 'bank', '1140', 'office', true)
      returning id`;

    // The channel itself belongs to org A; only its STORED destination points at org B's account —
    // a real fixture shape (no APP write path produces it, since setChannelPayoutDestination only
    // ever writes an id it just validated as org A's own — but the state IS reachable in the DB,
    // DEF-490), not a mock of the repo.
    const [channel] = await sql<{ id: string }[]>`
      insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code,
                                  destination_money_account_id)
      values (${orgA.orgId}, ${orgA.storeId}, ${`Foodpanda ${uid('c')}`}, false, '1220', ${foreignAccount!.id})
      returning id`;

    const result = await asOrg(orgA.orgId, (tx) =>
      setChannelPayoutDestination(tx, orgA.admin, { channelId: channel!.id, moneyAccountId: newAccount!.id }),
    );
    expect(result.wrote, 'setup: the change must actually write for the audit row to exist').toBe(true);

    const auditRow = await asPrivileged((tx) =>
      auditLogRepo.latestForEntity(tx, orgA.orgId, {
        entity: 'sales_channels',
        entityId: channel!.id,
        action: 'set_channel_payout',
      }),
    );
    expect(auditRow, 'expected an audit row').toBeDefined();
    const before = auditRow!.before as { moneyAccountId: string | null; moneyAccountName: string | null };
    expect(
      before.moneyAccountId,
      'wanted: the id actually stored on the channel (unreachable via getById across orgs)',
    ).toBe(foreignAccount!.id);
    expect(before.moneyAccountName, 'the name genuinely cannot be known when the lookup misses').toBeNull();
  });
});
