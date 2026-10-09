import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-304 (two-layer terminal sign-in) + T-303 (PIN attempt throttle) against real Postgres.
 * docs/tasks/304-two-layer-terminal-sign-in.md, docs/tasks/303-pin-attempt-lockout.md.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import {
  closeDb,
  transaction,
  APP_ROLE,
  sessionsRepo,
  personsRepo,
  pinAttemptsRepo,
  withOrgPrincipal,
  type Tx,
} from '@shareat/db';
import {
  signInWithPin,
  signInWithFirebase,
  resolveTerminalIdentity,
  endAllForDevice,
  assignRoleAsActor,
  grantCapabilityAsActor,
  hashPin,
  pinLookupHash,
  AuthenticationError,
  AuthorizationError,
  type Actor,
} from '@shareat/auth';

const sql = postgres(url, { max: 5 });

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

interface Fixture {
  orgId: string;
  storeId: string;
  storeId2: string;
  personId: string;
  adminId: string;
  admin: Actor;
}

async function setup(hint: string): Promise<Fixture> {
  const code = uid(`s-${hint}`);
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
  const mkPerson = async (n: string) => {
    const [r] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${orgId}, ${n}) returning id
    `;
    return r!.id;
  };
  const adminId = await mkPerson(`${hint} Admin`);
  const f = {
    orgId,
    storeId: await mkStore(`${hint}-s1`),
    storeId2: await mkStore(`${hint}-s2`),
    personId: await mkPerson(`${hint} Cashier`),
    adminId,
    admin: { personId: adminId, orgId },
  };
  // ⭐ T-302 — sign-in now asks whether this person works at, or is scoped to, the store. These
  // fixtures held neither row, so every PIN case here refused with the flat BAD_PIN.
  for (const personId of [f.personId, f.adminId]) {
    for (const storeId of [f.storeId, f.storeId2]) {
      await sql`insert into person_store_scope (person_id, store_id) values (${personId}, ${storeId})`;
    }
  }
  return f;
}

/** A terminal person + its `kind='firebase'` credential, scoped to one store — option (a). */
async function mkTerminal(orgId: string, storeId: string, hint: string): Promise<{ personId: string; externalId: string }> {
  const [p] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name, kind) values (${orgId}, ${`Terminal ${hint}`}, 'terminal') returning id
  `;
  const externalId = uid(`fbuid-${hint}`);
  await sql`
    insert into person_credentials (person_id, kind, store_id, external_id)
    values (${p!.id}, 'firebase', ${storeId}, ${externalId})
  `;
  return { personId: p!.id, externalId };
}

