/**
 * T-653 - ONE flavour list; each package and each refill ticks the flavours it allows. Spec: C:\shareat\specs\653-package-refill-flavours.md (migration 0292).
 *
 * The flavour list is the org's one option group with role 'flavours'. A package variant or a refill item is LINKED to it (the same link table every option group uses),
 * and the link carries (a) the flavours it allows (menu_option_link_values: no rows = every active flavour, rows = only those) and (b) its own min / max
 * (a package picks 1 to 3, a refill exactly 1). The projection (project.ts) applies both for every reader: the POS snapshot, the store menu and the server re-check
 * in `optionDelta` (a flavour the link does not allow is "not on the item" there, so a hostile client cannot order one).
 *
 * Every function: `(actor, input, tx?)`, `manage_menu` first, one audit row per write. Retired values and groups are never deleted (past order lines keep their value ids).
 */
import { authorize, type Actor } from '@shareat/auth';
import { menuRepo, type Tx } from '@shareat/db';
import { gone, refuse } from '../shared/refusal';
import { audit, inTx, requireName } from './shared';
import { MENU_ORDER_STEP } from './order';
import { assertFieldRules } from '../shared/field-rules-assert';
import { MENU_OPTION_VALUE_RULES } from '../field-rules/menu';

/** The default limits of a package's flavour link (guests pick 1 to 3) and a refill's (exactly 1). */
export const PACKAGE_FLAVOUR_LIMITS = { min: 1, max: 3 } as const;
export const REFILL_FLAVOUR_LIMITS = { min: 1, max: 1 } as const;

/** Trimmed, case-ignored: how two flavour names are "the same flavour". */
export const flavourKey = (name: string): string => name.trim().toLowerCase().replace(/\s+/g, ' ');

const NO_LIST = 'Start your flavour list first (Menu, then Flavours).';

/** "Start your flavour list": creates THE flavour group (multi) when the org has none; returns the one it has. */
export async function startFlavourList(actor: Actor, tx?: Tx): Promise<{ id: string; created: boolean }> {
  return inTx(tx, actor.orgId, async (trx) => {
    await authorize(trx, actor, 'manage_menu', {});
    const existing = await menuRepo.getFlavoursGroup(trx, actor.orgId);
    if (existing) return { id: existing.id, created: false };
    const row = await menuRepo.insertOptionGroup(trx, {
      orgId: actor.orgId,
      name: 'Flavours',
      selectionMode: 'multi',
      minSelections: 0,
      maxSelections: 10,
      role: 'flavours',
      createdBy: actor.personId,
    });
    await audit(trx, actor, 'menu_option_group_create', null, row.id, null, row);
    return { id: row.id, created: true };
  });
}

/** Add a flavour to the one list. A name already on the list (any case, retired or not) is refused in words (a retired one says so). */
export async function addFlavour(actor: Actor, input: { name: string }, tx?: Tx): Promise<{ id: string }> {
  return inTx(tx, actor.orgId, async (trx) => {
    await authorize(trx, actor, 'manage_menu', {});
    assertFieldRules(MENU_OPTION_VALUE_RULES, { name: input.name });
    const name = requireName(input.name, 'addFlavour', 'A flavour');
    const group = await menuRepo.getFlavoursGroup(trx, actor.orgId);
    if (!group) throw refuse('addFlavour: no flavour list.', NO_LIST);
    const held = (await menuRepo.valuesOfGroup(trx, actor.orgId, group.id)).find((v) => flavourKey(v.name) === flavourKey(name));
    if (held) {
      throw refuse(
        'addFlavour: the name is already on the list.',
        held.status === 'active' ? `${held.name} is already on the flavour list.` : `${held.name} is on the flavour list but retired. Bring it back instead of adding it again.`,
      );
    }
    const row = await menuRepo.insertOptionValue(trx, {
      orgId: actor.orgId,
      optionGroupId: group.id,
      name,
      sortOrder: await menuRepo.nextSortOrder(trx, { kind: 'optionValues', orgId: actor.orgId, optionGroupId: group.id }, MENU_ORDER_STEP),
      createdBy: actor.personId,
    });
    await audit(trx, actor, 'menu_option_value_create', null, row.id, null, row);
    return { id: row.id };
  });
}

