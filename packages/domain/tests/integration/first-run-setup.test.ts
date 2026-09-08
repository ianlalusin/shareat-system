/**
 * T-232 slice 2 — first-run setup, against real Postgres.
 * `docs/tasks/232-email-sign-in-and-first-run-setup.md` §"Slice 2 — contract".
 *
 * ## ⭐ Case 1 is the point of the whole task and was written first
 *
 * Ian signs in on production with the email and password he uses in v1, and the system he lands in
 * has no organisation yet. Case 1 is that moment, end to end: `bootstrapOrganization` on a
 * genuinely empty database, then **`signInWithFirebase` resolving the credential it just wrote**,
 * then that session's actor **authorising `post_journal_entry` and `manage_stores`** — the two
 * halves of *"Ian is the owner"*, asserted rather than implied.
 *
 * ## ⛔ Why the person holds `admin` and four grants rather than two role rows
 *
 * §2.1: the database allows **at most one active role per (person, org)** —
 * `person_roles_active_person_org_unique`, `packages/db/migrations/0014_access_roles_and_grants.sql:56`
 * — so decision 3's "both rows" raises 23505 and aborts the transaction. `admin` plus the four
 * capabilities `super_admin` holds and `admin` does not is an **exact equivalence**, and case 4
 * proves it capability by capability rather than asserting it. Case 5 is that claim's non-zero
 * control: without it, case 4 would still pass against a matrix that gave `admin` everything.
 */
import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { closeDb, transaction, accessRepo, sessionsRepo } from '@shareat/db';
import {
  authorize,
  signInWithFirebase,
  signInWithPin,
  AuthenticationError,
  AuthorizationError,
  CAPABILITIES,
  CAPABILITY_MATRIX,
  CAPABILITY_SCOPE,
  type Actor,
  type Capability,
} from '@shareat/auth';
import { CHART_OF_ACCOUNTS } from '../../../db/seed/chart-of-accounts';
import { EXPENSE_CATEGORY_SEED } from '../../../db/seed/expense-categories';
import { bootstrapOrganization, createFirstAdmin, createOrganization } from '../../src/organizations';

config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
const sql = postgres(url, { max: 3 });

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

/** ⚠️ Every case here starts from a genuinely empty database, because "zero organizations" is the
 *  precondition the whole screen is gated on — a fixture that left one behind would test nothing. */
beforeEach(async () => {
  await sql`
    truncate table sessions, person_credentials, person_store_scope, person_grants, person_roles,
      stock_locations, location_types, sales_channels, stores, persons,
      expense_categories, accounts, organizations
      restart identity cascade`;
});

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const countOf = async (table: string): Promise<number> => {
  const [row] = await sql<{ n: number }[]>`select count(*)::int n from ${sql(table)}`;
  return row!.n;
};

/** The eleven places a first run writes. Case 2 asserts every one of them is zero after a rollback. */
const ALL_TABLES = [
  'organizations',
  'accounts',
  'expense_categories',
  'persons',
  'person_roles',
  'person_grants',
  'stores',
  'location_types',
  'stock_locations',
  'person_store_scope',
  'person_credentials',
] as const;

/** Exactly the capabilities `super_admin` holds that `admin` does not — DERIVED from the matrix,
 *  never listed, so this test fails the day the matrix changes rather than drifting past it. */
const SUPER_ADMIN_ONLY: readonly Capability[] = CAPABILITIES.filter(
  (c) => CAPABILITY_MATRIX[c].super_admin && !CAPABILITY_MATRIX[c].admin,
);

const INPUT = {
  code: 'SHAREAT_OPC',
  name: 'SHAREAT OPC',
  adminDisplayName: 'Ian Lauzon',
  storeCode: 'LIPA',
  storeName: 'SharEat Lipa',
  pin: '135790',
};

// -------------------------------------------------------------------------------------
// Case 1 — written FIRST. The whole chain, and the two halves of "Ian is the owner".
// -------------------------------------------------------------------------------------

