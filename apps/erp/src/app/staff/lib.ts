/**
 * Server-only reads for the staff-onboarding screens. T-202 / DEF-131.
 *
 * ⛔ **T-435 / bible row 353 - the gate is at the READ, not only at the write.** This file once said *"the gate belongs to the
 * WRITE, not to looking at a roster"*; T-288 (Ian, 2026-09-12: "do both hide the menu and gate the reads") overturned that, and
 * row 353 finished it: personal data is shown only to people whose job needs it, for their own stores. Every reader that
 * returns a person takes the FULL `Actor` and calls `authorize` / `can` for `enrol_staff` OR `manage_attendance` at the store it
 * reads (a by-id reader checks the ROW's store). Mutations still run through `packages/domain/src/people/index.ts`'s own
 * `authorize()` via `withOrgPrincipal`. `searchPersonsFor` carries `enrol_staff` and is scoped in the domain function.
 */
import { accessRepo, employmentRepo, personsRepo, sessionsRepo, statutoryRepo, type EmploymentPositionRow, type EmploymentRow, type PersonRow, type PositionRow, type RosterRow, type Tx } from '@shareat/db';
import { authorize, can, type Actor, type Capability } from '@shareat/auth';
import { searchPersons, staffMediaView } from '@shareat/domain';
import { listStores, withOrgPrincipal, type StoreOption } from '../expenses/lib';
import { heldStoresFor } from '../../lib/held-stores';

/** Seeing a store's roster and employments: either way in (Ian Q2, 16 Oct). */
const STAFF_READ: readonly Capability[] = ['enrol_staff', 'manage_attendance'];

/** Authorizes `actor` for ANY of `caps` at `storeId`; the first capability's refusal is thrown when none passes (one denial logged). */
async function authorizeAny(tx: Tx, actor: Actor, caps: readonly Capability[], storeId: string): Promise<void> {
  for (const cap of caps) {
    if (await can(tx, actor, cap, { storeId })) return;
  }
  await authorize(tx, actor, caps[0]!, { storeId });
}

/** The stores the actor may read staff for (`caps` default: roster readers), for the page's picker and its forged-store check. */
export async function staffStoresFor(actor: Actor, caps: readonly Capability[] = STAFF_READ): Promise<StoreOption[]> {
  return withOrgPrincipal(actor.orgId, (tx) => heldStoresFor(tx, actor, caps));
}

export { peso } from '../../lib/format';
export { listStores, withOrgPrincipal };
export type { StoreOption };

export interface PositionAssignment {
  positionId: string;
  name: string;
  isPrimary: boolean;
}

export interface RosterViewRow extends RosterRow {
  positions: PositionAssignment[];
}

/** The roster for one store — DEF-131's whole point. Columns: staff code, name, status,
 *  positions (primary marked), started on. */
export async function rosterForStore(actor: Actor, storeId: string): Promise<RosterViewRow[]> {
  return withOrgPrincipal(actor.orgId, async (tx) => {
    await authorizeAny(tx, actor, STAFF_READ, storeId);
    const roster = await employmentRepo.listActiveRoster(tx, storeId);
    const positionRows = await employmentRepo.listEmploymentPositionsFor(tx, roster.map((r) => r.id));
    const byEmployment = groupPositions(positionRows);
    return roster.map((r) => ({ ...r, positions: byEmployment.get(r.id) ?? [] }));
  });
}

async function anyOf(tx: Tx, actor: Actor, caps: readonly Capability[], storeId: string): Promise<boolean> {
  for (const cap of caps) if (await can(tx, actor, cap, { storeId })) return true;
  return false;
}

/** A store's assignable positions — the canonical six plus whatever it has added of its own. */
export async function positionsForStore(orgId: string, storeId: string): Promise<PositionRow[]> {
  return withOrgPrincipal(orgId, (tx) => employmentRepo.listPositions(tx, orgId, storeId));
}

export interface EmploymentDetail {
  role?: string | null;
  employment: EmploymentRow;
  personName: string;
  /** T-438: the stored parts; all null for a legacy person (never guessed, spec N3) - the Name form then shows empty boxes. */
  nameParts: { lastName: string | null; firstName: string | null; middleName: string | null };
  storeName: string;
  positions: PositionAssignment[];
}

/**
 * Everything the `/staff/[employmentId]` page needs, or `null` if it does not exist in this org - or sits at a store the actor
 * does not hold (the same `null` as a forged id, DEF-497: an out-of-scope employment must not be distinguishable from none).
 */
export async function employmentDetail(actor: Actor, employmentId: string): Promise<EmploymentDetail | null> {
  const orgId = actor.orgId;
  const stores = await listStores(orgId);
  return withOrgPrincipal(orgId, async (tx) => {
    const employment = await employmentRepo.getEmployment(tx, employmentId);
    if (!employment || employment.orgId !== orgId) return null;
    if (!(await anyOf(tx, actor, STAFF_READ, employment.storeId))) return null;
    const person = await personsRepo.getPersonById(tx, orgId, employment.personId);
    const nameParts = (await personsRepo.getNameParts(tx, orgId, employment.personId)) ?? { lastName: null, firstName: null, middleName: null };
    const store = stores.find((s) => s.id === employment.storeId);
    const positionRows = await employmentRepo.listEmploymentPositions(tx, employmentId);
    const role = await accessRepo.activeRoleForPerson(tx, employment.personId, orgId);
    return {
      role: role?.role ?? null,
      employment,
      personName: person?.displayName ?? '(unknown person)',
      nameParts,
      storeName: store?.name ?? employment.storeId,
      positions: positionRows.map((p) => ({ positionId: p.positionId, name: p.positionName, isPrimary: p.isPrimary })),
    };
  });
}