/** Rename, retire or bring back a flavour of the one list. A retired flavour disappears from every package and refill at once. */
export async function editFlavour(actor: Actor, input: { id: string; name?: string; status?: 'active' | 'retired' }, tx?: Tx): Promise<{ id: string }> {
  return inTx(tx, actor.orgId, async (trx) => {
    await authorize(trx, actor, 'manage_menu', {});
    const group = await menuRepo.getFlavoursGroup(trx, actor.orgId);
    if (!group) throw refuse('editFlavour: no flavour list.', NO_LIST);
    const row = await menuRepo.getOptionValue(trx, actor.orgId, input.id);
    if (!row || row.optionGroupId !== group.id) throw gone(`editFlavour: flavour ${input.id} is not on the flavour list.`, 'flavour');
    const name = input.name === undefined ? undefined : requireName(input.name, 'editFlavour', 'A flavour');
    if (name !== undefined) assertFieldRules(MENU_OPTION_VALUE_RULES, { name });
    if (name !== undefined && flavourKey(name) !== flavourKey(row.name)) {
      const clash = (await menuRepo.valuesOfGroup(trx, actor.orgId, group.id)).find((v) => v.id !== row.id && flavourKey(v.name) === flavourKey(name));
      if (clash) throw refuse('editFlavour: the name is already on the list.', `${clash.name} is already on the flavour list.`);
    }
    const patch: { name?: string; status?: 'active' | 'retired' } = {};
    if (name !== undefined && name !== row.name) patch.name = name;
    if (input.status !== undefined && input.status !== row.status) patch.status = input.status;
    if (Object.keys(patch).length === 0) return { id: row.id };
    const after = await menuRepo.updateOptionValue(trx, row.id, patch);
    await audit(trx, actor, 'menu_option_value_edit', null, row.id, row, after);
    return { id: row.id };
  });
}

// -------------------------------------------------------------------------------------------------------------------
// Allowed flavours of one package variant or one refill item
// -------------------------------------------------------------------------------------------------------------------
export interface SetAllowedFlavoursInput {
  /** A refill item (or any item): the link is on the item. */
  menuItemId?: string;
  /** A package variant: the link is on the variant. Exactly one of menuItemId / variantId. */
  variantId?: string;
  /** The flavours allowed. EMPTY = no flavours at all (the link is removed). */
  optionValueIds: readonly string[];
  /** Guests pick at least / at most this many (a package 1 and 3, a refill 1 and 1). Omitted = the flavour group's own. */
  min?: number;
  max?: number;
}

export type SetAllowedFlavoursOutcome = { linked: boolean; optionValueIds: string[]; min: number | null; max: number | null; changed: boolean };

/** The shape of the min / max a link may carry, as sentences. `count` is how many flavours are allowed. */
function requireLimits(min: number | undefined, max: number | undefined, count: number): void {
  if (min !== undefined && (!Number.isInteger(min) || min < 0)) throw refuse('setAllowedFlavours: min must be a whole number from 0.', 'The fewest flavours must be 0 or more, in whole numbers.');
  if (max !== undefined && (!Number.isInteger(max) || max < 1)) throw refuse('setAllowedFlavours: max must be a whole number from 1.', 'The most flavours must be at least 1, in whole numbers.');
  if (min !== undefined && max !== undefined && max < min) throw refuse('setAllowedFlavours: max below min.', 'The most flavours cannot be below the fewest.');
  if (min !== undefined && min > count) {
    throw refuse('setAllowedFlavours: min above the flavours allowed.', `Guests must pick at least ${min}, but only ${count} flavour${count === 1 ? ' is' : 's are'} allowed. Allow more flavours or lower the minimum.`);
  }
}

/**
 * REPLACES the flavours one package variant (or refill item) allows, and its min / max, in one transaction: creates the link to the org's flavour list when there is none, updates it
 * when there is. An empty list removes the link (no flavours). Setting what it already has writes nothing.
 */
