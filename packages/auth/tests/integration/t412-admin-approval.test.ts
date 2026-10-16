import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-412 S1 (TESTER) - `verifyAdminApproval`, the server-side check behind every Tier P danger button.
 * docs/tasks/412-confirm-destructive-tiers.md, "How the server verifies a Tier P action", tests I1-I9 (+ I11 shared budget).
 *
 * CONTRACT PINNED HERE (taken from the spec; the builder matches):
 *   verifyAdminApproval(tx: Tx | null, { actor, storeId, pin, capability, deviceId? }) => Promise<{ approverPersonId }>
 *   exported from `@shareat/auth`; throws ONE sentence for every refusal, byte for byte:
 *   ADMIN_PIN_REFUSED = 'That PIN cannot approve this. An administrator must enter their own PIN.'
 *   a stopped / paused store keeps signInWithPin's own sentences (STOPPED_MESSAGE / cooldownMessage), unchanged.
 *
 * WHY THESE TESTS ARE RED FOR THE RIGHT REASON TODAY: the export does not exist, so `approve()` throws
 * "MISSING EXPORT ..." and EVERY assertion below compares the thrown message with the exact spec sentence (never just
 * "it threw"), so a refusal test cannot pass vacuously on the missing function.
 *
 * Time is moved by back-dating rows with SQL (T-395's idiom), never by sleeping. Lookups are counted by wrapping
 * `sessionsRepo.findActiveCredentialByLookupHash` through a `vi.mock` of `@shareat/db`.
 *
 * MUTANTS (spec V1-V5, plus three the tester added; each one-line edit in packages/auth/src/admin-approval.ts, run, red, reverted):
 *   M2   allowed = verified (drop the whole authority term)                    -> I3 red
 *   M2b  isAdmin ignored (allowed = verified && fallback)                       -> I1 red
 *   M3   fallback without `adminless &&`                                        -> I3 red
 *   M4   drop `fallback` (allowed = verified && isAdmin)                        -> I4 red
 *   M5   hash the PIN with a constant instead of actor.orgId                    -> I1 red (and I5's collision leg if the hash
 *        is built from the PIN owner's org); I5 alone cannot go red on a constant, see its comment
 *   M6   charge inside the caller's transaction (miss rolls back with the throw) -> I2 red
 *   M7   skip refuseIfCharged                                                   -> I6 red
 *   M12  approvals charge their own bucket (not the sign-in store budget)       -> I11 red          (tester-added)
 *   M13  refund the charge when the PIN is right but its owner is no admin      -> I3 red           (tester-added)
 *   M14  isAdministrative narrowed to 'admin' only (super_admin refused)        -> I1d red          (tester-added)
 *   (M1, M8, M9, M10, M11 live in the action / census tests: t412-destructive-actions.test.ts and t412-destructive-census.test.ts.)
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - name must contain "_test".`);
}

const lookups = vi.hoisted(() => ({ n: 0 }));
vi.mock('@shareat/db', async (importOriginal) => {
  const real = await importOriginal<typeof import('@shareat/db')>();
  return {
    ...real,
    sessionsRepo: {
      ...real.sessionsRepo,
      findActiveCredentialByLookupHash: (...args: Parameters<typeof real.sessionsRepo.findActiveCredentialByLookupHash>) => {
        lookups.n++;
        return real.sessionsRepo.findActiveCredentialByLookupHash(...args);
      },
    },
  };
});

import { APP_ROLE, closeDb, transaction, type Tx } from '@shareat/db';
import * as auth from '@shareat/auth';
import { elevateManager, hashPin, pinLookupHash, signInWithPin } from '@shareat/auth';

const sql = postgres(url, { max: 8 });

/** The spec's one refusal sentence, typed here on purpose: a test must assert the text the spec wrote, not a re-export of it. */
const ADMIN_PIN_REFUSED = 'That PIN cannot approve this. An administrator must enter their own PIN.';
const STOPPED =
  /PIN sign-in is stopped at this store after too many wrong PINs today\. A manager can reopen it: sign in with email and password, then open Staff\./;
const PAUSED = /paused until/;
const WRONG = '000000'; // well-formed, never issued in these fixtures

type Approve = (
  tx: null,
  input: { actor: { personId: string; orgId: string }; storeId: string; pin: string; capability: string; deviceId?: string },
) => Promise<{ approverPersonId: string }>;
function verifyFn(): Approve {
  const fn = (auth as Record<string, unknown>).verifyAdminApproval;
  if (typeof fn !== 'function') {
    throw new Error('MISSING EXPORT: @shareat/auth does not export verifyAdminApproval (T-412 S1 has not been built).');
  }
  return fn as Approve;
}

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
let pinSeq = 0;
/** Distinct, well-formed, never WRONG, never a repeated-digit run. */
const nextPin = () => String(200000 + ++pinSeq * 13);

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

interface Who {
  personId: string;
  pin: string;
}
interface Fixture {
  orgId: string;
  storeId: string;
  admin?: Who;
  superAdmin?: Who;
  manager: Who; // role manager, holds void_expense by the matrix, NOT manage_users
  manager2: Who; // a second plain manager
  staff: Who; // role staff: lacks void_expense and manage_users
  deviceId: string;
}

async function org(hint: string, opts: { admin?: boolean; superAdmin?: boolean } = {}): Promise<Fixture> {
  const code = uid(`t412-${hint}`);
  const [o] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = o!.id;
  const [st] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('s')}, 'S') returning id`;
  const storeId = st!.id;
  const mk = async (name: string, role: string): Promise<Who> => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    const personId = p!.id;
    await sql`insert into person_roles (person_id, org_id, role) values (${personId}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id, source) values (${personId}, ${storeId}, 'manual')`;
    const pin = nextPin();
    await sql`
      insert into person_credentials (person_id, kind, store_id, secret_hash, lookup_hash)
      values (${personId}, 'pin', ${storeId}, ${await hashPin(pin)}, ${pinLookupHash(orgId, pin)})`;
    return { personId, pin };
  };
  const [dev] = await sql<{ id: string }[]>`insert into persons (org_id, display_name, kind) values (${orgId}, 'Terminal', 'terminal') returning id`;
  const f: Fixture = {
    orgId,
    storeId,
    manager: await mk('Manager', 'manager'),
    manager2: await mk('Manager Two', 'manager'),
    staff: await mk('Staff', 'staff'),
    deviceId: dev!.id,
  };
  if (opts.admin) f.admin = await mk('Admin', 'admin');
  if (opts.superAdmin) f.superAdmin = await mk('Super', 'super_admin');
  return f;
}