describe('T-232 case 1 — ⭐ empty database to a signed-in owner', () => {
  it('creates everything, and the verified uid then signs in and may post and manage stores', async () => {
    const verifiedUid = uid('firebase-uid');

    const result = await transaction((tx) =>
      bootstrapOrganization(tx, { ...INPUT, code: uid('BOOT'), firebaseUid: verifiedUid }),
    );

    // The organisation, and the reference data it cannot exist without.
    expect(result.orgId).toBeTruthy();
    expect(result.accountsSeeded).toBe(CHART_OF_ACCOUNTS.length);
    expect(result.categoriesSeeded).toBe(EXPENSE_CATEGORY_SEED.length);

    // The person, their role, and the four grants that make them the owner.
    expect(result.personId).toBeTruthy();
    const role = await transaction((tx) => accessRepo.activeRoleForPerson(tx, result.personId, result.orgId));
    expect(role?.role).toBe('admin');
    expect(role?.grantedBy).toBeNull();
    expect([...result.grantedCapabilities].sort()).toEqual([...SUPER_ADMIN_ONLY].sort());

    // The store, its default room, and — the step DEF-180 proves gets forgotten — the scope row.
    expect(result.storeId).toBeTruthy();
    expect(result.locationId).toBeTruthy();
    expect(result.scopedAdminIds).toEqual([result.personId]);
    expect(await transaction((tx) => accessRepo.storeIdsForPerson(tx, result.personId))).toEqual([
      result.storeId,
    ]);

    // Both credentials.
    expect(result.pinCredentialId).toBeTruthy();
    expect(result.firebaseCredentialId).toBeTruthy();

    // ⭐ The seam slice 1 depends on: the uid it verified now resolves to a person and a session.
    const session = await transaction((tx) => signInWithFirebase(tx, { verifiedUid }));
    expect(session.personId).toBe(result.personId);
    expect(session.token).toBeTruthy();

    // ⭐ And that session's actor really is the owner — both halves, asserted.
    const actor: Actor = { personId: result.personId, orgId: result.orgId };
    await expect(
      transaction((tx) => authorize(tx, actor, 'post_journal_entry', {})),
    ).resolves.toBeUndefined();
    await expect(transaction((tx) => authorize(tx, actor, 'manage_stores', {}))).resolves.toBeUndefined();
  });
});

// -------------------------------------------------------------------------------------
// Case 2 — all-or-nothing, proved by an injected failure.
// -------------------------------------------------------------------------------------

describe('T-232 case 2 — ⭐ everything or nothing', () => {
  it('a failure after the last step leaves NOTHING behind, in all eleven tables', async () => {
    // ⛔ The failure is injected AFTER every step has run, which is stronger than failing part-way
    // through — the risk being excluded is a step that quietly ran on its own connection, and such
    // a step would survive this rollback and be counted below. A half-succeeded bootstrap is
    // unrecoverable: `createFirstAdmin` would refuse the retry, so there would be no second chance.
    await expect(
      transaction(async (tx) => {
        await bootstrapOrganization(tx, { ...INPUT, code: uid('ROLL'), firebaseUid: uid('uid') });
        throw new Error('injected failure, inside the same transaction');
      }),
    ).rejects.toThrow(/injected failure/);

    for (const table of ALL_TABLES) {
      expect(await countOf(table), `${table} should be empty after the rollback`).toBe(0);
    }
  });

  it('and the retry then succeeds — a rolled-back attempt does not close first-run setup', async () => {
    await expect(
      transaction(async (tx) => {
        await bootstrapOrganization(tx, { ...INPUT, code: uid('ROLL') });
        throw new Error('injected failure');
      }),
    ).rejects.toThrow();

    const retried = await transaction((tx) => bootstrapOrganization(tx, { ...INPUT, code: uid('REAL') }));
    expect(retried.personId).toBeTruthy();
  });
});

// -------------------------------------------------------------------------------------
// Case 3 — first-run setup closes for good.
// -------------------------------------------------------------------------------------

describe('T-232 case 3 — refuses once ANY organization exists', () => {
  it('refuses even for a completely different org code, which the unique index would not catch', async () => {
    await transaction((tx) => bootstrapOrganization(tx, { ...INPUT, code: uid('FIRST') }));

    await expect(
      transaction((tx) =>
        bootstrapOrganization(tx, { ...INPUT, code: uid('SECOND'), storeCode: 'MALVAR', pin: '246810' }),
      ),
    ).rejects.toThrow(/already has an organization/i);

    // ⛔ The point of the refusal: exactly one organisation, not one per code.
    expect(await countOf('organizations')).toBe(1);
    expect(await countOf('persons')).toBe(1);
  });

  it('refuses when the existing organization was created by any other route', async () => {
    await transaction((tx) => createOrganization(tx, { code: uid('BY_HAND'), name: 'Made elsewhere' }));

    await expect(
      transaction((tx) => bootstrapOrganization(tx, { ...INPUT, code: uid('LATE') })),
    ).rejects.toThrow(/already has an organization/i);
  });
});

// -------------------------------------------------------------------------------------
// Cases 4 and 5 — the equivalence, and its non-zero control.
// -------------------------------------------------------------------------------------