export async function setAllowedFlavours(actor: Actor, input: SetAllowedFlavoursInput, tx?: Tx): Promise<SetAllowedFlavoursOutcome> {
  return inTx(tx, actor.orgId, async (trx) => {
    await authorize(trx, actor, 'manage_menu', {});
    if (Boolean(input.menuItemId) === Boolean(input.variantId)) {
      throw refuse('setAllowedFlavours: exactly one of menuItemId / variantId is required.', 'Allow flavours for one package or one refill item, not both and not neither.');
    }
    const group = await menuRepo.getFlavoursGroup(trx, actor.orgId);
    if (!group) throw refuse('setAllowedFlavours: no flavour list.', NO_LIST);
    let menuItemId = input.menuItemId;
    if (input.variantId) {
      const variant = await menuRepo.getVariant(trx, actor.orgId, input.variantId);
      if (!variant) throw gone(`setAllowedFlavours: variant ${input.variantId} does not exist.`, 'package variant');
      // Serialise with other edits of the same item: the item row, then the link is read.
      await menuRepo.getItem(trx, actor.orgId, variant.menuItemId, true);
    } else {
      const item = await menuRepo.getItem(trx, actor.orgId, input.menuItemId!, true);
      if (!item) throw gone(`setAllowedFlavours: item ${input.menuItemId} does not exist.`, 'menu item');
      menuItemId = item.id;
    }
    const target = input.variantId ? { variantId: input.variantId } : { menuItemId: menuItemId! };

    const wanted = [...new Set(input.optionValueIds)].sort();
    const onList = new Map((await menuRepo.valuesOfGroup(trx, actor.orgId, group.id)).map((v) => [v.id, v]));
    for (const id of wanted) {
      const v = onList.get(id);
      if (!v) throw refuse(`setAllowedFlavours: value ${id} is not on the flavour list.`, 'One of the flavours is not on your flavour list. Pick flavours from the list.');
      if (v.status !== 'active') throw refuse(`setAllowedFlavours: value ${id} is retired.`, `${v.name} is retired. Bring it back on the flavour list before allowing it.`);
    }

    const link = await menuRepo.linkOfTarget(trx, actor.orgId, group.id, target);
    const before = link
      ? { linked: true, optionValueIds: await menuRepo.linkValueIds(trx, actor.orgId, link.id), min: link.minSelections, max: link.maxSelections }
      : { linked: false, optionValueIds: [] as string[], min: null, max: null };

    if (wanted.length === 0) {
      if (!link) return { linked: false, optionValueIds: [], min: null, max: null, changed: false };
      await menuRepo.deleteLink(trx, link.id);
      await audit(trx, actor, 'menu.flavours_allowed_set', null, link.menuItemId ?? link.variantId ?? link.id, before, { linked: false, optionValueIds: [], min: null, max: null });
      return { linked: false, optionValueIds: [], min: null, max: null, changed: true };
    }

    requireLimits(input.min, input.max, wanted.length);
    const min = input.min ?? null;
    const max = input.max ?? null;
    let live = link;
    if (live && live.status !== 'active') {
      // a retired link cannot be revived (no UPDATE of its status); replace it
      await menuRepo.deleteLink(trx, live.id);
      live = undefined;
    }
    if (!live) {
      live = await menuRepo.insertLink(trx, { orgId: actor.orgId, optionGroupId: group.id, menuItemId: input.variantId ? null : menuItemId!, variantId: input.variantId ?? null, createdBy: actor.personId });
    }
    const sameSet = before.linked && before.optionValueIds.join(',') === wanted.join(',');
    const sameLimits = before.linked && before.min === min && before.max === max;
    if (sameSet && sameLimits && link && link.id === live.id) return { linked: true, optionValueIds: wanted, min, max, changed: false };
    if (!sameLimits || !link || link.id !== live.id) await menuRepo.updateLinkLimits(trx, live.id, { minSelections: min, maxSelections: max });
    if (!sameSet || !link || link.id !== live.id) await menuRepo.replaceLinkValues(trx, actor.orgId, live, wanted);
    await audit(trx, actor, 'menu.flavours_allowed_set', null, input.variantId ?? menuItemId!, before, { linked: true, optionValueIds: wanted, min, max });
    return { linked: true, optionValueIds: wanted, min, max, changed: true };
  });
}

/** What a package variant or refill item allows now, for the screens. */
export async function allowedFlavoursOf(
  tx: Tx,
  orgId: string,
  target: { menuItemId?: string; variantId?: string },
): Promise<{ linked: boolean; optionValueIds: string[]; min: number | null; max: number | null }> {
  const group = await menuRepo.getFlavoursGroup(tx, orgId);
  if (!group) return { linked: false, optionValueIds: [], min: null, max: null };
  const link = await menuRepo.linkOfTarget(tx, orgId, group.id, target);
  if (!link || link.status !== 'active') return { linked: false, optionValueIds: [], min: null, max: null };
  return { linked: true, optionValueIds: await menuRepo.linkValueIds(tx, orgId, link.id), min: link.minSelections, max: link.maxSelections };
}