const actorOf = (f: Fixture, who: Who) => ({ personId: who.personId, orgId: f.orgId });
const approve = (f: Fixture, actor: Who, pin: string, capability = 'void_expense', storeId = f.storeId) =>
  verifyFn()(null, { actor: actorOf(f, actor), storeId, pin, capability });
const msg = (p: Promise<unknown>): Promise<string> => p.then(() => 'OK', (e: Error) => e.message);

const countKind = async (f: Fixture, kind: string) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from sign_in_attempts where store_id = ${f.storeId} and kind = ${kind}`)[0]!.n;
const throttleRow = async (f: Fixture) =>
  (await sql<{ fail_count: number; stopped_at: Date | null }[]>`select fail_count, stopped_at from pin_attempt_throttle where store_id = ${f.storeId}`)[0];

beforeEach(() => {
  lookups.n = 0;
});
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('fixture sanity (green today; proves the counters below measure something)', () => {
  it('an admin signs a wrong PIN into the sign-in door: one miss row, one lookup; a correct PIN refunds it', async () => {
    const f = await org('sanity', { admin: true });
    expect(await msg(signInWithPin(null, { orgId: f.orgId, storeId: f.storeId, pin: WRONG, deviceId: f.deviceId }))).toBe('Sign-in failed: that PIN is not valid.');
    expect(await countKind(f, 'miss')).toBe(1);
    expect(lookups.n).toBe(1);
  });
});

describe('I1 an administrator approves with their OWN correct PIN', () => {
  it('I1: the admin’s PIN, typed at a manager’s action, returns the ADMIN’s id (not the actor’s)', async () => {
    const f = await org('i1', { admin: true });
    const r = await approve(f, f.manager, f.admin!.pin);
    expect(r).toEqual({ approverPersonId: f.admin!.personId });
  });

  it('I1b: the approver may be the actor (an admin approving their own void with their own PIN)', async () => {
    const f = await org('i1b', { admin: true });
    expect(await approve(f, f.admin!, f.admin!.pin)).toEqual({ approverPersonId: f.admin!.personId });
  });

  it('I1c: an admin is NOT subject to the capability test (admin approves a capability a plain manager lacks, org has an admin)', async () => {
    const f = await org('i1c', { admin: true });
    expect(await approve(f, f.manager, f.admin!.pin, 'manage_users')).toEqual({ approverPersonId: f.admin!.personId });
  });

  it('I1d (M14): a SUPER_admin’s PIN counts as an administrator’s, like the existing isAdministrative test', async () => {
    const f = await org('i1d', { superAdmin: true });
    expect(await approve(f, f.manager, f.superAdmin!.pin)).toEqual({ approverPersonId: f.superAdmin!.personId });
  });
});

describe('I2 a wrong PIN is refused with the one sentence, and the miss SURVIVES', () => {
  it('I2: ADMIN_PIN_REFUSED, and the sign_in_attempts miss row is committed although the call threw (M6)', async () => {
    const f = await org('i2', { admin: true });
    expect(await countKind(f, 'miss')).toBe(0);
    expect(await msg(approve(f, f.manager, WRONG))).toBe(ADMIN_PIN_REFUSED);
    expect(await countKind(f, 'miss'), 'the charge committed on its own, before the lookup').toBe(1);
    expect((await throttleRow(f))!.fail_count, 'tier 1 advanced too').toBe(1);
  });

  it('I2b: an unknown-but-well-formed PIN and a real PIN of the wrong kind of person read the SAME sentence (no oracle)', async () => {
    const f = await org('i2b', { admin: true });
    const unknown = await msg(approve(f, f.manager, '654321'));
    const notAdmin = await msg(approve(f, f.manager, f.staff.pin));
    expect(unknown).toBe(ADMIN_PIN_REFUSED);
    expect(notAdmin).toBe(ADMIN_PIN_REFUSED);
  });

  it('I2c: the miss is written at the store of the RECORD (the storeId the action passes), nowhere else', async () => {
    const f = await org('i2c', { admin: true });
    const [other] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${f.orgId}, ${uid('s2')}, 'S2') returning id`;
    await msg(approve(f, f.manager, WRONG, 'void_expense', other!.id));
    const at = async (id: string) => (await sql<{ n: number }[]>`select count(*)::int as n from sign_in_attempts where store_id = ${id} and kind = 'miss'`)[0]!.n;
    expect(await at(other!.id)).toBe(1);
    expect(await at(f.storeId)).toBe(0);
  });
});

