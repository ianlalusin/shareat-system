/**
 * T-237 — a Firebase credential's lifecycle, against real PostgreSQL.
 * `docs/tasks/237-def-224-firebase-credential-lifecycle.md` §8. Closes **DEF-224** and **DEF-228**.
 *
 * ## ⭐ Case 1 is the defect, executed
 *
 * Link a uid, unlink it, link **the same uid again**. Before migration `0137` that third step
 * raised `23505` — the unique index covered revoked rows — which is what made T-232's own sentence,
 * *"ask an administrator to link it"*, advice nobody could follow.
 *
 * ## ⛔ Case 2 is its boundary, and it passes both before and after
 *
 * Two **live** rows for one uid are still refused. It is here so that a later widening — one
 * Firebase account across two organisations — cannot happen silently: `findActiveCredentialByExternalId`
 * ends `const [row] = …` with no `ORDER BY`, on the sign-in path's owner connection where RLS does
 * not apply, so two live rows would sign a franchise owner into an arbitrary org on different days.
 *
 * ## ⛔ Case 8 PASSED before slice C, and that is the point
 *
 * `setPin` used to insert a new credential and end only the SESSIONS, so the previous PIN went on
 * signing that person in forever (DEF-228). Case 8 asserts the old PIN is refused; it is the
 * security assertion of this task, not a regression test for something that already worked.
 */
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { closeDb, transaction, APP_ROLE, sessionsRepo, type Tx } from '@shareat/db';
import {
  linkFirebaseCredential,
  unlinkCredential,
  signInWithFirebase,
  signInWithPin,
  setPin,
  resolveActor,
  AuthenticationError,
  AuthorizationError,
  type Actor,
} from '@shareat/auth';

const sql = postgres(url, { max: 5 });

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

/** T-239 / DEF-229 — every unlink carries a reason now. The cases that are ABOUT the reason spell
 *  out their own; the rest take this one, so a required argument never reads as a case's subject. */
const REASON = 'They have left the company.';

interface Fixture {
  orgId: string;
  storeId: string;
  storeId2: string;
  /** Holds `admin` — the actor for every gated call below. */
  adminId: string;
  admin: Actor;
  /** An ordinary person with no role: the target of most link/unlink calls. */
  personId: string;
  /** Holds `manager` — the negative control for the gate. */
  managerId: string;
  manager: Actor;
}

async function setup(hint: string): Promise<Fixture> {
  const code = uid(`c-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const mkStore = async (h: string) => {
    const [r] = await sql<{ id: string }[]>`
      insert into stores (org_id, code, name) values (${orgId}, ${uid(h)}, ${`Store ${h}`}) returning id`;
    return r!.id;
  };
  const mkPerson = async (n: string) => {
    const [r] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${orgId}, ${n}) returning id`;
    return r!.id;
  };
  const adminId = await mkPerson(`${hint} Admin`);
  const managerId = await mkPerson(`${hint} Manager`);
  await mkRole(orgId, adminId, 'admin');
  await mkRole(orgId, managerId, 'manager');

  const f = {
    orgId,
    storeId: await mkStore(`${hint}-s1`),
    storeId2: await mkStore(`${hint}-s2`),
    adminId,
    admin: { personId: adminId, orgId },
    personId: await mkPerson(`${hint} Staffer`),
    managerId,
    manager: { personId: managerId, orgId },
  };
  /*
   * ⭐ **T-302 — every fixture person gets store scope at both stores, and it is required now.**
   * Sign-in gates on "does this person work at, or hold scope for, this store" instead of the old
   * `credential.storeId === input.storeId`, which was true by construction. Without these rows the
   * PIN cases below refuse with the flat `BAD_PIN` and look like credential bugs.
   */
  for (const personId of [f.adminId, f.personId, f.managerId]) {
    for (const storeId of [f.storeId, f.storeId2]) {
      await sql`insert into person_store_scope (person_id, store_id) values (${personId}, ${storeId})`;
      // T-407: the PIN door also needs the org-level rule (open employment / admin role / never-employed manager), so each fixture person is employed too.
      await sql`insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on) values (${orgId}, ${storeId}, ${personId}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, 'regular', '2020-01-01')`;
    }
  }
  return f;
}

/** `granted_by` NULL, as `createFirstAdmin` writes it — there is no grantor in a fixture. */
async function mkRole(orgId: string, personId: string, role: string): Promise<void> {
  await sql`
    insert into person_roles (org_id, person_id, role, granted_by)
    values (${orgId}, ${personId}, ${role}, null)`;
}