// -------------------------------------------------------------------------------------------------------------------
// "Use these flavours": merge the per-item "Flavours" groups a store already built (T-643 setup) into the one list
// -------------------------------------------------------------------------------------------------------------------
/** A per-item flavour group built before this list existed: an active 'choice' group called Flavour / Flavours (any case). */
const OLD_FLAVOUR_GROUP = /^flavou?rs?$/i;

export interface FlavourMergePreview {
  /** Whether the org already has its one flavour list (the merge creates it when not). */
  hasList: boolean;
  /** The distinct flavour names the merge puts on the list, in first-seen order, and which are new to it. */
  names: { name: string; isNew: boolean }[];
  /** The groups that will be retired, each with the items or variants that will be re-linked to the one list. */
  groups: { groupId: string; name: string; values: string[]; targets: { kind: 'item' | 'variant'; id: string; label: string; min: number; max: number; skipped: boolean }[] }[];
}

async function oldGroupsOf(tx: Tx, orgId: string) {
  // Oldest group first (ids are time-ordered uuidv7): the first spelling of a flavour name wins, and the list is built in the order the store built its groups.
  const groups = (await menuRepo.optionGroupsOfOrg(tx, orgId))
    .filter((g) => g.role === 'choice' && g.status === 'active' && OLD_FLAVOUR_GROUP.test(g.name.trim()))
    .sort((x, y) => x.id.localeCompare(y.id));
  const out = [];
  for (const g of groups) {
    const values = (await menuRepo.valuesOfGroup(tx, orgId, g.id)).filter((v) => v.status === 'active');
    const links = (await menuRepo.linksOfGroup(tx, orgId, g.id)).filter((l) => l.status === 'active');
    out.push({ group: g, values, links });
  }
  return out;
}

async function labelOf(tx: Tx, orgId: string, link: { menuItemId: string | null; variantId: string | null }): Promise<string> {
  if (link.menuItemId) return (await menuRepo.getItem(tx, orgId, link.menuItemId))?.name ?? 'An item';
  const v = link.variantId ? await menuRepo.getVariant(tx, orgId, link.variantId) : undefined;
  const item = v ? await menuRepo.getItem(tx, orgId, v.menuItemId) : undefined;
  return `${item?.name ?? 'An item'}${v?.label ? ` - ${v.label}` : ''}`;
}

/** Read-only: exactly what "Use these flavours" would do, so the manager sees it before agreeing. Null when there is nothing to merge. */
export async function previewFlavourMerge(actor: Actor, tx?: Tx): Promise<FlavourMergePreview | null> {
  return inTx(tx, actor.orgId, async (trx) => {
    await authorize(trx, actor, 'manage_menu', {});
    const old = await oldGroupsOf(trx, actor.orgId);
    if (old.length === 0) return null;
    const list = await menuRepo.getFlavoursGroup(trx, actor.orgId);
    const onList = new Set(list ? (await menuRepo.valuesOfGroup(trx, actor.orgId, list.id)).map((v) => flavourKey(v.name)) : []);
    const seen = new Set<string>();
    const names: FlavourMergePreview['names'] = [];
    for (const o of old) {
      for (const v of o.values) {
        const k = flavourKey(v.name);
        if (seen.has(k)) continue;
        seen.add(k);
        names.push({ name: v.name.trim(), isNew: !onList.has(k) });
      }
    }
    const groups: FlavourMergePreview['groups'] = [];
    for (const o of old) {
      const targets = [];
      for (const l of o.links) {
        const taken = list ? await menuRepo.linkOfTarget(trx, actor.orgId, list.id, l.menuItemId ? { menuItemId: l.menuItemId } : { variantId: l.variantId! }) : undefined;
        targets.push({
          kind: (l.menuItemId ? 'item' : 'variant') as 'item' | 'variant',
          id: (l.menuItemId ?? l.variantId)!,
          label: await labelOf(trx, actor.orgId, l),
          min: l.minSelections ?? o.group.minSelections,
          max: l.maxSelections ?? o.group.maxSelections,
          skipped: taken !== undefined,
        });
      }
      groups.push({ groupId: o.group.id, name: o.group.name, values: o.values.map((v) => v.name.trim()), targets });
    }
    return { hasList: list !== undefined, names, groups };
  });
}