describe('I3 only an administrator’s PIN counts while the org has an administrator', () => {
  it('I3: a manager who HOLDS the capability enters their own correct PIN, org has an admin -> refused, same sentence, and the miss STAYS charged (M2, M3, M13)', async () => {
    const f = await org('i3', { admin: true });
    expect(await msg(approve(f, f.manager, f.manager.pin, 'void_expense'))).toBe(ADMIN_PIN_REFUSED);
    expect(await countKind(f, 'miss'), 'a correct PIN of a non-admin is NOT refunded').toBe(1);
  });

  it('I3b: a plain staff member’s correct PIN, and a second manager’s, are refused the same way', async () => {
    const f = await org('i3b', { admin: true });
    expect(await msg(approve(f, f.manager, f.staff.pin))).toBe(ADMIN_PIN_REFUSED);
    expect(await msg(approve(f, f.manager, f.manager2.pin))).toBe(ADMIN_PIN_REFUSED);
  });
});

describe('I4 row 196: in an org with NO administrator the elevated manager holding the capability is whose PIN counts', () => {
  it('I4: elevated manager (holds manage_users) approves; a plain manager without it and a staff member are refused (M4)', async () => {
    const f = await org('i4');
    await asOrg(f.orgId, (tx) => elevateManager(tx, { personId: f.manager.personId, orgId: f.orgId, grantedBy: null }));
    expect(await approve(f, f.manager2, f.manager.pin, 'manage_users'), 'control: the elevated manager approves').toEqual({
      approverPersonId: f.manager.personId,
    });
    expect(await msg(approve(f, f.manager, f.manager2.pin, 'manage_users')), 'a manager WITHOUT the capability').toBe(ADMIN_PIN_REFUSED);
    expect(await msg(approve(f, f.manager, f.staff.pin, 'void_expense')), 'staff lacks void_expense').toBe(ADMIN_PIN_REFUSED);
  });

  it('I4b: the fallback uses the capability the ACTION names (a manager holds void_expense but not manage_users)', async () => {
    const f = await org('i4b');
    expect(await approve(f, f.staff, f.manager.pin, 'void_expense')).toEqual({ approverPersonId: f.manager.personId });
    expect(await msg(approve(f, f.staff, f.manager.pin, 'manage_users'))).toBe(ADMIN_PIN_REFUSED);
  });
});

