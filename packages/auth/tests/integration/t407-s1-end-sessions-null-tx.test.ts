import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * T-407 S1 (DEF-650) - `endShift(null, ...)` and `endAllForDevice(null, ...)` must actually end sessions.
 * docs/tasks/407-def649-ended-employment-signin.md: R9, Invariants 1, 2, 3.
 *
 * ## What is judged
 * Fixtures are committed as the OWNER over a plain postgres.js connection; every read is the owner's too, so a count is
 * what COMMITTED. The functions under test run through `@shareat/db`'s `transaction()`/`withOrgPrincipal`, i.e. the
 * restricted harness role (RLS on): a null-tx path that opens a plain `transaction()` has no org principal, RLS hides
 * every `sessions` row, and the UPDATE ends 0 (DEF-650).
 *
 * ## State at HEAD
 * Invariants 1 and 2 are red on "expected N sessions ended, got 0". Invariant 3 is red because nothing is ended, so the
 * forced audit failure never fires and the call resolves. The unknown-person/device and caller-tx legs are green controls.
 * Mutants: fallback restored to `transaction()` (1, 2); audit moved to the outbox (3).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

// A switch that makes the audit append fail, to prove the end-sessions UPDATE and its audit row share one transaction.
const ctl = vi.hoisted(() => ({ failAudit: false }));
vi.mock('@shareat/db', async (importOriginal) => {
  const real = await importOriginal<typeof import('@shareat/db')>();
  const boom = () => Promise.reject(new Error('forced audit append failure'));
  return {
    ...real,
    auditLogRepo: {
      ...real.auditLogRepo,
      append: (...a: Parameters<typeof real.auditLogRepo.append>) => (ctl.failAudit ? boom() : real.auditLogRepo.append(...a)),
      appendSystem: (...a: Parameters<typeof real.auditLogRepo.appendSystem>) => (ctl.failAudit ? boom() : real.auditLogRepo.appendSystem(...a)),
    },
  };
});

import { closeDb, withOrgPrincipal } from '@shareat/db';
import { endAllForDevice, endShift, flushSecurityEvents } from '@shareat/auth';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

async function fixture(hint: string) {
  const code = uid(`t407s1-${hint}`);
  const orgId = (await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`)[0]!.id;
  const mkStore = async (h: string) =>
    (await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(h)}, ${`Store ${h}`}) returning id`)[0]!.id;
  const mkPerson = async (name: string, kind = 'person') =>
    (await sql<{ id: string }[]>`insert into persons (org_id, display_name, kind) values (${orgId}, ${name}, ${kind}) returning id`)[0]!.id;
  const storeA = await mkStore(`${hint}-A`);
  const storeB = await mkStore(`${hint}-B`);
  const personId = await mkPerson('Cashier');
  const otherId = await mkPerson('Other');
  const deviceId = await mkPerson('Terminal', 'terminal');
  const credOf = async (pid: string) =>
    (await sql<{ id: string }[]>`
      insert into person_credentials (person_id, kind, store_id, external_id) values (${pid}, 'firebase', null, ${uid('fb')}) returning id`)[0]!.id;
  const cred = await credOf(personId);
  const otherCred = await credOf(otherId);
  const session = async (pid: string, credId: string, storeId: string | null, device: string | null) =>
    (await sql<{ id: string }[]>`
      insert into sessions (token_hash, person_id, credential_id, credential_kind, store_id, device_id, expires_at)
      values (${uid('tok')}, ${pid}, ${credId}, 'pin', ${storeId}, ${device}, now() + interval '12 hours') returning id`)[0]!.id;
  return { orgId, storeA, storeB, personId, otherId, deviceId, cred, otherCred, session };
}

