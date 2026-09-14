/**
 * Standing up an organization — T-228, `docs/tasks/228-organization-bootstrap.md`, closing DEF-195.
 *
 * ## ⛔ The chicken-and-egg, and why the order is the whole design
 *
 * | To do this | You first need |
 * |---|---|
 * | Sign in | a **PIN** |
 * | `setPin` | an **`orgId`** — the PIN is hashed per organisation (`pinLookupHash(orgId, pin)`, T-302) — **and** a `storeId`, which is stamped on the credential row (`person_credentials_shape_check` requires one for `kind = 'pin'`) and records where it was issued |
 * | A store, properly made | `createStore` (T-222), which authorizes `manage_stores` first |
 * | To pass that gate | a person holding an **admin** role |
 * | A person and a role | an **organization** |
 * | An organization | ⛔ nothing |
 *
 * So *"create the org and an admin, then use `/admin/stores`"* does not work: without a store there
 * is no PIN, and without a PIN nobody can sign in to reach `/admin/stores` at all. **The first
 * store has to be part of the bootstrap.** Ordered correctly, exactly one hand-written insert is
 * needed — the organization row — and everything after it goes through code that already exists and
 * is tested, including T-222's admin fan-out, which writes the `person_store_scope` row so nothing
 * here touches an access table beyond the first role.
 *
 * ## ⛔ `createOrganization` takes no `Actor`, and it is the one function here that legitimately
 * cannot
 *
 * There is no principal before the organization exists. `authorize()` resolves capabilities through
 * `person_roles`, which is keyed by `org_id`, so a gate here could never pass — not "does not yet",
 * but *cannot*. **Do not "fix" this by adding one.**
 *
 * ⭐ **The gate is the runner, not the caller.** `bootstrapOrganization` takes an already-open `Tx`
 * from its caller and never opens one itself. Its two callers, `scripts/bootstrap-org.ts` and
 * `apps/erp/src/app/setup/actions.ts`, are the ones that do, and neither is reachable from any other
 * request handler.
 *
 * ⚠️ **Stated precisely, because a stale mechanism description outlives the mechanism (DEF-217).**
 * Both callers open `systemTransaction()` (T-251a, `packages/db/src/client.ts`), not a bare
 * `transaction()`. With `SYSTEM_DATABASE_URL` unset — every environment this task touches — that is
 * byte-for-byte the same connection as before: owner role, RLS not applied, nothing here behaves
 * differently. What changed is that the authority this function runs under now has a name and a
 * closed, enumerable caller list instead of being wherever someone happened to write `transaction()`.
 * This is bible §13 row 185's named exception: first-run setup is the one path that opens an
 * owner-role transaction with no principal, because there is no principal before the first
 * organisation exists — not a precedent, and closed forever the moment that organisation is created.
 * `systemTransaction()`'s own doc comment names both callers by name;
 * `tests/unit/system-transaction-callers.test.ts` fails the build if a third one appears.
 */
import {
  organizationsRepo,
  fiscalPeriodsRepo,
  personsRepo,
  accessRepo,
  sessionsRepo,
  type OrganizationRow,
  type Tx,
} from '@shareat/db';
import { toBusinessDate } from '@shareat/core';
// ⭐ T-229 slice 4 — the FIRST gated function in this module. Everything above it runs before a
// principal exists (bootstrap), which is why the import was not needed until now.
import {
  authorize,
  isValidPinFormat,
  setPin,
  SUPER_ADMIN_ONLY_CAPABILITIES,
  type Actor,
  type Capability,
} from '@shareat/auth';
import { createStore } from '../stores/service';
// ⭐ The two pure identifier helpers used to live in THIS file, and `stores/service.ts` imported
// one of them back — an import cycle that resolved only because every symbol crossing it was a
// hoisted `function` declaration. They now live in a leaf module both sides import, so a future
// module-scope `const` in either file cannot become a TDZ crash at boot. `identifiers.ts` says why.
import { normaliseDigits, normaliseBranchCode } from './identifiers';