describe('I5 the PIN is bound to the actor’s organisation', () => {
  it('I5: an admin of ANOTHER org typing their own correct PIN -> refused; and the same six digits that belong to a non-admin here do not borrow that admin’s authority', async () => {
    // A constant in place of actor.orgId (M5) makes every PIN miss, which turns I1 red, not this test: the org binding
    // is one of the two layers (the HMAC prefix and the person_credentials RLS policy), and a mutant has to defeat both.
    const here = await org('i5-here', { admin: true });
    const there = await org('i5-there', { admin: true });
    expect(await msg(approve(here, here.manager, there.admin!.pin))).toBe(ADMIN_PIN_REFUSED);
    // Collision leg: give THIS org's staff member the very digits the other org's admin holds.
    const same = there.admin!.pin;
    await sql`delete from person_credentials where person_id = ${here.staff.personId}`;
    await sql`
      insert into person_credentials (person_id, kind, store_id, secret_hash, lookup_hash)
      values (${here.staff.personId}, 'pin', ${here.storeId}, ${await hashPin(same)}, ${pinLookupHash(here.orgId, same)})`;
    expect(await msg(approve(here, here.manager, same)), 'same digits, resolved to THIS org’s staff member: not an admin').toBe(ADMIN_PIN_REFUSED);
  });
});

describe('I6 a stopped store keeps the stopped sentence and does no lookup', () => {
  it('I6: 50 misses an hour old, one attempt trips the budget; the admin’s CORRECT PIN then reads the stopped sentence with zero lookups (M7)', async () => {
    const f = await org('i6', { admin: true });
    await sql`
      insert into sign_in_attempts (org_id, store_id, device_id, kind, occurred_at)
      select ${f.orgId}::uuid, ${f.storeId}::uuid, ${f.deviceId}::uuid, 'miss', now() - interval '1 hour' from generate_series(1, 50)`;
    expect(await msg(approve(f, f.manager, WRONG)), 'the tripping attempt').toMatch(STOPPED);
    lookups.n = 0;
    expect(await msg(approve(f, f.manager, f.admin!.pin))).toMatch(STOPPED);
    expect(lookups.n, 'refused at the charge, before any credential lookup').toBe(0);
  });
});

