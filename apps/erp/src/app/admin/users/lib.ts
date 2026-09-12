/**
 * Server-only reads for the user/role management screens. T-219 / DEF-167.
 *
 * ⭐ Mirrors `apps/erp/src/app/staff/lib.ts`: plain reads go straight to the repo layer with no
 * capability gate — the gate belongs to the WRITE, not to looking at a roster — and every mutation
 * runs through `packages/auth`'s own `authorize()` call via the actions file. That asymmetry is
 * deliberate and matches every other admin screen here (`/staff`, `/attendance/terminals`).
 */
import {
  accessRepo,
  personsRepo,
  positionDefaultsRepo,
  sessionsRepo,
  type GrantRow,
  type PersonWithAccessRow,
} from '@shareat/db';
import { CAPABILITIES, CAPABILITY_MATRIX, type Capability, type Role } from '@shareat/auth';
import { listStores, withOrgPrincipal, type StoreOption } from '../../expenses/lib';

export { listStores, withOrgPrincipal };
export type { StoreOption, PersonWithAccessRow };

/** T-289 §C15, via the namespace re-export — `packages/db` is outside this task's file list. */
export type PositionDefaultSource = positionDefaultsRepo.PositionDefaultSource;

/**
 * T-291 §C2 — a `GrantRow` with the position-default facts folded on, when it has one. `null`
 * for every non-`'position'` source, and also `null` on a `'position'` row if `describeSources`
 * came back empty for its `sourceRef` (§C2's "should be impossible" case — the FK is `ON DELETE
 * RESTRICT` — handled by rendering readable, never by crashing or inventing a name).
 */
export interface GrantWithSource extends GrantRow {
  positionSource: PositionDefaultSource | null;
}

/** Everyone in the org with their role, store-scope count and active-grant count. */
export async function listUsers(orgId: string): Promise<PersonWithAccessRow[]> {
  return withOrgPrincipal(orgId, (tx) => personsRepo.listWithAccessForOrg(tx, orgId));
}

export interface UserDetail {
  person: PersonWithAccessRow;
  /** Every store in the org, each flagged with whether this person holds scope for it. */
  stores: (StoreOption & { inScope: boolean })[];
  /** Active and revoked both — invariant 11 requires a revoked grant to stay queryable with
   *  its revocation date, and the screen is where that promise is kept. T-291: each row also
   *  carries its position-default facts, when it has any, so the page never joins per row. */
  grants: GrantWithSource[];
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

    // T-291 §C2 — ONE batched read for every position-sourced grant's names, never per row (the
    // shape `listEmploymentPositionsFor` already uses). `describeSources` returns `[]` for an
    // empty input, so a person with no position grants costs nothing extra.
    const sources = await positionDefaultsRepo.describeSources(
      tx,
      grants.map((g) => g.sourceRef).filter((r): r is string => r !== null),
    );
    const sourceById = new Map(sources.map((s) => [s.id, s]));
    const grantsWithSource: GrantWithSource[] = grants.map((g) => ({
      ...g,
      positionSource: g.sourceRef ? (sourceById.get(g.sourceRef) ?? null) : null,
    }));

    return {
      person,
      stores: stores.map((s) => ({ ...s, inScope: held.has(s.id) })),
      grants: grantsWithSource.sort((a, b) => a.grantName.localeCompare(b.grantName)),
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
 * `null` renders as "not recorded" and ONLY that — never defaulted to any of the four known
 * values. DEF-237's residue (a row written before migration `0140` existed) is permanent; a
 * fabricated attribution would be worse than an absent one.
 *
 * ⛔ No `default:` arm — the exhaustive switch is what turns a widened `GrantSource` into a
 * compile error instead of a silently-wrong label, and that is the guard working (T-291 §C1).
 */
export function grantSourceLabel(source: GrantRow['grantSource']): string {
  switch (source) {
    case 'elevation':
      return 'auto-elevated — clears when this org gains an active administrator';
    case 'position':
      // T-291 §C1. The active-grants list itself never calls this arm for a `'position'` row —
      // it renders `positionProvenanceLine` instead, with the actual position and store name.
      // This arm stays exact and generic for every other reader of `grantSourceLabel` (the
      // switch's own exhaustiveness, and any future caller that only has the source, not a
      // fetched `PositionDefaultSource`).
      return 'via a position default — clears when the position or the default does';
    case 'owner':
      return 'owner-equivalent grant';
    case 'grant':
      return 'hand-granted';
    case null:
      return 'source not recorded';
  }
}

/**
 * T-291 §C2 — "via Cashier at Lipa", from the position DEFAULT's own names, never the person's
 * current employment. The default is the thing that justifies the row; an employment that has
 * since moved on is exactly the case `reconcilePositionGrants` handles, and reading from it here
 * would make this line disagree with the row it is explaining.
 *
 * Fails readable, never fails confident: a `null` source — which should be impossible, the FK on
 * `person_grants.source_ref` is `ON DELETE RESTRICT` — renders the bare sentence with no names
 * rather than crashing or inventing one.
 */
export function positionProvenanceLine(source: PositionDefaultSource | null): string {
  return source ? `via ${source.positionName} at ${source.storeName}` : 'via a position default';
}

/**
 * T-291 §C2 — the pure predicate behind "a `'position'` row offers no revoke control here".
 * Revoking one on this page would be undone by the next `reconcilePositionGrants` — a control
 * that appears to work and silently does not, which is worse than no control at all. Kept here,
 * not inline in the page, for the same reason `grantSourceLabel` and `requireRevokeReason` are:
 * testable without rendering.
 */
export function canRevokeHere(grant: Pick<GrantRow, 'grantSource'>): boolean {
  return grant.grantSource !== 'position';
}

/**
 * T-291 §C4 — after T-289 an ordinary staff member can carry several `'position'` rows they never
 * asked for, and calling those "extra grants" beside a role name is misleading. Splits the active
 * grants into what a position inherited for them and what was granted by some other means
 * (a hand-grant, an elevation, an owner-equivalent, or an unrecorded pre-migration row — anything
 * that is not `'position'`). Derived from `grantSource` alone, no new read.
 */
export function grantSummaryLine(grants: Pick<GrantRow, 'grantSource'>[]): string {
  let inherited = 0;
  let granted = 0;
  for (const g of grants) {
    if (g.grantSource === 'position') inherited += 1;
    else granted += 1;
  }
  return `${inherited} inherited from positions · ${granted} granted`;
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