/** ⭐ Re-exported so no caller changed when the cycle was broken — the store screen and
 *  `setOrganizationIdentity` both normalise a branch code the same way. */
export { normaliseBranchCode };

export interface CreateOrganizationInput {
  /** ⚠️ Unique across all organizations and permanent in practice — it is the stable handle. */
  readonly code: string;
  readonly name: string;
}

export interface CreateOrganizationResult {
  readonly orgId: string;
  readonly accountsSeeded: number;
  readonly categoriesSeeded: number;
  readonly periodsSeeded: number;
}

/** Postgres unique-violation. */
const UNIQUE_VIOLATION = '23505';

/**
 * ⭐ T-264 / DEF-284 slice 1 — the SINGLE definition of "how far ahead a fresh org is seeded."
 * 12 consecutive calendar months, starting at the org's current business month (Asia/Manila, via
 * `toBusinessDate` — the sanctioned idiom, not a raw-UTC one). Exported so
 * `scripts/backfill-fiscal-periods.ts` computes the identical window for an EXISTING org rather
 * than inventing a second answer to "how far ahead" — the same "one function, every caller" shape
 * `bootstrapOrganization` already uses for reference-data seeding.
 *
 * ⚠️ Deliberately not anchored to the 2027-01-01 cutover date. Any org bootstrapped before then
 * (the pilot's plan) is covered because 12 months comfortably reaches it from any 2026 start
 * month; hardcoding the cutover date would make this function need editing again once cutover has
 * passed, for no benefit — the general rule stays correct on both sides of that date.
 *
 * ⛔ **The cliff, named rather than left to be re-derived under pressure:** this rule covers
 * `2027-01-01` for a bootstrap in any month up to and including `2027-01`, and STOPS covering it
 * from `2027-02` onward (12 months forward from Feb 2027 reaches only Jan 2028). That is fine — an
 * org bootstrapped after cutover has its own cutover date, not this one — but it is a real edge,
 * not an unconditionally-safe window, and the next person to touch this number should see it here
 * rather than re-deriving it.
 */
export function fiscalPeriodSeedWindow(
  now = new Date(),
): { startYear: number; startMonth: number; months: number } {
  const [yStr, mStr] = toBusinessDate(now).split('-');
  return { startYear: Number(yStr), startMonth: Number(mStr), months: 12 };
}

/**
 * Creates an organization **and its reference data, in the caller's transaction**.
 *
 * ⛔ An organization always has its chart of accounts, its expense categories, and a year of
 * fiscal periods to post into — or it does not exist. All three seeds run here, on this
 * transaction, so there is no window in which an org exists that cannot post. Before T-264/DEF-284
 * there was no third seed at all: `postEntry` refused the very first entry any fresh org tried to
 * record, in every environment except a test or `dev-seed-inventory.ts`, both of which wrote their
 * own period by hand.
 */
export async function createOrganization(
  tx: Tx,
  input: CreateOrganizationInput,
): Promise<CreateOrganizationResult> {
  const code = input.code.trim();
  const name = input.name.trim();
  if (!code) throw new Error('createOrganization: an organization needs a code.');
  if (!name) throw new Error('createOrganization: an organization needs a name.');

  // The readable refusal. ⚠️ This is NOT the guarantee — `organizations.code` is `unique` and that
  // constraint is what actually makes a double-run a no-op. Checking first only buys a sentence a
  // human can act on instead of a raw 23505, and it is worth buying because the alternative is
  // learning the code was taken *after* someone has typed a production invocation.
  const existing = await organizationsRepo.getOrgByCode(tx, code);
  if (existing) {
    throw new Error(
      `createOrganization: an organization with code "${code}" already exists ` +
        `("${existing.name}"). Organization codes are unique and permanent; pick another, ` +
        'or use the existing organization.',
    );
  }

  let org: OrganizationRow;
  try {
    org = await organizationsRepo.insertOrganization(tx, { code, name });
  } catch (err: unknown) {
    // ⛔ Re-thrown, never recovered from. A unique violation ABORTS the transaction — every
    // statement after it is refused with 25P02 until rollback — so there is nothing to continue
    // into. Catching here translates the message and stops; it does not retry.
    if (isUniqueViolation(err)) {
      throw new Error(
        `createOrganization: an organization with code "${code}" already exists. ` +
          'Organization codes are unique and permanent.',
      );
    }
    throw err;
  }

  const { accountsSeeded, categoriesSeeded } = await organizationsRepo.seedReferenceData(tx, org.id);
  const { periodsInserted } = await fiscalPeriodsRepo.seedCalendarMonths(
    tx,
    org.id,
    fiscalPeriodSeedWindow(),
  );
  return { orgId: org.id, accountsSeeded, categoriesSeeded, periodsSeeded: periodsInserted };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === UNIQUE_VIOLATION;
}