/**
 * A SECOND organisation with one person — the fixture every tenancy case needs.
 *
 * ⚠️ There is no way to build this from `setup()`: the whole point is a person the acting org's
 * principal can never legitimately see, so it has to be created outside that org.
 */
async function otherOrgPerson(hint: string): Promise<{ orgId: string; personId: string }> {
  const code = uid(`other-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Other ${code}`}, ${code}) returning id`;
  const [person] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${org!.id}, 'Someone Else') returning id`;
  return { orgId: org!.id, personId: person!.id };
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

const liveCredentialCount = async (personId: string): Promise<number> => {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int n from person_credentials
    where person_id = ${personId} and revoked_at is null`;
  return row!.n;
};

beforeAll(async () => {
  await sql`truncate table sessions, person_credentials, person_store_scope restart identity cascade`;
});

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

// =========================================================================================
// DEF-224 — the index
// =========================================================================================

describe('DEF-224 — a uid that was unlinked can be linked again', () => {
  it('⭐ case 1: link → unlink → link the SAME uid, and sign-in resolves to the NEW row', async () => {
    const f = await setup('relink');
    const externalId = uid('firebase');

    const first = await asOrg(f.orgId, (tx) =>
      linkFirebaseCredential(tx, f.admin, { personId: f.personId, uid: externalId }),
    );
    await asOrg(f.orgId, (tx) =>
      unlinkCredential(tx, f.admin, { personId: f.personId, credentialId: first.credentialId, reason: REASON }),
    );

    // ⛔ This is the line that raised 23505 before migration 0137.
    const second = await asOrg(f.orgId, (tx) =>
      linkFirebaseCredential(tx, f.admin, { personId: f.personId, uid: externalId }),
    );
    expect(second.credentialId).not.toBe(first.credentialId);

    // And the uid resolves to the LIVE row, not the revoked one — the partial index is also the
    // index this lookup wants.
    const found = await asOrg(f.orgId, (tx) =>
      sessionsRepo.findActiveCredentialByExternalId(tx, externalId),
    );
    expect(found?.id).toBe(second.credentialId);
    expect(await liveCredentialCount(f.personId)).toBe(1);
  });

  it('⛔ case 2: two LIVE rows for one uid are still refused', async () => {
    // Passes before and after 0137. It is here so that opening one Firebase account to a second
    // organisation cannot happen quietly: the sign-in lookup takes one row with no ORDER BY.
    const f = await setup('dupe');
    const externalId = uid('firebase');
    await asOrg(f.orgId, (tx) =>
      linkFirebaseCredential(tx, f.admin, { personId: f.personId, uid: externalId }),
    );

    await expect(
      asOrg(f.orgId, (tx) =>
        linkFirebaseCredential(tx, f.admin, { personId: f.adminId, uid: externalId }),
      ),
    ).rejects.toThrow(/person_credentials_external_id_unique|duplicate key/);
  });
});

// =========================================================================================
// Unlinking
// =========================================================================================

describe('unlinkCredential — the row and the sessions, together', () => {
  it('⭐ case 3 + 4: revokes the credential, ends the live sessions, and says how many', async () => {
    const f = await setup('unlink');
    // T-438: email sign-in needs a manager/admin role (staff are PIN-only); this case tests unlink + session revocation, so the person is a manager.
    await mkRole(f.orgId, f.personId, 'manager');
    const externalId = uid('firebase');
    const { credentialId } = await asOrg(f.orgId, (tx) =>
      linkFirebaseCredential(tx, f.admin, { personId: f.personId, uid: externalId }),
    );

    const session = await asOrg(f.orgId, (tx) => signInWithFirebase(tx, { verifiedUid: externalId }));
    expect(await asOrg(f.orgId, (tx) => resolveActor(tx, session.token))).toBeTruthy();

    const result = await asOrg(f.orgId, (tx) =>
      unlinkCredential(tx, f.admin, { personId: f.personId, credentialId, reason: REASON }),
    );

    expect(result.sessionsEnded).toBe(1);
    expect(result.kind).toBe('firebase');
    expect(await liveCredentialCount(f.personId)).toBe(0);

    // ⭐ The session is really dead, asserted through the function every page calls.
    await expect(asOrg(f.orgId, (tx) => resolveActor(tx, session.token))).rejects.toThrow(
      AuthenticationError,
    );

    // ⭐ Case 4 — `'revoked'` has been in SessionEndReason since T-138 with no writer. This is it.
    const [row] = await sql<{ ended_reason: string }[]>`
      select ended_reason from sessions where id = ${session.sessionId}`;
    expect(row!.ended_reason).toBe('revoked');
  });

  it('case 3b: the credential must belong to the person named — a mismatched pair is refused', async () => {
    const f = await setup('mismatch');
    const { credentialId } = await asOrg(f.orgId, (tx) =>
      linkFirebaseCredential(tx, f.admin, { personId: f.personId, uid: uid('firebase') }),
    );

    await expect(
      asOrg(f.orgId, (tx) =>
        // The admin's own id, someone else's credential: a hand-crafted POST's shape.
        unlinkCredential(tx, f.admin, { personId: f.adminId, credentialId, reason: REASON }),
      ),
    ).rejects.toThrow(/not linked to this person/);
    expect(await liveCredentialCount(f.personId)).toBe(1);
  });

  it('⛔ case 5: a manager is refused both link and unlink; an admin is allowed', async () => {
    const f = await setup('gate');
    await expect(
      asOrg(f.orgId, (tx) =>
        linkFirebaseCredential(tx, f.manager, { personId: f.personId, uid: uid('firebase') }),
      ),
    ).rejects.toThrow(AuthorizationError);

    const { credentialId } = await asOrg(f.orgId, (tx) =>
      linkFirebaseCredential(tx, f.admin, { personId: f.personId, uid: uid('firebase') }),
    );
    await expect(
      asOrg(f.orgId, (tx) =>
        unlinkCredential(tx, f.manager, { personId: f.personId, credentialId, reason: REASON }),
      ),
    ).rejects.toThrow(AuthorizationError);

    // The non-zero control: the same call from an admin succeeds, so the refusals above are the
    // capability and not a broken fixture.
    await expect(
      asOrg(f.orgId, (tx) => unlinkCredential(tx, f.admin, { personId: f.personId, credentialId, reason: REASON })),
    ).resolves.toMatchObject({ kind: 'firebase' });
  });

  it('⭐ case 7: unlinking your OWN credential is allowed, and signs you out', async () => {
    const f = await setup('self');
    // A second admin WHO CAN SIGN IN, so the lockout guard is not what is being tested here.
    // ⚠️ The role alone is not enough, and that is not a fixture detail — it is the guard's whole
    // point since the Opus second read. This line failed the moment the guard was corrected.
    await mkRole(f.orgId, f.personId, 'admin');
    await asOrg(f.orgId, (tx) => setPin(tx, { orgId: f.orgId, personId: f.personId, storeId: f.storeId, pin: '098765' }));
    const externalId = uid('firebase');
    const { credentialId } = await asOrg(f.orgId, (tx) =>
      linkFirebaseCredential(tx, f.admin, { personId: f.adminId, uid: externalId }),
    );
    await asOrg(f.orgId, (tx) => signInWithFirebase(tx, { verifiedUid: externalId }));

    const result = await asOrg(f.orgId, (tx) =>
      unlinkCredential(tx, f.admin, { personId: f.adminId, credentialId, reason: REASON }),
    );
    expect(result.sessionsEnded).toBe(1);
  });
});

describe('⛔ case 6 — the last way into an organisation', () => {
  it('refuses the only admin’s last credential, and allows it once a second admin exists', async () => {
    const f = await setup('lockout');
    const { credentialId } = await asOrg(f.orgId, (tx) =>
      linkFirebaseCredential(tx, f.admin, { personId: f.adminId, uid: uid('firebase') }),
    );

    await expect(
      asOrg(f.orgId, (tx) => unlinkCredential(tx, f.admin, { personId: f.adminId, credentialId, reason: REASON })),
    ).rejects.toThrow(/last way into this organisation/);
    expect(await liveCredentialCount(f.adminId)).toBe(1);

    // ⛔ A second admin ROW is not another way in. This person cannot sign in, so the organisation
    // would still be left with zero live credentials — the version of this guard that only counted
    // roles allowed exactly this, and this very case is what proved it (Opus second read, T-237).
    await mkRole(f.orgId, f.personId, 'admin');
    await expect(
      asOrg(f.orgId, (tx) => unlinkCredential(tx, f.admin, { personId: f.adminId, credentialId, reason: REASON })),
    ).rejects.toThrow(/last way into this organisation/);
    expect(await liveCredentialCount(f.adminId)).toBe(1);

    // ⭐ Give that admin a way to sign in, and the same call goes through. The pair is the point:
    // the role alone must not unblock it, and the role plus a credential must.
    await asOrg(f.orgId, (tx) => setPin(tx, { orgId: f.orgId, personId: f.personId, storeId: f.storeId, pin: '654321' }));
    await expect(
      asOrg(f.orgId, (tx) => unlinkCredential(tx, f.admin, { personId: f.adminId, credentialId, reason: REASON })),
    ).resolves.toMatchObject({ kind: 'firebase' });
  });

  it('⭐ counts a SUPER_ADMIN as another way in — the reason hasOtherActiveAdminWhoCanSignIn exists', async () => {
    // Every other admin-counting helper in `accessRepo` filters the literal role 'admin', so a
    // super_admin-only organisation would be refused its own unlink for no reason at all.
    const f = await setup('superadmin');
    await mkRole(f.orgId, f.personId, 'super_admin');
    // …and that super_admin must be able to sign in, or they are not a way in either.
    await asOrg(f.orgId, (tx) => setPin(tx, { orgId: f.orgId, personId: f.personId, storeId: f.storeId, pin: '135790' }));
    const { credentialId } = await asOrg(f.orgId, (tx) =>
      linkFirebaseCredential(tx, f.admin, { personId: f.adminId, uid: uid('firebase') }),
    );

    await expect(
      asOrg(f.orgId, (tx) => unlinkCredential(tx, f.admin, { personId: f.adminId, credentialId, reason: REASON })),
    ).resolves.toMatchObject({ kind: 'firebase' });
  });

  it('does not fire for a person who is not an administrator at all', async () => {
    const f = await setup('nonadmin');
    const { credentialId } = await asOrg(f.orgId, (tx) =>
      linkFirebaseCredential(tx, f.admin, { personId: f.personId, uid: uid('firebase') }),
    );
    // Their last credential, and nobody is locked out of anything by removing it.
    await expect(
      asOrg(f.orgId, (tx) => unlinkCredential(tx, f.admin, { personId: f.personId, credentialId, reason: REASON })),
    ).resolves.toMatchObject({ sessionsEnded: 0 });
  });
});

// =========================================================================================
// Tenancy, input, and the lock — the Opus second read's should-fixes
// =========================================================================================

describe('⛔ tenancy — another org’s person is refused by THIS layer, not only by RLS', () => {
  it('link and unlink both refuse, with the domain’s sentence rather than a 42501', async () => {
    const f = await setup('crossorg');
    const other = await otherOrgPerson('link');

    // ⚠️ The assertion is as much about WHICH refusal as about the refusal: bible §15.11 / DEF-210
    // says no layer may be the only layer, and RLS's own message ("new row violates row-level
    // security policy") is one a person cannot act on. `/does not exist in org/` is the wording
    // `/admin/users` already maps to "That person is not part of this organisation."
    const linking = asOrg(f.orgId, (tx) =>
      linkFirebaseCredential(tx, f.admin, { personId: other.personId, uid: uid('firebase') }),
    );
    await expect(linking).rejects.toThrow(AuthorizationError);
    await expect(linking).rejects.toThrow(/does not exist in org/);
    await expect(linking).rejects.not.toThrow(/row-level security|42501/);

    // The same for unlink, against a credential that really exists in the other org.
    const [cred] = await sql<{ id: string }[]>`
      insert into person_credentials (person_id, kind, external_id)
      values (${other.personId}, 'firebase', ${uid('other-uid')}) returning id`;
    await expect(
      asOrg(f.orgId, (tx) =>
        unlinkCredential(tx, f.admin, { personId: other.personId, credentialId: cred!.id, reason: REASON }),
      ),
    ).rejects.toThrow(/does not exist in org/);

    // ⭐ And it is still there: a refused unlink must not have revoked anything.
    const [still] = await sql<{ n: number }[]>`
      select count(*)::int n from person_credentials where id = ${cred!.id} and revoked_at is null`;
    expect(still!.n).toBe(1);
  });

  it('⭐ case 5b: one uid live in TWO ORGANISATIONS is refused — §2.3’s real boundary', async () => {
    // The same-org case above proves one uid is one person. This is the case §2.3 actually argues
    // about, and the one `/admin/users`' "already linked to somebody" sentence exists for: the index
    // is global, so the second org's link is refused by the database, not by a tenancy check.
    const f = await setup('crossuid');
    const other = await otherOrgPerson('uid');
    const shared = uid('firebase-shared');

    await asOrg(f.orgId, (tx) =>
      linkFirebaseCredential(tx, f.admin, { personId: f.personId, uid: shared }),
    );

    await expect(
      sql`insert into person_credentials (person_id, kind, external_id)
          values (${other.personId}, 'firebase', ${shared})`,
    ).rejects.toThrow(/person_credentials_external_id_unique|duplicate key/);
  });
});

describe('the uid is validated for shape, since it cannot be validated for truth', () => {
  const link = (f: Awaited<ReturnType<typeof setup>>, value: string) =>
    asOrg(f.orgId, (tx) => linkFirebaseCredential(tx, f.admin, { personId: f.personId, uid: value }));

  it('⛔ refuses an email address — §5.3 enforced, not merely printed under the field', async () => {
    const f = await setup('uidmail');
    await expect(link(f, 'ian@shareat.net')).rejects.toThrow(/looks like an email address/);
  });

  it('⛔ refuses whitespace inside, and a blank value', async () => {
    const f = await setup('uidspace');
    await expect(link(f, 'abc def')).rejects.toThrow(/contains no spaces/);
    await expect(link(f, '   ')).rejects.toThrow(/Paste the Firebase uid/);
  });

  it('⛔ refuses one longer than a Firebase uid can be, before the btree does it rudely', async () => {
    // Past ~2.7 KB the index raises "index row size exceeds maximum" — a raw Postgres error on an
    // admin screen, for what is always a paste accident.
    const f = await setup('uidlong');
    await expect(link(f, 'x'.repeat(129))).rejects.toThrow(/too long to be a Firebase uid/);
  });

  it('✅ and accepts a real-shaped uid, trimmed — the control', async () => {
    const f = await setup('uidok');
    const value = uid('AbCd0123');
    const { credentialId } = await link(f, `  ${value}  `);
    const found = await asOrg(f.orgId, (tx) => sessionsRepo.findActiveCredentialByExternalId(tx, value));
    expect(found?.id).toBe(credentialId);
  });
});

describe('the lockout guard is serialised for the organisation', () => {
  it('⭐ UNLINKCREDENTIAL takes the advisory lock — driven through the call, not through the helper', async () => {
    /**
     * ⚠️ **The first version of this test called `accessRepo.lockOrgAccess` directly**, which proved
     * the helper locks and said nothing about whether `unlinkCredential` calls it — while its title
     * claimed the second. A guard that proves something other than its name is worse than none,
     * because it is credited. So the lock is taken by the real call here, and the assertion is made
     * inside the same transaction, where a transaction-scoped lock is still held.
     *
     * ⭐ The BEFORE check is the control. Without it, a connection that already held an advisory lock
     * from anything else would satisfy the after check no matter what `unlinkCredential` did.
     *
     * The race itself is not simulated — two concurrent transactions in one test is a flake waiting
     * to happen. What is ruled out is the failure mode a comment cannot: a lock nobody takes.
     */
    const f = await setup('lock');
    const { credentialId } = await asOrg(f.orgId, (tx) =>
      linkFirebaseCredential(tx, f.admin, { personId: f.personId, uid: uid('firebase') }),
    );

    const advisoryLocks = async (tx: Tx): Promise<number> => {
      const rows = await tx.execute(
        dsql`select count(*)::int as n from pg_locks
             where locktype = 'advisory' and pid = pg_backend_pid()`,
      );
      return Number((rows as unknown as { n: number }[])[0]!.n);
    };

    await asOrg(f.orgId, async (tx) => {
      expect(await advisoryLocks(tx)).toBe(0);
      await unlinkCredential(tx, f.admin, { personId: f.personId, credentialId, reason: REASON });
      expect(await advisoryLocks(tx)).toBeGreaterThan(0);
    });
  });
});

// =========================================================================================
// DEF-228 — the PIN half
// =========================================================================================

describe('DEF-228 — re-issuing a PIN retires the one it replaces', () => {
  it('⛔ case 8: the OLD PIN no longer signs in — the security assertion of this task', async () => {
    const f = await setup('oldpin');
    await asOrg(f.orgId, (tx) => setPin(tx, { orgId: f.orgId, personId: f.personId, storeId: f.storeId, pin: '111111' }));
    await asOrg(f.orgId, (tx) => setPin(tx, { orgId: f.orgId, personId: f.personId, storeId: f.storeId, pin: '222222' }));

    // Before T-237 this signed in happily: the old credential was never revoked, only the sessions
    // minted under it were ended.
    await expect(
      asOrg(f.orgId, (tx) => signInWithPin(tx, { orgId: f.orgId, storeId: f.storeId, pin: '111111' })),
    ).rejects.toThrow(AuthenticationError);

    const newSession = await asOrg(f.orgId, (tx) =>
      signInWithPin(tx, { orgId: f.orgId, storeId: f.storeId, pin: '222222' }),
    );
    expect(newSession.personId).toBe(f.personId);
    expect(await liveCredentialCount(f.personId)).toBe(1);
  });

  it('⭐ case 9: the SAME six digits can be re-issued — and T-302 leaves ONE credential, not two', async () => {
    /*
     * ⛔ **THE SECOND HALF OF THIS TEST'S TITLE USED TO BE *"and another store's PIN is
     * untouched"*, AND T-302 DELIBERATELY REVERSES IT.** It asserted `liveCredentialCount === 2`:
     * the lookup key was store-scoped, so the same six digits at two stores were two separate
     * credentials and re-issuing at one had to leave the other alone.
     *
     * Under `pinLookupHash(orgId, pin)` they are **one** credential. Re-issuing anywhere retires
     * the person's PIN everywhere — which is the point of the task, and is also what stops the
     * insert below colliding with the person's own live row on the unique index.
     *
     * ⭐ **The half this test was originally written for survives unchanged**: re-issuing a
     * person's OWN six digits must succeed rather than raise a raw 23505 (DEF-177 mapped that
     * message at the presentation edge instead of fixing the cause; `0137`'s partial index and
     * T-237's revoke-before-insert fixed it properly).
     */
    const f = await setup('samepin');
    await asOrg(f.orgId, (tx) => setPin(tx, { orgId: f.orgId, personId: f.personId, storeId: f.storeId, pin: '345678' }));
    await asOrg(f.orgId, (tx) => setPin(tx, { orgId: f.orgId, personId: f.personId, storeId: f.storeId2, pin: '345678' }));
    await asOrg(f.orgId, (tx) => setPin(tx, { orgId: f.orgId, personId: f.personId, storeId: f.storeId, pin: '345678' }));

    // ⭐ ONE credential, not two — the T-302 assertion.
    expect(await liveCredentialCount(f.personId)).toBe(1);

    // …and that one credential signs in at BOTH stores, which is what the person actually wanted
    // when they held two PINs before.
    const atStore2 = await asOrg(f.orgId, (tx) =>
      signInWithPin(tx, { orgId: f.orgId, storeId: f.storeId2, pin: '345678' }),
    );
    expect(atStore2.personId).toBe(f.personId);
    const atStore1 = await asOrg(f.orgId, (tx) =>
      signInWithPin(tx, { orgId: f.orgId, storeId: f.storeId, pin: '345678' }),
    );
    expect(atStore1.personId).toBe(f.personId);
  });

  it('a PIN belonging to ANOTHER person is still refused with its own sentence', async () => {
    // The pre-check that already existed, unchanged — and the control proving the revoke-first step
    // did not turn "somebody else's PIN" into a silent takeover.
    const f = await setup('taken');
    await asOrg(f.orgId, (tx) => setPin(tx, { orgId: f.orgId, personId: f.personId, storeId: f.storeId, pin: '456789' }));
    await expect(
      asOrg(f.orgId, (tx) => setPin(tx, { orgId: f.orgId, personId: f.adminId, storeId: f.storeId, pin: '456789' })),
      // ⭐ T-302 — the sentence lost "at this store" when the key became org-scoped.
    ).rejects.toThrow(/already in use/);
  });
});

// =========================================================================================
// T-239 / DEF-229 — a revocation records WHY
// =========================================================================================

/**
 * ⛔ **Case 3 below is the one that matters, and it is the one an ordinary suite would not have.**
 *
 * Every other case here writes rows through code that supplies a reason, so all of them pass
 * against a constraint that does nothing at all. Only a raw-SQL write proves the DATABASE refuses
 * a revocation with no reason — which is the whole point of putting the rule in a CHECK rather
 * than in the service layer (bible §15.11: no layer may be the only one for a given risk).
 *
 * ⚠️ The naive spelling of that CHECK — `revoked_at is not null and btrim(revoke_reason) <> ''` —
 * ACCEPTS a NULL reason, because a CHECK passes when its expression evaluates to NULL rather than
 * TRUE. Spec §2a, proven on this database before the constraint was written. Case 3 is what makes
 * the difference falsifiable; without it the migration could ship a no-op and stay green.
 */
describe('DEF-229 — a revocation records why', () => {
  /** Revoked directly by raw SQL, bypassing every service: the constraint is the only thing left. */
  const forceRevoke = async (credentialId: string, reason: string | null) =>
    sql`update person_credentials
           set revoked_at = now(), revoked_by = null, revoke_reason = ${reason}
         where id = ${credentialId}`;

  it('⭐ stores the administrator’s reason against the row, trimmed', async () => {
    const f = await setup('why-stored');
    const { credentialId } = await asOrg(f.orgId, (tx) =>
      linkFirebaseCredential(tx, f.admin, { personId: f.personId, uid: uid('fb-why') }),
    );

    await asOrg(f.orgId, (tx) =>
      unlinkCredential(tx, f.admin, {
        personId: f.personId,
        credentialId,
        reason: '  Account compromised — reported by the branch manager.  ',
      }),
    );

    const [row] = await sql<{ revoke_reason: string; revoked_by: string | null }[]>`
      select revoke_reason, revoked_by from person_credentials where id = ${credentialId}`;
    expect(row!.revoke_reason).toBe('Account compromised — reported by the branch manager.');
    // ⭐ And the human is still recorded — this task added a third question, it did not replace one.
    expect(row!.revoked_by).toBe(f.adminId);
  });

  it('⛔ refuses a blank reason, and the credential is STILL LIVE afterwards', async () => {
    // The second half is the real assertion: it proves the refusal happened BEFORE the write,
    // rather than after a revocation that then rolled back for some unrelated reason.
    const f = await setup('why-blank');
    const { credentialId } = await asOrg(f.orgId, (tx) =>
      linkFirebaseCredential(tx, f.admin, { personId: f.personId, uid: uid('fb-blank') }),
    );

    await expect(
      asOrg(f.orgId, (tx) =>
        unlinkCredential(tx, f.admin, { personId: f.personId, credentialId, reason: '   ' }),
      ),
    ).rejects.toThrow(/needs a reason/);
    expect(await liveCredentialCount(f.personId)).toBe(1);
  });

  it('⛔ THE CONTROL: the DATABASE refuses a revoked row whose reason is NULL', async () => {
    // Raw SQL, no service in the way. If this passes, `person_credentials_revoke_check` is either
    // absent or NULL-blind, and every other case in this file would still be green.
    const f = await setup('why-db');
    const { credentialId } = await asOrg(f.orgId, (tx) =>
      linkFirebaseCredential(tx, f.admin, { personId: f.personId, uid: uid('fb-db') }),
    );

    await expect(forceRevoke(credentialId, null)).rejects.toThrow(
      /person_credentials_revoke_check/,
    );
    // ⚠️ And the blank case too — the clause this table has that its sibling does not (spec §5).
    await expect(forceRevoke(credentialId, '   ')).rejects.toThrow(
      /person_credentials_revoke_check/,
    );
    expect(await liveCredentialCount(f.personId)).toBe(1);
  });

  it('a LIVE row still has a NULL reason — the constraint did not become “every row needs one”', async () => {
    const f = await setup('why-live');
    const { credentialId } = await asOrg(f.orgId, (tx) =>
      linkFirebaseCredential(tx, f.admin, { personId: f.personId, uid: uid('fb-live') }),
    );
    const [row] = await sql<{ revoke_reason: string | null }[]>`
      select revoke_reason from person_credentials where id = ${credentialId}`;
    expect(row!.revoke_reason).toBeNull();
  });

  it('⛔ and a reason without a revocation is refused too — the pair is symmetric', async () => {
    // Otherwise a half-written row ("we meant to revoke this") reads as a live credential that
    // somebody has already explained away.
    const f = await setup('why-sym');
    const { credentialId } = await asOrg(f.orgId, (tx) =>
      linkFirebaseCredential(tx, f.admin, { personId: f.personId, uid: uid('fb-sym') }),
    );
    await expect(
      sql`update person_credentials set revoke_reason = 'Changed my mind.' where id = ${credentialId}`,
    ).rejects.toThrow(/person_credentials_revoke_check/);
  });
});
