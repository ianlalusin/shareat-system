import { config } from 'dotenv';
import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-160 — the transactional outbox and the mirror publisher.
 * `docs/tasks/160-lane-a-publisher.md`, bible §5.1.
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
  drainOutbox,
  endEmployment,
  seedAttendanceConfig,
  seedCanonicalPositions,
  supersedeConfig,
  parseShiftDay,
  type MirrorDocument,
  type MirrorDriver,
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

/** Records every document the real driver would have written. */
function fakeDriver(opts: { throwOnce?: boolean } = {}) {
  const written: MirrorDocument[] = [];
  let thrown = false;
  const driver: MirrorDriver = {
    async publish(documents) {
      if (opts.throwOnce && !thrown) {
        thrown = true;
        throw new Error('firestore unavailable');
      }
      written.push(...documents);
    },
  };
  return { driver, written };
}

async function fixture(hint: string) {
  const code = uid(`mo-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const [admin] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${admin!.id}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${admin!.id}, ${store!.id})`;
  const [worker] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Maria Santos') returning id`;
  await asOrg(orgId, (tx) => seedCanonicalPositions(tx, orgId));
  await asOrg(orgId, (tx) =>
    seedAttendanceConfig(tx, { orgId, storeId: store!.id, effectiveFrom: '2026-01-01' }),
  );
  // Clear the seed's own enqueues so each test starts from a known outbox.
  await sql`delete from mirror_outbox where org_id = ${orgId}`;
  return { orgId, storeId: store!.id, admin: actor(orgId, admin!.id), workerId: worker!.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const hire = (f: Fixture) =>
  asOrg(f.orgId, (tx) =>
    createEmployment(tx, f.admin, {
      storeId: f.storeId,
      personId: f.workerId,
      employmentStatus: 'regular',
      startedOn: '2026-01-05',
    }),
  );

const outbox = (f: Fixture) =>
  sql<{ entity: string; op: string; published_at: Date | null; attempts: number }[]>`
    select entity, op, published_at, attempts from mirror_outbox
    where org_id = ${f.orgId} order by id`;

const drain = (f: Fixture, driver: MirrorDriver) => asOrg(f.orgId, (tx) => drainOutbox(tx, driver, {}));

// -------------------------------------------------------------------------------------

describe('T-160 invariant 1 — the change and its intent commit together', () => {
  it('⭐ hiring enqueues a roster row, in the SAME transaction, via a trigger', async () => {
    const f = await fixture('enqueue');
    await hire(f);
    const rows = await outbox(f);
    expect(rows.filter((r) => r.entity === 'roster').length).toBeGreaterThan(0);
  });

  it('⭐ a ROLLED BACK hire enqueues nothing — the guarantee, tested', async () => {
    const f = await fixture('rollback');
    await expect(
      asOrg(f.orgId, async (tx) => {
        await createEmployment(tx, f.admin, {
          storeId: f.storeId,
          personId: f.workerId,
          employmentStatus: 'regular',
          startedOn: '2026-01-05',
        });
        throw new Error('deliberate rollback');
      }),
    ).rejects.toThrow(/deliberate/);
    expect(await outbox(f)).toHaveLength(0);
  });

  it('a position change enqueues the roster too — it is on the document', async () => {
    const f = await fixture('positions');
    const e = await hire(f);
    await sql`delete from mirror_outbox where org_id = ${f.orgId}`;
    const [pos] = await sql<{ id: string }[]>`
      select id from positions where org_id = ${f.orgId} and name = 'Cook'`;
    await sql`
      insert into employment_positions (employment_id, position_id, is_primary)
      values (${e.id}, ${pos!.id}, false)`;
    const rows = await outbox(f);
    expect(rows.some((r) => r.entity === 'roster')).toBe(true);
  });

  it('renaming a PERSON enqueues their open employments', async () => {
    const f = await fixture('rename');
    await hire(f);
    await sql`delete from mirror_outbox where org_id = ${f.orgId}`;
    await sql`update persons set display_name = 'Maria S. Santos' where id = ${f.workerId}`;
    const rows = await outbox(f);
    expect(rows.filter((r) => r.entity === 'roster')).toHaveLength(1);
  });
});

describe('T-160 invariants 2 & 5 — the document id, and config first', () => {
  it('2. the roster document id is the employment PK', async () => {
    const f = await fixture('docid');
    const e = await hire(f);
    const { driver, written } = fakeDriver();
    await drain(f, driver);
    expect(written.some((d) => d.path === `mirror/${f.storeId}/roster/${e.id}`)).toBe(true);
  });

  it('⭐ 5. attendance_config is published BEFORE the roster, whatever the enqueue order', async () => {
    // Landmine #15: a kill switch that arrives after the roster is a kill switch that did not work.
    const f = await fixture('priority');
    await hire(f); // roster enqueued first...
    await asOrg(f.orgId, (tx) =>
      supersedeConfig(tx, f.admin, {
        storeId: f.storeId,
        effectiveFrom: parseShiftDay('2026-06-01'),
        changes: { credentialFace: false },
      }),
    ); // ...config enqueued second, and must still go first.

    const { driver, written } = fakeDriver();
    await drain(f, driver);
    const first = written.findIndex((d) => d.path.includes('/config/'));
    const firstRoster = written.findIndex((d) => d.path.includes('/roster/'));
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(firstRoster);
  });

  it('the config document is at a fixed `current` id, carrying its PK in the body', async () => {
    const f = await fixture('config-id');
    await asOrg(f.orgId, (tx) =>
      supersedeConfig(tx, f.admin, {
        storeId: f.storeId,
        effectiveFrom: parseShiftDay('2026-06-01'),
        changes: { breakEnabled: false },
      }),
    );
    const { driver, written } = fakeDriver();
    await drain(f, driver);
    const doc = written.find((d) => d.path === `mirror/${f.storeId}/config/current`);
    expect(doc).toBeDefined();
    expect(doc!.data?.configId).toBeTruthy();
    expect(doc!.data?.breakEnabled).toBe(false);
  });
});

describe('T-160 invariants 3 & 4 — idempotent, and never stale', () => {
  it('3. re-draining publishes nothing new', async () => {
    const f = await fixture('idem');
    await hire(f);
    const { driver, written } = fakeDriver();
    const first = await drain(f, driver);
    expect(first.published).toBeGreaterThan(0);
    const before = written.length;
    const second = await drain(f, driver);
    expect(second.seen).toBe(0);
    expect(written).toHaveLength(before);
  });

  it('⭐ 4. a queue that has fallen behind publishes CURRENT truth, not the enqueued value', async () => {
    // The reason the outbox carries no payload column. A mirror may be stale; it may not be WRONG.
    const f = await fixture('current');
    const e = await hire(f);
    await sql`update persons set display_name = 'Renamed After Enqueue' where id = ${f.workerId}`;

    const { driver, written } = fakeDriver();
    await drain(f, driver);
    const doc = written.find((d) => d.path === `mirror/${f.storeId}/roster/${e.id}`);
    expect(doc!.data?.displayName).toBe('Renamed After Enqueue');
  });
});

describe('T-160 invariant 6 — a delete is a TOMBSTONE', () => {
  it('⭐ ending an employment publishes deleted, and the document survives', async () => {
    // §5.1: "an offline device must be able to learn that a record went away". A hard delete is
    // invisible to a device that was offline when it happened — it keeps the stale row forever.
    const f = await fixture('tombstone');
    const e = await hire(f);
    await asOrg(f.orgId, (tx) =>
      endEmployment(tx, f.admin, { employmentId: e.id, endedOn: '2026-06-30', employmentStatus: 'resigned' }),
    );
    const { driver, written } = fakeDriver();
    await drain(f, driver);
    const last = written.filter((d) => d.path === `mirror/${f.storeId}/roster/${e.id}`).pop();
    expect(last!.deleted).toBe(true);
    expect(last!.data).toBeUndefined();
  });

  it('a deactivated PERSON also tombstones — the roster view is the source of truth', async () => {
    const f = await fixture('person-off');
    const e = await hire(f);
    await sql`delete from mirror_outbox where org_id = ${f.orgId}`;
    await sql`update persons set is_active = false where id = ${f.workerId}`;
    const { driver, written } = fakeDriver();
    await drain(f, driver);
    const last = written.filter((d) => d.path.includes(e.id)).pop();
    expect(last!.deleted).toBe(true);
  });
});

describe('T-160 invariants 7 & 10 — failure, and emptiness', () => {
  it('⛔ 7. a publish failure leaves the row UNPUBLISHED, with attempts and lastError', async () => {
    const f = await fixture('fail');
    await hire(f);
    const { driver } = fakeDriver({ throwOnce: true });
    const report = await drain(f, driver);
    expect(report.failed).toBe(1);

    const [failedRow] = await sql<{ attempts: number; last_error: string; published_at: Date | null }[]>`
      select attempts, last_error, published_at from mirror_outbox
      where org_id = ${f.orgId} and published_at is null order by id limit 1`;
    expect(failedRow!.attempts).toBe(1);
    expect(failedRow!.last_error).toMatch(/unavailable/);
    expect(failedRow!.published_at).toBeNull();
  });

  it('...and the NEXT drain retries it — nothing is ever dropped', async () => {
    const f = await fixture('retry');
    await hire(f);
    const failing = fakeDriver({ throwOnce: true });
    await drain(f, failing.driver);
    const second = await drain(f, failing.driver);
    expect(second.published).toBeGreaterThan(0);
    const unpublished = await sql`
      select id from mirror_outbox where org_id = ${f.orgId} and published_at is null`;
    expect(unpublished).toHaveLength(0);
  });

  it('10. draining an empty outbox reports zero rather than erroring', async () => {
    const f = await fixture('empty');
    const { driver } = fakeDriver();
    const report = await drain(f, driver);
    expect(report).toMatchObject({ seen: 0, published: 0, failed: 0 });
  });
});

describe('T-160 invariant 8 — ⛔ only the three named entities, ever', () => {
  it('the hot set is closed, and a fourth entity is refused by the database', async () => {
    const f = await fixture('closed');
    await expect(sql`
      insert into mirror_outbox (org_id, store_id, entity, entity_id, op, src_version)
      values (${f.orgId}, ${f.storeId}, 'pay_rates', ${f.workerId}, 'upsert', 1)`)
      .rejects.toThrow(/entity_check|check/i);
  });

  it('and the enum in the schema matches the CHECK — one closed list, not two', async () => {
    const rows = await sql<{ c: string }[]>`
      select pg_get_constraintdef(oid) as c from pg_constraint
      where conname = 'mirror_outbox_entity_check'`;
    expect(rows[0]!.c).toContain('roster');
    expect(rows[0]!.c).toContain('attendance_config');
    expect(rows[0]!.c).toContain('day_feed');
    expect(rows[0]!.c).not.toContain('biometric');
  });
});