export interface CreateFirstAdminInput {
  readonly orgId: string;
  /** ⚠️ A real person's real name. `persons.display_name` is what the ledger attributes the
   *  organization's first entries to — this is not a service account. */
  readonly displayName: string;
  /**
   * ⭐ **T-232 slice 2, decision 3 as the database permits it.** Defaults to `true`: the first
   * person of an organization is its owner and receives the four capabilities `super_admin` holds
   * and `admin` does not, as explicit grant rows.
   *
   * Pass `false` only to make a PLAIN admin — which exists so a test can prove the four grants are
   * doing the work rather than the matrix (`first-run-setup.test.ts` case 5, the non-zero control).
   */
  readonly withSuperAdminCapabilities?: boolean;
}

export interface CreateFirstAdminResult {
  readonly personId: string;
  /** The capabilities granted beyond the `admin` role. Empty when `withSuperAdminCapabilities`
   *  is false. Reported, never silent — the CLI prints it. */
  readonly grantedCapabilities: readonly Capability[];
}

/**
 * The first admin of an organization — the **base case** of the authority chain.
 *
 * ⭐ **`granted_by` is NULL, and that is correct rather than a shortcut.** `scripts/dev-seed.ts:106`
 * already states the rule and its reason: *"`granted_by` is null only for seeded rows — bible row
 * 116's authority chain is enforced by the service layer, and there is no grantor before the first
 * admin."* Do not invent a synthetic grantor to fill the column; a fabricated authority is worse
 * than an absent one, because it reads as evidence.
 *
 * ⛔ **Refuses outright once the org holds any role.** This is what makes it the *first* admin
 * rather than a back door that mints admins forever with no grantor. Once one exists the supported
 * path is `/admin/users` (T-219), which records who granted what.
 *
 * ⛔ It does **not** write `person_store_scope` — `createStore`'s §C.2 fan-out does that, and the
 * bootstrap is just another caller of it.
 *
 * ## ⚠️ The super_admin equivalence holds AT CREATION TIME, and a matrix change needs a backfill
 *
 * `SUPER_ADMIN_ONLY_CAPABILITIES` is derived from the matrix, so it is always current — but the
 * grants it produces are **materialised rows written once**. Add a fifth capability that
 * `super_admin` holds and `admin` does not, and every owner created before that day silently
 * lacks it: no error, no red test, just a refusal on a screen months later. Removing one leaves a
 * stale grant behind, which is worse — a live authority nobody decided to give.
 *
 * ⛔ **So a change to that set is a data migration, not an edit.** Write the backfill (and the
 * revocation, for a removal) for existing `person_grants` BEFORE changing the matrix.
 * `packages/auth/tests/super-admin-capability-set.test.ts` pins the set to exactly its four
 * members so that day arrives as a failing test with those instructions attached.
 */
