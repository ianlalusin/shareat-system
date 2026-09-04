/**
 * Server-only reads for the staff-onboarding screens. T-202 / DEF-131.
 *
 * ⭐ Mirrors `apps/erp/src/app/items/lib.ts`: plain reads go straight to the repo layer (no
 * capability gate — the gate belongs to the WRITE, not to looking at a roster), and every mutation
 * runs through `packages/domain/src/people/index.ts`'s own `authorize()` call via
 * `withOrgPrincipal`. `searchPersonsFor` is the one read that carries a capability (`enrol_staff`
 * — Contract §2), so it takes the full `Actor`, not just an `orgId`, and calls the domain function.
 */
import { employmentRepo, personsRepo, type EmploymentPositionRow, type EmploymentRow, type PersonRow, type PositionRow, type RosterRow } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { searchPersons } from '@shareat/domain';
import { listStores, withOrgPrincipal, type StoreOption } from '../expenses/lib';

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
export async function rosterForStore(orgId: string, storeId: string): Promise<RosterViewRow[]> {
  return withOrgPrincipal(orgId, async (tx) => {
    const roster = await employmentRepo.listActiveRoster(tx, storeId);
    const positionRows = await employmentRepo.listEmploymentPositionsFor(tx, roster.map((r) => r.id));
    const byEmployment = groupPositions(positionRows);
    return roster.map((r) => ({ ...r, positions: byEmployment.get(r.id) ?? [] }));
  });
}

/** A store's assignable positions — the canonical six plus whatever it has added of its own. */
export async function positionsForStore(orgId: string, storeId: string): Promise<PositionRow[]> {
  return withOrgPrincipal(orgId, (tx) => employmentRepo.listPositions(tx, orgId, storeId));
}

export interface EmploymentDetail {
  employment: EmploymentRow;
  personName: string;
  storeName: string;
  positions: PositionAssignment[];
}

/** Everything the `/staff/[employmentId]` page needs, or `null` if it does not exist in this org. */
export async function employmentDetail(orgId: string, employmentId: string): Promise<EmploymentDetail | null> {
  const stores = await listStores(orgId);
  return withOrgPrincipal(orgId, async (tx) => {
    const employment = await employmentRepo.getEmployment(tx, employmentId);
    if (!employment || employment.orgId !== orgId) return null;
    const person = await personsRepo.getPersonById(tx, orgId, employment.personId);
    const store = stores.find((s) => s.id === employment.storeId);
    const positionRows = await employmentRepo.listEmploymentPositions(tx, employmentId);
    return {
      employment,
      personName: person?.displayName ?? '(unknown person)',
      storeName: store?.name ?? employment.storeId,
      positions: positionRows.map((p) => ({ positionId: p.positionId, name: p.positionName, isPrimary: p.isPrimary })),
    };
  });
}

/**
 * ⭐ Contract §2 / §3 — the hire flow's search box. Capability-gated (`enrol_staff`, every store
 * the actor covers), so this calls the DOMAIN function, not the repo, and needs the full actor.
 * An empty query returns no results rather than the whole org's staff.
 */
export async function searchPersonsFor(actor: Actor, query: string): Promise<PersonRow[]> {
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
