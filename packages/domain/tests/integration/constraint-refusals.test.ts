import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-252 — DEF-246, bible §13 row 189. docs/tasks/252-def-246-constraint-message-fallback.md §5/§8.
 *
 * ⛔ The durability case is the one that matters, same as T-245's own guard: this suite is run
 * once against a deliberately-naive same-tx mechanism to capture RED (zero rows, not an error —
 * the whole point), then again after the fix to confirm GREEN. Both outputs go in READY.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(
    `Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`,
  );
}

import { APP_ROLE, transaction, type Tx } from '@shareat/db';
import { recordConstraintRefusal } from '@shareat/domain';

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
  const code = uid(`cr-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const [person] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Actor') returning id`;
  return { orgId, storeId: store!.id, personId: person!.id };
}

afterAll(async () => {
  await sql.end();
});

describe('T-252 — constraint refusals are durably recorded', () => {
  it('⛔ DURABILITY: a refusal recorded before a throw survives the caller transaction rolling back', async () => {
    const f = await fixture('durability');

    // Same shape every real call site will have: the recording happens INSIDE a transaction that
    // then rolls back for a reason unrelated to the recording itself (here, deliberately, to
    // prove durability) — the row must survive that rollback regardless.
    await expect(
      asOrg(f.orgId, async (tx) => {
        await recordConstraintRefusal({
          orgId: f.orgId,
          storeId: f.storeId,
          actorPersonId: f.personId,
          constraintName: 'cash_requests_amount_positive_check',
        });
        throw new Error('simulated caller failure — the transaction this recording happened in aborts');
      }),
    ).rejects.toThrow('simulated caller failure');

    // Read in a BRAND NEW transaction, opened after the throwing one has fully rejected.
    const rows = await sql`
      select reason_code, domain, actor_person_id from prerequisite_refusals
      where org_id = ${f.orgId} and reason_code = 'cash_requests_amount_positive_check'
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]!.domain).toBe('constraint');
    expect(rows[0]!.actor_person_id).toBe(f.personId);
  });

  it('two different constraint names are recorded as independently-queryable buckets', async () => {
    const f = await fixture('buckets');
    await recordConstraintRefusal({
      orgId: f.orgId,
      storeId: f.storeId,
      actorPersonId: f.personId,
      constraintName: 'loans_principal_positive_check',
    });
    await recordConstraintRefusal({
      orgId: f.orgId,
      storeId: f.storeId,
      actorPersonId: f.personId,
      constraintName: 'loans_principal_positive_check',
    });
    await recordConstraintRefusal({
      orgId: f.orgId,
      storeId: f.storeId,
      actorPersonId: f.personId,
      constraintName: 'ap_payments_amount_positive_check',
    });

    const rows = await sql<{ reason_code: string; count: number }[]>`
      select reason_code, count(*)::int as count from prerequisite_refusals
      where org_id = ${f.orgId} and domain = 'constraint'
      group by reason_code order by reason_code
    `;
    expect(rows).toEqual([
      { reason_code: 'ap_payments_amount_positive_check', count: 1 },
      { reason_code: 'loans_principal_positive_check', count: 2 },
    ]);
  });

  it('a recording failure is swallowed, never thrown', async () => {
    // A bogus orgId that cannot satisfy the FK — recordConstraintRefusal must not reject.
    await expect(
      recordConstraintRefusal({
        orgId: '00000000-0000-0000-0000-000000000000',
        storeId: null,
        actorPersonId: null,
        constraintName: 'does_not_matter_check',
      }),
    ).resolves.toBeUndefined();
  });
});

/**
 * ⛔ MANUAL RLS PROBE REQUIRED (DEF-218 — no automated test can prove this; the integration
 * harness connects as a superuser that bypasses RLS entirely). See READY for the two verbatim
 * outputs: connect as `shareat_app` on port 5435 with no `app.org_id` set (must be refused) and
 * with it set to a real org (must succeed, and a different org's `app.org_id` must not see the
 * row) — T-245 §6's exact method, reused rather than re-derived.
 */