describe('T-232 case 4 — ⭐ admin + four grants authorizes exactly what super_admin does', () => {
  it('holds every capability super_admin holds, checked one by one against the matrix', async () => {
    const result = await transaction((tx) => bootstrapOrganization(tx, { ...INPUT, code: uid('EQUIV') }));
    const actor: Actor = { personId: result.personId, orgId: result.orgId };

    // The grants are real rows, not an inference.
    for (const capability of SUPER_ADMIN_ONLY) {
      expect(
        await transaction((tx) => accessRepo.personHasActiveGrant(tx, result.personId, capability)),
        `expected an active grant for ${capability}`,
      ).toBe(true);
    }

    // ⭐ And the whole set resolves through `authorize`, which is what actually gates a mutation.
    const superAdminHolds = CAPABILITIES.filter((c) => CAPABILITY_MATRIX[c].super_admin);
    expect(superAdminHolds.length).toBeGreaterThan(0); // the sweep has something to find
    for (const capability of superAdminHolds) {
      const ctx = CAPABILITY_SCOPE[capability] === 'store' ? { storeId: result.storeId } : {};
      await expect(
        transaction((tx) => authorize(tx, actor, capability, ctx)),
        `expected the first person to hold ${capability}`,
      ).resolves.toBeUndefined();
    }
  });

  it('the grants carry granted_by NULL — the base case of the authority chain, not a fabricated grantor', async () => {
    const result = await transaction((tx) => bootstrapOrganization(tx, { ...INPUT, code: uid('CHAIN') }));
    const rows = await sql<{ granted_by: string | null }[]>`
      select granted_by from person_grants where person_id = ${result.personId}`;
    expect(rows).toHaveLength(SUPER_ADMIN_ONLY.length);
    expect(rows.every((r) => r.granted_by === null)).toBe(true);
  });
});

describe('T-232 case 5 — ⛔ the non-zero control for case 4', () => {
  it('a plain admin, created WITHOUT the grants, is refused post_journal_entry', async () => {
    // Without this, case 4 would pass just as happily against a matrix that gave `admin`
    // everything — a sweep that cannot fail proves nothing (memory: a sweep needs a non-zero
    // control). This is the same shape of person, minus the four rows.
    const made = await transaction(async (tx) => {
      const org = await createOrganization(tx, { code: uid('PLAIN'), name: 'Plain Co' });
      const admin = await createFirstAdmin(tx, {
        orgId: org.orgId,
        displayName: 'Plain Admin',
        withSuperAdminCapabilities: false,
      });
      return { orgId: org.orgId, personId: admin.personId };
    });

    const actor: Actor = { personId: made.personId, orgId: made.orgId };
    await expect(transaction((tx) => authorize(tx, actor, 'post_journal_entry', {}))).rejects.toThrow(
      AuthorizationError,
    );
  });
});

// -------------------------------------------------------------------------------------
// Case 6 — the CLI path. T-228's guarantee, unbroken.
// -------------------------------------------------------------------------------------

describe('T-232 case 6 — the CLI calls the same function and still works', () => {
  it('with no firebaseUid: everything except the firebase credential, and signInWithPin still works', async () => {
    const pin = '864209';
    const result = await transaction((tx) =>
      bootstrapOrganization(tx, { ...INPUT, code: uid('CLI'), pin }),
    );

    expect(result.firebaseCredentialId).toBeNull();
    expect(result.pinCredentialId).toBeTruthy();
    expect(await countOf('person_credentials')).toBe(1);

    const session = await transaction((tx) => signInWithPin(tx, { storeId: result.storeId, pin }));
    expect(session.personId).toBe(result.personId);

    // ⚠️ And nothing minted a Firebase credential by accident — an unknown uid is still refused.
    await expect(
      transaction((tx) => signInWithFirebase(tx, { verifiedUid: uid('never-linked') })),
    ).rejects.toThrow(AuthenticationError);
  });

  it('links the firebase credential to the FIRST person, with no store and no local secret', async () => {
    const verifiedUid = uid('shape');
    const result = await transaction((tx) =>
      bootstrapOrganization(tx, { ...INPUT, code: uid('SHAPE'), firebaseUid: verifiedUid }),
    );

    const credential = await transaction((tx) =>
      sessionsRepo.findActiveCredentialByExternalId(tx, verifiedUid),
    );
    expect(credential?.personId).toBe(result.personId);
    expect(credential?.kind).toBe('firebase');
    // `person_credentials_shape_check` refuses anything else; asserted so a future "convenience"
    // that stuffed a lookup hash in here fails loudly rather than at the constraint.
    expect(credential?.storeId).toBeNull();
    expect(credential?.secretHash).toBeNull();
    expect(credential?.lookupHash).toBeNull();
  });
});

