import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-407 S3 (DEF-649, PIN door + readiness) - docs/tasks/407-def649-ended-employment-signin.md: R2, Invariants 11-14.
 *
 * The PIN door's question becomes: (scope here OR an open employment here) AND the org-level rule R1
 *   R1 = (a) an open employment anywhere in the org, or (b) an active admin/super_admin role,
 *        or (c) an active manager role AND no employment row EVER in the org.
 * `countActiveCredentials` (store readiness) must give the same answer in the same statement.
 *
 * ## Spec problems reported, not worked around
 *  - Invariant 11 says "manager with `manual` scope at A and no open employment anywhere -> BAD_PIN". Read literally that
 *    includes a manager who was NEVER employed, and R1 leg (c) ADMITS that person (the franchise owner). The only reading
 *    consistent with R1 is a manager who HAS an employment row and every one is ended. That is what is built here; the
 *    never-employed manager with scope is a separate case that signs in.
 *  - Making the PIN door stricter breaks every EXISTING fixture that gives a person scope but no role and no employment
 *    (global-pin 'a store-scope row is enough' ~205, t402-s2 cashier fixture, and more). The spec lists only
 *    global-pin ~257-270; the full-suite run after the build will show the rest. Reported in the hand-back.
 *
 * ## State at HEAD
 * Red: the PIN refusals of Invariant 11 (HEAD admits on scope alone) and the readiness count of Invariant 13.
 * Green controls (guard the mutants): Invariant 12, the never-employed manager, an employed person with no role,
 * Invariant 14 (one round trip).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { closeDb, transaction, APP_ROLE, accessRepo, storesRepo, type Tx } from '@shareat/db';
import { AuthenticationError, flushSecurityEvents, hashPin, pinLookupHash, signInWithPin } from '@shareat/auth';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const BAD_PIN = 'Sign-in failed: that PIN is not valid.';

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

/** Runs under the real RLS principal, exactly as a request would (same shape as global-pin.test.ts). */
async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

type Role = 'super_admin' | 'admin' | 'manager' | 'staff';
let pinSeq = 0;

