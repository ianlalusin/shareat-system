import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-625 step 4.1 - re-seeding the mirror outbox (mirrorOutboxRepo.liveCoverage / enqueueLiveEntities / pendingPerOrg).
 * Mutants proven red (see the task report): live roster filter dropping the ended_on test; credential filter dropping the
 * revoked_at test; config filter dropping superseded_at; the "no unsent row" guard removed (a second run doubles the rows).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - name must contain "_test".`);
}

import { APP_ROLE, mirrorOutboxRepo, transaction, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { parseShiftDay, seedAttendanceConfig, supersedeConfig } from '@shareat/domain';

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

/**
 * One org + store; a current config (after one superseded config); three employments:
 * live | ended (ended_on set) | inactive (person is_active false); two cards on the live employment: one live, one revoked.
 * Expected live set: 1 roster, 1 credential, 1 attendance_config. The outbox is cleared so each test starts empty.
 */
async function fixture(hint: string) {
  const code = uid(`rs-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, 'S') returning id`;
  const storeId = store!.id;
  const person = async (name: string, active = true) =>
    (await sql<{ id: string }[]>`insert into persons (org_id, display_name, is_active) values (${orgId}, ${name}, ${active}) returning id`)[0]!.id;
  const adminId = await person('Admin');
  await sql`insert into person_roles (person_id, org_id, role) values (${adminId}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${adminId}, ${storeId})`;
  const actor: Actor = { personId: adminId, orgId };

  const employ = async (personId: string, endedOn: string | null) =>
    (await sql<{ id: string }[]>`
      insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on, ended_on)
      values (${orgId}, ${storeId}, ${personId}, ${'SE-' + String(1000 + ++seq)}, ${endedOn ? 'resigned' : 'regular'}, '2026-01-05', ${endedOn}) returning id`)[0]!.id;
  const liveEmployment = await employ(await person('Live'), null);
  await employ(await person('Ended'), '2026-06-01');
  await employ(await person('Inactive', false), null);

  const card = (cardId: string, revoked: boolean) =>
    sql`insert into attendance_credentials (org_id, store_id, employment_id, kind, card_id, enrolled_by, revoked_at, revoked_by, revoke_reason)
        values (${orgId}, ${storeId}, ${liveEmployment}, 'card', ${cardId}, ${adminId}, ${revoked ? new Date() : null}, ${revoked ? adminId : null}, ${revoked ? 'lost' : null})`;
  await card(uid('live'), false);
  await card(uid('dead'), true);

  await asOrg(orgId, (tx) => seedAttendanceConfig(tx, { orgId, storeId, effectiveFrom: '2026-01-01' }));
  await asOrg(orgId, (tx) =>
    supersedeConfig(tx, actor, { storeId, effectiveFrom: parseShiftDay('2026-06-01'), changes: { breakEnabled: false } }),
  );

  await sql`delete from mirror_outbox where org_id = ${orgId}`;
  return { orgId };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const enqueue = (f: Fixture) => asOrg(f.orgId, (tx) => mirrorOutboxRepo.enqueueLiveEntities(tx));
const coverage = (f: Fixture) => asOrg(f.orgId, (tx) => mirrorOutboxRepo.liveCoverage(tx));
const rows = (f: Fixture) =>
  sql<{ entity: string; op: string; published_at: Date | null; store_id: string; src_version: string }[]>`
    select entity, op, published_at, store_id, src_version::text from mirror_outbox where org_id = ${f.orgId} order by id`;

describe('T-625 reseed: live entities only, once', () => {
  it('queues exactly one upsert row per LIVE roster, credential and config - no ended, inactive, revoked or superseded', async () => {
    const f = await fixture('live-only');
    const added = await enqueue(f);
    expect(added).toEqual({ roster: 1, credential: 1, attendance_config: 1 });
    const r = await rows(f);
    expect(r).toHaveLength(3);
    expect(r.every((x) => x.op === 'upsert' && x.published_at === null)).toBe(true);
    const [st] = await sql<{ id: string }[]>`select id from stores where org_id = ${f.orgId}`;
    expect(r.every((x) => x.store_id === st!.id)).toBe(true);
    expect(new Set(r.map((x) => x.src_version)).size).toBe(3); // a fresh nextval each, never 0 or shared
  });

  it('a second run adds nothing while the first rows are still unsent', async () => {
    const f = await fixture('twice');
    await enqueue(f);
    expect(await enqueue(f)).toEqual({});
    expect(await rows(f)).toHaveLength(3);
  });

  it('once the relay has sent them, a new run queues a fresh row for each (what a new Firestore needs)', async () => {
    const f = await fixture('after-send');
    await enqueue(f);
    await sql`update mirror_outbox set published_at = now() where org_id = ${f.orgId}`;
    expect(await enqueue(f)).toEqual({ roster: 1, credential: 1, attendance_config: 1 });
    expect(await rows(f)).toHaveLength(6);
  });

  it('--check: reports live entities with no outbox row, and none after the re-seed', async () => {
    const f = await fixture('check');
    const before = await coverage(f);
    expect(before.map((c) => [c.entity, c.live, c.noRow])).toEqual([
      ['attendance_config', 1, 1],
      ['credential', 1, 1],
      ['roster', 1, 1],
    ]);
    await enqueue(f);
    const after = await coverage(f);
    expect(after.every((c) => c.noRow === 0 && c.noPending === 0)).toBe(true);
  });

  it('pendingPerOrg counts only unsent rows', async () => {
    const f = await fixture('pending');
    await enqueue(f);
    expect(await asOrg(f.orgId, (tx) => mirrorOutboxRepo.pendingPerOrg(tx))).toEqual([3]);
    await sql`update mirror_outbox set published_at = now() where org_id = ${f.orgId}`;
    expect(await asOrg(f.orgId, (tx) => mirrorOutboxRepo.pendingPerOrg(tx))).toEqual([]);
  });
});
