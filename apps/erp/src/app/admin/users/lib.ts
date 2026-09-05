/**
 * Server-only reads for the user/role management screens. T-219 / DEF-167.
 *
 * ⭐ Mirrors `apps/erp/src/app/staff/lib.ts`: plain reads go straight to the repo layer with no
 * capability gate — the gate belongs to the WRITE, not to looking at a roster — and every mutation
 * runs through `packages/auth`'s own `authorize()` call via the actions file. That asymmetry is
 * deliberate and matches every other admin screen here (`/staff`, `/attendance/terminals`).
 */
import { accessRepo, personsRepo, type GrantRow, type PersonWithAccessRow } from '@shareat/db';
import { CAPABILITIES, CAPABILITY_MATRIX, type Capability, type Role } from '@shareat/auth';
import { listStores, withOrgPrincipal, type StoreOption } from '../../expenses/lib';

export { listStores, withOrgPrincipal };
export type { StoreOption, PersonWithAccessRow };

/** Everyone in the org with their role, store-scope count and active-grant count. */
export async function listUsers(orgId: string): Promise<PersonWithAccessRow[]> {
  return withOrgPrincipal(orgId, (tx) => personsRepo.listWithAccessForOrg(tx, orgId));
}

export interface UserDetail {
  person: PersonWithAccessRow;
  /** Every store in the org, each flagged with whether this person holds scope for it. */
  stores: (StoreOption & { inScope: boolean })[];
  /** Active and revoked both — invariant 11 requires a revoked grant to stay queryable with
   *  its revocation date, and the screen is where that promise is kept. */
  grants: GrantRow[];
}

export async function userDetail(orgId: string, personId: string): Promise<UserDetail | null> {
  const stores = await listStores(orgId);
  return withOrgPrincipal(orgId, async (tx) => {
    const rows = await personsRepo.listWithAccessForOrg(tx, orgId);
    const person = rows.find((r) => r.id === personId);
    if (!person) return null;

    const [scopedIds, grants] = await Promise.all([
      accessRepo.storeIdsForPerson(tx, personId),
      accessRepo.grantsForPerson(tx, personId),
    ]);
    const held = new Set(scopedIds);

    return {
      person,
      stores: stores.map((s) => ({ ...s, inScope: held.has(s.id) })),
      grants: grants.sort((a, b) => a.grantName.localeCompare(b.grantName)),
    };
  });
}

/**
 * The capabilities worth OFFERING as an explicit grant for a role, i.e. the ones the matrix
 * denies that role. Granting a capability the role already has is a no-op row that makes the
 * grant list harder to read, so the picker leaves them out.
 *
 * ⭐ Derived from `CAPABILITIES`/`CAPABILITY_MATRIX`, never hand-listed — T-219 invariant 5.
 * A capability added to the matrix appears here on the next build with no edit to this file,
 * which is the same discipline `authorize.test.ts` applies to its own coverage.
 */
export function grantableCapabilitiesFor(role: Role | null): readonly Capability[] {
  if (!role) return CAPABILITIES;
  return CAPABILITIES.filter((c) => !CAPABILITY_MATRIX[c][role]);
}