export async function createFirstAdmin(
  tx: Tx,
  input: CreateFirstAdminInput,
): Promise<CreateFirstAdminResult> {
  const displayName = input.displayName.trim();
  if (!displayName) throw new Error('createFirstAdmin: the first admin needs a name.');

  if (await organizationsRepo.orgHasAnyRole(tx, input.orgId)) {
    throw new Error(
      'createFirstAdmin: this organization already has at least one role, so it already has an ' +
        'authority chain — this function only ever creates the FIRST one, whose grantor is null ' +
        'because there is nobody above it. Appoint further people through /admin/users, which ' +
        'records who granted the role.',
    );
  }

  const person = await personsRepo.insertPerson(tx, {
    orgId: input.orgId,
    displayName,
  });
  await accessRepo.insertRole(tx, {
    personId: person.id,
    orgId: input.orgId,
    role: 'admin',
    // ⭐ NULL by design — see this function's header. Not a TODO.
    grantedBy: null,
  });

  // ⭐ The owner's four extra capabilities, as real rows. `granted_by` is NULL for the same reason
  // the role's is: there is nobody above the first person, and a fabricated grantor would be worse
  // than an absent one because it reads as evidence.
  //
  // ⭐ T-248 / DEF-237 — `grantSource: 'owner'`, never `'elevation'`. This grant is never eligible
  // for the admin-arrival revocation: its holder already holds `admin` themselves (inserted just
  // above), so there is no later "an administrator arrived" event relative to their own grant —
  // they ARE the administrator from the moment of bootstrap.
  //
  // Not wired to call the revocation itself, deliberately: `orgHasAnyRole`'s refusal above means
  // this function only ever runs on an org with ZERO role history, so no manager could ever have
  // been elevated here yet — a revocation call on this path would be untested dead code, never
  // exercising its own "found something" branch.
  const grantedCapabilities =
    input.withSuperAdminCapabilities === false ? [] : SUPER_ADMIN_ONLY_CAPABILITIES;
  for (const capability of grantedCapabilities) {
    await accessRepo.grantCapability(tx, {
      personId: person.id,
      grantName: capability,
      grantedBy: null,
      grantSource: 'owner',
    });
  }

  return { personId: person.id, grantedCapabilities };
}

// -----------------------------------------------------------------------------------------
// T-232 slice 2 — the one function first-run setup and the CLI both call
// -----------------------------------------------------------------------------------------

export interface BootstrapOrganizationInput {
  /** ⚠️ Unique across all organizations and permanent in practice. */
  readonly code: string;
  readonly name: string;
  /** The first person's REAL name — `persons.display_name` is ledger attribution. */
  readonly adminDisplayName: string;
  readonly storeCode: string;
  readonly storeName: string;
  /** Six digits. Validated before anything is written. */
  readonly pin: string;
  /**
   * The **verified** Firebase uid, when this is the `/setup` screen rather than the CLI.
   *
   * ⛔ Verified by the CALLER — this module never takes an unverified assertion, the same posture
   * `signInWithFirebase` states: *"a login is not an introduction."*
   */
  readonly firebaseUid?: string | null;
}

export interface BootstrapOrganizationResult
  extends CreateOrganizationResult,
    CreateFirstAdminResult {
  readonly storeId: string;
  readonly locationId: string;
  readonly scopedAdminIds: readonly string[];
  readonly pinCredentialId: string;
  readonly firebaseCredentialId: string | null;
}

/**
 * ⭐ **Standing up an organization — the ONE function `scripts/bootstrap-org.ts` and `/setup` both
 * call, so the CLI and the screen cannot drift.** T-232 slice 2.
 *
 * ⛔ **It takes no `Actor`, and that is not an oversight** — this module's header already argues
 * it: there is no principal before the organization exists, *"not 'does not yet', but cannot. Do
 * not 'fix' this by adding one."* The gate is the caller. The CLI is unreachable from a request
 * handler; `/setup` is gated on a verified Firebase identity with no credential row, plus the
 * zero-organization refusal below.
 *
 * ⚠️ **Everything happens in the CALLER's transaction.** A bootstrap that half-succeeds leaves an
 * organization nobody can sign into *and* no way to re-run, because `createFirstAdmin` would refuse
 * the retry. `first-run-setup.test.ts` case 2 proves the rollback with an injected failure.
 */