export interface FlavourMergeOutcome {
  flavoursAdded: number;
  linksMoved: number;
  linksSkipped: number;
  groupsRetired: number;
}

/**
 * "Use these flavours": inside ONE transaction, (1) create the one list if there is none, (2) put every distinct old flavour name on it (trimmed, case ignored; a name already
 * there is reused, a retired one is brought back), (3) re-link each item or variant that had an old group to the one list with the SAME allowed names and the old group's min / max,
 * (4) retire every old group. Old groups and values are never deleted (past order lines keep their value ids); the old LINKS are removed so an item does not offer two lists.
 * A target that already has a link to the one list is left as it is. Either all of it happens or none of it.
 */
export async function mergeIntoFlavours(actor: Actor, tx?: Tx): Promise<FlavourMergeOutcome> {
  return inTx(tx, actor.orgId, async (trx) => {
    await authorize(trx, actor, 'manage_menu', {});
    const old = await oldGroupsOf(trx, actor.orgId);
    if (old.length === 0) throw refuse('mergeIntoFlavours: nothing to merge.', 'There are no per-item flavour groups to merge.');
    const started = await startFlavourList(actor, trx);
    const list = (await menuRepo.getFlavoursGroup(trx, actor.orgId))!;
    const existing = new Map((await menuRepo.valuesOfGroup(trx, actor.orgId, list.id)).map((v) => [flavourKey(v.name), v]));
    void started;

    let flavoursAdded = 0;
    const idByKey = new Map<string, string>();
    for (const o of old) {
      for (const v of o.values) {
        const k = flavourKey(v.name);
        if (idByKey.has(k)) continue;
        const have = existing.get(k);
        if (have) {
          if (have.status !== 'active') await menuRepo.updateOptionValue(trx, have.id, { status: 'active' });
          idByKey.set(k, have.id);
          continue;
        }
        const row = await menuRepo.insertOptionValue(trx, {
          orgId: actor.orgId,
          optionGroupId: list.id,
          name: v.name.trim(),
          sortOrder: await menuRepo.nextSortOrder(trx, { kind: 'optionValues', orgId: actor.orgId, optionGroupId: list.id }, MENU_ORDER_STEP),
          createdBy: actor.personId,
        });
        idByKey.set(k, row.id);
        flavoursAdded += 1;
      }
    }

    let linksMoved = 0;
    let linksSkipped = 0;
    for (const o of old) {
      const allowed = [...new Set(o.values.map((v) => idByKey.get(flavourKey(v.name))!))].sort();
      for (const l of o.links) {
        const target = l.menuItemId ? { menuItemId: l.menuItemId } : { variantId: l.variantId! };
        const taken = await menuRepo.linkOfTarget(trx, actor.orgId, list.id, target);
        await menuRepo.deleteLink(trx, l.id); // the old link goes either way: an item never offers two flavour lists
        if (taken) {
          linksSkipped += 1;
          continue;
        }
        if (allowed.length === 0) continue;
        const link = await menuRepo.insertLink(trx, { orgId: actor.orgId, optionGroupId: list.id, menuItemId: l.menuItemId, variantId: l.variantId, createdBy: actor.personId });
        // the old group's own limits become this link's (clamped so the minimum never asks for more than the list allows)
        const min = Math.min(l.minSelections ?? o.group.minSelections, allowed.length);
        const max = Math.max(l.maxSelections ?? o.group.maxSelections, min, 1);
        await menuRepo.updateLinkLimits(trx, link.id, { minSelections: min, maxSelections: max });
        await menuRepo.replaceLinkValues(trx, actor.orgId, link, allowed);
        linksMoved += 1;
      }
    }

    let groupsRetired = 0;
    for (const o of old) {
      await menuRepo.updateOptionGroup(trx, o.group.id, { status: 'retired' });
      groupsRetired += 1;
    }
    const outcome = { flavoursAdded, linksMoved, linksSkipped, groupsRetired };
    await audit(trx, actor, 'menu.flavours_merged', null, list.id, { groups: old.map((o) => o.group.id) }, outcome);
    return outcome;
  });
}
