import { config } from 'dotenv';
import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * DEF-664 - re-adding a RETIRED store position must re-activate that same row (audited), not
 * silently return the hidden row. An active existing one stays a no-op; canonical names still
 * refuse; a retired position at another store is never touched.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - name must contain "_test".`);
}

import { APP_ROLE, transaction, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import {
  createEmployment,
  listPositions,
  retireStorePosition,
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

async function fixture(hint: string) {
  const code = uid(`d664-${hint}`);
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
  const actor: Actor = { personId: admin!.id, orgId };
  return { orgId, storeId: store!.id, storeBId: store2!.id, admin: actor, workerId: worker!.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const upsert = (f: Fixture, storeId: string, name: string) =>
  asOrg(f.orgId, (tx) => upsertStorePosition(tx, f.admin, { storeId, name }));

const auditCount = async (f: Fixture, positionId: string) => {
  const [r] = await sql<{ n: string }[]>`
    select count(*)::text as n from audit_log where org_id = ${f.orgId} and entity_id = ${positionId}`;
  return Number(r!.n);
};

const isActive = async (id: string) => {
  const [r] = await sql<{ is_active: boolean }[]>`select is_active from positions where id = ${id}`;
  return r!.is_active;
};

describe('DEF-664 - re-adding a retired store position', () => {
  it('1: re-activates the SAME row (case-insensitive), audited, listed and assignable', async () => {
    const f = await fixture('react');
    const created = await upsert(f, f.storeId, 'Greeter');
    await asOrg(f.orgId, (tx) => retireStorePosition(tx, f.admin, { positionId: created.id }));
    expect(await isActive(created.id)).toBe(false);
    expect((await asOrg(f.orgId, (tx) => listPositions(tx, f.admin, { storeId: f.storeId }))).map((p) => p.id)).not.toContain(created.id);

    const auditBefore = await auditCount(f, created.id);
    const again = await upsert(f, f.storeId, '  GREETER ');

    expect(again.id).toBe(created.id);
    expect(await isActive(created.id)).toBe(true);
    expect((await asOrg(f.orgId, (tx) => listPositions(tx, f.admin, { storeId: f.storeId }))).map((p) => p.id)).toContain(created.id);
    const n = await sql<{ n: string }[]>`
      select count(*)::text as n from positions where org_id = ${f.orgId} and store_id = ${f.storeId} and lower(name) = 'greeter'`;
    expect(n[0]!.n).toBe('1');
    expect(await auditCount(f, created.id)).toBe(auditBefore + 1);

    // assignable to staff via the same function the /staff page uses
    const emp = await asOrg(f.orgId, (tx) =>
      createEmployment(tx, f.admin, {
        storeId: f.storeId,
        personId: f.workerId,
        employmentStatus: 'probationary',
        startedOn: '2026-01-05',
      }),
    );
    await asOrg(f.orgId, (tx) =>
      setEmploymentPositions(tx, f.admin, {
        employmentId: emp.id,
        positionIds: [created.id],
        primaryPositionId: created.id,
      }),
    );
    const held = await sql`select 1 from employment_positions where employment_id = ${emp.id} and position_id = ${created.id}`;
    expect(held).toHaveLength(1);
  });

  it('2: an ACTIVE existing position is a no-op (same id, no new row, no audit)', async () => {
    const f = await fixture('active');
    const created = await upsert(f, f.storeId, 'Barista');
    const auditBefore = await auditCount(f, created.id);
    const again = await upsert(f, f.storeId, 'barista');
    expect(again.id).toBe(created.id);
    expect(await isActive(created.id)).toBe(true);
    const n = await sql<{ n: string }[]>`
      select count(*)::text as n from positions where org_id = ${f.orgId} and store_id = ${f.storeId} and lower(name) = 'barista'`;
    expect(n[0]!.n).toBe('1');
    expect(await auditCount(f, created.id)).toBe(auditBefore);
  });

  it('3: a canonical name still refuses', async () => {
    const f = await fixture('canon');
    await expect(upsert(f, f.storeId, 'cashier')).rejects.toThrow(/canonical/i);
  });

  it('4: a retired position at ANOTHER store with the same name is not touched', async () => {
    const f = await fixture('other');
    const atB = await upsert(f, f.storeBId, 'Greeter');
    await asOrg(f.orgId, (tx) => retireStorePosition(tx, f.admin, { positionId: atB.id }));
    const auditBefore = await auditCount(f, atB.id);

    const atA = await upsert(f, f.storeId, 'Greeter');

    expect(atA.id).not.toBe(atB.id);
    expect(atA.storeId).toBe(f.storeId);
    expect(await isActive(atA.id)).toBe(true);
    expect(await isActive(atB.id)).toBe(false);
    expect(await auditCount(f, atB.id)).toBe(auditBefore);
  });
});
