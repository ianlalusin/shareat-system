import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-464 - POS tablet: pair once, then Employee ID + PIN. docs/tasks/464-pos-tablet-sign-in.md.
 *
 * Covers the spec's Verification section except the page render (apps/erp tests) and the 9008 smoke test:
 *   - the auth-door lookup refuses: unknown, revoked and stale tokens each resolve to nothing, and it exposes four fields only;
 *   - an unpaired device cannot use the ID+PIN path: no / forged / revoked / 31-day-stale cookie -> one flat refusal, no `sessions` row, no charge;
 *   - the lockout policy: 5 wrong PINs for SE-007 pause THAT ID (even a correct 6th), another ID still signs in, an unknown ID pauses
 *     identically, 5 minutes later the correct PIN works, and the store's own tiers still count every miss;
 *   - codes are typed and scoped: 7 / 07 / 007 are one employment, letters and a 4th digit are refused, SE-007 elsewhere is not this one,
 *     an ended employment is refused, one scrypt on every path;
 *   - capability: staff and a manager of another store are refused, an admin and the store's manager succeed; pairing replaces the old
 *     tablet and ends its sessions; un-pairing needs the label retyped, ends sessions, and the next resolve is nothing.
 * Runs on ANY `_test` database; every row uses fresh ids.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) throw new Error('Refusing to run: the database name must contain "_test".');

import { APP_ROLE, closeDb, transaction, type Tx } from '@shareat/db';
import {
  AuthorizationError,
  AuthenticationError,
  BAD_ID_OR_PIN,
  STAFF_CODE_PAUSED,
  TABLET_NOT_PAIRED,
  flushSecurityEvents,
  hashPin,
  pairPosTablet,
  pinLookupHash,
  posTabletTokenHash,
  resolveActor,
  resolvePosTablet,
  signInOnPairedTablet,
  signInWithStaffCodeAndPin,
  unpairPosTablet,
} from '@shareat/auth';

