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
 *    ⭐ **T-341 / DEF-414.** For a 'store'-scoped capability, the override grant must match
 *    THIS store: a store-carrying row (`'position'`-sourced, or since T-349 / DEF-456 a `'grant'`
 *    hold in their own right) is honoured only at the store it names, never at a store the
 *    person merely has scope at — `accessRepo.personHasActiveGrant`'s `atStoreId` argument. A
 *    person-level grant (every other source, `storeId IS NULL`) still matches everywhere,
 *    unchanged. No code here changed for T-349 — `personHasActiveGrant`'s own query already
 *    reads a store-scoped row correctly, whatever its source.
 * 3. **Store scope** — for a 'store'-scoped capability only: does a `person_store_scope`
 *    row exist for this exact store? Checked SEPARATELY from the capability decision and
 *    ALWAYS, per CAPABILITY-MATRIX.md rule 4 ("scope is checked separately and always") —
 *    invariant 6 exists specifically to prove holding the capability is not sufficient on
 *    its own. A store-scoped grant passing axis 2 above says only that THIS store's default
 *    justifies the capability; this axis still separately requires the person to hold scope
 *    there — the two are never the same check.
 *
 * `close_period` carries one further, capability-specific condition on top of these three
 * — see the dedicated comment at that branch below.
 */
import { accessRepo, organizationsRepo, storesRepo, type Tx } from '@shareat/db';
import { logger } from '@shareat/core/logger';
import { CAPABILITY_MATRIX, CAPABILITY_SCOPE, grantsConfer, type Capability, type Role } from './capabilities';
import { AuthorizationError } from './errors';
import { enqueueAuthorizeDenied } from './security-events';
import {
  closePeriodNeedsWholeOrg,
  jobIsElsewhere,
  noActiveRole,
  notAssignedToStore,
  otherOrg,
  roleMayNot,
  storeNotInOrg,
  storeRequired,
} from './refusal-text';

/**
 * Amendment R2/R3 item 2/6 — the one helper behind all four refusal-branch lookups below. Each
 * runs inside its own SAVEPOINT (`tx.transaction()`, which drizzle emits as a nested Postgres
 * transaction) so a lookup that ERRORS rolls back only itself, never the caller's outer `tx`
 * (Amendment R2 — `.catch(() => undefined)` alone does not un-abort an aborted transaction). A
 * failed lookup is never silent: it is logged once at `warn` with the error, then swallowed —
 * never thrown, because the refusal it decorates must still reach the caller with its fallback
 * wording (Amendment R3 item 2).
 */
async function savepointLookup<T>(tx: Tx, run: (t: Tx) => Promise<T>): Promise<T | undefined> {
  return tx.transaction(run).catch((err: unknown) => {
    logger.warn({ err }, 'authorize: a refusal-branch lookup failed inside its savepoint');
    return undefined;
  });
}

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
  deps: AuthorizeDeps = {},
): Promise<void> {
  const refusal = await decide(tx, actor, capability, ctx);
  if (!refusal) return;
  const error = await refusal();
  // T-402 S2 (R9, A1): the denial goes to the in-process outbox - SYNCHRONOUS, nothing awaited, no second connection -
  // and is written after the fact (first of the Manila day as a row, the rest counted). The refusal is thrown unchanged.
  enqueueAuthorizeDenied(
    {
      orgId: actor.orgId,
      actorPersonId: actor.personId,
      capability,
      storeId: CAPABILITY_SCOPE[capability] === 'store' ? (ctx.storeId ?? null) : null,
    },
    deps.now ?? Date.now,
  );
  throw error;
}

/**
 * T-402 S2 (A2): the NON-LOGGING yes/no for `actor` + `capability` (+ ctx) - the same `decide()` as `authorize()`, so it
 * can never disagree, but it writes nothing. For render probes and "try A, else fall back to B" checks, where a denial is
 * an ordinary answer, not an attempted act. A real mutation gate is `authorize()`, never this: a forgotten gate that
 * uses `authorize()` still logs (the fail-safe direction).
 */
export async function can(tx: Tx, actor: Actor, capability: Capability, ctx: AuthorizeContext = {}): Promise<boolean> {
  return (await decide(tx, actor, capability, ctx)) === null;
}

/** T-402 S2: the clock behind the denial's Manila business day, injectable so a test can cross Manila midnight. */
interface AuthorizeDeps {
  readonly now?: () => number;
}

/**
 * T-391 S6 - a NON-THROWING yes/no that shares authorize()'s decision code (`decide`), so it can never disagree with it:
 * "may `personId` do `capability` at `storeId`?" - org, role (matrix or grant) and store scope. The org is the store's own
 * (RLS keeps a foreign store invisible, which answers false). For REPORTS and readiness checks only: a mutation is gated by
 * `authorize()`, never by this.
 */
