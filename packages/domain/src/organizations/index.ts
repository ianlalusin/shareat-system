/**
 * Standing up an organization — T-228, `docs/tasks/228-organization-bootstrap.md`, closing DEF-195.
 *
 * ## ⛔ The chicken-and-egg, and why the order is the whole design
 *
 * | To do this | You first need |
 * |---|---|
 * | Sign in | a **PIN** |
 * | `setPin` | a **`storeId`** — the PIN is hashed per store (`pinLookupHash(storeId, pin)`) |
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
 * ⭐ **The gate is the runner, not the caller.** `scripts/bootstrap-org.ts` is the only caller and it
 * is not reachable from any request handler — no route imports this module, and nothing here takes
 * an `Actor` that a request could supply.
 *
 * ⚠️ **Stated precisely, because the spec's wording invites a wrong reading.** The script does not
 * *call* `applyPrincipal({ kind: 'system' })`; it opens a plain `transaction()`, which connects as
 * the owner role, for which RLS does not apply. That is the same posture every scheduler script
 * already runs under, and it is what `packages/db/src/rls/principal.ts:38` describes a `system`
 * principal as doing — *"deliberately does nothing: it stays as the connecting (owner) role... and
 * it is why a `system` principal must never be reachable from a request handler."* The effect is
 * identical; the call is simply not made, here or anywhere else in the codebase.
 */
import {
  organizationsRepo,
  personsRepo,
  accessRepo,
  sessionsRepo,
  type OrganizationRow,
  type Tx,
} from '@shareat/db';
// ⭐ T-229 slice 4 — the FIRST gated function in this module. Everything above it runs before a
// principal exists (bootstrap), which is why the import was not needed until now.
import {
  authorize,
  isValidPinFormat,
  setPin,
  CAPABILITIES,
  CAPABILITY_MATRIX,
  type Actor,
  type Capability,
} from '@shareat/auth';
// ⚠️ T-232 slice 2. `stores/service.ts` imports `normaliseBranchCode` from THIS file, so this
// edge closes a cycle. It is safe only because everything crossing it in both directions is a
// hoisted `function` declaration — ⛔ never move `createStore` or `normaliseBranchCode` behind a
// module-scope `const`, which would be a TDZ error at import time rather than a type error.
import { createStore } from '../stores/service';

export interface CreateOrganizationInput {
  /** ⚠️ Unique across all organizations and permanent in practice — it is the stable handle. */
  readonly code: string;
  readonly name: string;
}

export interface CreateOrganizationResult {
  readonly orgId: string;
  readonly accountsSeeded: number;
  readonly categoriesSeeded: number;
}

/** Postgres unique-violation. */
const UNIQUE_VIOLATION = '23505';

/**
 * Creates an organization **and its reference data, in the caller's transaction**.
 *
 * ⛔ An organization always has its chart of accounts and its expense categories, or it does not
 * exist. Both seeds run here, on this transaction, so there is no window in which an org exists
 * that cannot post.
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
  return { orgId: org.id, accountsSeeded, categoriesSeeded };
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
 * ⭐ **Exactly the capabilities `super_admin` holds that `admin` does not — DERIVED, never listed.**
 *
 * The same discipline, and the same reason, as `ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER`: *"computed
 * from the matrix above so the two can never silently drift apart."* Today it is four —
 * `approve_item`, `post_journal_entry`, `cross_org_access`, `view_franchise_sales`.
 *
 * ⛔ **Why this exists at all.** Decision 3 asked for the first person to hold BOTH an `admin` and
 * a `super_admin` role row. The database refuses: `person_roles_active_person_org_unique`
 * (`migrations/0014_access_roles_and_grants.sql:56`) allows **at most one active role per
 * (person, org)**, and `authorize` resolves exactly one. Because no capability is
 * `admin: true, super_admin: false`, `admin` + this set authorizes **precisely** what `super_admin`
 * authorizes — an equivalence, not a downgrade, and `first-run-setup.test.ts` case 4 proves it
 * capability by capability.
 */
export const SUPER_ADMIN_ONLY_CAPABILITIES: readonly Capability[] = CAPABILITIES.filter(
  (c) => CAPABILITY_MATRIX[c].super_admin && !CAPABILITY_MATRIX[c].admin,
);

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
  const grantedCapabilities =
    input.withSuperAdminCapabilities === false ? [] : SUPER_ADMIN_ONLY_CAPABILITIES;
  for (const capability of grantedCapabilities) {
    await accessRepo.grantCapability(tx, {
      personId: person.id,
      grantName: capability,
      grantedBy: null,
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

  // 4. The organization, its chart of accounts and its expense categories.
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

  // 7. The PIN — possible only now, because it is hashed per store.
  const pinCredential = await setPin(tx, {
    personId: admin.personId,
    storeId: store.storeId,
    pin: input.pin,
  });

  // 8. The browser credential, when there is one. ⚠️ `person_credentials_shape_check` refuses a
  //    `firebase` row carrying a local secret, and `person_credentials_external_id_unique` refuses
  //    a uid already linked — neither can fire here (zero orgs means zero persons means zero
  //    credentials), which is why they are left to the database rather than re-checked here.
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

/**
 * ⭐ **Normalises a typed identifier to digits.** A person may type `123-456-789` or
 * `123 456 789`; the column stores one canonical shape so two spellings of one number cannot read
 * as two numbers.
 *
 * ⛔ **Format only — no checksum, and no rule tying a branch code to its TIN.** A format check
 * catches a typo; a checksum starts to look like validating a registration, which is the compliance
 * posture bible §13 row 75 refuses. If a legitimate PH form is ever refused here, WIDEN the pattern
 * with the source recorded — never drop the check. The DATABASE holds the same rule and is the
 * authority (RULES §6 item 3, bible §15.11).
 */
function normaliseDigits(raw: string | null, field: string, min: number, max: number): string | null {
  if (raw === null) return null;
  const stripped = raw.replace(/[\s-]/g, '');
  if (stripped === '') return null;
  if (!new RegExp(`^[0-9]{${min},${max}}$`).test(stripped)) {
    throw new Error(
      `${field} must be ${min === max ? String(min) : `${min}-${max}`} digits — dashes and spaces ` +
        `are fine and are removed, but "${raw}" is not a number of that length.`,
    );
  }
  return stripped;
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

/** ⭐ Exported for the store screen, which normalises a branch code the same way. */
export function normaliseBranchCode(raw: string | null): string | null {
  return normaliseDigits(raw, 'A branch code', 3, 5);
}
