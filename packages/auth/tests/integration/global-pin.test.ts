import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-302 — one PIN identifies one person across every branch, keyed `orgId:pin`.
 * docs/tasks/302-global-pin-uniqueness.md, against real Postgres (RULES §9.3 — never a mock).
 *
 * ## What each group is here to catch
 *
 * - **across branches** — the feature. Before T-302 the lookup hash mixed in the STORE, so the
 *   same person needed different digits at each branch; `runPinSignIn`'s store-EQUALITY guard then
 *   refused any attempt elsewhere.
 * - **who may sign in here** — the gate that replaced that guard. ⛔ The spec said
 *   `personHasStoreScope` alone; measuring showed nothing in the hire flow writes a scope row, so
 *   a scope-only gate would refuse a normally-hired cashier with the flat `BAD_PIN` sentence.
 *   **Both legs are tested separately**, because a gate that happens to admit everybody through
 *   one of them is not tested at all.
 * - **one organisation, not two** — bible invariant 7. This is the group that must fail if the key
 *   ever drifts back to a tenant-blind `HMAC(pin)`, and the group that proves T-302/B1's move of
 *   the lookup off the auth door onto `withOrgPrincipal` actually bites.
 * - **constant cost** — the timing oracle T-302 creates and must close in the same task.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { closeDb, transaction, APP_ROLE, sessionsRepo, accessRepo, type Tx } from '@shareat/db';
import {
  signInWithPin,
  setPin,
  verifyPin,
  pinLookupHash,
  DUMMY_SCRYPT_HASH,
  AuthenticationError,
} from '@shareat/auth';

const sql = postgres(url, { max: 5 });

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

interface Org {
  orgId: string;
  storeA: string;
  storeB: string;
}