export async function canAt(tx: Tx, personId: string, capability: Capability, storeId: string): Promise<boolean> {
  const orgId = await accessRepo.orgIdOfStore(tx, storeId);
  if (!orgId) return false;
  return (await decide(tx, { personId, orgId }, capability, { storeId })) === null;
}

/** A refusal is built lazily, so its savepointed message lookups only run when someone is actually refused. */
type Refusal = () => Promise<AuthorizationError>;

/** The ONE decision: null when allowed, else the refusal to throw. Shared by authorize() and canAt(). */
async function decide(tx: Tx, actor: Actor, capability: Capability, ctx: AuthorizeContext): Promise<Refusal | null> {
  const scope = CAPABILITY_SCOPE[capability];

  // --- Axis 1: organization -------------------------------------------------------------
  if (scope !== 'platform') {
    const resourceOrgId = ctx.orgId ?? actor.orgId;
    if (resourceOrgId !== actor.orgId) {
      return async () =>
        new AuthorizationError(
        `authorize: actor's org (${actor.orgId}) does not match the resource's org (${resourceOrgId}) for '${capability}'`,
        capability,
        // Row 4 — no lookup, no org named at all (bible §7/§15.11: never disclose the resource's org).
        otherOrg(capability),
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
    // Row 1 — refusal-branch-only lookup (Invariant 5: never on the success path above).
    // Amendment R2 — inside a SAVEPOINT (`tx.transaction()`, a nested Postgres transaction): a
    // lookup that ERRORS aborts whatever transaction it ran in, and `.catch(() => undefined)`
    // alone does not un-abort one — it would only swallow the error while leaving the CALLER's tx
    // aborted, which is exactly what breaks the probe callers (canBypassBlock and friends) that
    // keep writing in the same tx after a caught refusal. The savepoint rolls back on its own;
    // the outer `tx` is untouched either way.
    return async () => {
      const org = await savepointLookup(tx, (t) => organizationsRepo.identityOf(t, actor.orgId));
      return new AuthorizationError(
        `authorize: person ${actor.personId} has no active role in org ${actor.orgId}`,
        capability,
        noActiveRole(org?.name),
      );
    };
  }
  const role = activeRole.role as Role;

  // --- Axis 3a/3b: capability from the matrix, OR an explicit override grant -------------
  // T-341 / DEF-414 — a store-scoped capability's grant check is narrowed to THIS store (a
  // 'position'-sourced grant matches only its own default's store; a person-level grant still
  // matches everywhere, unchanged). Axis 2 below still runs separately and always — a store-scoped
  // call with no storeId falls through to axis 2's own "no storeId was given" refusal unchanged.
  const matrixAllows = CAPABILITY_MATRIX[capability][role];
  // T-475 S3 (Q3=A): a role-only capability is never conferred by a grant (`grantsConfer`), so the grant lookup is skipped.
  const allowed =
    matrixAllows ||
    (grantsConfer(capability) && (await accessRepo.personHasActiveGrant(tx, actor.personId, capability, scope === 'store' ? ctx.storeId : undefined)));
  if (!allowed) {
    // Row 5 — S2b/DEF-430: for a store-scoped capability, one savepointed lookup asks whether a
    // position at ANOTHER store gives the person this capability, and names that store instead of
    // blaming the role. Org/platform-scoped capabilities and a missing storeId skip the lookup —
    // there is nowhere else to point to.
    const rowFiveStoreId = scope === 'store' ? ctx.storeId : undefined;
    return async () => {
      const found = rowFiveStoreId
        ? await savepointLookup(tx, async (t) => {
            const jobs = await accessRepo.positionGrantsElsewhere(t, {
              personId: actor.personId,
              orgId: actor.orgId,
              capability,
              excludingStoreId: rowFiveStoreId,
            });
            return jobs.length ? { jobs, here: await storesRepo.getById(t, actor.orgId, rowFiveStoreId) } : undefined;
          })
        : undefined;
      return new AuthorizationError(
        `authorize: role '${role}' may not '${capability}'`,
        capability,
        found ? jobIsElsewhere(capability, found.here, found.jobs) : roleMayNot(role, capability),
      );
    };
  }

  // --- Axis 2: store scope, for 'store'-scoped capabilities only -------------------------
  // CAPABILITY-MATRIX.md rule 4: "scope is checked separately and always" — holding the
  // capability is necessary but never sufficient on its own (invariant 6).
  if (scope === 'store') {
    if (!ctx.storeId) {
      // No lookup — there is no storeId to look up.
      return async () =>
        new AuthorizationError(`authorize: '${capability}' is store-scoped but no storeId was given`, capability, storeRequired(capability));
    }
    const storeId = ctx.storeId; // narrowed once, so the closures below don't need it re-narrowed
    const storeInOrg = await accessRepo.storeBelongsToOrg(tx, storeId, actor.orgId);
    if (!storeInOrg) {
      // Row 3 — names the ACTOR's own org, never the foreign one the given storeId actually
      // belongs to (bible §15.11: no cross-tenant disclosure). Amendment R2 — savepoint, see row 1.
      return async () => {
        const org = await savepointLookup(tx, (t) => organizationsRepo.identityOf(t, actor.orgId));
        return new AuthorizationError(`authorize: store ${storeId} does not belong to org ${actor.orgId}`, capability, storeNotInOrg(org?.name));
      };
    }
    const inScope = await accessRepo.personHasStoreScope(tx, actor.personId, storeId);
    if (!inScope) {
      // Row 2 — reuses the same storeId Postgres already checked above. Amendment R2 — savepoint.
      return async () => {
        const store = await savepointLookup(tx, (t) => storesRepo.getById(t, actor.orgId, storeId));
        return new AuthorizationError(
          `authorize: person ${actor.personId} (role '${role}') has no store scope for ${storeId}`,
          capability,
          notAssignedToStore(capability, store),
        );
      };
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
      // Amendment R2 — savepoint, see row 1.
      return async () => {
        const org = await savepointLookup(tx, (t) => organizationsRepo.identityOf(t, actor.orgId));
        return new AuthorizationError(
          "authorize: 'close_period' requires a manager's store scope to cover the whole org " +
            '(CAPABILITY-MATRIX.md §Open 2) — this manager does not cover every active store',
          capability,
          closePeriodNeedsWholeOrg(org?.name),
        );
      };
    }
  }
  return null;
}

/**
 * ⭐ **T-288 — which capabilities this actor holds, for PRESENTATION and page-level read gating.**
 *
 * Ian, 2026-09-12: *"do both hide the menu and gate the reads."*
 *
 * ## ⛔ This is NOT `authorize()`, and the three differences are all deliberate
 *
 * 1. **It returns a set instead of throwing.** `authorize()` throws precisely so a caller cannot
 *    write `if (can) {…}` with no `else`. That reasoning is unchanged and this function does not
 *    weaken it — a *menu* genuinely needs a boolean, because "render the link or do not" has no
 *    failure path to forget. ⛔ **Never branch a mutation on this.** The write gate is
 *    `authorize()`, unchanged, still inside every domain service.
 * 2. **Store scope is NOT consulted.** It answers *"may this person open this CLASS of screen"*,
 *    not *"may they act on this store"*. A page is often not store-specific, or lets you pick the
 *    store after it loads — there is no single `storeId` to check at page level. The per-store
 *    decision stays exactly where it is: axis 2 of `authorize()`, on the action.
 *    ⚠️ That makes this deliberately MORE permissive than `authorize()` for a store-scoped
 *    capability. That is the safe direction here — the screen opens, and the action is still
 *    refused properly. The reverse would hide a screen someone may legitimately use.
 * 3. **It reads role and grants ONCE**, so a sidebar asking about twenty routes costs two queries
 *    rather than forty.
 *
 * ## ⭐ Why it lives HERE and not in `apps/erp`
 *
 * The rule "the matrix allows it, OR an explicit grant does" is axis 3a/3b of `authorize()`,
 * fifteen lines above. A second copy of that rule in a front-end would be a second source of truth
 * that drifts — the defect class this repo has filed repeatedly. Keeping it adjacent means any
 * change to one is visible in review of the other.
 */
export async function heldCapabilities(tx: Tx, actor: Actor): Promise<ReadonlySet<Capability>> {
  const activeRole = await accessRepo.activeRoleForPerson(tx, actor.personId, actor.orgId);
  // ⛔ No active role is NOT a fallback to the least-privileged role — same posture as
  //    `authorize()` above. An unconfigured person holds nothing.
  if (!activeRole) return new Set();
  const role = activeRole.role as Role;

  const grants = await accessRepo.grantsForPerson(tx, actor.personId);
  const granted = new Set(grants.filter((g) => g.revokedAt === null).map((g) => g.grantName));

  const held = new Set<Capability>();
  for (const capability of Object.keys(CAPABILITY_MATRIX) as Capability[]) {
    if (CAPABILITY_MATRIX[capability][role] || (granted.has(capability) && grantsConfer(capability))) held.add(capability);
  }
  return held;
}
