/**
 * authorize() — the ONE function every mutation calls (docs/tasks/121-roles-and-access.md
 * Contract §2, bible §7 rule 1: "Every server action's first statement is
 * `await authorize(actor, action, resource)`. No exceptions, no inline role checks
 * scattered through feature code.").
 *
 * ## It THROWS. It is not a boolean.
 *
 * A boolean invites `if (can) { … }` with no `else` — a check whose failure path does
 * nothing, which is exactly DEF-051 (`canAccessFinancialReports` hid the UI while the data
 * stayed readable) in a different costume. `authorize()` resolves to `void` on success and
 * THROWS `AuthorizationError` on any failure, so a caller that forgets to handle denial
 * gets an unhandled rejection — loud — rather than a silently-ignored `false`.
 *
 * ## The three axes, always checked, always in this order
 *
 * 1. **Organization** — does the actor even operate in the org the resource belongs to?
 *    Checked FIRST and unconditionally (except for 'platform'-scoped capabilities, which
 *    are cross-org by design — `cross_org_access`, `view_franchise_sales`). This is
 *    invariant 7: holding a capability in another org is denied, and it is denied before
 *    the capability itself is even evaluated, so the error always names the right reason.
 * 2. **Role + grants** — does the actor's role grant this capability per
 *    `CAPABILITY_MATRIX`, OR does the actor hold an explicit `person_grants` override for
 *    it (the grant-time-fallback mechanism, bible rows 115-116)? A role with no active row
 *    at all is refused outright — there is no implicit lowest-privilege default (contrast
 *    v1, where an unconfigured user quietly became the least-privileged Server position;
 *    here "no role" means "not authorized for anything in this org", stated, not inferred).
 * 3. **Store scope** — for a 'store'-scoped capability only: does a `person_store_scope`
 *    row exist for this exact store? Checked SEPARATELY from the capability decision and
 *    ALWAYS, per CAPABILITY-MATRIX.md rule 4 ("scope is checked separately and always") —
 *    invariant 6 exists specifically to prove holding the capability is not sufficient on
 *    its own.
 *
 * `close_period` carries one further, capability-specific condition on top of these three
 * — see the dedicated comment at that branch below.
 */
import { accessRepo, type Tx } from '@shareat/db';
import { CAPABILITY_MATRIX, CAPABILITY_SCOPE, type Capability, type Role } from './capabilities';
import { AuthorizationError } from './errors';

/** ⚠️ Re-exported, not declared: it moved to the dependency-free `./errors` leaf so a unit test can
 *  import it without pulling `@shareat/db` through this file. Every existing importer is unchanged. */
export { AuthorizationError };

/** Who is acting, and in which org's context — resolved server-side from a verified
 * session (bible §7.1: "no server action ever accepts an actor identity as a parameter"
 * meaning the CLIENT never supplies it; `orgId` here is the org the current request
 * operates under, e.g. from the signed-in store/org switcher, itself verified server-side
 * before `authorize()` is ever called). */
export interface Actor {
  readonly personId: string;
  readonly orgId: string;
}

export interface AuthorizeContext {
  /** Required when the capability's scope is 'store' (Contract §3's Scope column).
   * Omitted for 'org' and 'platform' capabilities. */
  readonly storeId?: string;
  /** The RESOURCE's org, if it could differ from `actor.orgId` — pass this to prove a
   * cross-org attempt is denied (invariant 7). Defaults to `actor.orgId`: the ordinary,
   * same-org case needs nothing extra. */
  readonly orgId?: string;
}

/**
 * Checks all three axes for `capability` and throws `AuthorizationError` on the first one
 * that fails. Resolves to nothing on success — call it and keep going; there is no return
 * value to branch on, by design (see this file's top comment).
 */
export async function authorize(
  tx: Tx,
  actor: Actor,
  capability: Capability,
  ctx: AuthorizeContext = {},
): Promise<void> {
  const scope = CAPABILITY_SCOPE[capability];

  // --- Axis 1: organization -------------------------------------------------------------
  if (scope !== 'platform') {
    const resourceOrgId = ctx.orgId ?? actor.orgId;
    if (resourceOrgId !== actor.orgId) {
      throw new AuthorizationError(
        `authorize: actor's org (${actor.orgId}) does not match the resource's org (${resourceOrgId}) for '${capability}'`,
        capability,
      );
    }
  }

  // --- Axis 3a: role ---------------------------------------------------------------------
  // Resolved from Postgres, never trusted from the caller (bible §7.3: "Roles live in
  // Postgres... Postgres answers what you may do"). No active role at all is a denial, not
  // a fallback to the least-privileged role — an unconfigured person is authorized for
  // NOTHING, not "staff by default".
  const activeRole = await accessRepo.activeRoleForPerson(tx, actor.personId, actor.orgId);
  if (!activeRole) {
    throw new AuthorizationError(
      `authorize: person ${actor.personId} has no active role in org ${actor.orgId}`,
      capability,
    );
  }
  const role = activeRole.role as Role;

  // --- Axis 3a/3b: capability from the matrix, OR an explicit override grant -------------
  const matrixAllows = CAPABILITY_MATRIX[capability][role];
  const allowed = matrixAllows || (await accessRepo.personHasActiveGrant(tx, actor.personId, capability));
  if (!allowed) {
    throw new AuthorizationError(`authorize: role '${role}' may not '${capability}'`, capability);
  }

  // --- Axis 2: store scope, for 'store'-scoped capabilities only -------------------------
  // CAPABILITY-MATRIX.md rule 4: "scope is checked separately and always" — holding the
  // capability is necessary but never sufficient on its own (invariant 6).
  if (scope === 'store') {
    if (!ctx.storeId) {
      throw new AuthorizationError(`authorize: '${capability}' is store-scoped but no storeId was given`, capability);
    }
    const storeInOrg = await accessRepo.storeBelongsToOrg(tx, ctx.storeId, actor.orgId);
    if (!storeInOrg) {
      throw new AuthorizationError(`authorize: store ${ctx.storeId} does not belong to org ${actor.orgId}`, capability);
    }
    const inScope = await accessRepo.personHasStoreScope(tx, actor.personId, ctx.storeId);
    if (!inScope) {
      throw new AuthorizationError(
        `authorize: person ${actor.personId} (role '${role}') has no store scope for ${ctx.storeId}`,
        capability,
      );
    }
  }

  // --- close_period's extra condition (CAPABILITY-MATRIX.md §Open 2) --------------------
  // Bible row 101 says admin AND manager may close a period. Bible row 114 says
  // capabilities are store-scoped. A fiscal period is ORG-wide, so a manager scoped to one
  // store closing it would be closing every OTHER store's books too. The resolution: a
  // manager may close only if their store scope covers the WHOLE org — checked here,
  // because it depends on that manager's specific scope rows, not on the role alone (see
  // capabilities.ts's `CONDITIONAL_CAPABILITIES` comment for why this cannot live in the
  // matrix itself). super_admin and admin are unaffected — their row is a plain `true`.
  if (capability === 'close_period' && role === 'manager') {
    const coversWholeOrg = await accessRepo.personCoversWholeOrg(tx, actor.personId, actor.orgId);
    if (!coversWholeOrg) {
      throw new AuthorizationError(
        "authorize: 'close_period' requires a manager's store scope to cover the whole org " +
          '(CAPABILITY-MATRIX.md §Open 2) — this manager does not cover every active store',
        capability,
      );
    }
  }
}
