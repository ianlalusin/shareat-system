import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

/**
 * T-350 S3 (bible §13 row 238, DEF-169) — `audit_log` gains `org_id`, RLS policies, and an
 * append-only trigger. `docs/tasks/350-def-477-change-channel-payout-account.md` §S3, legs
 * L1-L7 (M1/M6 amendments fold in).
 *
 * ⛔ TESTER, not BUILDER. `audit_log` has no `org_id` column today (migration 0167 does not exist
 * yet) — every leg that seeds a row with one hits a REAL Postgres `42703` (column does not exist).
 * That is the shared root cause of every red below, not a bug in this file.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

import { APP_ROLE } from '../../src/rls/registry';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

/** One transaction as the restricted app role, principalled to `org` (or unprincipalled if null). */
async function asOrg<T>(org: string | null, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return (await sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${APP_ROLE}`);
    if (org !== null) await tx`select set_config('app.org_id', ${org}, true)`;
    return (await fn(tx)) as never;
  })) as T;
}

async function orgAndPerson(hint: string) {
  const code = uid(`t350s3-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [person] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Actor') returning id`;
  return { orgId, personId: person!.id };
}

/** Inserts one row with the TARGET shape (owner connection, bypasses RLS) — the `org_id` column
 *  does not exist yet, so this throws 42703 today for every caller. */
async function seedRow(orgId: string, personId: string) {
  const [row] = await sql<{ id: string }[]>`
    insert into audit_log (org_id, actor_person_id, action, entity, entity_id, before, after, source, category, sensitivity, severity, retention_class)
    values (${orgId}, ${personId}, 'set_channel_payout', 'sales_channels', ${randomUUID()}, ${sql.json({ moneyAccountId: null })}, ${sql.json({ moneyAccountId: 'x' })}, 'web', 'settings', 'normal', 5, 'r10y')
    returning id`;
  return row!.id;
}

async function caught<T>(p: Promise<T>): Promise<(Error & { code?: string }) | undefined> {
  try {
    await p;
  } catch (err) {
    return err as Error & { code?: string };
  }
  return undefined;
}

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe('L1 — org A\'s principal reads its own audit row', () => {
  it('count 1 — was red today: 42703, no org_id column (system_only otherwise reads 0 regardless)', async () => {
    const a = await orgAndPerson('l1');
    const err = await caught(seedRow(a.orgId, a.personId));
    if (err) {
      expect(err.code, `wanted the row to seed; got: ${err.message}`).toBeUndefined();
      return;
    }
    const rows = await asOrg(a.orgId, (tx) => tx`select id from audit_log where org_id = ${a.orgId}`);
    expect(rows.length, 'wanted: 1 — was red: system_only reads 0 for every tenant').toBe(1);
  });
});

describe('L2 (M1) — org B\'s principal reads 0 of org A\'s rows', () => {
  it('the leak guard, once the column exists — was red today (M1): the seed itself throws 42703, before RLS ever runs', async () => {
    const a = await orgAndPerson('l2a');
    const b = await orgAndPerson('l2b');
    await seedRow(a.orgId, a.personId);
    const rows = await asOrg(b.orgId, (tx) => tx`select id from audit_log where org_id = ${a.orgId}`);
    expect(rows.length).toBe(0);
  });
});

describe('L3 (M1) — org A inserting a row naming org B\'s org_id: 42501 (WITH CHECK)', () => {
  it('assert by SQLSTATE, paired with L1 — was red today: refused for the wrong reason (no org_id column at all, 42703)', async () => {
    const a = await orgAndPerson('l3a');
    const b = await orgAndPerson('l3b');
    const err = await caught(
      asOrg(a.orgId, (tx) => tx`
        insert into audit_log (org_id, actor_person_id, action, entity, entity_id, before, after, source, category, sensitivity, severity, retention_class)
        values (${b.orgId}, ${a.personId}, 'set_channel_payout', 'sales_channels', ${randomUUID()}, null, null, 'web', 'settings', 'normal', 5, 'r10y')`),
    );
    expect(err, 'expected a refusal at all').toBeInstanceOf(Error);
    expect(err?.code, "wanted 42501 (WITH CHECK) after 0167 — was red today: 42703 (no org_id column), the wrong reason").toBe('42501');
  });
});

describe('L4 (T-354) — the app-role privilege revoke: app role UPDATE/DELETE rejected 42501; owner UPDATE/DELETE refused by the trigger', () => {
  it('app role gets insufficient_privilege (42501), row unchanged; owner gets restrict_violation (23001) — was red today: the app role had no UPDATE/DELETE policy, so it silently affected 0 rows instead of being rejected outright', async () => {
    const a = await orgAndPerson('l4');
    const id = await seedRow(a.orgId, a.personId);
    const before = await sql<{ action: string }[]>`select action from audit_log where id = ${id}`;

    const appUpdateErr = await caught(asOrg(a.orgId, (tx) => tx`update audit_log set action = 'tampered' where id = ${id}`));
    expect(appUpdateErr, 'wanted: insufficient_privilege — was red: the app role had no UPDATE policy, so the statement just ran and affected 0 rows').toBeInstanceOf(Error);
    expect(appUpdateErr?.code).toBe('42501');
    const after = await sql<{ action: string }[]>`select action from audit_log where id = ${id}`;
    expect(after[0]?.action).toBe(before[0]?.action);

    const appDeleteErr = await caught(asOrg(a.orgId, (tx) => tx`delete from audit_log where id = ${id}`));
    expect(appDeleteErr, 'wanted: insufficient_privilege — was red: the app role had no DELETE policy, so the statement just ran and affected 0 rows').toBeInstanceOf(Error);
    expect(appDeleteErr?.code).toBe('42501');

    const ownerErr = await caught(sql`update audit_log set action = 'tampered' where id = ${id}`);
    expect(ownerErr, 'wanted: restrict_violation — was red: no trigger, the owner update just succeeds').toBeInstanceOf(Error);
    expect(ownerErr?.code).toBe('23001');

    const deleteErr = await caught(sql`delete from audit_log where id = ${id}`);
    expect(deleteErr?.code).toBe('23001');
  });
});

describe('L7 (M6) — an insert naming another org\'s person as actor: 42501', () => {
  it('cross-org actor impersonation is refused by the WITH CHECK — was red today: 42703, no org_id column', async () => {
    const a = await orgAndPerson('l7a');
    const b = await orgAndPerson('l7b');
    const err = await caught(
      asOrg(a.orgId, (tx) => tx`
        insert into audit_log (org_id, actor_person_id, action, entity, entity_id, before, after, source, category, sensitivity, severity, retention_class)
        values (${a.orgId}, ${b.personId}, 'set_channel_payout', 'sales_channels', ${randomUUID()}, null, null, 'web', 'settings', 'normal', 5, 'r10y')`),
    );
    expect(err, 'expected a refusal at all').toBeInstanceOf(Error);
    expect(err?.code, 'wanted 42501 (actor must belong to the same org) — was red today: 42703').toBe('42501');
  });
});

describe('L6 (M2, guard) — the cutover purge TRUNCATE passes the append-only trigger', () => {
  it(
    'a row seeded as owner is gone after a TRUNCATE — row triggers do not fire on TRUNCATE, before or after the trigger exists (purge.ts:355)',
    async () => {
      const a = await orgAndPerson('l6');
      // ⚠️ 0167 landed and made org_id NOT NULL, so the seed carries a real one from the fixture —
      // this leg's own claim (TRUNCATE bypasses row triggers) is about the TRUNCATE, not the
      // column gap L1-L3/L7 already prove, and stays true whether the trigger exists yet or not.
      const [row] = await sql<{ id: string }[]>`
        insert into audit_log (org_id, actor_person_id, action, entity, entity_id, before, after, source, category, sensitivity, severity, retention_class)
        values (${a.orgId}, ${a.personId}, 'set_channel_payout', 'sales_channels', ${randomUUID()}, null, null, 'web', 'settings', 'normal', 5, 'r10y')
        returning id`;
      const id = row!.id;
      const before = await sql<{ id: string }[]>`select id from audit_log where id = ${id}`;
      expect(before.length, 'setup: the row is there before the purge').toBe(1);

      await sql.begin(async (tx) => {
        await tx`truncate table audit_log cascade`;
      });

      const after = await sql<{ id: string }[]>`select id from audit_log where id = ${id}`;
      expect(after.length, 'gone after TRUNCATE, trigger or not').toBe(0);
    },
  );
});