async function mkOrg(hint: string): Promise<Org> {
  const code = uid(`o-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id
  `;
  const orgId = org!.id;
  const mkStore = async (h: string) => {
    const [r] = await sql<{ id: string }[]>`
      insert into stores (org_id, code, name) values (${orgId}, ${uid(h)}, ${`Store ${h}`}) returning id
    `;
    return r!.id;
  };
  return { orgId, storeA: await mkStore(`${hint}-A`), storeB: await mkStore(`${hint}-B`) };
}

async function mkPerson(orgId: string, name: string): Promise<string> {
  const [r] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id
  `;
  return r!.id;
}

/**
 * ⚠️ Raw inserts rather than `createEmployment` / `grantStoreScope`, deliberately: this file is
 * testing the SIGN-IN gate, and routing the fixture through the domain would drag in positions,
 * `enrol_staff` and a whole capability fixture to establish one row. What matters here is which
 * row exists.
 */
async function hireAt(orgId: string, personId: string, storeId: string): Promise<void> {
  await sql`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${orgId}, ${storeId}, ${personId}, ${uid('SC')}, 'regular', '2026-01-01')
  `;
}

async function scopeAt(personId: string, storeId: string): Promise<void> {
  await sql`insert into person_store_scope (person_id, store_id) values (${personId}, ${storeId})`;
}

/** Runs under the real RLS principal, exactly as a request would. */
async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

async function livePinRows(personId: string): Promise<{ id: string; store_id: string }[]> {
  return sql<{ id: string; store_id: string }[]>`
    select id, store_id from person_credentials
    where person_id = ${personId} and kind = 'pin' and revoked_at is null
  `;
}

beforeAll(async () => {
  await sql`truncate table sessions, person_credentials, person_store_scope, employments restart identity cascade`;
});

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

// =========================================================================================

describe('a PIN works across branches', () => {
  it('⭐ signs its holder in at a branch the PIN was NOT issued at', async () => {
    // ⛔ THE TEST THE WHOLE TASK EXISTS FOR, and the one that would have caught the spec's fix #1.
    // Before T-302 this failed with BAD_PIN: the lookup hash mixed in store A, so store B's hash
    // matched nothing — and had it matched, the store-equality guard refused it anyway.
    const o = await mkOrg('across');
    const p = await mkPerson(o.orgId, 'Two Branch Cashier');
    await hireAt(o.orgId, p, o.storeA);
    await hireAt(o.orgId, p, o.storeB);
    await asOrg(o.orgId, (tx) => setPin(tx, { orgId: o.orgId, personId: p, storeId: o.storeA, pin: '445511' }));

    const res = await signInWithPin(null, { orgId: o.orgId, storeId: o.storeB, pin: '445511' });
    expect(res.personId).toBe(p);
  });

  it('leaves ONE live PIN when re-issued at a second branch, not two', async () => {
    // The spec's fix #2. `setPin`'s retire loop used to be narrowed to the store it was called
    // with, so the person's PIN at the other branch stayed live, the insert hit the unique index,
    // and the UI blamed the admin for a PIN that was the person's own.
    const o = await mkOrg('one-pin');
    const p = await mkPerson(o.orgId, 'Re-issued');
    await hireAt(o.orgId, p, o.storeA);
    await hireAt(o.orgId, p, o.storeB);

    await asOrg(o.orgId, (tx) => setPin(tx, { orgId: o.orgId, personId: p, storeId: o.storeA, pin: '445522' }));
    await asOrg(o.orgId, (tx) => setPin(tx, { orgId: o.orgId, personId: p, storeId: o.storeB, pin: '445522' }));

    const rows = await livePinRows(p);
    expect(rows).toHaveLength(1);
    // ⚠️ The surviving row is stamped with store B — where it was last ISSUED, never where it
    // works. Asserted so the next reader finds the rule stated rather than inferring the old one.
    expect(rows[0]!.store_id).toBe(o.storeB);
  });

  it('ends the holder’s sessions at OTHER branches when the PIN is re-issued', async () => {
    // ⭐ The site the spec missed entirely (`endAllForPerson`'s fourth argument). One credential
    // means one revocation, so a session opened with it anywhere must not outlive it.
    const o = await mkOrg('sessions');
    const p = await mkPerson(o.orgId, 'Session Holder');
    await hireAt(o.orgId, p, o.storeA);
    await hireAt(o.orgId, p, o.storeB);
    await asOrg(o.orgId, (tx) => setPin(tx, { orgId: o.orgId, personId: p, storeId: o.storeA, pin: '445533' }));

    const atA = await signInWithPin(null, { orgId: o.orgId, storeId: o.storeA, pin: '445533' });

    await asOrg(o.orgId, (tx) => setPin(tx, { orgId: o.orgId, personId: p, storeId: o.storeB, pin: '445544' }));

    const [row] = await sql<{ ended_at: Date | null }[]>`
      select ended_at from sessions where id = ${atA.sessionId}
    `;
    expect(row!.ended_at).not.toBeNull();
  });
});

describe('who may sign in here — employment OR store scope, and both legs matter', () => {
  /*
   * ⛔ **BOTH LEG TESTS ISSUE THE PIN AT STORE A AND SIGN IN AT STORE B, AND THAT IS THE WHOLE
   * DESIGN OF THEM.** Written the obvious way — issue at A, sign in at A — they passed against the
   * OLD store-equality guard as happily as against the new gate, because `credential.storeId ===
   * input.storeId` was trivially true. Caught by reverting the gate and watching them stay green:
   * a test that only ever passed proves nothing (RULES §3.2). Signing in somewhere the credential
   * was NOT stamped is the only arrangement in which the gate is the thing deciding.
   */
  it('an open employment at this branch is enough, with no scope row anywhere', async () => {
    // ⛔ The leg the spec's scope-only gate would have refused — a normally-hired cashier, whose
    // scope row nothing in the hire flow ever writes.
    const o = await mkOrg('emp-leg');
    const p = await mkPerson(o.orgId, 'Hired Only');
    await hireAt(o.orgId, p, o.storeB);
    await asOrg(o.orgId, (tx) => setPin(tx, { orgId: o.orgId, personId: p, storeId: o.storeA, pin: '445555' }));

    expect(await sql`select 1 from person_store_scope where person_id = ${p}`).toHaveLength(0);
    const res = await signInWithPin(null, { orgId: o.orgId, storeId: o.storeB, pin: '445555' });
    expect(res.personId).toBe(p);

    // …and the employment is what admitted them, not the credential's own stamp: store A is where
    // the PIN row points and they are refused there.
    await expect(signInWithPin(null, { orgId: o.orgId, storeId: o.storeA, pin: '445555' })).rejects.toThrow(
      AuthenticationError,
    );
  });

  it('a store-scope row is enough for the founding admin (admin role, no employment anywhere)', async () => {
    // `bootstrapOrganization`'s first admin holds scope (via `createStore`'s fan-out) and has no
    // employment at all, so an employment-only gate would lock the owner out of their own tills.
    const o = await mkOrg('scope-leg');
    const p = await mkPerson(o.orgId, 'Admin Only');
    await scopeAt(p, o.storeB);
    // T-407: scope alone no longer admits; the founding admin's shape is scope + an active admin role (R1 leg b), no employment.
    await sql`insert into person_roles (person_id, org_id, role) values (${p}, ${o.orgId}, 'admin')`;
    await asOrg(o.orgId, (tx) => setPin(tx, { orgId: o.orgId, personId: p, storeId: o.storeA, pin: '445566' }));

    expect(await sql`select 1 from employments where person_id = ${p}`).toHaveLength(0);
    const res = await signInWithPin(null, { orgId: o.orgId, storeId: o.storeB, pin: '445566' });
    expect(res.personId).toBe(p);

    await expect(signInWithPin(null, { orgId: o.orgId, storeId: o.storeA, pin: '445566' })).rejects.toThrow(
      AuthenticationError,
    );
  });

  it('neither row at this branch is refused — with the SAME flat sentence as an unknown PIN', async () => {
    const o = await mkOrg('no-leg');
    const p = await mkPerson(o.orgId, 'Elsewhere');
    await hireAt(o.orgId, p, o.storeA);
    await asOrg(o.orgId, (tx) => setPin(tx, { orgId: o.orgId, personId: p, storeId: o.storeA, pin: '445577' }));

    const refused = await signInWithPin(null, { orgId: o.orgId, storeId: o.storeB, pin: '445577' }).catch(
      (e: Error) => e.message,
    );
    const unknown = await signInWithPin(null, { orgId: o.orgId, storeId: o.storeB, pin: '445588' }).catch(
      (e: Error) => e.message,
    );
    // ⛔ Identical, deliberately. A distinguishable "valid, but not at this branch" would tell
    // anyone at any terminal whether six guessed digits are live somewhere in the business.
    expect(refused).toBe(unknown);
    expect(refused).not.toMatch(/store/i);
  });

  it('an ENDED employment at this branch is not enough', async () => {
    const o = await mkOrg('ended');
    const p = await mkPerson(o.orgId, 'Resigned');
    await hireAt(o.orgId, p, o.storeA);
    await hireAt(o.orgId, p, o.storeB);
    await asOrg(o.orgId, (tx) => setPin(tx, { orgId: o.orgId, personId: p, storeId: o.storeA, pin: '445599' }));
    await sql`
      update employments set ended_on = '2026-06-01', employment_status = 'resigned'
      where person_id = ${p} and store_id = ${o.storeB}
    `;

    await expect(signInWithPin(null, { orgId: o.orgId, storeId: o.storeB, pin: '445599' })).rejects.toThrow(
      AuthenticationError,
    );
    // Still fine where they still work — the refusal above is about the branch, not the person.
    const res = await signInWithPin(null, { orgId: o.orgId, storeId: o.storeA, pin: '445599' });
    expect(res.personId).toBe(p);
  });

  it('personMaySignInAtStore answers the two legs independently', async () => {
    const o = await mkOrg('pred');
    const employed = await mkPerson(o.orgId, 'Employed');
    const scoped = await mkPerson(o.orgId, 'Scoped');
    const neither = await mkPerson(o.orgId, 'Neither');
    await hireAt(o.orgId, employed, o.storeA);
    await scopeAt(scoped, o.storeA);
    // T-407 S3: scope alone no longer admits (R2 = scope-or-employment HERE, AND the org-level rule R1). `scoped` is a
    // never-employed manager (the franchise-owner shape, R1 leg c), so it still answers true, and for the stated reason.
    await sql`insert into person_roles (person_id, org_id, role) values (${scoped}, ${o.orgId}, 'manager')`;

    await asOrg(o.orgId, async (tx) => {
      expect(await accessRepo.personMaySignInAtStore(tx, employed, o.storeA)).toBe(true);
      expect(await accessRepo.personMaySignInAtStore(tx, scoped, o.storeA)).toBe(true);
      expect(await accessRepo.personMaySignInAtStore(tx, neither, o.storeA)).toBe(false);
      expect(await accessRepo.personMaySignInAtStore(tx, employed, o.storeB)).toBe(false);
    });
  });
});

describe('one organisation, not two — bible invariant 7', () => {
  it('refuses a second person in the SAME org taking six digits already live', async () => {
    const o = await mkOrg('same-org');
    const first = await mkPerson(o.orgId, 'First');
    const second = await mkPerson(o.orgId, 'Second');
    await hireAt(o.orgId, first, o.storeA);
    // ⚠️ A DIFFERENT store, on purpose: before T-302 these were two different hashes and both
    // inserts succeeded. The collision is the feature.
    await hireAt(o.orgId, second, o.storeB);

    await asOrg(o.orgId, (tx) => setPin(tx, { orgId: o.orgId, personId: first, storeId: o.storeA, pin: '446600' }));
    await expect(
      asOrg(o.orgId, (tx) => setPin(tx, { orgId: o.orgId, personId: second, storeId: o.storeB, pin: '446600' })),
    ).rejects.toThrow(/already in use/);
  });

  it('two organisations may BOTH hold the same six digits, with no collision', async () => {
    // ⭐ This is what `orgId:pin` buys over a tenant-blind `HMAC(pin)`: no cross-tenant oracle.
    const o1 = await mkOrg('org-1');
    const o2 = await mkOrg('org-2');
    const p1 = await mkPerson(o1.orgId, 'In One');
    const p2 = await mkPerson(o2.orgId, 'In Two');
    await hireAt(o1.orgId, p1, o1.storeA);
    await hireAt(o2.orgId, p2, o2.storeA);

    await asOrg(o1.orgId, (tx) => setPin(tx, { orgId: o1.orgId, personId: p1, storeId: o1.storeA, pin: '446611' }));
    await asOrg(o2.orgId, (tx) => setPin(tx, { orgId: o2.orgId, personId: p2, storeId: o2.storeA, pin: '446611' }));

    expect(await livePinRows(p1)).toHaveLength(1);
    expect(await livePinRows(p2)).toHaveLength(1);
    expect(pinLookupHash(o1.orgId, '446611')).not.toBe(pinLookupHash(o2.orgId, '446611'));

    // …and each signs in only in their own organisation.
    expect((await signInWithPin(null, { orgId: o1.orgId, storeId: o1.storeA, pin: '446611' })).personId).toBe(p1);
    expect((await signInWithPin(null, { orgId: o2.orgId, storeId: o2.storeA, pin: '446611' })).personId).toBe(p2);
  });

  it('⛔ a PIN live in org A does not authenticate at a terminal in org B', async () => {
    // ⛔ **T-302/B1's deliverable.** Two layers have to hold for this, and the test is deliberately
    // blind to which one does: the HMAC is keyed on the org, AND the lookup now runs under
    // `withOrgPrincipal(orgId, …)` where `person_credentials_via_person` refuses a foreign-org row
    // outright. Bible §15.11 — no layer may be the only one for a given risk. Until T-302 this
    // lookup ran on the auth door, where RLS is bypassed and the key was the only thing standing.
    const o1 = await mkOrg('leak-1');
    const o2 = await mkOrg('leak-2');
    const p1 = await mkPerson(o1.orgId, 'Org A Staff');
    await hireAt(o1.orgId, p1, o1.storeA);
    // Before migration 0194 (T-398 S1) this gave org A's person an employment in org B's store, so the GATE could not be what refused
    // the sign-in. 0194 makes (org_id, person_id) a same-org composite FK, so that fixture is impossible by construction. The DB now
    // refuses it (23503 naming the constraint) and the sign-in assertion below stands on the credential lookup alone.
    const crossOrg = await sql`
      insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
      values (${o2.orgId}, ${o2.storeA}, ${p1}, ${uid('SC')}, 'regular', '2026-01-01')
    `.then(
      () => null,
      (e: { code?: string; constraint_name?: string }) => e,
    );
    expect(crossOrg?.code, 'a cross-org employment is refused by the DB').toBe('23503');
    expect(crossOrg?.constraint_name).toBe('employments_person_id_same_org_fk');
    await asOrg(o1.orgId, (tx) => setPin(tx, { orgId: o1.orgId, personId: p1, storeId: o1.storeA, pin: '446622' }));

    await expect(
      signInWithPin(null, { orgId: o2.orgId, storeId: o2.storeA, pin: '446622' }),
    ).rejects.toThrow(AuthenticationError);
  });
});

describe('constant-cost failure — the oracle T-302 creates and closes', () => {
  it('the dummy hash actually reaches the KDF rather than being rejected as malformed', async () => {
    // ⛔ The check that matters more than the timing one. `verifyPin` returns false from four
    // places and three are string checks costing nothing: one mistyped character in
    // DUMMY_SCRYPT_HASH would silently delete the constant-cost property while leaving the call
    // site looking correct. Asserting the SHAPE is what makes that mistake loud.
    const [algo, salt, key] = DUMMY_SCRYPT_HASH.split('$');
    expect(algo).toBe('scrypt');
    expect(salt).toMatch(/^[0-9a-f]{32}$/);
    expect(key).toMatch(/^[0-9a-f]{128}$/); // 64 bytes — SCRYPT_KEY_BYTES, or verifyPin exits early
    expect(await verifyPin('123456', DUMMY_SCRYPT_HASH)).toBe(false);
  });

  it('an unknown PIN pays for a KDF it did not need', async () => {
    /*
     * ⛔ **CALIBRATED AGAINST THIS MACHINE'S OWN KDF COST, NOT AGAINST A NUMBER.** The first draft
     * of this test asserted the no-row path takes more than 10 ms, reasoning that one scrypt is
     * ~35 ms and a bare HMAC is 2.4 µs. **It passed with the dummy KDF deleted** — because
     * `signInWithPin`'s no-row path also makes three round trips (throttle check, credential
     * lookup, `recordMiss`), and those alone clear 10 ms. A floor below the floor measures
     * nothing, and it was only caught by removing the line and watching the test stay green.
     *
     * Measured on this machine, five samples each:
     *   with the dummy KDF    : 275–305 ms
     *   without it            :  26–29 ms   ← the three round trips, and nothing else
     *   one scrypt alone      : 115–190 ms
     *
     * So the honest assertion is *"this path costs at least half a KDF"*, with the KDF timed HERE
     * rather than quoted. ⚠️ Still one-sided: a slower machine raises both numbers together, and
     * the ratio is what this asserts. A warm-up call first, because the first scrypt in a process
     * is markedly slower than the rest and would inflate the bar.
     */
    const o = await mkOrg('cost');
    await verifyPin('123456', DUMMY_SCRYPT_HASH); // warm-up, not measured
    const kdfStart = performance.now();
    await verifyPin('123456', DUMMY_SCRYPT_HASH);
    const kdfMs = performance.now() - kdfStart;

    const samples: number[] = [];
    for (let i = 0; i < 3; i++) {
      const started = performance.now();
      await signInWithPin(null, { orgId: o.orgId, storeId: o.storeA, pin: '446633' }).catch(() => {});
      samples.push(performance.now() - started);
    }
    const median = samples.sort((a, b) => a - b)[1]!;
    expect(median, `no-row path ${median.toFixed(0)}ms vs one KDF ${kdfMs.toFixed(0)}ms`).toBeGreaterThan(
      kdfMs * 0.5,
    );
  });

  it('a malformed PIN is still refused cheaply, and that is deliberate', async () => {
    // "Six digits or not" is public knowledge — `isValidPinFormat` is the rule — so the cheapness
    // of this path discloses nothing. Asserted so nobody later "fixes" it into a KDF burn.
    const o = await mkOrg('malformed');
    await expect(
      signInWithPin(null, { orgId: o.orgId, storeId: o.storeA, pin: 'not-a-pin' }),
    ).rejects.toThrow(AuthenticationError);
  });
});

describe('readiness reflects who can sign in, not where rows are stamped', () => {
  it('counts a person whose PIN was issued at another branch', async () => {
    // The spec's fix #4/#5. `countActiveCredentials` counted rows carrying this store's id, so a
    // branch whose staff all hold PINs issued elsewhere reported ZERO and the BLOCKING readiness
    // gate would have refused to let a real branch open.
    const o = await mkOrg('ready');
    const p = await mkPerson(o.orgId, 'Roaming');
    await hireAt(o.orgId, p, o.storeA);
    await hireAt(o.orgId, p, o.storeB);
    await asOrg(o.orgId, (tx) => setPin(tx, { orgId: o.orgId, personId: p, storeId: o.storeA, pin: '446644' }));

    const { storesRepo } = await import('@shareat/db');
    await asOrg(o.orgId, async (tx) => {
      expect(await storesRepo.countActiveCredentials(tx, o.storeA)).toBe(1);
      // ⭐ Zero credential ROWS carry store B's id, and the answer is still 1.
      expect(await storesRepo.countActiveCredentials(tx, o.storeB)).toBe(1);
    });
    const stamped = await sql`
      select 1 from person_credentials where store_id = ${o.storeB} and revoked_at is null
    `;
    expect(stamped).toHaveLength(0);
  });

  it('does not count a person with a PIN who neither works here nor is scoped here', async () => {
    const o = await mkOrg('ready-neg');
    const p = await mkPerson(o.orgId, 'Only At A');
    await hireAt(o.orgId, p, o.storeA);
    await asOrg(o.orgId, (tx) => setPin(tx, { orgId: o.orgId, personId: p, storeId: o.storeA, pin: '446655' }));

    const { storesRepo } = await import('@shareat/db');
    await asOrg(o.orgId, async (tx) => {
      expect(await storesRepo.countActiveCredentials(tx, o.storeB)).toBe(0);
    });
  });

  it('a live PIN row whose holder lost both legs stops counting — and 0148’s shape', async () => {
    // Migration 0148 revokes every store-scoped PIN at deploy. This asserts the readiness gate
    // reads a revoked credential as gone, which is what makes "you have no PIN — issue one" the
    // state operators actually see after the cutover.
    const o = await mkOrg('revoked');
    const p = await mkPerson(o.orgId, 'Revoked Holder');
    await hireAt(o.orgId, p, o.storeA);
    await asOrg(o.orgId, (tx) => setPin(tx, { orgId: o.orgId, personId: p, storeId: o.storeA, pin: '446666' }));
    await sql`
      update person_credentials set revoked_at = now(), revoke_reason = 'test'
      where person_id = ${p} and kind = 'pin'
    `;

    const { storesRepo } = await import('@shareat/db');
    await asOrg(o.orgId, async (tx) => {
      expect(await storesRepo.countActiveCredentials(tx, o.storeA)).toBe(0);
    });
    await expect(
      signInWithPin(null, { orgId: o.orgId, storeId: o.storeA, pin: '446666' }),
    ).rejects.toThrow(AuthenticationError);
  });
});

describe('the enrolment guard still narrows to one row', () => {
  it('a lookup hash resolves to exactly one live credential', async () => {
    const o = await mkOrg('one-row');
    const p = await mkPerson(o.orgId, 'Single');
    await hireAt(o.orgId, p, o.storeA);
    await asOrg(o.orgId, (tx) => setPin(tx, { orgId: o.orgId, personId: p, storeId: o.storeA, pin: '446677' }));

    await asOrg(o.orgId, async (tx) => {
      const found = await sessionsRepo.findActiveCredentialByLookupHash(
        tx,
        pinLookupHash(o.orgId, '446677'),
      );
      expect(found?.personId).toBe(p);
    });
  });
});