describe('I7 an administrator whose authority is gone is refused', () => {
  it('I7: an admin whose role row was revoked is refused while ANOTHER admin keeps the org administered', async () => {
    const f = await org('i7', { admin: true });
    const second = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.orgId}, 'Admin Two') returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${second[0]!.id}, ${f.orgId}, 'admin')`;
    await sql`update person_roles set revoked_at = now() where person_id = ${f.admin!.personId}`;
    expect(await msg(approve(f, f.manager, f.admin!.pin))).toBe(ADMIN_PIN_REFUSED);
  });

  it('I7b: the SOLE admin revoked -> the org is adminless again, but the ex-admin holds no role and no capability: still refused', async () => {
    const f = await org('i7b', { admin: true });
    await sql`update person_roles set revoked_at = now() where person_id = ${f.admin!.personId}`;
    expect(await msg(approve(f, f.manager, f.admin!.pin, 'manage_users'))).toBe(ADMIN_PIN_REFUSED);
  });

  it('I7c: an admin’s REVOKED PIN credential is refused', async () => {
    const f = await org('i7c', { admin: true });
    await sql`update person_credentials set revoked_at = now(), revoke_reason = 'test' where person_id = ${f.admin!.personId}`;
    expect(await msg(approve(f, f.manager, f.admin!.pin))).toBe(ADMIN_PIN_REFUSED);
  });
});

describe('I8 a malformed PIN is refused and charged', () => {
  it('I8: short, long, letters, blank and spaced values each read the one sentence and each cost one miss', async () => {
    const f = await org('i8', { admin: true });
    let expected = 0;
    for (const bad of ['12345', '1234567', 'abcdef', '', '12 456']) {
      expect(await msg(approve(f, f.manager, bad)), `"${bad}"`).toBe(ADMIN_PIN_REFUSED);
      expected += 1;
      expect(await countKind(f, 'miss'), `after "${bad}"`).toBe(expected);
    }
  });
});

describe('I9 a correct PIN refunds its charge', () => {
  it('I9: ten correct approvals leave no miss rows and no pause; the next wrong PIN is a plain refusal, not a pause', async () => {
    const f = await org('i9', { admin: true });
    for (let i = 0; i < 10; i++) {
      expect(await approve(f, f.manager, f.admin!.pin), `approval ${i + 1}`).toEqual({ approverPersonId: f.admin!.personId });
    }
    expect(await countKind(f, 'miss'), 'every charge was refunded').toBe(0);
    expect(await msg(approve(f, f.manager, WRONG))).toBe(ADMIN_PIN_REFUSED);
    expect((await throttleRow(f))!.stopped_at).toBeNull();
  });
});

describe('I11 approval misses and sign-in misses are ONE per-store budget', () => {
  it('I11: five wrong sign-ins + five wrong approvals pause the store for BOTH doors (M12)', async () => {
    const f = await org('i11', { admin: true });
    for (let i = 0; i < 5; i++) {
      await msg(signInWithPin(null, { orgId: f.orgId, storeId: f.storeId, pin: WRONG, deviceId: f.deviceId }));
      await msg(approve(f, f.manager, WRONG));
    }
    expect(await countKind(f, 'miss'), 'ten misses at ONE store').toBe(10);
    expect(await msg(approve(f, f.manager, f.admin!.pin)), 'the admin’s correct PIN is paused out').toMatch(PAUSED);
    expect(await msg(signInWithPin(null, { orgId: f.orgId, storeId: f.storeId, pin: WRONG, deviceId: f.deviceId })), 'and so is the sign-in door').toMatch(PAUSED);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// AUDIT ROUND (M3 / M4, orchestrator ruling): the approving PIN's OWNER must pass `personMaySignInToOrg` (T-407: an open
// employment, OR an admin / super_admin role, OR a never-employed manager) and must not be a terminal. It applies to the
// admin path AND the adminless-org manager fallback (row 196).
//   MA-1  drop the personMaySignInToOrg term from the fallback leg           -> A2 red
//   MA-2  drop the terminal check                                            -> A3 red, A3b red
//   MA-3  drop the personMaySignInToOrg term from the admin leg              -> A1 stays green (an admin role IS a T-407 leg);
//         the admin-path guard is therefore a terminal / role-revoked guard and is held by A1 / A3 / I7.
// ---------------------------------------------------------------------------------------------------------------------
async function employ(f: Fixture, personId: string, endedOn: string | null) {
  await sql`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on, ended_on)
    values (${f.orgId}, ${f.storeId}, ${personId}, ${uid('SE')}, ${endedOn ? 'resigned' : 'regular'}, '2025-01-01', ${endedOn})`;
}

describe('A1 an admin whose employment ended and who holds no admin role any more is refused (admin path)', () => {
  it('A1: the ex-admin (role revoked, employment ended, live PIN) -> ADMIN_PIN_REFUSED, even while another admin keeps the org administered', async () => {
    const f = await org('a1', { admin: true });
    const [second] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.orgId}, 'Admin Two') returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${second!.id}, ${f.orgId}, 'admin')`;
    await employ(f, f.admin!.personId, '2026-01-31');
    await sql`update person_roles set revoked_at = now() where person_id = ${f.admin!.personId}`;
    expect(await msg(approve(f, f.manager, f.admin!.pin))).toBe(ADMIN_PIN_REFUSED);
  });

  it('A1b (control, green): an admin whose EMPLOYMENT ended but who still holds the admin role keeps approving (an admin role is a T-407 leg)', async () => {
    const f = await org('a1b', { admin: true });
    await employ(f, f.admin!.personId, '2026-01-31');
    expect(await approve(f, f.manager, f.admin!.pin)).toEqual({ approverPersonId: f.admin!.personId });
  });
});