export async function bootstrapOrganization(
  tx: Tx,
  input: BootstrapOrganizationInput,
): Promise<BootstrapOrganizationResult> {
  // 1. Serialise first run BEFORE reading, or two concurrent callers both read "no organizations"
  //    and both write one. There is nothing else to lock on an empty database.
  await organizationsRepo.lockFirstRun(tx);

  // 2. ⛔ First run happens once, ever.
  if (await organizationsRepo.anyOrganizationExists(tx)) {
    throw new Error(
      'bootstrapOrganization: this system already has an organization, so first-run setup is ' +
        'closed. Add people through /admin/users and stores through /admin/stores.',
    );
  }

  // 3. ⛔ The PIN is validated BEFORE anything is written. The CLI learned this one already:
  //    finding out after creating an organization is a bad time to learn it — and here it is worse,
  //    because a half-run would leave setup permanently closed.
  if (!isValidPinFormat(input.pin)) {
    throw new Error('bootstrapOrganization: the PIN must be exactly 6 digits.');
  }

  // 3b. ⛔ A uid that is PRESENT but blank, refused here for the same reason and in the same place.
  //     `input.firebaseUid?.trim()` treats `'   '` as absent, so step 8 would skip the credential
  //     and the organisation would commit without one — and `/setup` would then call
  //     `signInWithFirebase` with that uid, find nothing, and fail AFTER the point of no return,
  //     with first-run setup closed forever. That is the single path in this function with no
  //     retry, so the blank is a refusal and never a default.
  //
  //     ⚠️ Absent (`undefined`/`null`) still means the CLI path and is legitimate. The distinction
  //     is "did the caller claim to have a verified identity?", not "is the string truthy?"
  if (input.firebaseUid !== undefined && input.firebaseUid !== null && input.firebaseUid.trim() === '') {
    throw new Error(
      'bootstrapOrganization: a firebase uid was supplied but is blank. Pass the verified uid, ' +
        'or omit it entirely for the CLI path — a blank one would create an organization nobody ' +
        'can sign into with an email.',
    );
  }

  // 4. The organization, its chart of accounts, its expense categories, and a year of fiscal
  //    periods to post into (T-264/DEF-284 slice 1).
  const org = await createOrganization(tx, { code: input.code, name: input.name });

  // 5. The first person: the `admin` role and the owner's four capabilities, both `granted_by` NULL.
  const admin = await createFirstAdmin(tx, {
    orgId: org.orgId,
    displayName: input.adminDisplayName,
  });

  // 6. The first store, through T-222's tested path — which also runs CAPABILITY-MATRIX §C.2's
  //    fan-out (the `person_store_scope` row) and creates the default room. ⭐ This is why the first
  //    person holds `admin` and not `super_admin`: the fan-out grants scope to ADMIN roles only, so
  //    a super_admin would end up scoped to no store and land nowhere (DEF-200's shape).
  const store = await createStore(
    tx,
    { personId: admin.personId, orgId: org.orgId },
    { code: input.storeCode, name: input.storeName },
  );

  // 7. The PIN. ⚠️ **T-302 — the hash is now per ORGANISATION, so the ordering constraint this
  //    step used to carry is weaker than it looks**: the key needs only `org.orgId`, which step 4
  //    already produced. The store is still required, but by the row's own CHECK (a `pin`
  //    credential must carry a `store_id`), not by the key. ⛔ The step stays here regardless —
  //    `createStore` must run first for the admin to hold store scope at all, and a PIN issued
  //    before any store exists would have nowhere to be stamped.
  const pinCredential = await setPin(tx, {
    orgId: org.orgId,
    personId: admin.personId,
    storeId: store.storeId,
    pin: input.pin,
  });

  // 8. The browser credential, when there is one. ⚠️ `person_credentials_shape_check` refuses a
  //    `firebase` row carrying a local secret, and `person_credentials_external_id_unique` refuses
  //    a uid already linked **and still live** — since T-237 that index is partial on
  //    `revoked_at is null`, so an unlinked uid may be linked again (DEF-224). Neither can fire
  //    here (zero orgs means zero persons means zero credentials), which is why they are left to
  //    the database rather than re-checked here.
  const firebaseUid = input.firebaseUid?.trim();
  const firebaseCredential = firebaseUid
    ? await sessionsRepo.insertCredential(tx, {
        personId: admin.personId,
        kind: 'firebase',
        externalId: firebaseUid,
      })
    : null;

  return {
    ...org,
    ...admin,
    storeId: store.storeId,
    locationId: store.locationId,
    scopedAdminIds: store.scopedAdminIds,
    pinCredentialId: pinCredential.credentialId,
    firebaseCredentialId: firebaseCredential?.id ?? null,
  };
}