/**
 * T-190 - the person's government numbers (SSS, PhilHealth, Pag-IBIG, TIN). PERSONAL DATA: returned only to someone holding `enrol_staff`
 * at the store of the employment being viewed; `null` otherwise (the section is simply not shown). A missing number means that agency is
 * not deducted on the person's payslips.
 */
export async function governmentIdsFor(
  actor: Actor,
  personId: string,
  storeId: string,
): Promise<{ sssNo: string | null; philhealthNo: string | null; pagibigNo: string | null; tin: string | null } | null> {
  return withOrgPrincipal(actor.orgId, async (tx) => {
    if (!(await can(tx, actor, 'enrol_staff', { storeId }))) return null;
    const [row] = await statutoryRepo.governmentIdsFor(tx, actor.orgId, [personId]);
    return row ? { sssNo: row.sssNo, philhealthNo: row.philhealthNo, pagibigNo: row.pagibigNo, tin: row.tin } : null;
  });
}

/**
 * T-217 / DEF-174. Whether this person already has a live sign-in PIN — the read half of "hired but
 * no PIN issued yet." T-435: answered only for a person employed at a store the viewer holds.
 *
 * ⭐ **T-302 — no longer narrowed to a store, and that is a correctness fix, not a tidy-up.** This
 * passed `storeId` to `listLiveForPerson`, which was right while a PIN belonged to a (person,
 * store) pair. Under org-scoped hashing a person holds ONE PIN whose row carries whichever store
 * it was last issued at — so the store-narrowed read would answer *"no sign-in PIN issued yet —
 * this person cannot sign in"* on the employment page of every OTHER branch they work at, about a
 * PIN that works there perfectly well. Worse, that sentence invites the admin to issue one, which
 * silently changes the person's PIN at the first branch.
 */
export async function livePinFor(actor: Actor, personId: string): Promise<{ issuedAt: Date } | null> {
  return withOrgPrincipal(actor.orgId, async (tx) => {
    // T-435: a person's sign-in state is theirs to see only for someone who has an employment at a store the viewer holds.
    const held = (await heldStoresFor(tx, actor, STAFF_READ)).map((st) => st.id);
    if (!(await employmentRepo.personHasEmploymentAtStores(tx, personId, held))) return null;
    const rows = await sessionsRepo.listLiveForPerson(tx, personId);
    const pin = rows.find((r) => r.kind === 'pin');
    return pin ? { issuedAt: pin.createdAt } : null;
  });
}

/** ⭐ T-302 — the other branches this person still works at, for the warning the issue-PIN form
 *  shows BEFORE the button. One PIN per person now means issuing one here changes it there. */
export async function otherOpenBranchesFor(
  actor: Actor,
  personId: string,
  excludeStoreId: string,
): Promise<{ branches: { storeId: string; storeName: string }[]; hiddenCount: number }> {
  return withOrgPrincipal(actor.orgId, async (tx) => {
    const all = await employmentRepo.listOtherOpenBranches(tx, personId, excludeStoreId);
    // T-435: name only the branches the viewer holds; the rest are counted ("and N other branch(es)") so the T-302 PIN warning
    // still fires without disclosing a store the viewer has no business knowing the person works at.
    const held = new Set((await heldStoresFor(tx, actor, STAFF_READ)).map((st) => st.id));
    const branches = all.filter((b) => held.has(b.storeId));
    return { branches, hiddenCount: all.length - branches.length };
  });
}

/**
 * ⭐ Contract §2 / §3 — the hire flow's search box. Capability-gated (`enrol_staff`, every store
 * the actor covers), so this calls the DOMAIN function, not the repo, and needs the full actor.
 * An empty query returns no results rather than the whole org's staff.
 */
export async function searchPersonsFor(actor: Actor, query: string): Promise<(PersonRow | { id: string; displayName: string; branches: string[] })[]> {
  if (!query.trim()) return [];
  return withOrgPrincipal(actor.orgId, (tx) => searchPersons(tx, actor, { query }));
}

function groupPositions(rows: EmploymentPositionRow[]): Map<string, PositionAssignment[]> {
  const out = new Map<string, PositionAssignment[]>();
  for (const r of rows) {
    const arr = out.get(r.employmentId) ?? [];
    arr.push({ positionId: r.positionId, name: r.positionName, isPrimary: r.isPrimary });
    out.set(r.employmentId, arr);
  }
  return out;
}

/**
 * T-434. The detail page's photo and signature state, from the domain loader: booleans for the signature (never its id) and the photo
 * file id only for a viewer who holds `enrol_staff` at the store. A refusal reads as "nothing to show".
 */
export async function mediaFor(
  actor: Actor,
  employmentId: string,
): Promise<{ hasSignature: boolean; canViewSignature: boolean; signatureFileId: string | null; photoFileId: string | null }> {
  try {
    return await withOrgPrincipal(actor.orgId, (tx) => staffMediaView(tx, actor, { employmentId }));
  } catch {
    return { hasSignature: false, canViewSignature: false, signatureFileId: null, photoFileId: null };
  }
}