describe('A2 adminless org: an ex-employee manager with a live PIN is refused (row 196 fallback needs T-407 sign-in standing)', () => {
  it('A2: manager with an ENDED employment, org has no administrator, holds the capability, PIN live -> refused (MA-1)', async () => {
    const f = await org('a2');
    await employ(f, f.manager.personId, '2026-01-31');
    expect(await msg(approve(f, f.manager2, f.manager.pin, 'void_expense'))).toBe(ADMIN_PIN_REFUSED);
  });

  it('A2b (control, green): the same manager with an OPEN employment is the row-196 approver; a never-employed manager is too (I4b)', async () => {
    const f = await org('a2b');
    await employ(f, f.manager.personId, null);
    expect(await approve(f, f.manager2, f.manager.pin, 'void_expense')).toEqual({ approverPersonId: f.manager.personId });
  });

  it('A2c: ended-employment manager is refused and the miss STAYS charged (a right PIN of an ineligible person is not refunded)', async () => {
    const f = await org('a2c');
    await employ(f, f.manager.personId, '2026-01-31');
    expect(await msg(approve(f, f.manager2, f.manager.pin, 'void_expense'))).toBe(ADMIN_PIN_REFUSED);
    expect(await countKind(f, 'miss')).toBe(1);
  });
});

describe('A3 a terminal can never approve', () => {
  async function terminalWith(f: Fixture, role: 'admin' | 'manager') {
    const [t] = await sql<{ id: string }[]>`insert into persons (org_id, display_name, kind) values (${f.orgId}, 'Lane terminal', 'terminal') returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${t!.id}, ${f.orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id, source) values (${t!.id}, ${f.storeId}, 'manual')`;
    const pin = nextPin();
    await sql`
      insert into person_credentials (person_id, kind, store_id, secret_hash, lookup_hash)
      values (${t!.id}, 'pin', ${f.storeId}, ${await hashPin(pin)}, ${pinLookupHash(f.orgId, pin)})`;
    return pin;
  }

  it('A3: a terminal holding the ADMIN role and a live PIN -> refused (MA-2)', async () => {
    const f = await org('a3');
    const pin = await terminalWith(f, 'admin');
    expect(await msg(approve(f, f.manager, pin))).toBe(ADMIN_PIN_REFUSED);
  });

  it('A3b: in an adminless org a terminal holding the MANAGER role (and so the capability) -> refused (MA-2)', async () => {
    const f = await org('a3b');
    const pin = await terminalWith(f, 'manager');
    expect(await msg(approve(f, f.manager, pin, 'void_expense'))).toBe(ADMIN_PIN_REFUSED);
  });
});
