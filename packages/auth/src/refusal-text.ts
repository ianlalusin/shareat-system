/**
 * T-343 S2 — one human sentence per `authorize()` refusal row.
 * `docs/tasks/343-def-417-human-readable-refusals.md` §S2.
 *
 * Pure, presentation-only string builders. Every function takes only what `authorize.ts` already
 * has in hand at the refusal branch — an already-resolved `Role`/`Capability`, and an org/store
 * NAME (never an id) that the caller looked up itself. Nothing here queries anything.
 *
 * ⛔ **The person is always the actor ("you") — never a person lookup.** `authorize()` never names
 * WHO was refused, only what they tried and why.
 *
 * ⛔ **Cross-tenant discipline (bible §7/§15.11):** `otherOrg` takes only a capability — there is
 * nothing in its signature to leak the foreign org's name even by mistake. `storeNotInOrg` and
 * `closePeriodNeedsWholeOrg` take only the ACTOR's own org name; the resource's/other org's name is
 * never passed to either.
 */
import { CAPABILITY_LABEL, ROLE_LABEL, type Capability, type Role } from './capabilities';

/**
 * Row 1 — no active role at all. Amendment R3 item 5 — "nothing here can be changed yet" was
 * wrong for a VIEW capability, where nothing was ever going to be changed in the first place;
 * neutral wording that covers both.
 */
export function noActiveRole(orgName: string | undefined): string {
  return `Your account has no active role in ${orgName ?? 'this organization'}, so you can't use this yet. Ask an admin to give you one.`;
}

/** Row 5 — the role/grant check failed outright. */
export function roleMayNot(role: Role, capability: Capability): string {
  return `Your role (${ROLE_LABEL[role]}) can't ${CAPABILITY_LABEL[capability]}. Ask an admin if you need to.`;
}

/** Row 2 — held the capability, but not for this particular store. */
export function notAssignedToStore(capability: Capability, store: { name: string; code: string } | undefined): string {
  const where = store ? `${store.name} (${store.code})` : 'that store';
  return `You aren't assigned to ${where}, so you can't ${CAPABILITY_LABEL[capability]} there.`;
}

/** Row 3 — the storeId given doesn't belong to the actor's own org. Never names the foreign store. */
export function storeNotInOrg(orgName: string | undefined): string {
  return `That store isn't part of ${orgName ?? 'your organization'}.`;
}

/** Row 4 — cross-org axis-1 refusal. Never names any organization, foreign or otherwise. */
export function otherOrg(capability: Capability): string {
  return `That record belongs to another organization, so you can't ${CAPABILITY_LABEL[capability]} on it from here.`;
}

/** A store-scoped capability was called with no storeId at all. */
export function storeRequired(capability: Capability): string {
  return `Pick a store first. To ${CAPABILITY_LABEL[capability]} you have to choose which store it is for.`;
}

/** `close_period`'s extra condition — a manager whose scope doesn't cover every active store. */
export function closePeriodNeedsWholeOrg(orgName: string | undefined): string {
  return `Closing a period changes every store's books, so a manager needs to be assigned to every active store in ${orgName ?? 'the organization'}.`;
}

/**
 * T-343 S2b (DEF-430). Row 5, store-scoped: the person holds `capability` through a position at
 * another store in this org. Names where the job actually works instead of blaming the role.
 * Structurally equal to `@shareat/db`'s `PositionGrantElsewhereRow` — no import, on purpose (R1.5:
 * one import, `./capabilities`).
 */
export interface JobElsewhere {
  readonly positionName: string;
  readonly storeName: string;
  readonly storeCode: string;
}

function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function joinList(items: readonly string[]): string {
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]!} and ${items[1]!}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]!}`;
}

export function jobIsElsewhere(capability: Capability, here: { name: string; code: string } | undefined, jobs: readonly JobElsewhere[]): string {
  const H = here ? `${clean(here.name)} (${clean(here.code)})` : 'that store';

  // DEF-447c — `jobs` is empty only if a future caller skips `authorize.ts`'s own `jobs.length`
  // check; there is no `role` here to build `roleMayNot`, so this drops the (otherwise empty)
  // "jobs that let you" clause rather than print one that names nothing.
  if (jobs.length === 0) {
    return `You can't ${CAPABILITY_LABEL[capability]} at ${H}. Ask an admin if you need to do it here too.`;
  }

  const groups: { storeName: string; storeCode: string; positions: string[] }[] = [];
  const byStore = new Map<string, (typeof groups)[number]>();
  for (const job of jobs) {
    const storeCode = clean(job.storeCode);
    let group = byStore.get(storeCode);
    if (!group) {
      group = { storeName: clean(job.storeName), storeCode, positions: [] };
      byStore.set(storeCode, group);
      groups.push(group);
    }
    const positionName = clean(job.positionName);
    if (!group.positions.includes(positionName)) group.positions.push(positionName);
  }

  let middle: string;
  if (groups.length === 1) {
    const group = groups[0]!;
    const S = `${group.storeName} (${group.storeCode})`;
    middle =
      group.positions.length === 1
        ? `the ${group.positions[0]!} job that lets you is at ${S}`
        : `the ${joinList(group.positions)} jobs that let you are at ${S}`;
  } else {
    const shown = groups.slice(0, 3).map((g) => `${joinList(g.positions)} at ${g.storeName} (${g.storeCode})`);
    const rest = groups.length - shown.length;
    const tail = rest > 0 ? `${shown.join('; ')}; and ${rest} more store${rest === 1 ? '' : 's'}` : shown.join('; ');
    middle = `the jobs that let you are at other stores: ${tail}`;
  }

  return `You can't ${CAPABILITY_LABEL[capability]} at ${H} — ${middle}. Ask an admin if you need to do it here too.`;
}