async function mkOrdinaryFirebasePerson(orgId: string, hint: string): Promise<{ personId: string; externalId: string }> {
  const [p] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, ${`Person ${hint}`}) returning id
  `;
  const externalId = uid(`fbuid-${hint}`);
  await sql`insert into person_credentials (person_id, kind, external_id) values (${p!.id}, 'firebase', ${externalId})`;
  return { personId: p!.id, externalId };
}

/**
 * ⭐ **T-302 — takes `orgId` now, because the lookup key is `HMAC(orgId:pin)`.** `storeId` is still
 * written to the row (a `pin` credential must carry one) but no longer feeds the hash: it records
 * where the PIN was ISSUED, never where it works.
 */
async function mkPin(orgId: string, personId: string, storeId: string, pin: string): Promise<void> {
  // Bypasses `setPin`'s KDF cost for fixture speed — same shape `credentials-admin.test.ts` uses
  // nowhere, but this file is under real time pressure and the hash's own correctness is proven
  // elsewhere (`credentials.test.ts`). Uses the real `hashPin`/`pinLookupHash` so the actual
  // sign-in path is exercised, not a shortcut around it.
  await sql`
    insert into person_credentials (person_id, kind, store_id, secret_hash, lookup_hash)
    values (${personId}, 'pin', ${storeId}, ${await hashPin(pin)}, ${pinLookupHash(orgId, pin)})
  `;
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

beforeAll(async () => {
  await sql`truncate table sessions, person_credentials, person_store_scope, pin_attempt_throttle, persons restart identity cascade`;
});

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

// =========================================================================================
// T-304 — resolveTerminalIdentity
// =========================================================================================

describe('resolveTerminalIdentity', () => {
  it('resolves a terminal credential to {orgId, storeId, deviceId} and mints no session', async () => {
    const f = await setup('resolve');
    const term = await mkTerminal(f.orgId, f.storeId, 'resolve');

    const identity = await resolveTerminalIdentity(null, term.externalId);
    expect(identity).toEqual({ orgId: f.orgId, storeId: f.storeId, deviceId: term.personId });

    const [row] = await sql<{ n: number }[]>`select count(*)::int as n from sessions where person_id = ${term.personId}`;
    expect(row!.n).toBe(0);
  });

  it('refuses an ordinary (non-terminal) firebase credential', async () => {
    const f = await setup('resolve-ordinary');
    const person = await mkOrdinaryFirebasePerson(f.orgId, 'ord');
    await expect(resolveTerminalIdentity(null, person.externalId)).rejects.toThrow(AuthenticationError);
  });

  it('refuses an unknown uid', async () => {
    await expect(resolveTerminalIdentity(null, uid('nobody'))).rejects.toThrow(AuthenticationError);
  });

  it('⛔ test 12 — revoking the terminal credential takes effect on the NEXT resolution', async () => {
    const f = await setup('revoke-terminal');
    const term = await mkTerminal(f.orgId, f.storeId, 'revoke');

    await expect(resolveTerminalIdentity(null, term.externalId)).resolves.toBeTruthy();

    await sql`update person_credentials set revoked_at = now(), revoke_reason = 'test' where external_id = ${term.externalId}`;

    await expect(resolveTerminalIdentity(null, term.externalId)).rejects.toThrow(AuthenticationError);
  });
});

// =========================================================================================
// T-304 invariant 8 / test 7 — the admin form refuses a terminal-kind person
// =========================================================================================

describe('signInWithFirebase refuses a terminal-kind person (invariant 8)', () => {
  it('the store credential, typed into the admin form, is refused with the flat not-linked sentence', async () => {
    const f = await setup('admin-refuse');
    const term = await mkTerminal(f.orgId, f.storeId, 'admin-refuse');

    await expect(signInWithFirebase(null, { verifiedUid: term.externalId })).rejects.toThrow(
      'Sign-in failed: this account is not linked to a person in this system.',
    );
  });

  it('⛔ invariant 7 / test 6 — admin email sign-in still works with NO terminal credential in the database', async () => {
    const f = await setup('admin-still-works-none');
    const person = await mkOrdinaryFirebasePerson(f.orgId, 'admin-a');
    const session = await signInWithFirebase(null, { verifiedUid: person.externalId });
    expect(session.personId).toBe(person.personId);
  });

  it('⛔ invariant 7 / test 6 — admin email sign-in still works with a terminal credential signed in', async () => {
    const f = await setup('admin-still-works-with');
    await mkTerminal(f.orgId, f.storeId, 'admin-b-terminal');
    const person = await mkOrdinaryFirebasePerson(f.orgId, 'admin-b');
    const session = await signInWithFirebase(null, { verifiedUid: person.externalId });
    expect(session.personId).toBe(person.personId);
  });
});

// =========================================================================================
// T-304 tests 3/8 — a terminal holds no role, appears in no staff listing, no headcount
// =========================================================================================

describe('a terminal-kind person is not staff (the three-part guard)', () => {
  it('assignRoleAsActor refuses a terminal target', async () => {
    const f = await setup('guard-role');
    const term = await mkTerminal(f.orgId, f.storeId, 'guard-role');
    await sql`insert into person_roles (person_id, org_id, role, granted_by) values (${f.adminId}, ${f.orgId}, 'admin', null)`;
    await expect(
      asOrg(f.orgId, (tx) =>
        assignRoleAsActor(tx, f.admin, { personId: term.personId, role: 'manager' }),
      ),
    ).rejects.toThrow(AuthorizationError);
  });

  it('grantCapabilityAsActor refuses a terminal target', async () => {
    const f = await setup('guard-grant');
    const term = await mkTerminal(f.orgId, f.storeId, 'guard-grant');
    await sql`insert into person_roles (person_id, org_id, role, granted_by) values (${f.adminId}, ${f.orgId}, 'admin', null)`;
    await expect(
      asOrg(f.orgId, (tx) =>
        grantCapabilityAsActor(tx, f.admin, { personId: term.personId, capability: 'view_financial_reports' }),
      ),
    ).rejects.toThrow(AuthorizationError);
  });

  it('is excluded from listWithAccessForOrg (/admin/users\' data source)', async () => {
    const f = await setup('guard-listing');
    const term = await mkTerminal(f.orgId, f.storeId, 'guard-listing');
    const rows = await asOrg(f.orgId, (tx) => personsRepo.listWithAccessForOrg(tx, f.orgId));
    expect(rows.some((r) => r.id === term.personId)).toBe(false);
    expect(rows.some((r) => r.id === f.personId)).toBe(true);
  });

  it('⭐ is excluded from v_active_employments ITSELF, not only the repo wrapper — a filter can be correct in the view definition and unreached in practice', async () => {
    const f = await setup('guard-view');
    const term = await mkTerminal(f.orgId, f.storeId, 'guard-view');
    // An employment row for the terminal person — the "no convenient proxy" case: even if
    // something accidentally gave a terminal an employment row, the view must still exclude it.
    await sql`
      insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
      values (${f.orgId}, ${f.storeId}, ${term.personId}, ${uid('EMP')}, 'regular', current_date)
    `;
    const rows = await asOrg(f.orgId, (tx) =>
      tx.execute(dsql`select person_id from v_active_employments where store_id = ${f.storeId}`),
    );
    const personIds = (rows as unknown as { person_id: string }[]).map((r) => r.person_id);
    expect(personIds).not.toContain(term.personId);
  });
});

// =========================================================================================
// endAllForDevice — the lost-tablet runbook's actual remote sign-out
// =========================================================================================

describe('endAllForDevice', () => {
  it('ends only that device\'s live session, not another device\'s session for the same person', async () => {
    const f = await setup('end-device');
    await mkPin(f.orgId, f.personId, f.storeId, '741852');
    const termA = await mkTerminal(f.orgId, f.storeId, 'end-device-a');
    const termB = await mkTerminal(f.orgId, f.storeId2, 'end-device-b');

    const onDeviceA = await signInWithPin(null, { orgId: f.orgId, storeId: f.storeId, pin: '741852', deviceId: termA.personId });
    // Same person, second PIN sign-in from a second tablet — same store, different device.
    const onDeviceB = await signInWithPin(null, { orgId: f.orgId, storeId: f.storeId, pin: '741852', deviceId: termB.personId });

    // ⚠️ Called under a real principal, the way an admin action would — `sessions` is `derived`
    // RLS (via persons.org_id), so a bare `transaction()` with no principal at all sees no rows
    // to end regardless of the device filter. `endShift` (this function's sibling) has the same
    // `tx: Tx | null` shape and, not coincidentally, zero production callers today; this is not a
    // new limitation this task introduces.
    const { ended } = await asOrg(f.orgId, (tx) => endAllForDevice(tx, { deviceId: termA.personId }));
    expect(ended).toBe(1);

    const [a] = await sql<{ ended_at: Date | null }[]>`select ended_at from sessions where id = ${onDeviceA.sessionId}`;
    const [b] = await sql<{ ended_at: Date | null }[]>`select ended_at from sessions where id = ${onDeviceB.sessionId}`;
    expect(a!.ended_at).not.toBeNull();
    expect(b!.ended_at).toBeNull();
  });
});

// =========================================================================================
// T-304 test 9 — provision-terminal's own guard: no second live terminal credential per store.
// `scripts/provision-terminal.ts` itself does console I/O and exits the process, so this
// exercises the repo predicate it refuses on directly rather than shelling out to the script.
// =========================================================================================

describe('hasLiveTerminalCredentialForStore — provision-terminal\'s dedup guard', () => {
  it('is false for a store with none, true once one exists, and unaffected by a revoked one', async () => {
    const f = await setup('provision-dedup');
    expect(await withOrgPrincipal(f.orgId, (tx) => sessionsRepo.hasLiveTerminalCredentialForStore(tx, f.storeId))).toBe(
      false,
    );

    const term = await mkTerminal(f.orgId, f.storeId, 'dedup');
    expect(await withOrgPrincipal(f.orgId, (tx) => sessionsRepo.hasLiveTerminalCredentialForStore(tx, f.storeId))).toBe(
      true,
    );

    await sql`update person_credentials set revoked_at = now(), revoke_reason = 'test' where person_id = ${term.personId}`;
    expect(await withOrgPrincipal(f.orgId, (tx) => sessionsRepo.hasLiveTerminalCredentialForStore(tx, f.storeId))).toBe(
      false,
    );
  });
});

// =========================================================================================
// T-303 — the throttle, 10 / 60s / 2min
// =========================================================================================

describe('pin_attempt_throttle — T-303, 10 misses / 60s window / 2 minute cooldown', () => {
  it('test 1 — ten misses locks the store; the eleventh is refused BEFORE any credential lookup runs', async () => {
    const f = await setup('throttle-lock');
    await mkPin(f.orgId, f.personId, f.storeId, '111111');
    const term = await mkTerminal(f.orgId, f.storeId, 'throttle-lock');

    for (let i = 0; i < 10; i++) {
      await expect(
        signInWithPin(null, { orgId: f.orgId, storeId: f.storeId, pin: '000000', deviceId: term.personId }),
      ).rejects.toThrow(AuthenticationError);
    }

    // ⭐ Ordering proof without a spy or a timer: a MALFORMED pin would normally be refused
    // by runPinSignIn's own format check, before any DB read. If the throttle's cooldown message
    // appears instead, the throttle check ran first and the credential path was never reached at
    // all — invariant 3, checked structurally rather than by timing.
    await expect(
      signInWithPin(null, { orgId: f.orgId, storeId: f.storeId, pin: 'not-a-pin', deviceId: term.personId }),
    ).rejects.toThrow(/paused until/);
  });

  it('test 7 — a WRONG pin and an UNKNOWN pin advance the counter identically and produce the same message', async () => {
    const f = await setup('throttle-parity');
    await mkPin(f.orgId, f.personId, f.storeId, '222222');

    const wrong = await signInWithPin(null, { orgId: f.orgId, storeId: f.storeId, pin: '333333' }).catch(
      (e: Error) => e.message,
    );
    const [afterWrong] = await sql<{ fail_count: number }[]>`select fail_count from pin_attempt_throttle where store_id = ${f.storeId}`;

    const f2 = await setup('throttle-parity-2');
    const unknown = await signInWithPin(null, { orgId: f2.orgId, storeId: f2.storeId, pin: '444444' }).catch(
      (e: Error) => e.message,
    );
    const [afterUnknown] = await sql<{ fail_count: number }[]>`select fail_count from pin_attempt_throttle where store_id = ${f2.storeId}`;

    expect(wrong).toBe(unknown);
    expect(afterWrong!.fail_count).toBe(1);
    expect(afterUnknown!.fail_count).toBe(1);
  });

  it('test 3 — a second store is unaffected while the first is cooling down', async () => {
    /*
     * ⚠️ **T-302 — the second store's PIN belongs to a DIFFERENT person now.** This gave one person
     * two PINs, one per store, which was the normal shape while the key was store-scoped and is a
     * state T-302 forbids (one live PIN per person, enforced by the unique index once the hashes
     * collapse). The raw insert would still have produced it, so the test would have gone on
     * passing while modelling something the system can no longer contain.
     *
     * ⭐ Two people is also the better test of what this asserts: the throttle is per STORE, so
     * what must survive store 1's cooldown is store 2's traffic, whoever is typing.
     */
    const f = await setup('throttle-second-store');
    await mkPin(f.orgId, f.personId, f.storeId, '555555');
    await mkPin(f.orgId, f.adminId, f.storeId2, '666666');

    for (let i = 0; i < 10; i++) {
      await signInWithPin(null, { orgId: f.orgId, storeId: f.storeId, pin: '000000' }).catch(() => {});
    }
    await expect(
      signInWithPin(null, { orgId: f.orgId, storeId: f.storeId, pin: '555555' }),
    ).rejects.toThrow(/paused until/);

    // The second store, same org — unaffected.
    const res = await signInWithPin(null, { orgId: f.orgId, storeId: f.storeId2, pin: '666666' });
    expect(res.personId).toBe(f.adminId);
  });

  it('test 3b — once locked, further misses never extend or reset the cooldown (the lock-clobber bug)', async () => {
    const f = await setup('throttle-clobber');
    for (let i = 0; i < 10; i++) {
      await signInWithPin(null, { orgId: f.orgId, storeId: f.storeId, pin: '000000' }).catch(() => {});
    }
    const [first] = await sql<{ locked_until: Date }[]>`select locked_until from pin_attempt_throttle where store_id = ${f.storeId}`;
    expect(first!.locked_until).not.toBeNull();

    for (let i = 0; i < 3; i++) {
      await signInWithPin(null, { orgId: f.orgId, storeId: f.storeId, pin: '000000' }).catch(() => {});
    }
    const [second] = await sql<{ locked_until: Date; fail_count: number }[]>`select locked_until, fail_count from pin_attempt_throttle where store_id = ${f.storeId}`;
    expect(second!.locked_until.getTime()).toBe(first!.locked_until.getTime());
    expect(second!.fail_count).toBe(10);
  });

  it('test 3c — concurrent misses all count (the increment is transactional)', async () => {
    const f = await setup('throttle-concurrent');
    const N = 5;
    await Promise.all(
      Array.from({ length: N }, () => signInWithPin(null, { orgId: f.orgId, storeId: f.storeId, pin: '000000' }).catch(() => {})),
    );
    const [row] = await sql<{ fail_count: number }[]>`select fail_count from pin_attempt_throttle where store_id = ${f.storeId}`;
    expect(row!.fail_count).toBe(N);
  });

  it('test 2 — after the cooldown expires, the same store gets another attempt', async () => {
    const f = await setup('throttle-expires');
    await mkPin(f.orgId, f.personId, f.storeId, '777777');
    for (let i = 0; i < 10; i++) {
      await signInWithPin(null, { orgId: f.orgId, storeId: f.storeId, pin: '000000' }).catch(() => {});
    }
    // Simulate the cooldown having already elapsed rather than sleeping 2 real minutes.
    await sql`update pin_attempt_throttle set locked_until = now() - interval '1 second' where store_id = ${f.storeId}`;

    const res = await signInWithPin(null, { orgId: f.orgId, storeId: f.storeId, pin: '777777' });
    expect(res.personId).toBe(f.personId);
  });

  it('test 4 — a correct PIN on the tenth attempt still succeeds; the limit is on failures, not attempts', async () => {
    const f = await setup('throttle-tenth-ok');
    await mkPin(f.orgId, f.personId, f.storeId, '888888');
    for (let i = 0; i < 9; i++) {
      await signInWithPin(null, { orgId: f.orgId, storeId: f.storeId, pin: '000000' }).catch(() => {});
    }
    const res = await signInWithPin(null, { orgId: f.orgId, storeId: f.storeId, pin: '888888' });
    expect(res.personId).toBe(f.personId);

    // ⭐ Clears on success (v1's hadMisses trick) — the counter is gone, not merely unlocked.
    const [row] = await sql<{ fail_count: number; locked_until: Date | null }[]>`select fail_count, locked_until from pin_attempt_throttle where store_id = ${f.storeId}`;
    expect(row!.fail_count).toBe(0);
    expect(row!.locked_until).toBeNull();
  });

  it('test 4b — the window rolls: nine misses, a pause past 60s, nine more → never locked', async () => {
    const f = await setup('throttle-rolling');
    for (let i = 0; i < 9; i++) {
      await signInWithPin(null, { orgId: f.orgId, storeId: f.storeId, pin: '000000' }).catch(() => {});
    }
    // Backdate the window rather than sleeping 61 real seconds.
    await sql`update pin_attempt_throttle set window_started_at = now() - interval '61 seconds' where store_id = ${f.storeId}`;

    for (let i = 0; i < 9; i++) {
      await signInWithPin(null, { orgId: f.orgId, storeId: f.storeId, pin: '000000' }).catch(() => {});
    }
    const [row] = await sql<{ locked_until: Date | null; fail_count: number }[]>`select locked_until, fail_count from pin_attempt_throttle where store_id = ${f.storeId}`;
    expect(row!.locked_until).toBeNull();
    expect(row!.fail_count).toBe(9);
  });

  it('test 5 — email sign-in works while the device is cooling down (invariant 4)', async () => {
    const f = await setup('throttle-email-unaffected');
    const person = await mkOrdinaryFirebasePerson(f.orgId, 'e');
    for (let i = 0; i < 10; i++) {
      await signInWithPin(null, { orgId: f.orgId, storeId: f.storeId, pin: '000000' }).catch(() => {});
    }
    const session = await signInWithFirebase(null, { verifiedUid: person.externalId });
    expect(session.personId).toBe(person.personId);
  });

  it('⛔ every counter read and write runs under a principal, never the auth door (invariant 5, T-303)', async () => {
    const f = await setup('throttle-principal');
    // If this ran on the auth door's elevated connection, it would still succeed regardless of
    // which org owns the store — the whole point of proving it runs under withOrgPrincipal is
    // that a WRONG org's principal is refused by RLS. Confirmed the positive path already works
    // above; here the negative: a caller declaring the WRONG org for this store's throttle row
    // must not silently write under it.
    const other = await setup('throttle-principal-other-org');
    // ⚠️ **This test PROVED NOTHING on its first draft, and that is worth keeping visible
    // (RULES §3.2: "a test that only ever passed proves nothing").** The original version called
    // `recordMiss(tx, other.orgId, f.storeId)` under `withOrgPrincipal(other.orgId, …)` — the
    // inserted `org_id` and the applied principal were the SAME value, so `WITH CHECK (org_id =
    // app_current_org())` was trivially satisfied and the assertion passed for a reason that had
    // nothing to do with RLS. The fix is this: the PRINCIPAL is `f.orgId`, but the write claims
    // `other.orgId` — a genuine mismatch, which `WITH CHECK` must now refuse.
    await expect(
      withOrgPrincipal(f.orgId, (tx) => pinAttemptsRepo.chargeAttempt(tx, { orgId: other.orgId, storeId: f.storeId, deviceId: null })),
    ).rejects.toThrow();
  });
});
