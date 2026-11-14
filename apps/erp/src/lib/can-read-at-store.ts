/**
 * T-577 (DEF-834, bible row 461) - may `actor` read ONE record at the store it belongs to? True when they hold ANY of `capabilities` at
 * `storeId`. A single-record page loads the record, calls this with the record's own `storeId`, and calls `notFound()` on false, so a record
 * outside the viewer's stores is the same page as a forged id and never says it exists.
 *
 * Uses `can()`, the non-logging twin of `authorize()` (same `decide()`, so it cannot disagree): a page view is a probe, not an attempted act,
 * and must write no denial row. Pass a `tx` from `withOrgPrincipal`, and call it BEFORE any other read of the record's store.
 *
 * Its own file, not `page-access.tsx`: tests that stub `page-access` to skip the route gate must not also stub away the store check.
 */
import { can, isAdministrative, type Actor, type Capability } from '@shareat/auth';
import { accessRepo, type Tx } from '@shareat/db';

/**
 * Org-wide roles (`admin`, `super_admin`: auth's own `isAdministrative`) are NEVER store-filtered on a READ page, whatever their scope rows say.
 * Scope rows are fanned out only for stores ACTIVE when the admin was appointed, so filtering on them would hide a retired store's debt from the
 * people who answer for it (Opus ruling, T-577 round 3). Reads only: `can()` and every write gate are untouched.
 */
export async function isOrgWideRole(tx: Tx, actor: Actor): Promise<boolean> {
  return isAdministrative((await accessRepo.activeRoleForPerson(tx, actor.personId, actor.orgId))?.role);
}

export async function canReadAtStore(tx: Tx, actor: Actor, storeId: string, capabilities: readonly Capability[]): Promise<boolean> {
  if (await isOrgWideRole(tx, actor)) return true;
  for (const capability of capabilities) if (await can(tx, actor, capability, { storeId })) return true;
  return false;
}
