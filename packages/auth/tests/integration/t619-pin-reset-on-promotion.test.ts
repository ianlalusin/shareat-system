/**
 * T-619 / DEF-920 — a RAISED role retires the person's PIN, in the same transaction, and ends their sessions.
 * `docs/tasks/619-pin-reset-on-promotion.md`. Ian, 22 Nov 2026: "yes".
 *
 * Case 1 is the defect executed: promote a staffer who holds a PIN, and the old PIN must stop signing in.
 * Mutant (checked by hand): drop the `resetPinOnPromotion` call in `assignRole` and case 1 goes red.
 */
import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - name must contain "_test".`);
}

import { closeDb, transaction, APP_ROLE, sessionsRepo, type Tx } from '@shareat/db';
import { assignRoleAsActor, signInWithPin, setPin, resolveActor, AuthenticationError, type Actor, type Role } from '@shareat/auth';

const sql = postgres(url, { max: 5 });

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const OLD_PIN = '135790';
const NEW_PIN = '246801';

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

interface Fixture {
  orgId: string;
  storeId: string;
  /** Holds `super_admin`, so it may appoint admins. */
  boss: Actor;
  /** The person whose role is changed; starts at the role given to `setup`, with a PIN and a live session. */
  targetId: string;
  sessionToken: string;
  sessionId: string;
}

async function setup(hint: string, startRole: Role, withPin = true): Promise<Fixture> {
  const code = uid(`t619-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('s')}, 'Store') returning id`;
  const storeId = store!.id;
  const mkPerson = async (n: string) => {
    const [r] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${n}) returning id`;
    return r!.id;
  };
  const bossId = await mkPerson(`${hint} Boss`);
  const targetId = await mkPerson(`${hint} Target`);
  await sql`insert into person_roles (org_id, person_id, role, granted_by) values (${orgId}, ${bossId}, 'super_admin', null)`;
  await sql`insert into person_roles (org_id, person_id, role, granted_by) values (${orgId}, ${targetId}, ${startRole}, null)`;
  for (const personId of [bossId, targetId]) {
    await sql`insert into person_store_scope (person_id, store_id) values (${personId}, ${storeId})`;
    await sql`insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on) values (${orgId}, ${storeId}, ${personId}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e9)}`}, 'regular', '2020-01-01')`;
  }
  let sessionToken = '';
  let sessionId = '';
  if (withPin) {
    await asOrg(orgId, (tx) => setPin(tx, { orgId, personId: targetId, storeId, pin: OLD_PIN }));
    const s = await asOrg(orgId, (tx) => signInWithPin(tx, { orgId, storeId, pin: OLD_PIN }));
    sessionToken = s.token;
    sessionId = s.sessionId;
  }
  return { orgId, storeId, boss: { personId: bossId, orgId }, targetId, sessionToken, sessionId };
}

const change = (f: Fixture, role: Role) => asOrg(f.orgId, (tx) => assignRoleAsActor(tx, f.boss, { personId: f.targetId, role }));
const livePins = async (personId: string) =>
  (await sql<{ n: number }[]>`select count(*)::int n from person_credentials where person_id = ${personId} and kind = 'pin' and revoked_at is null`)[0]!.n;
const auditRows = (orgId: string) =>
  sql<{ before: { role: string | null }; after: { role: string } }[]>`
    select before, after from audit_log where org_id = ${orgId} and action = 'credential.pin_reset_on_promotion'`;

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('T-619 - a promotion resets the PIN', () => {
  for (const [name, from, to] of [
    ['1: staff -> manager', 'staff', 'manager'],
    ['2: manager -> admin', 'manager', 'admin'],
  ] as const) {
    it(`case ${name}: the old PIN stops signing in, sessions end, one audit row`, async () => {
      const f = await setup(`c${from}${to}`, from);
      expect(await livePins(f.targetId)).toBe(1);

      await change(f, to);

      expect(await livePins(f.targetId), 'mutant: revoke skipped').toBe(0);
      await expect(
        asOrg(f.orgId, (tx) => signInWithPin(tx, { orgId: f.orgId, storeId: f.storeId, pin: OLD_PIN })),
      ).rejects.toThrow(AuthenticationError);
      await expect(asOrg(f.orgId, (tx) => resolveActor(tx, f.sessionToken))).rejects.toThrow(AuthenticationError);
      const [sess] = await sql<{ ended_reason: string }[]>`select ended_reason from sessions where id = ${f.sessionId}`;
      expect(sess!.ended_reason).toBe('revoked');
      const [cred] = await sql<{ revoke_reason: string }[]>`
        select revoke_reason from person_credentials where person_id = ${f.targetId} and kind = 'pin'`;
      expect(cred!.revoke_reason).toBe(`role raised to ${to}`);

      const rows = await auditRows(f.orgId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.before.role).toBe(from);
      expect(rows[0]!.after.role).toBe(to);
      expect(await asOrg(f.orgId, (tx) => sessionsRepo.pinResetPendingForPerson(tx, f.targetId))).toBe(true);
    });
  }

  it('case 3: manager -> staff, and a same-role re-assignment, leave the PIN alone', async () => {
    const f = await setup('lower', 'manager');
    await change(f, 'staff');
    expect(await livePins(f.targetId)).toBe(1);
    const s = await asOrg(f.orgId, (tx) => signInWithPin(tx, { orgId: f.orgId, storeId: f.storeId, pin: OLD_PIN }));
    expect(s.personId).toBe(f.targetId);
    await asOrg(f.orgId, (tx) => resolveActor(tx, f.sessionToken)); // the earlier session is still live
    await change(f, 'staff'); // same role again
    expect(await livePins(f.targetId)).toBe(1);
    expect(await auditRows(f.orgId)).toHaveLength(0);
    expect(await asOrg(f.orgId, (tx) => sessionsRepo.pinResetPendingForPerson(tx, f.targetId))).toBe(false);
  });

  it('a promotion of someone with no PIN writes no reset row', async () => {
    const f = await setup('nopin', 'staff', false);
    await change(f, 'manager');
    expect(await auditRows(f.orgId)).toHaveLength(0);
    expect(await asOrg(f.orgId, (tx) => sessionsRepo.pinResetPendingForPerson(tx, f.targetId))).toBe(false);
  });

  it('case 4: a new PIN set after the promotion works, and the reset note clears', async () => {
    const f = await setup('newpin', 'staff');
    await change(f, 'manager');
    expect(await asOrg(f.orgId, (tx) => sessionsRepo.pinResetPendingForPerson(tx, f.targetId))).toBe(true);
    await asOrg(f.orgId, (tx) => setPin(tx, { orgId: f.orgId, personId: f.targetId, storeId: f.storeId, pin: NEW_PIN, actorPersonId: f.boss.personId }));
    const s = await asOrg(f.orgId, (tx) => signInWithPin(tx, { orgId: f.orgId, storeId: f.storeId, pin: NEW_PIN }));
    expect(s.personId).toBe(f.targetId);
    expect(await livePins(f.targetId)).toBe(1);
    expect(await asOrg(f.orgId, (tx) => sessionsRepo.pinResetPendingForPerson(tx, f.targetId))).toBe(false);
  });
});
