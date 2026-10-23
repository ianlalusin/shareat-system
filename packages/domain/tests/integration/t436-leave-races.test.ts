import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-436 cases 5 and 5a (+ SIL balance race) - transitions are race-safe.
 * Two REAL connections (the `transaction` pool hands each concurrent `asOrg` its own), both with an OPEN
 * transaction before either calls the domain function, released together by a barrier. Without the person-row
 * lock and the `WHERE status = 'pending'` row-count check, both pass the count and both approve.
 *
 * API contract: see the header of `t436-leave.test.ts`.
 * RED REASON today: `requestLeave`/`approveLeave`/... are not exported (no leave module, no migration 0205).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(
    `Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`,
  );
}

import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { approveLeave, cancelLeave, loadLeaveRequest, recordLeave, requestLeave, setLeaveCap, silBalance } from '@shareat/domain';

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
const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

/** A latch that opens when `n` parties have arrived. */
function barrier(n: number) {
  let arrived = 0;
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  return () => {
    if (++arrived >= n) open();
    return gate;
  };
}

async function fixture(hint: string) {
  const code = uid(`r436-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid('S')}, 'Store') returning id`;
  const storeId = store!.id;
  const mk = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    return p!.id;
  };
  const adminId = await mk('Admin', 'admin');
  const mgr1 = await mk('Manager 1', 'manager');
  const mgr2 = await mk('Manager 2', 'manager');
  const workerId = await mk('Worker', 'staff');
  const [e] = await sql<{ id: string }[]>`
    insert into employments (org_id, person_id, store_id, staff_code, started_on, employment_status, created_by)
    values (${orgId}, ${workerId}, ${storeId}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, '2025-01-01', 'regular', ${adminId}) returning id`;
  return {
    orgId, storeId, workerId, employmentId: e!.id,
    admin: actor(orgId, adminId), mgr1: actor(orgId, mgr1), mgr2: actor(orgId, mgr2), worker: actor(orgId, workerId),
  };
}
type F = Awaited<ReturnType<typeof fixture>>;

const day = (date: string) => ({ date, kind: 'leave' as const });
const pending = async (f: F, leaveType: string, date: string): Promise<string> =>
  (await asOrg(f.orgId, (tx) =>
    requestLeave(tx, f.worker, { employmentId: f.employmentId, leaveType, days: [day(date)] } as never))).requestId;
const statusOf = async (f: F, requestId: string) =>
  (await asOrg(f.orgId, (tx) => loadLeaveRequest(tx, f.admin, { requestId } as never)) as { status: string }).status;

/** Runs both calls with their transactions open, then releases them at once. */
async function race<A, B>(
  f: F,
  a: (tx: Tx) => Promise<A>,
  b: (tx: Tx) => Promise<B>,
): Promise<[PromiseSettledResult<A>, PromiseSettledResult<B>]> {
  const arrive = barrier(2);
  return (await Promise.allSettled([
    asOrg(f.orgId, async (tx) => { await arrive(); return a(tx); }),
    asOrg(f.orgId, async (tx) => { await arrive(); return b(tx); }),
  ])) as never;
}
const codeOf = (r: PromiseSettledResult<unknown>) => (r.status === 'rejected' ? (r.reason as { code?: string }).code : undefined);

afterAll(async () => {
  await sql.end();
  await closeDb();
});

describe('T-436 case 5 - two approvals for the last cap slot', () => {
  it('exactly one succeeds, the other is refused LEAVE_CAP_MONTHLY (person lock + counts under the lock)', async () => {
    for (let round = 0; round < 3; round++) {
      const f = await fixture(`r5-${round}`);
      await asOrg(f.orgId, (tx) =>
        setLeaveCap(tx, f.admin, { leaveType: 'sick', monthlyCap: 1, yearlyCap: null } as never));
      const r1 = await pending(f, 'sick', '2026-03-02');
      const r2 = await pending(f, 'sick', '2026-03-03');
      const [x, y] = await race(
        f,
        (tx) => approveLeave(tx, f.mgr1, { requestId: r1 } as never),
        (tx) => approveLeave(tx, f.mgr2, { requestId: r2 } as never),
      );
      const outcomes = [x, y];
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      const lost = outcomes.find((o) => o.status === 'rejected')!;
      expect(codeOf(lost)).toBe('LEAVE_CAP_MONTHLY');
      const statuses = [await statusOf(f, r1), await statusOf(f, r2)].sort();
      expect(statuses).toEqual(['approved', 'pending']);
    }
  });

  it('the last SIL day: two approvals on two connections give exactly one SIL_BALANCE_EXHAUSTED', async () => {
    const f = await fixture('r5sil');
    await asOrg(f.orgId, (tx) =>
      recordLeave(tx, f.mgr1, { employmentId: f.employmentId, leaveType: 'sil', days: ['2026-02-02', '2026-02-03', '2026-02-04', '2026-02-05'].map(day) } as never));
    const r1 = await pending(f, 'sil', '2026-03-02');
    const r2 = await pending(f, 'sil', '2026-03-03');
    const [x, y] = await race(
      f,
      (tx) => approveLeave(tx, f.mgr1, { requestId: r1 } as never),
      (tx) => approveLeave(tx, f.mgr2, { requestId: r2 } as never),
    );
    expect([x, y].filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(codeOf([x, y].find((o) => o.status === 'rejected')!)).toBe('SIL_BALANCE_EXHAUSTED');
    const b = await asOrg(f.orgId, (tx) => silBalance(tx, f.admin, { personId: f.workerId, year: 2026 } as never));
    expect(b).toMatchObject({ used: 5, remaining: 0 });
  });
});

describe('T-436 case 5a - approve against cancel of the same pending request', () => {
  it('one wins, the other gets LEAVE_NOT_PENDING, and the final status is the winner\'s', async () => {
    for (let round = 0; round < 5; round++) {
      const f = await fixture(`r5a-${round}`);
      const id = await pending(f, 'sick', '2026-03-02');
      const [a, c] = await race(
        f,
        (tx) => approveLeave(tx, f.mgr1, { requestId: id } as never),
        (tx) => cancelLeave(tx, f.worker, { requestId: id } as never),
      );
      const fulfilled = [a, c].filter((o) => o.status === 'fulfilled');
      expect(fulfilled).toHaveLength(1);
      const lost = a.status === 'rejected' ? a : c;
      expect(codeOf(lost)).toBe('LEAVE_NOT_PENDING');
      const final = await statusOf(f, id);
      expect(final).toBe(a.status === 'fulfilled' ? 'approved' : 'cancelled');
    }
  });

  it('two approvals of the SAME request: one succeeds, one LEAVE_NOT_PENDING, and exactly one approved audit row', async () => {
    const f = await fixture('r5a2');
    const id = await pending(f, 'sick', '2026-03-02');
    const [x, y] = await race(
      f,
      (tx) => approveLeave(tx, f.mgr1, { requestId: id } as never),
      (tx) => approveLeave(tx, f.mgr2, { requestId: id } as never),
    );
    expect([x, y].filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(codeOf([x, y].find((o) => o.status === 'rejected')!)).toBe('LEAVE_NOT_PENDING');
    const rows = await sql`select 1 from audit_log where org_id = ${f.orgId} and entity_id = ${id} and action = 'leave.approved'`;
    expect(rows).toHaveLength(1);
  });
});