const live = async (ids: string[]) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from sessions where id = any(${ids}::uuid[]) and ended_at is null`)[0]!.n;
const audit = async (orgId: string, action: string) => {
  await flushSecurityEvents();
  return sql<{ actor_person_id: string | null; entity_id: string; after: Record<string, unknown> }[]>`
    select actor_person_id, entity_id, after from audit_log where org_id = ${orgId} and action = ${action} order by recorded_at, id`;
};
const reasonOf = async (id: string) => (await sql<{ ended_reason: string | null }[]>`select ended_reason from sessions where id = ${id}`)[0]!.ended_reason;

describe('Invariant 1 - endShift(null, ...) ends the sessions and records one session.ended', () => {
  it('2 live PIN sessions at store A end (2), a session at store B and another person survive; one session.ended in the same transaction', async () => {
    const f = await fixture('shift');
    const a1 = await f.session(f.personId, f.cred, f.storeA, null);
    const a2 = await f.session(f.personId, f.cred, f.storeA, null);
    const b1 = await f.session(f.personId, f.cred, f.storeB, null);
    const o1 = await f.session(f.otherId, f.otherCred, f.storeA, null);

    const r = await endShift(null, { personId: f.personId, storeId: f.storeA });
    expect(r, 'mutant: fallback restored to transaction() - RLS hides every row, 0 ended').toEqual({ ended: 2 });
    expect(await live([a1, a2])).toBe(0);
    expect(await reasonOf(a1)).toBe('shift_end');
    expect(await live([b1, o1]), 'other store and other person are untouched').toBe(2);

    const rows = await audit(f.orgId, 'session.ended');
    expect(rows, 'exactly one session.ended for the hand-over').toHaveLength(1);
    expect(rows[0]!.entity_id).toBe(f.personId);
    expect(rows[0]!.actor_person_id).toBe(f.personId);
    expect(rows[0]!.after).toMatchObject({ reason: 'shift_end', atStoreId: f.storeA, ended: 2 });
  });

  it('control: an unknown person ends nothing and writes nothing', async () => {
    const f = await fixture('shift-none');
    const r = await endShift(null, { personId: '00000000-0000-4000-8000-000000000407', storeId: f.storeA });
    expect(r).toEqual({ ended: 0 });
    expect(await audit(f.orgId, 'session.ended')).toHaveLength(0);
  });

  it('control: with a caller transaction the existing path already works', async () => {
    const f = await fixture('shift-tx');
    const a1 = await f.session(f.personId, f.cred, f.storeA, null);
    const r = await withOrgPrincipal(f.orgId, (tx) => endShift(tx, { personId: f.personId, storeId: f.storeA }));
    expect(r).toEqual({ ended: 1 });
    expect(await live([a1])).toBe(0);
    expect(await audit(f.orgId, 'session.ended')).toHaveLength(1);
  });
});

describe('Invariant 2 - endAllForDevice(null, ...) ends every live session on the device and records one session.ended_all', () => {
  it('3 sessions of 2 people on the device end; a session elsewhere survives; one session.ended_all (system row, no actor)', async () => {
    const f = await fixture('dev');
    const d1 = await f.session(f.personId, f.cred, f.storeA, f.deviceId);
    const d2 = await f.session(f.personId, f.cred, f.storeA, f.deviceId);
    const d3 = await f.session(f.otherId, f.otherCred, f.storeA, f.deviceId);
    const elsewhere = await f.session(f.personId, f.cred, f.storeA, 'some-other-device');

    const r = await endAllForDevice(null, { deviceId: f.deviceId });
    expect(r, 'mutant: fallback restored to transaction() - 0 ended').toEqual({ ended: 3 });
    expect(await live([d1, d2, d3])).toBe(0);
    expect(await reasonOf(d1)).toBe('revoked');
    expect(await live([elsewhere])).toBe(1);

    const rows = await audit(f.orgId, 'session.ended_all');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entity_id).toBe(f.deviceId);
    expect(rows[0]!.actor_person_id, 'no actor named: a system row').toBeNull();
    expect(rows[0]!.after).toMatchObject({ reason: 'revoked', deviceId: f.deviceId, ended: 3 });
  });

  it('with an actorPersonId the event carries that actor', async () => {
    const f = await fixture('dev-actor');
    const d1 = await f.session(f.personId, f.cred, f.storeA, f.deviceId);
    const r = await endAllForDevice(null, { deviceId: f.deviceId, actorPersonId: f.otherId });
    expect(r).toEqual({ ended: 1 });
    expect(await live([d1])).toBe(0);
    const rows = await audit(f.orgId, 'session.ended_all');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_person_id).toBe(f.otherId);
  });

  it('control: an unknown device ends nothing and writes nothing', async () => {
    const f = await fixture('dev-none');
    expect(await endAllForDevice(null, { deviceId: '00000000-0000-4000-8000-000000000408' })).toEqual({ ended: 0 });
    expect(await audit(f.orgId, 'session.ended_all')).toHaveLength(0);
  });
});

describe('Invariant 3 - a failed audit append leaves every session live (same transaction)', () => {
  it('endShift: audit append fails -> the call rejects and nothing is ended', async () => {
    const f = await fixture('fail-shift');
    const a1 = await f.session(f.personId, f.cred, f.storeA, null);
    const a2 = await f.session(f.personId, f.cred, f.storeA, null);
    ctl.failAudit = true;
    try {
      await expect(endShift(null, { personId: f.personId, storeId: f.storeA }), 'mutant: audit moved to the outbox resolves instead').rejects.toThrow();
    } finally {
      ctl.failAudit = false;
    }
    expect(await live([a1, a2]), 'the UPDATE rolled back with the failed audit').toBe(2);
  });

  it('endAllForDevice: audit append fails -> the call rejects and nothing is ended', async () => {
    const f = await fixture('fail-dev');
    const d1 = await f.session(f.personId, f.cred, f.storeA, f.deviceId);
    const d2 = await f.session(f.otherId, f.otherCred, f.storeA, f.deviceId);
    ctl.failAudit = true;
    try {
      await expect(endAllForDevice(null, { deviceId: f.deviceId }), 'mutant: audit moved to the outbox resolves instead').rejects.toThrow();
    } finally {
      ctl.failAudit = false;
    }
    expect(await live([d1, d2])).toBe(2);
  });
});