// -------------------------------------------------------------------------------------
// Cases 7 and 8 — refusals that must write nothing.
// -------------------------------------------------------------------------------------

describe('T-232 cases 7 and 8 — refusals leave the database untouched', () => {
  it('case 7: a duplicate organization code is refused and writes nothing', async () => {
    const code = uid('DUP');
    await transaction((tx) => bootstrapOrganization(tx, { ...INPUT, code }));

    // ⚠️ Refused by the zero-org guard before the code is even considered — which is the stricter
    // of the two refusals and the one that matters. The code's unique index remains underneath it.
    await expect(transaction((tx) => bootstrapOrganization(tx, { ...INPUT, code }))).rejects.toThrow();
    expect(await countOf('organizations')).toBe(1);
  });

  it('case 8: a malformed PIN is refused BEFORE the organization is created', async () => {
    // ⛔ The CLI already learned this one: "finding that out after creating an organization is a
    // bad time to learn it." Here it matters more — a half-run leaves setup permanently closed.
    await expect(
      transaction((tx) => bootstrapOrganization(tx, { ...INPUT, code: uid('BADPIN'), pin: '12345' })),
    ).rejects.toThrow(/6 digits/i);

    expect(await countOf('organizations')).toBe(0);
    expect(await countOf('persons')).toBe(0);
  });

  it('case 8b: an empty organization name or admin name is refused, and writes nothing', async () => {
    await expect(
      transaction((tx) => bootstrapOrganization(tx, { ...INPUT, code: uid('BLANK'), adminDisplayName: '  ' })),
    ).rejects.toThrow(/needs a name/i);
    expect(await countOf('organizations')).toBe(0);
  });
});

// -------------------------------------------------------------------------------------
// Case 9 — a uid that is present but blank. Found by the Opus review, 2026-09-08.
// -------------------------------------------------------------------------------------

describe('T-232 case 9 — ⛔ a blank firebaseUid is refused, never silently skipped', () => {
  it('refuses BEFORE anything is written, rather than committing an org with no credential', async () => {
    // ⛔ The defect: `input.firebaseUid?.trim()` made `'   '` falsy, so the credential step was
    // skipped and the organisation committed anyway. `/setup` would then call `signInWithFirebase`
    // with that uid, find no credential row, and fail — AFTER the point of no return, with the
    // organisation created and first-run setup closed forever. The one path with no retry.
    //
    // ⚠️ It is refused beside the PIN check, for the same stated reason: finding out after
    // creating an organization is a bad time to learn it.
    await expect(
      transaction((tx) =>
        bootstrapOrganization(tx, { ...INPUT, code: uid('BLANKUID'), firebaseUid: '   ' }),
      ),
    ).rejects.toThrow(/firebase/i);

    expect(await countOf('organizations')).toBe(0);
    expect(await countOf('persons')).toBe(0);
    expect(await countOf('person_credentials')).toBe(0);
  });

  it('refuses an empty string too — the same value, spelled differently', async () => {
    await expect(
      transaction((tx) => bootstrapOrganization(tx, { ...INPUT, code: uid('EMPTYUID'), firebaseUid: '' })),
    ).rejects.toThrow(/firebase/i);

    expect(await countOf('organizations')).toBe(0);
  });

  it('⭐ but null and undefined still mean "the CLI path" and are allowed', async () => {
    // The non-zero control for the two refusals above: absent is a legitimate, tested case, and a
    // check that refused it would break `scripts/bootstrap-org.ts` outright.
    const explicitNull = await transaction((tx) =>
      bootstrapOrganization(tx, { ...INPUT, code: uid('NULLUID'), firebaseUid: null }),
    );
    expect(explicitNull.firebaseCredentialId).toBeNull();
    expect(explicitNull.personId).toBeTruthy();
  });

  it('⭐ and a uid with surrounding whitespace is TRIMMED, not refused — it names a real account', async () => {
    const bare = uid('padded');
    const result = await transaction((tx) =>
      bootstrapOrganization(tx, { ...INPUT, code: uid('PADUID'), firebaseUid: `  ${bare}  ` }),
    );

    expect(result.firebaseCredentialId).toBeTruthy();
    // ⛔ Stored trimmed, so `signInWithFirebase` — which is handed the raw verified uid — matches it.
    const credential = await transaction((tx) =>
      sessionsRepo.findActiveCredentialByExternalId(tx, bare),
    );
    expect(credential?.personId).toBe(result.personId);
  });
});
