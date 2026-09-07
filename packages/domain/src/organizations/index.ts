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
import { organizationsRepo, personsRepo, accessRepo, type OrganizationRow, type Tx } from '@shareat/db';

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
}

export interface CreateFirstAdminResult {
  readonly personId: string;
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

  return { personId: person.id };
}
