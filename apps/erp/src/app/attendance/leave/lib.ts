/**
 * Server-only helpers for `/attendance/leave`. T-436.
 *
 * ⭐ This screen adds no rule of its own: `requestLeave`, `approveLeave` and the rest (`@shareat/domain`) authorize, take the
 * person's lock, and apply the caps, the SIL balance and the self-approval rule. This file only bridges form strings to them
 * and reads what the screen draws.
 *
 * ⛔ Personal data (bible row 353): no list here reads a note, and nothing here ever holds a stored file's id. A certificate is
 * opened only by the `openLeaveDocument` action, which redirects to a link good for 60 seconds.
 */
import {
  isoDateCompare,
  listLeave,
  loadLeaveRequest,
  myLeave,
  silBalance,
  type LeaveRequestView,
  type LeaveRow,
  type MyLeave,
} from '@shareat/domain';
import { AuthorizationError } from '@shareat/auth';
import { heldCapabilities } from '@shareat/auth';
import { employmentRepo, type RosterRow } from '@shareat/db';
import { withOrgPrincipal, listStores } from '../../expenses/lib';

export { withOrgPrincipal, listStores };
export type { LeaveRequestView, LeaveRow, MyLeave };

type Actor = { orgId: string; personId: string };

export function loadMine(actor: Actor): Promise<MyLeave> {
  return withOrgPrincipal(actor.orgId, (tx) => myLeave(tx, actor));
}

/** Whether this person may open the manager half of the screen (manage_attendance anywhere; each store is still checked on every read). */
export async function holdsManageAttendance(actor: Actor): Promise<boolean> {
  const held = await withOrgPrincipal(actor.orgId, (tx) => heldCapabilities(tx, actor));
  return held.has('manage_attendance');
}

export function loadStoreLeave(actor: Actor, input: { storeId: string; from: string; to: string }): Promise<LeaveRow[]> {
  return withOrgPrincipal(actor.orgId, (tx) => listLeave(tx, actor, input));
}

export function loadRoster(actor: Actor, storeId: string): Promise<RosterRow[]> {
  return withOrgPrincipal(actor.orgId, (tx) => employmentRepo.listActiveRoster(tx, storeId));
}

/**
 * One request in full - the ONE place a note is read (bible row 353). The domain returns it to the person it is for and to a
 * manage_attendance holder at the filing store, and refuses everyone else; a refusal here is "not available", never a detail.
 */
export async function loadRequestDetail(actor: Actor, requestId: string): Promise<LeaveRequestView | null> {
  try {
    return await withOrgPrincipal(actor.orgId, (tx) => loadLeaveRequest(tx, actor, { requestId }));
  } catch (err) {
    if (err instanceof AuthorizationError) return null;
    throw err;
  }
}

/** A person's Service Incentive Leave balance for a year, shown to the manager deciding their request. */
export async function loadBalanceOf(actor: Actor, personId: string, year: number) {
  try {
    return await withOrgPrincipal(actor.orgId, (tx) => silBalance(tx, actor, { personId, year }));
  } catch (err) {
    // A person whose latest job is at a store this manager does not run: no balance shown, never a crashed page.
    if (err instanceof AuthorizationError) return null;
    throw err;
  }
}

/** A request grouped from its per-date rows, for the manager lists. */
export interface RequestGroup {
  requestId: string;
  personId: string;
  personName: string;
  leaveType: string;
  status: string;
  paid: boolean;
  hasProof: boolean;
  clash: boolean;
  dates: string[];
  restDays: string[];
}

export function groupByRequest(rows: readonly LeaveRow[]): RequestGroup[] {
  const map = new Map<string, RequestGroup>();
  for (const r of rows) {
    const g = map.get(r.requestId) ?? {
      requestId: r.requestId,
      personId: r.personId,
      personName: r.personName,
      leaveType: r.leaveType,
      status: r.status,
      paid: r.paid,
      hasProof: r.hasProof,
      clash: false,
      dates: [],
      restDays: [],
    };
    if (r.kind === 'rest_day') g.restDays.push(r.date);
    else {
      g.dates.push(r.date);
      g.paid = g.paid || r.paid;
    }
    g.clash = g.clash || r.clash;
    map.set(r.requestId, g);
  }
  const first = (g: RequestGroup) => g.dates[0] ?? g.restDays[0] ?? '';
  return [...map.values()].sort((a, b) => isoDateCompare(first(a), first(b)));
}

/** Every date from..to inclusive; at most 62, and refuses an inverted range. The rest days are marked, not dropped. */
export function expandRange(from: string, to: string, restDays: ReadonlySet<string>): { date: string; kind: 'leave' | 'rest_day' }[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || isoDateCompare(from, to) === 1) return [];
  const out: { date: string; kind: 'leave' | 'rest_day' }[] = [];
  let t = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  while (t <= end && out.length < 62) {
    const date = new Date(t).toISOString().slice(0, 10);
    out.push({ date, kind: restDays.has(date) ? 'rest_day' : 'leave' });
    t += 86_400_000;
  }
  return out;
}

export function labelFor(kinds: readonly { code: string; label: string }[], code: string): string {
  return kinds.find((k) => k.code === code)?.label ?? code;
}