async function fixture(hint: string) {
  const code = uid(`t407s3-${hint}`);
  const orgId = (await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`)[0]!.id;
  const mkStore = async (h: string) =>
    (await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(h)}, ${`Store ${h}`}) returning id`)[0]!.id;
  const storeA = await mkStore(`${hint}-A`);
  const storeB = await mkStore(`${hint}-B`);
  /** A person with a live PIN (6 distinct digits per call), an optional role, and nothing else. */
  const person = async (name: string, role: Role | null) => {
    const personId = (await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`)[0]!.id;
    if (role) await sql`insert into person_roles (person_id, org_id, role) values (${personId}, ${orgId}, ${role})`;
    const pin = String(740100 + ++pinSeq);
    await sql`
      insert into person_credentials (person_id, kind, store_id, secret_hash, lookup_hash)
      values (${personId}, 'pin', ${storeA}, ${await hashPin(pin)}, ${pinLookupHash(orgId, pin)})`;
    return { personId, pin };
  };
  const scope = (personId: string, storeId: string, source: 'manual' | 'fan_out' | 'employment') =>
    sql`insert into person_store_scope (person_id, store_id, source) values (${personId}, ${storeId}, ${source})`;
  const employ = (personId: string, storeId: string, startedOn: string, endedOn?: string) =>
    sql`
      insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on, ended_on)
      values (${orgId}, ${storeId}, ${personId}, ${uid('SC')}, ${endedOn ? 'terminated' : 'regular'}, ${startedOn}, ${endedOn ?? null})`;
  const pinAt = (pin: string, storeId: string) => signInWithPin(null, { orgId, storeId, pin });
  return { orgId, storeA, storeB, person, scope, employ, pinAt };
}

describe('Invariant 11 - the PIN door applies R1 on top of scope/employment here', () => {
  it('manager with manual scope at A whose only employment (at B) ended: BAD_PIN at A', async () => {
    const f = await fixture('ended-mgr');
    const p = await f.person('Ex Manager', 'manager');
    await f.employ(p.personId, f.storeB, '2026-01-01', '2026-03-01');
    await f.scope(p.personId, f.storeA, 'manual');

    const e = await f.pinAt(p.pin, f.storeA).then(
      () => null,
      (x: Error) => x,
    );
    expect(e, 'mutant: R1 clause removed from personMaySignInAtStore - scope alone admits').toBeInstanceOf(AuthenticationError);
    expect(e!.message).toBe(BAD_PIN);
    expect((await sql`select 1 from sessions where person_id = ${p.personId}`).length, 'no session row').toBe(0);
  });

  it('staff with scope at A and no employment ever: BAD_PIN (scope without R1 is not enough)', async () => {
    const f = await fixture('scope-only-staff');
    const p = await f.person('Scoped Staff', 'staff');
    await f.scope(p.personId, f.storeA, 'manual');
    await expect(f.pinAt(p.pin, f.storeA)).rejects.toMatchObject({ message: BAD_PIN });
  });

  it('scope with no role at all and no employment: BAD_PIN', async () => {
    const f = await fixture('scope-only-roleless');
    const p = await f.person('Roleless', null);
    await f.scope(p.personId, f.storeA, 'manual');
    await expect(f.pinAt(p.pin, f.storeA)).rejects.toMatchObject({ message: BAD_PIN });
  });

  it('a refused PIN writes no new audit row (sign_in_attempts is the PIN miss log; R3)', async () => {
    const f = await fixture('no-audit');
    const p = await f.person('Ex Manager', 'manager');
    await f.employ(p.personId, f.storeB, '2026-01-01', '2026-03-01');
    await f.scope(p.personId, f.storeA, 'manual');
    await f.pinAt(p.pin, f.storeA).catch(() => undefined);
    await flushSecurityEvents();
    const n = (await sql<{ n: number }[]>`select count(*)::int as n from audit_log where org_id = ${f.orgId}`)[0]!.n;
    expect(n).toBe(0);
  });

  it('control: a never-employed manager with scope at A signs in (the franchise owner, leg c applies at the PIN door too)', async () => {
    const f = await fixture('owner');
    const p = await f.person('Owner', 'manager');
    await f.scope(p.personId, f.storeA, 'manual');
    expect((await f.pinAt(p.pin, f.storeA)).personId).toBe(p.personId);
  });

  it('control: an open employment HERE admits a person who has no role (leg a)', async () => {
    const f = await fixture('employed-here');
    const p = await f.person('Cashier', null);
    await f.employ(p.personId, f.storeA, '2026-01-01');
    expect((await f.pinAt(p.pin, f.storeA)).personId).toBe(p.personId);
  });

  it('control: employed at B (open) with manual scope at A signs in at A (R1 via leg a, scope here)', async () => {
    const f = await fixture('employed-elsewhere');
    const p = await f.person('Floater', 'staff');
    await f.employ(p.personId, f.storeB, '2026-01-01');
    await f.scope(p.personId, f.storeA, 'manual');
    expect((await f.pinAt(p.pin, f.storeA)).personId).toBe(p.personId);
  });

  it('control: employed at B only, nothing at A: still refused at A (the store leg is unchanged)', async () => {
    const f = await fixture('wrong-store');
    const p = await f.person('Elsewhere', 'staff');
    await f.employ(p.personId, f.storeB, '2026-01-01');
    await expect(f.pinAt(p.pin, f.storeA)).rejects.toMatchObject({ message: BAD_PIN });
  });
});

describe('Invariant 12 - admin with fan_out scope and no employment signs in by PIN', () => {
  it.each(['admin', 'super_admin'] as const)('%s, fan_out scope at A, never employed', async (role) => {
    const f = await fixture(`admin-${role}`);
    const p = await f.person(role, role);
    await f.scope(p.personId, f.storeA, 'fan_out');
    const r = await f.pinAt(p.pin, f.storeA);
    expect(r.personId, 'mutant: R1 without leg (b)').toBe(p.personId);
  });

  it('an admin whose role was REVOKED, with scope and no employment, is refused', async () => {
    const f = await fixture('admin-revoked');
    const p = await f.person('Demoted', 'admin');
    await f.scope(p.personId, f.storeA, 'fan_out');
    await sql`update person_roles set revoked_at = now() where person_id = ${p.personId}`;
    await expect(f.pinAt(p.pin, f.storeA)).rejects.toMatchObject({ message: BAD_PIN });
  });
});

describe('Invariant 13 - countActiveCredentials agrees with the gate (lockstep)', () => {
  it('counts exactly the people the PIN door admits at A: both answers asserted together, on the same fixtures', async () => {
    const f = await fixture('lockstep');
    // refused by R1
    const exMgr = await f.person('exMgr', 'manager');
    await f.employ(exMgr.personId, f.storeB, '2026-01-01', '2026-03-01');
    await f.scope(exMgr.personId, f.storeA, 'manual');
    const scopedStaff = await f.person('scopedStaff', 'staff');
    await f.scope(scopedStaff.personId, f.storeA, 'manual');
    const scopedRoleless = await f.person('scopedRoleless', null);
    await f.scope(scopedRoleless.personId, f.storeA, 'manual');
    // admitted
    const admin = await f.person('admin', 'admin');
    await f.scope(admin.personId, f.storeA, 'fan_out');
    const owner = await f.person('owner', 'manager');
    await f.scope(owner.personId, f.storeA, 'manual');
    const employed = await f.person('employed', 'staff');
    await f.employ(employed.personId, f.storeA, '2026-01-01');
    // not at A at all
    const atB = await f.person('atB', 'staff');
    await f.employ(atB.personId, f.storeB, '2026-01-01');

    const everyone = [exMgr, scopedStaff, scopedRoleless, admin, owner, employed, atB];
    const gate = await asOrg(f.orgId, async (tx) => {
      const out: boolean[] = [];
      for (const p of everyone) out.push(await accessRepo.personMaySignInAtStore(tx, p.personId, f.storeA));
      return out;
    });
    expect(gate, 'the repo predicate: ex-manager, scoped staff, scoped roleless refused; admin, owner, employed admitted; atB not here').toEqual([
      false, false, false, true, true, true, false,
    ]);
    const admitted = gate.filter(Boolean).length;
    expect(admitted).toBe(3);

    // the real door agrees person by person
    for (let i = 0; i < everyone.length; i++) {
      const p = everyone[i]!;
      const r = await f.pinAt(p.pin, f.storeA).then(
        () => true,
        () => false,
      );
      expect(r, `signInWithPin at A for person #${i}`).toBe(gate[i]);
    }

    const counted = await asOrg(f.orgId, (tx) => storesRepo.countActiveCredentials(tx, f.storeA));
    expect(counted, 'mutant: lockstep clause missing in stores.ts (HEAD counts all 5 with scope or employment here)').toBe(admitted);
  });

  it('readiness for a store where only R1-refused people hold scope reads 0 (the "no one can sign in yet" gate is not fooled)', async () => {
    const f = await fixture('lockstep-zero');
    const exMgr = await f.person('exMgr', 'manager');
    await f.employ(exMgr.personId, f.storeB, '2026-01-01', '2026-03-01');
    await f.scope(exMgr.personId, f.storeA, 'manual');
    expect(await asOrg(f.orgId, (tx) => storesRepo.countActiveCredentials(tx, f.storeA))).toBe(0);
  });
});

