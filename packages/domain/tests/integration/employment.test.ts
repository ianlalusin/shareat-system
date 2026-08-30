import { config } from 'dotenv';
import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-154 — positions and employments. `docs/tasks/154-positions-and-employments.md`.
 *
 * The nine invariants of the spec, one describe block each. ⭐ Several of these exist because v1
 * CANNOT express them — one open employment per store, an end date that agrees with the status,
 * a primary position that cannot disagree with the list — so a test that only checked the happy
 * path would prove nothing about what this task is for.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { APP_ROLE, transaction, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import {
  createEmployment,
  endEmployment,
  listRoster,
  seedCanonicalPositions,
  setEmploymentPositions,
  upsertStorePosition,
} from '@shareat/domain';

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

async function fixture(hint: string) {
  const code = uid(`em-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const [store2] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(`${hint}b`)}, ${`Store ${hint} B`}) returning id`;
  const [admin] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${admin!.id}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${admin!.id}, ${store!.id})`;
  await sql`insert into person_store_scope (person_id, store_id) values (${admin!.id}, ${store2!.id})`;

  const [worker] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Maria Santos') returning id`;

  await asOrg(orgId, (tx) => seedCanonicalPositions(tx, orgId));

  return {
    orgId,
    storeId: store!.id,
    storeBId: store2!.id,
    admin: actor(orgId, admin!.id),
    workerId: worker!.id,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const hire = (f: Fixture, over: Partial<Parameters<typeof createEmployment>[2]> = {}) =>
  asOrg(f.orgId, (tx) =>
    createEmployment(tx, f.admin, {
      storeId: f.storeId,
      personId: f.workerId,
      employmentStatus: 'probationary',
      startedOn: '2026-01-05',
      ...over,
    }),
  );

// -------------------------------------------------------------------------------------

describe('T-154 invariant 1 — at most one OPEN employment per person per store', () => {
  it('a second open employment at the same store is REFUSED', async () => {
    const f = await fixture('one-open');
    await hire(f);
    await expect(hire(f)).rejects.toThrow(/already/i);
  });

  it('...but a re-hire after the first ended is allowed', async () => {
    const f = await fixture('rehire');
    const first = await hire(f);
    await asOrg(f.orgId, (tx) =>
      endEmployment(tx, f.admin, { employmentId: first.id, endedOn: '2026-03-31', employmentStatus: 'resigned' }),
    );
    const second = await hire(f, { startedOn: '2026-06-01' });
    expect(second.id).not.toBe(first.id);
  });
});

describe('T-154 invariant 2 — status and end date always agree', () => {
  it('ending WITHOUT a terminal status is refused', async () => {
    const f = await fixture('end-status');
    const e = await hire(f);
    await expect(
      asOrg(f.orgId, (tx) =>
        endEmployment(tx, f.admin, {
          employmentId: e.id,
          endedOn: '2026-03-31',
          employmentStatus: 'regular' as never,
        }),
      ),
    ).rejects.toThrow();
  });

  it('an end date before the start date is refused', async () => {
    const f = await fixture('end-before');
    const e = await hire(f);
    await expect(
      asOrg(f.orgId, (tx) =>
        endEmployment(tx, f.admin, { employmentId: e.id, endedOn: '2025-12-01', employmentStatus: 'resigned' }),
      ),
    ).rejects.toThrow();
  });

  it('a live employment has no end date, and an ended one has both', async () => {
    const f = await fixture('pair');
    const e = await hire(f);
    expect(e.endedOn).toBeNull();
    const ended = await asOrg(f.orgId, (tx) =>
      endEmployment(tx, f.admin, { employmentId: e.id, endedOn: '2026-04-30', employmentStatus: 'terminated' }),
    );
    expect(ended.endedOn).toBe('2026-04-30');
    expect(ended.employmentStatus).toBe('terminated');
  });
});

describe('T-154 invariant 3 — exactly one primary position', () => {
  it('a hire with no positions gets the least-privileged default, as primary', async () => {
    const f = await fixture('default-pos');
    const e = await hire(f);
    const rows = await sql<{ name: string; is_primary: boolean }[]>`
      select p.name, ep.is_primary from employment_positions ep
      join positions p on p.id = ep.position_id where ep.employment_id = ${e.id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('Server');
    expect(rows[0]!.is_primary).toBe(true);
  });

  it('moving the primary leaves exactly one', async () => {
    const f = await fixture('move-primary');
    const e = await hire(f);
    const pos = await sql<{ id: string; name: string }[]>`
      select id, name from positions where org_id = ${f.orgId} and store_id is null`;
    const cashier = pos.find((p) => p.name === 'Cashier')!;
    const cook = pos.find((p) => p.name === 'Cook')!;

    await asOrg(f.orgId, (tx) =>
      setEmploymentPositions(tx, f.admin, {
        employmentId: e.id,
        positionIds: [cashier.id, cook.id],
        primaryPositionId: cashier.id,
      }),
    );
    await asOrg(f.orgId, (tx) =>
      setEmploymentPositions(tx, f.admin, {
        employmentId: e.id,
        positionIds: [cashier.id, cook.id],
        primaryPositionId: cook.id,
      }),
    );

    const rows = await sql<{ name: string; is_primary: boolean }[]>`
      select p.name, ep.is_primary from employment_positions ep
      join positions p on p.id = ep.position_id where ep.employment_id = ${e.id} order by p.name`;
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.is_primary)).toHaveLength(1);
    expect(rows.find((r) => r.is_primary)!.name).toBe('Cook');
  });

  it('a primary that is not among the assigned positions is refused', async () => {
    const f = await fixture('primary-outside');
    const e = await hire(f);
    const pos = await sql<{ id: string; name: string }[]>`
      select id, name from positions where org_id = ${f.orgId} and store_id is null`;
    const cashier = pos.find((p) => p.name === 'Cashier')!;
    const cook = pos.find((p) => p.name === 'Cook')!;
    await expect(
      asOrg(f.orgId, (tx) =>
        setEmploymentPositions(tx, f.admin, {
          employmentId: e.id,
          positionIds: [cashier.id],
          primaryPositionId: cook.id,
        }),
      ),
    ).rejects.toThrow(/primary/i);
  });
});

describe('T-154 invariant 4 — ending an employment destroys nothing', () => {
  it('the row, its positions and its staff code all survive', async () => {
    const f = await fixture('survive');
    const e = await hire(f);
    await asOrg(f.orgId, (tx) =>
      endEmployment(tx, f.admin, { employmentId: e.id, endedOn: '2026-05-31', employmentStatus: 'resigned' }),
    );
    const [row] = await sql<{ staff_code: string }[]>`select staff_code from employments where id = ${e.id}`;
    expect(row!.staff_code).toBe(e.staffCode);
    const pos = await sql`select 1 from employment_positions where employment_id = ${e.id}`;
    expect(pos.length).toBeGreaterThan(0);
  });
});

describe('T-154 invariant 5 — staffCode is unique per store and allocated without collision', () => {
  it('codes run SE-001, SE-002 in one store', async () => {
    const f = await fixture('codes');
    const first = await hire(f);
    expect(first.staffCode).toBe('SE-001');

    const [p2] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${f.orgId}, 'Jose Rizal') returning id`;
    const second = await hire(f, { personId: p2!.id });
    expect(second.staffCode).toBe('SE-002');
  });

  it('two CONCURRENT hires in one store never collide on a code', async () => {
    const f = await fixture('concurrent');
    const [a] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${f.orgId}, 'A') returning id`;
    const [b] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${f.orgId}, 'B') returning id`;

    // ⭐ Genuinely concurrent — two transactions in flight at once. This is the test that would
    // fail if the allocation were a read-then-write instead of `for update`.
    const [x, y] = await Promise.all([hire(f, { personId: a!.id }), hire(f, { personId: b!.id })]);
    expect(new Set([x.staffCode, y.staffCode]).size).toBe(2);
  });

  it('each store numbers from SE-001 independently', async () => {
    const f = await fixture('per-store');
    const atA = await hire(f);
    const atB = await hire(f, { storeId: f.storeBId });
    expect(atA.staffCode).toBe('SE-001');
    expect(atB.staffCode).toBe('SE-001');
  });
});

describe('T-154 invariant 6 — canonical positions are the org’s, not a store’s', () => {
  it('the six canonical positions seed, and re-seeding changes nothing', async () => {
    const f = await fixture('seed');
    const before = await sql<{ n: string }[]>`
      select count(*)::text as n from positions where org_id = ${f.orgId} and store_id is null`;
    expect(before[0]!.n).toBe('6');
    await asOrg(f.orgId, (tx) => seedCanonicalPositions(tx, f.orgId));
    const after = await sql<{ n: string }[]>`
      select count(*)::text as n from positions where org_id = ${f.orgId} and store_id is null`;
    expect(after[0]!.n).toBe('6');
  });

  it('a store position colliding with a canonical name is refused, case-insensitively', async () => {
    const f = await fixture('collide');
    await expect(
      asOrg(f.orgId, (tx) =>
        upsertStorePosition(tx, f.admin, { storeId: f.storeId, name: '  cashier ' }),
      ),
    ).rejects.toThrow(/canonical/i);
  });

  it('a store may define its own position', async () => {
    const f = await fixture('store-pos');
    const p = await asOrg(f.orgId, (tx) =>
      upsertStorePosition(tx, f.admin, { storeId: f.storeId, name: 'Barista' }),
    );
    expect(p.isCanonical).toBe(false);
    expect(p.storeId).toBe(f.storeId);
  });
});

describe('T-154 invariant 7 — "on the roster" is DERIVED, never a stored boolean', () => {
  it('employments has no is_active column', async () => {
    const cols = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns where table_name = 'employments'`;
    expect(cols.map((c) => c.column_name)).not.toContain('is_active');
  });

  it('the view excludes each inactive shape', async () => {
    const f = await fixture('view');
    const live = await hire(f);
    expect((await asOrg(f.orgId, (tx) => listRoster(tx, { storeId: f.storeId }))).map((r) => r.id)).toContain(live.id);

    await asOrg(f.orgId, (tx) =>
      endEmployment(tx, f.admin, { employmentId: live.id, endedOn: '2026-06-30', employmentStatus: 'resigned' }),
    );
    expect((await asOrg(f.orgId, (tx) => listRoster(tx, { storeId: f.storeId }))).map((r) => r.id)).not.toContain(live.id);
  });

  it('a deactivated PERSON drops off the roster even with a live employment', async () => {
    const f = await fixture('person-inactive');
    const e = await hire(f);
    await sql`update persons set is_active = false where id = ${f.workerId}`;
    expect((await asOrg(f.orgId, (tx) => listRoster(tx, { storeId: f.storeId }))).map((r) => r.id)).not.toContain(e.id);
  });
});

describe('T-154 invariant 8 — one person, two stores, two employments', () => {
  it('the cross-store query finds both, which is what the salary-advance ledger needs', async () => {
    const f = await fixture('cross-store');
    const a = await hire(f);
    const b = await hire(f, { storeId: f.storeBId });
    const rows = await sql<{ id: string }[]>`
      select id from employments where person_id = ${f.workerId} and ended_on is null order by store_id`;
    expect(rows.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
  });
});

describe('T-154 invariant 9 — a person with an employment cannot be deleted', () => {
  it('the delete is refused by the foreign key, not by a service check', async () => {
    const f = await fixture('fk');
    await hire(f);
    await expect(sql`delete from persons where id = ${f.workerId}`).rejects.toThrow(/foreign key|violates/i);
  });
});

describe('T-154 — authorization', () => {
  it('a staff-role person cannot hire', async () => {
    const f = await fixture('authz');
    const [s] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${f.orgId}, 'Floor') returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${s!.id}, ${f.orgId}, 'staff')`;
    await sql`insert into person_store_scope (person_id, store_id) values (${s!.id}, ${f.storeId})`;
    await expect(
      asOrg(f.orgId, (tx) =>
        createEmployment(tx, actor(f.orgId, s!.id), {
          storeId: f.storeId,
          personId: f.workerId,
          employmentStatus: 'regular',
          startedOn: '2026-01-05',
        }),
      ),
    ).rejects.toThrow();
  });
});
