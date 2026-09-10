/**
 * Server-only reads for the user/role management screens. T-219 / DEF-167.
 *
 * ⭐ Mirrors `apps/erp/src/app/staff/lib.ts`: plain reads go straight to the repo layer with no
 * capability gate — the gate belongs to the WRITE, not to looking at a roster — and every mutation
 * runs through `packages/auth`'s own `authorize()` call via the actions file. That asymmetry is
 * deliberate and matches every other admin screen here (`/staff`, `/attendance/terminals`).
 */
import { accessRepo, personsRepo, sessionsRepo, type GrantRow, type PersonWithAccessRow } from '@shareat/db';
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
  /**
   * T-237 — the ways this person can sign in, LIVE ones only.
   *
   * ⚠️ Revoked credentials are deliberately NOT listed, unlike the grants above. A revoked grant is
   * a statement about authority somebody once held and is worth reading back; a revoked credential
   * is a dead lookup hash or a dead uid, and listing it would put a person's former Firebase uid on
   * a screen forever for no decision anyone makes from it.
   */
  credentials: SignInCredential[];
}

/** One way in, as the screen needs it. ⛔ No `secretHash` and no `lookupHash` — the row carries
 *  them and nothing on a page has any use for either. */
export interface SignInCredential {
  id: string;
  kind: 'pin' | 'firebase' | 'biometric';
  storeId: string | null;
  /** The Firebase uid, for a `firebase` row. It is a name, not a secret — `verifyIdToken` is what
   *  makes it mean anything — so showing it is what lets an administrator tell two accounts apart. */
  externalId: string | null;
  createdAt: Date;
}

export async function userDetail(orgId: string, personId: string): Promise<UserDetail | null> {
  const stores = await listStores(orgId);
  return withOrgPrincipal(orgId, async (tx) => {
    const rows = await personsRepo.listWithAccessForOrg(tx, orgId);
    const person = rows.find((r) => r.id === personId);
    if (!person) return null;

    const [scopedIds, grants, credentials] = await Promise.all([
      accessRepo.storeIdsForPerson(tx, personId),
      accessRepo.grantsForPerson(tx, personId),
      sessionsRepo.listLiveForPerson(tx, personId),
    ]);
    const held = new Set(scopedIds);

    return {
      person,
      stores: stores.map((s) => ({ ...s, inScope: held.has(s.id) })),
      grants: grants.sort((a, b) => a.grantName.localeCompare(b.grantName)),
      credentials: credentials.map((c) => ({
        id: c.id,
        kind: c.kind,
        storeId: c.storeId,
        externalId: c.externalId,
        createdAt: c.createdAt,
      })),
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

/**
 * T-256 / DEF-247 — `grantSource` in one word an administrator reads without opening the bible.
 * `null` renders as "not recorded" and ONLY that — never defaulted to any of the three known
 * values. DEF-237's residue (a row written before migration `0140` existed) is permanent; a
 * fabricated attribution would be worse than an absent one.
 */
export function grantSourceLabel(source: GrantRow['grantSource']): string {
  switch (source) {
    case 'elevation':
      return 'auto-elevated — clears when this org gains an active administrator';
    case 'owner':
      return 'owner-equivalent grant';
    case 'grant':
      return 'hand-granted';
    case null:
      return 'source not recorded';
  }
}

/**
 * T-256 / DEF-247 — mirrors `unlinkCredential`'s own check (`packages/auth/src/credentials-admin.ts`)
 * so the two revoke forms on this page read as one system. Grant writes are gated in THIS file's
 * layer, not `packages/auth` — see this module's own actions.ts header for why.
 */
export function requireRevokeReason(raw: string): string {
  const reason = raw.trim();
  if (!reason) {
    throw new Error('Revoking a grant needs a reason — a revoked grant nobody can explain is not an audit trail.');
  }
  return reason;
}
