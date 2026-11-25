/**
 * T-641 - which stores a question may touch, decided here from the ASKER's own access, and the capability check for each. The model never names an organisation or a person (neither is a
 * tool argument at all); it may name a store, and a store it names is looked up ONLY among the stores this person may see, so another organisation's store, or one this person is not
 * assigned to, is simply "not one of yours". Then `authorize()` runs for the tool's own capability at that store, as the asker.
 *
 * The rules mirror the report screens (`apps/erp/src/app/reports/lib.ts`, bible row 353), because a figure Ask ERP gives must be one the screen would give the same person:
 *   - an active store counts when the person holds every active store, or has a scope row for it; a closed store only with a scope row;
 *   - a store the company switched OFF for AI (Settings > AI hub) is not read at all;
 *   - with no store named, every store where the capability holds is used, and the answer says when that is fewer than all;
 *   - "the whole organisation" (no store filter) is used only when the person is org-wide AND the capability holds at every active store.
 */
import { refuse } from '../shared/refusal';

export interface StoreRef {
  id: string;
  name: string;
  code: string;
}

export interface Visible {
  /** The stores this person may see and that AI is switched on for. */
  stores: StoreRef[];
  /** Not store-limited: an admin by role, or someone who holds every active store. */
  orgWide: boolean;
  /** How many active stores the organisation has, and how many of those are in `stores` (to tell "all of them" from "some"). */
  activeCount: number;
  activeShown: number;
}

const norm = (s: string): string => s.trim().toLowerCase();

/** A store the person named (an id, a code or a name), found only among the stores they may see. A plain refusal sentence when there is none or more than one. */
export function findStore(v: Visible, raw: string): StoreRef {
  const q = norm(raw);
  const exact = v.stores.filter((s) => s.id.toLowerCase() === q || norm(s.code) === q || norm(s.name) === q);
  const pool = exact.length > 0 ? exact : v.stores.filter((s) => norm(s.name).includes(q) && q.length >= 3);
  if (pool.length === 0) {
    throw refuse('ask erp: store not visible to the asker', "I can't show that store: it is not one of the stores you have access to. Use the store list to see which ones you can ask about.");
  }
  if (pool.length > 1) throw refuse('ask erp: store name is ambiguous', `More than one of your stores matches that name: ${pool.map((s) => `${s.name} (${s.code})`).join(', ')}. Name one by its code.`);
  return pool[0] as StoreRef;
}

export interface Picked {
  stores: StoreRef[];
  /** A store was named. */
  named: boolean;
  /** No store filter at all is safe: org-wide person, capability held at every active store, none named. */
  wholeOrg: boolean;
  /** Said to the model (and so to the person) when the answer covers fewer stores than they hold. */
  note: string | null;
}