const sql = postgres(url, { max: 5 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
let pinSeq = 0;
const nextPin = () => String(640100 + ++pinSeq);

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

async function fixture() {
  const code = uid('t464a');
  const orgId = (await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`)[0]!.id;
  const mkStore = async () => (await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('S')}, 'Lipa') returning id`)[0]!.id;
  const storeA = await mkStore();
  const storeB = await mkStore();
  const mkPerson = async (name: string, role: string | null, scopeStore?: string) => {
    const id = (await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`)[0]!.id;
    if (role) await sql`insert into person_roles (person_id, org_id, role) values (${id}, ${orgId}, ${role})`;
    if (scopeStore) await sql`insert into person_store_scope (person_id, store_id, source) values (${id}, ${scopeStore}, 'manual')`;
    return id;
  };
  const admin = await mkPerson('Admin', 'admin', storeA);
  const managerA = await mkPerson('Manager A', 'manager', storeA);
  const managerB = await mkPerson('Manager B', 'manager', storeB);
  const staffPerson = await mkPerson('Plain Staff', 'staff', storeA);
  /** A cashier employed at `storeId` under `staffCode`, with a live PIN (or none). */
  const employee = async (name: string, storeId: string, staffCode: string, opts: { pin?: boolean; ended?: boolean } = {}) => {
    const personId = await mkPerson(name, 'staff');
    await sql`insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on, ended_on)
              values (${orgId}, ${storeId}, ${personId}, ${staffCode}, ${opts.ended ? 'terminated' : 'regular'}, '2026-01-01', ${opts.ended ? '2026-02-01' : null})`;
    const pin = nextPin();
    if (opts.pin !== false) {
      await sql`insert into person_credentials (person_id, kind, store_id, secret_hash, lookup_hash)
                values (${personId}, 'pin', ${storeId}, ${await hashPin(pin)}, ${pinLookupHash(orgId, pin)})`;
    }
    return { personId, pin };
  };
  const actor = (personId: string) => ({ personId, orgId });
  const pair = (who: string, storeId: string, label = 'Lipa counter') => asOrg(orgId, (tx) => pairPosTablet(tx, actor(who), { storeId, label }));
  return { orgId, storeA, storeB, admin, managerA, managerB, staffPerson, employee, actor, pair };
}

const err = (p: Promise<unknown>) => p.then(() => null, (e: Error & { userMessage?: string }) => e);
const sessionCount = async (orgId: string) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from sessions s join persons p on p.id = s.person_id where p.org_id = ${orgId}`)[0]!.n;
const attemptCount = async (storeId: string) => (await sql<{ n: number }[]>`select count(*)::int as n from sign_in_attempts where store_id = ${storeId}`)[0]!.n;

describe('resolvePosTablet - the auth-door lookup (bible row 382) refuses', () => {
  it('unknown, revoked and stale tokens each resolve to nothing; a live one resolves to exactly four fields', async () => {
    const f = await fixture();
    const live = await f.pair(f.managerA, f.storeA);
    const hit = await resolvePosTablet(null, live.token);
    expect(hit, 'mutant: the live lookup is broken').toEqual({ pairingId: live.pairingId, orgId: f.orgId, storeId: f.storeA, label: 'Lipa counter' });
    expect(Object.keys(hit!).sort(), 'no other column is reachable through the door').toEqual(['label', 'orgId', 'pairingId', 'storeId']);

    expect(await resolvePosTablet(null, 'A'.repeat(43)), 'an unknown (well-formed) token').toBeNull();
    expect(await resolvePosTablet(null, 'not-a-token'), 'a malformed token never reaches the database').toBeNull();
    expect(await resolvePosTablet(null, null)).toBeNull();
    expect(await resolvePosTablet(null, undefined)).toBeNull();

    await sql`update pos_tablet_pairings set revoked_at = now(), revoked_by = ${f.managerA} where id = ${live.pairingId}`;
    expect(await resolvePosTablet(null, live.token), 'mutant: revoked_at not checked').toBeNull();

    const stale = await f.pair(f.managerA, f.storeA, 'Old drawer');
    await sql`update pos_tablet_pairings set paired_at = now() - interval '31 days', last_used_at = now() - interval '31 days' where id = ${stale.pairingId}`;
    expect(await resolvePosTablet(null, stale.token), 'mutant: the 30-day idle rule removed').toBeNull();
    await sql`update pos_tablet_pairings set last_used_at = now() - interval '29 days' where id = ${stale.pairingId}`;
    expect((await resolvePosTablet(null, stale.token))?.pairingId, '29 days idle is still live').toBe(stale.pairingId);
  });

  it('only the hash is stored, never the cookie value', async () => {
    const f = await fixture();
    const p = await f.pair(f.managerA, f.storeA);
    const [row] = await sql<{ cookie_digest: string }[]>`select cookie_digest from pos_tablet_pairings where id = ${p.pairingId}`;
    expect(row!.cookie_digest).toBe(posTabletTokenHash(p.token));
    expect(row!.cookie_digest).not.toBe(p.token);
  });
});

describe('an unpaired device cannot use the ID + PIN path', () => {
  it('no cookie, a forged cookie, a revoked pairing and a 31-day-stale pairing: one flat refusal, no session, no charge', async () => {
    const f = await fixture();
    const emp = await f.employee('Cashier', f.storeA, 'SE-007');
    const revoked = await f.pair(f.managerA, f.storeA, 'Revoked');
    await sql`update pos_tablet_pairings set revoked_at = now(), revoked_by = ${f.managerA} where id = ${revoked.pairingId}`;
    const stale = await f.pair(f.managerA, f.storeA, 'Stale');
    await sql`update pos_tablet_pairings set paired_at = now() - interval '31 days', last_used_at = now() - interval '31 days' where id = ${stale.pairingId}`;

    for (const [what, cookie] of [
      ['no cookie', null],
      ['a forged cookie', 'Zm9yZ2VkZm9yZ2VkZm9yZ2VkZm9yZ2VkZm9yZ2VkZm9yZ2U'],
      ['a revoked pairing', revoked.token],
      ['a stale pairing', stale.token],
    ] as const) {
      const e = await err(signInOnPairedTablet(null, { cookieToken: cookie, staffCode: '7', pin: emp.pin }));
      expect(e, `${what}: mutant - the pairing check is bypassed and the right PIN signs in`).toBeInstanceOf(AuthenticationError);
      expect(e!.message, what).toBe(TABLET_NOT_PAIRED);
    }
    expect(await sessionCount(f.orgId)).toBe(0);
    expect(await attemptCount(f.storeA), 'refused before any charge').toBe(0);
  });
});

describe('signing in on a paired tablet', () => {
  it('7, 07 and 007 reach the same person; the session is a PIN session bound to the store and to the pairing; last_used_at is stamped', async () => {
    const f = await fixture();
    const emp = await f.employee('Ana', f.storeA, 'SE-007');
    const p = await f.pair(f.managerA, f.storeA);
    expect((await sql<{ last_used_at: Date | null }[]>`select last_used_at from pos_tablet_pairings where id = ${p.pairingId}`)[0]!.last_used_at).toBeNull();
    for (const typed of ['7', '07', '007']) {
      const r = await signInOnPairedTablet(null, { cookieToken: p.token, staffCode: typed, pin: emp.pin });
      expect(r.personId, typed).toBe(emp.personId);
      const [row] = await sql<{ credential_kind: string; store_id: string; device_id: string }[]>`select credential_kind, store_id, device_id from sessions where id = ${r.sessionId}`;
      expect(row).toEqual({ credential_kind: 'pin', store_id: f.storeA, device_id: p.pairingId });
      const resolved = await resolveActor(null, r.token);
      expect(resolved.actor.personId).toBe(emp.personId);
    }
    expect((await sql<{ last_used_at: Date | null }[]>`select last_used_at from pos_tablet_pairings where id = ${p.pairingId}`)[0]!.last_used_at).not.toBeNull();
    await flushSecurityEvents();
    const audit = await sql`select 1 from audit_log where org_id = ${f.orgId} and action = 'auth.pin_signin_succeeded' and entity_id = ${emp.personId}`;
    expect(audit.length).toBeGreaterThanOrEqual(3);
  });

  it('an un-pair that lands after the cookie was resolved still refuses: no session is issued for a revoked pairing (audit finding 1)', async () => {
    const f = await fixture();
    const emp = await f.employee('Ana', f.storeA, 'SE-007');
    const p = await f.pair(f.managerA, f.storeA);
    // The pairing was resolved (the caller holds its id) and is then revoked before the PIN lookup runs.
    await sql`update pos_tablet_pairings set revoked_at = now(), revoked_by = ${f.managerA}, revoke_reason = 'race' where id = ${p.pairingId}`;
    await expect(
      signInWithStaffCodeAndPin(null, { orgId: f.orgId, storeId: f.storeA, pairingId: p.pairingId, staffCode: '7', pin: emp.pin }),
    ).rejects.toThrow(TABLET_NOT_PAIRED);
    expect((await sql`select 1 from sessions where device_id = ${p.pairingId}`).length).toBe(0);
  });

  it("re-pairing a browser that holds store A's cookie to store B gives A's pairing up (audit finding 4)", async () => {
    const f = await fixture();
    await sql`insert into person_store_scope (person_id, store_id, source) values (${f.admin}, ${f.storeB}, 'manual')`;
    const a = await f.pair(f.admin, f.storeA, 'Counter A');
    const b = await asOrg(f.orgId, (tx) =>
      pairPosTablet(tx, { personId: f.admin, orgId: f.orgId }, { storeId: f.storeB, label: 'Counter B', previousToken: a.token }),
    );
    expect(await resolvePosTablet(null, a.token)).toBeNull();
    expect((await resolvePosTablet(null, b.token))?.storeId).toBe(f.storeB);
    await flushSecurityEvents();
    expect((await sql`select 1 from audit_log where org_id = ${f.orgId} and action = 'pos_tablet.unpaired' and entity_id = ${a.pairingId}`).length).toBe(1);
  });

  it('every failure says the same sentence: wrong PIN, unknown ID, an ID with no PIN, letters, a 4th digit, an ended employment, another store\'s ID', async () => {
    const f = await fixture();
    const emp = await f.employee('Ana', f.storeA, 'SE-007');
    await f.employee('No Pin', f.storeA, 'SE-008', { pin: false });
    await f.employee('Gone', f.storeA, 'SE-009', { ended: true });
    const other = await f.employee('Elsewhere', f.storeB, 'SE-010');
    const p = await f.pair(f.managerA, f.storeA);
    const wrong = emp.pin === '000000' ? '111111' : '000000';
    const tries: Array<[string, string, string]> = [
      ['wrong PIN', '7', wrong],
      ['unknown ID', '555', emp.pin],
      ['ID with no PIN', '8', emp.pin],
      ['ended employment', '9', emp.pin],
      ["another store's ID with its own right PIN", '10', other.pin],
      ['letters', 'SE-7', emp.pin],
      ['a 4th digit', '0007', emp.pin],
      ['an empty ID', '', emp.pin],
      ['a short PIN', '7', '12345'],
    ];
    for (const [what, id, pin] of tries) {
      const e = await err(signInOnPairedTablet(null, { cookieToken: p.token, staffCode: id, pin }));
      expect(e, what).toBeInstanceOf(AuthenticationError);
      expect(e!.message, what).toBe(BAD_ID_OR_PIN);
    }
    expect(await sessionCount(f.orgId)).toBe(0);
  });

  it('SE-007 at another store is not this store\'s SE-007', async () => {
    const f = await fixture();
    const here = await f.employee('Here', f.storeA, 'SE-007');
    const there = await f.employee('There', f.storeB, 'SE-007');
    const p = await f.pair(f.managerA, f.storeA);
    expect((await signInOnPairedTablet(null, { cookieToken: p.token, staffCode: '007', pin: here.pin })).personId).toBe(here.personId);
    const e = await err(signInOnPairedTablet(null, { cookieToken: p.token, staffCode: '007', pin: there.pin }));
    expect(e!.message, 'the other store\'s person, right PIN, wrong store').toBe(BAD_ID_OR_PIN);
  });
});

describe('the lockout policy', () => {
  const miss = (token: string, id: string, pin: string) => err(signInOnPairedTablet(null, { cookieToken: token, staffCode: id, pin }));

  it('5 wrong PINs pause that Employee ID: the 6th, even correct, is paused; another ID still signs in; 5 minutes later it works; the store counted every miss', async () => {
    const f = await fixture();
    const a = await f.employee('Ana', f.storeA, 'SE-007');
    const b = await f.employee('Ben', f.storeA, 'SE-008');
    const p = await f.pair(f.managerA, f.storeA);
    const wrong = '000001';
    for (let i = 0; i < 5; i++) expect((await miss(p.token, '7', wrong))!.message).toBe(BAD_ID_OR_PIN);

    const paused = await miss(p.token, '7', a.pin);
    expect(paused!.message, 'mutant: no per-ID pause').toBe(STAFF_CODE_PAUSED);
    expect(paused!.message).toBe('Too many wrong PINs for this Employee ID. Wait 5 minutes.');
    expect((await signInOnPairedTablet(null, { cookieToken: p.token, staffCode: '8', pin: b.pin })).personId, 'another ID is not paused').toBe(b.personId);

    // Store tiers 1 and 2 still count these misses: 5 wrong + the paused attempt (+0 for Ben's success, refunded).
    const storeMisses = (await sql<{ n: number }[]>`select count(*)::int as n from sign_in_attempts where store_id = ${f.storeA} and staff_code is null and kind = 'miss'`)[0]!.n;
    expect(storeMisses, 'mutant: the store bucket is not charged on the tablet path').toBe(6);
    expect((await sql<{ n: number }[]>`select count(*)::int as n from sign_in_attempts where store_id = ${f.storeA} and staff_code = 'SE-007' and kind = 'miss'`)[0]!.n).toBe(5);

    // a controlled clock: move the pause into the past
    await sql`update pin_attempt_throttle set locked_until = now() - interval '1 second', window_started_at = now() - interval '6 minutes' where store_id = ${f.storeA} and staff_code = 'SE-007'`;
    expect((await signInOnPairedTablet(null, { cookieToken: p.token, staffCode: '7', pin: a.pin })).personId).toBe(a.personId);
    const [row] = await sql<{ fail_count: number; locked_until: Date | null }[]>`select fail_count, locked_until from pin_attempt_throttle where store_id = ${f.storeA} and staff_code = 'SE-007'`;
    expect(row, 'success clears the Employee ID bucket').toEqual({ fail_count: 0, locked_until: null });
  });

  it('an unknown ID pauses identically (the pause does not show whether a code exists)', async () => {
    const f = await fixture();
    const real = await f.employee('Ana', f.storeA, 'SE-007');
    const p = await f.pair(f.managerA, f.storeA);
    for (let i = 0; i < 5; i++) expect((await miss(p.token, '555', real.pin))!.message).toBe(BAD_ID_OR_PIN);
    expect((await miss(p.token, '555', real.pin))!.message).toBe(STAFF_CODE_PAUSED);
    // the real code's PIN is untouched by 555's pause
    expect((await signInOnPairedTablet(null, { cookieToken: p.token, staffCode: '7', pin: real.pin })).personId).toBe(real.personId);
  });

  it('the store\'s own tier 1 still pauses the whole terminal after 10 misses in a minute (spread over different IDs)', async () => {
    const f = await fixture();
    const a = await f.employee('Ana', f.storeA, 'SE-007');
    const p = await f.pair(f.managerA, f.storeA);
    for (let i = 0; i < 10; i++) await miss(p.token, String(100 + i), '000002');
    const e = await miss(p.token, '7', a.pin);
    expect(e!.message, 'mutant: store tier 1 bypassed').toMatch(/This terminal is paused until/);
  });
});

describe('capability pair_pos_tablet', () => {
  it('a staff member and a manager of ANOTHER store are refused; the store\'s manager and an admin pair', async () => {
    const f = await fixture();
    const e1 = await err(f.pair(f.staffPerson, f.storeA));
    expect(e1, 'mutant: staff holds the capability').toBeInstanceOf(AuthorizationError);
    const e2 = await err(f.pair(f.managerB, f.storeA));
    expect(e2, 'mutant: capability not store-scoped').toBeInstanceOf(AuthorizationError);
    expect((await f.pair(f.managerA, f.storeA)).pairingId).toBeTruthy();
    expect((await f.pair(f.admin, f.storeA, 'Replacement')).pairingId).toBeTruthy();
    expect((await sql`select 1 from pos_tablet_pairings where store_id = ${f.storeA} and revoked_at is null`).length).toBe(1);
  });

  it('un-pair: the same refusals; the label must be retyped; it ends the tablet\'s live session and the next resolve is nothing', async () => {
    const f = await fixture();
    const emp = await f.employee('Ana', f.storeA, 'SE-007');
    const p = await f.pair(f.managerA, f.storeA, 'Lipa counter');
    const live = await signInOnPairedTablet(null, { cookieToken: p.token, staffCode: '7', pin: emp.pin });
    const unpair = (who: string, confirmLabel: string) => asOrg(f.orgId, (tx) => unpairPosTablet(tx, f.actor(who), { pairingId: p.pairingId, confirmLabel }));

    expect(await err(unpair(f.staffPerson, 'Lipa counter')), 'staff').toBeInstanceOf(AuthorizationError);
    expect(await err(unpair(f.managerB, 'Lipa counter')), 'a manager of another store').toBeInstanceOf(AuthorizationError);
    const wrongLabel = await err(unpair(f.managerA, 'lipa counter 2'));
    expect(wrongLabel?.userMessage, 'mutant: the label confirm is skipped').toMatch(/Type the tablet's name exactly/);
    expect((await resolvePosTablet(null, p.token))?.pairingId, 'still paired after the refusals').toBe(p.pairingId);
    expect((await resolveActor(null, live.token)).actor.personId).toBe(emp.personId);

    const done = await unpair(f.admin, 'Lipa counter');
    expect(done.sessionsEnded, 'mutant: endAllForDevice not called').toBe(1);
    expect(await resolvePosTablet(null, p.token)).toBeNull();
    expect(await err(resolveActor(null, live.token)), 'the tablet\'s next request is signed out').toBeInstanceOf(AuthenticationError);
    expect((await err(unpair(f.admin, 'Lipa counter')))?.userMessage, 'a second un-pair').toMatch(/not paired/);

    await flushSecurityEvents();
    const acts = (await sql<{ action: string }[]>`select action from audit_log where org_id = ${f.orgId} and action in ('pos_tablet.paired','pos_tablet.unpaired','session.ended_all') order by action`).map((r) => r.action);
    expect(acts).toEqual(['pos_tablet.paired', 'pos_tablet.unpaired', 'session.ended_all']);
  });

  it('pairing a new tablet revokes the old pairing and ends its sessions in the same transaction', async () => {
    const f = await fixture();
    const emp = await f.employee('Ana', f.storeA, 'SE-007');
    const oldP = await f.pair(f.managerA, f.storeA, 'Lipa counter');
    const live = await signInOnPairedTablet(null, { cookieToken: oldP.token, staffCode: '7', pin: emp.pin });
    const newP = await f.pair(f.managerA, f.storeA, 'Second counter');
    expect(newP.replaced).toEqual({ id: oldP.pairingId, label: 'Lipa counter' });
    expect(await resolvePosTablet(null, oldP.token), 'the old cookie is dead').toBeNull();
    expect((await resolvePosTablet(null, newP.token))?.pairingId).toBe(newP.pairingId);
    expect(await err(resolveActor(null, live.token)), 'mutant: the old tablet\'s session survives').toBeInstanceOf(AuthenticationError);
    const [old] = await sql<{ revoked_by: string; revoke_reason: string }[]>`select revoked_by, revoke_reason from pos_tablet_pairings where id = ${oldP.pairingId}`;
    expect(old!.revoked_by).toBe(f.managerA);
  });

  it('a blank or over-long label is refused', async () => {
    const f = await fixture();
    expect((await err(f.pair(f.managerA, f.storeA, '   ')))?.userMessage).toMatch(/name of 1 to 60/);
    expect((await err(f.pair(f.managerA, f.storeA, 'x'.repeat(61))))?.userMessage).toMatch(/name of 1 to 60/);
  });
});