describe('Invariant 14 - personMaySignInAtStore is still ONE round trip', () => {
  /** Counts every statement a transaction is asked to run, whichever builder asked. */
  function counting(tx: Tx): { tx: Tx; n: () => number } {
    let n = 0;
    const METHODS = new Set(['execute', 'select', 'selectDistinct', 'selectDistinctOn', 'insert', 'update', 'delete', 'query', 'transaction']);
    const proxy = new Proxy(tx as object, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (typeof prop === 'string' && METHODS.has(prop) && typeof v === 'function') {
          return (...args: unknown[]) => {
            n++;
            return (v as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return v;
      },
    });
    return { tx: proxy as Tx, n: () => n };
  }

  it('one statement for an admitted person, a refused person, and a person refused by R1', async () => {
    const f = await fixture('one-trip');
    const admitted = await f.person('admin', 'admin');
    await f.scope(admitted.personId, f.storeA, 'fan_out');
    const exMgr = await f.person('exMgr', 'manager');
    await f.employ(exMgr.personId, f.storeB, '2026-01-01', '2026-03-01');
    await f.scope(exMgr.personId, f.storeA, 'manual');
    const nobody = await f.person('nobody', null);

    await asOrg(f.orgId, async (real) => {
      // The ANSWER is judged by Invariants 11-13; this test judges only the statement count, so it is a green control at HEAD.
      for (const who of [admitted, exMgr, nobody]) {
        const c = counting(real);
        await accessRepo.personMaySignInAtStore(c.tx, who.personId, f.storeA);
        expect(c.n(), 'mutant: split into two queries').toBe(1);
      }
    });
  });
});

describe('Q2 - an employment whose ended_on is in the FUTURE counts as ended (PIN door)', () => {
  it('manager with manual scope at A whose only employment (at A) ends TOMORROW: BAD_PIN, no session', async () => {
    const f = await fixture('future-end');
    const p = await f.person('Leaving Manager', 'manager');
    const tomorrow = (await sql<{ d: string }[]>`select (current_date + 1)::text as d`)[0]!.d;
    await f.employ(p.personId, f.storeA, '2026-01-01', tomorrow);
    await f.scope(p.personId, f.storeA, 'manual');
    const e = await f.pinAt(p.pin, f.storeA).then(
      () => null,
      (x: Error) => x,
    );
    expect(e, 'mutant: `ended_on <= current_date` - a future end date still counts as open').toBeInstanceOf(AuthenticationError);
    expect(e!.message).toBe(BAD_PIN);
    expect((await sql`select 1 from sessions where person_id = ${p.personId}`).length).toBe(0);
  });
});