// -----------------------------------------------------------------------------------------
// T-229 slice 4 — the organisation's registered identity. **DEF-208.**
//
// ⛔ **A REPLATFORM LOSS, not a missing screen.** v1 records `legalName`, `tin` and `taxType` on
// every store (`admin/stores/store-editor.tsx:56-70`); v2 carried none of them across. The
// placement is CORRECTED on the way back in: in PH a corporation holds ONE TIN and each branch
// carries a code against it (`stores.tin_branch_code`), so duplicating the number onto every store
// the way v1 did is N places for it to be wrong.
//
// ⚠️ **Nothing here is a compliance feature.** Bible §13 row 75: a management ledger, never a
// statutory filing basis, and nothing may be labelled or exported as BIR-ready. `tax_type` computes
// nothing; the fields exist so a document can print the right identity.
// -----------------------------------------------------------------------------------------

/** Org-scoped, admin ✅, manager ✗. ⚠️ The noun reads oddly for legal identity; the BAR is exactly
 *  right — the matrix's own words for this row are "the technical residue". T-229 open question 5,
 *  answered 2026-09-07: reuse it rather than mint `manage_organization` for a better name. */
const IDENTITY_CAPABILITY = 'manage_chart_of_accounts' as const;

export interface OrganizationIdentity {
  readonly legalName: string | null;
  readonly tin: string | null;
  readonly taxType: 'vat' | 'non_vat' | null;
}

/** Trim, and treat a blank as "not stated" rather than an empty string (DEF-087's shape). */
function blankToNull(raw: string | null): string | null {
  if (raw === null) return null;
  const t = raw.trim();
  return t === '' ? null : t;
}

/**
 * ⭐ **The org is the ACTOR's, never a parameter.** There is deliberately no `orgId` argument: a
 * function that took one would be the shape DEF-210 exists to close.
 *
 * ⚠️ All three fields are written every call — the screen owns them as a set, so omitting one
 * CLEARS it. That is what makes a wrong TIN removable, which matters more here than anywhere: an
 * identifier that cannot be corrected is worse than one that was never set.
 */
export async function setOrganizationIdentity(
  tx: Tx,
  actor: Actor,
  input: OrganizationIdentity,
): Promise<void> {
  await authorize(tx, actor, IDENTITY_CAPABILITY, {});

  if (input.taxType !== null && input.taxType !== 'vat' && input.taxType !== 'non_vat') {
    throw new Error("setOrganizationIdentity: tax type must be 'vat', 'non_vat', or not stated.");
  }

  await organizationsRepo.setIdentity(tx, actor.orgId, {
    legalName: blankToNull(input.legalName),
    tin: normaliseDigits(input.tin, 'A TIN', 9, 12),
    taxType: input.taxType,
  });
}

/**
 * The screen's read. ⚠️ **Ungated**, matching every other settings surface in this app: the gate
 * belongs to the WRITE, and hiding a screen is presentation, not a control (DEF-051).
 */
export async function organizationIdentity(
  tx: Tx,
  actor: Actor,
): Promise<OrganizationIdentity & { name: string; code: string }> {
  const row = await organizationsRepo.identityOf(tx, actor.orgId);
  if (!row) throw new Error('organizationIdentity: this organization does not exist.');
  return {
    name: row.name,
    code: row.code,
    legalName: row.legalName,
    tin: row.tin,
    taxType: row.taxType,
  };
}
