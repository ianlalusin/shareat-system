/**
 * T-401 S2 - option groups, their values, the links that attach a group to an item or a variant, and a package's named refills.
 * docs/tasks/401-erp-menu-catalog-master.md R3, R4, R8.
 *
 * Flavours are option values (R3): one mechanism. A variant's links, if it has any, REPLACE its item's (R4); that is the
 * projection's rule (S3), not stored here. Every function: `(actor, input, tx?)`, `manage_menu` first, one audit row.
 */
import { authorize, type Actor } from '@shareat/auth';
import { menuRepo, type Tx } from '@shareat/db';
import { MENU_SELECTION_MODES, type MenuSelectionMode, type MenuStatus } from '@shareat/db/schema';
import { gone, refuse } from '../shared/refusal';
import { audit, changedFields, inTx, requireName } from './shared';

// -------------------------------------------------------------------------------------------------------------------
// Option groups (R4): required = min_selections > 0, never a separate flag
// -------------------------------------------------------------------------------------------------------------------
export interface CreateOptionGroupInput {
  name: string;
  selectionMode: MenuSelectionMode;
  minSelections: number;
  maxSelections: number;
}

/** The same rules as the table's CHECKs, as sentences. */
function requireGroupShape(mode: unknown, min: unknown, max: unknown): void {
  if (!(MENU_SELECTION_MODES as readonly unknown[]).includes(mode)) {
    throw refuse('option group: selection mode must be single or multi.', 'Choose whether guests pick one option or several.');
  }
  if (!Number.isInteger(min) || !Number.isInteger(max) || (min as number) < 0 || (max as number) < 1) {
    throw refuse('option group: min must be a whole number from 0, max a whole number from 1.', 'The minimum must be 0 or more and the maximum at least 1, in whole numbers.');
  }
  if ((max as number) < (min as number)) {
    throw refuse('option group: max is below min.', 'The maximum cannot be below the minimum.');
  }
  if (mode === 'single' && max !== 1) {
    throw refuse('option group: a single-choice group has max 1.', 'A pick-one group allows exactly one choice.');
  }
}

export async function createOptionGroup(actor: Actor, input: CreateOptionGroupInput, tx?: Tx): Promise<{ id: string }> {
  return inTx(tx, async (trx) => {
    await authorize(trx, actor, 'manage_menu', {});
    const name = requireName(input.name, 'createOptionGroup', 'An option group');
    requireGroupShape(input.selectionMode, input.minSelections, input.maxSelections);
    const row = await menuRepo.insertOptionGroup(trx, {
      orgId: actor.orgId,
      name,
      selectionMode: input.selectionMode,
      minSelections: input.minSelections,
      maxSelections: input.maxSelections,
      createdBy: actor.personId,
    });
    await audit(trx, actor, 'menu_option_group_create', 'menu_option_groups', row.id, null, row);
    return { id: row.id };
  });
}

export interface EditOptionGroupInput {
  id: string;
  name?: string;
  selectionMode?: MenuSelectionMode;
  minSelections?: number;
  maxSelections?: number;
  status?: MenuStatus;
}

export async function editOptionGroup(actor: Actor, input: EditOptionGroupInput, tx?: Tx): Promise<{ id: string }> {
  return inTx(tx, async (trx) => {
    await authorize(trx, actor, 'manage_menu', {});
    const row = await menuRepo.getOptionGroup(trx, actor.orgId, input.id);
    if (!row) throw gone(`editOptionGroup: option group ${input.id} does not exist.`, 'option group');
    const name = input.name === undefined ? undefined : requireName(input.name, 'editOptionGroup', 'An option group');
    const patch = changedFields(
      row,
      { name, selectionMode: input.selectionMode, minSelections: input.minSelections, maxSelections: input.maxSelections, status: input.status },
      ['name', 'selectionMode', 'minSelections', 'maxSelections', 'status'],
    );
    if (Object.keys(patch).length === 0) return { id: row.id };
    requireGroupShape(
      patch.selectionMode ?? row.selectionMode,
      patch.minSelections ?? row.minSelections,
      patch.maxSelections ?? row.maxSelections,
    );
    const after = await menuRepo.updateOptionGroup(trx, row.id, patch);
    await audit(trx, actor, 'menu_option_group_edit', 'menu_option_groups', row.id, row, after);
    return { id: row.id };
  });
}

// -------------------------------------------------------------------------------------------------------------------
// Option values
// -------------------------------------------------------------------------------------------------------------------
export async function addOptionValue(
  actor: Actor,
  input: { optionGroupId: string; name: string; sortOrder?: number },
  tx?: Tx,
): Promise<{ id: string }> {
  return inTx(tx, async (trx) => {
    await authorize(trx, actor, 'manage_menu', {});
    const name = requireName(input.name, 'addOptionValue', 'An option');
    const group = await menuRepo.getOptionGroup(trx, actor.orgId, input.optionGroupId);
    if (!group) throw gone(`addOptionValue: option group ${input.optionGroupId} does not exist.`, 'option group');
    const row = await menuRepo.insertOptionValue(trx, {
      orgId: actor.orgId,
      optionGroupId: group.id,
      name,
      sortOrder: input.sortOrder ?? 0,
      createdBy: actor.personId,
    });
    await audit(trx, actor, 'menu_option_value_create', 'menu_option_values', row.id, null, row);
    return { id: row.id };
  });
}

export async function editOptionValue(
  actor: Actor,
  input: { id: string; name?: string; sortOrder?: number; status?: MenuStatus },
  tx?: Tx,
): Promise<{ id: string }> {
  return inTx(tx, async (trx) => {
    await authorize(trx, actor, 'manage_menu', {});
    const row = await menuRepo.getOptionValue(trx, actor.orgId, input.id);
    if (!row) throw gone(`editOptionValue: option value ${input.id} does not exist.`, 'option');
    const name = input.name === undefined ? undefined : requireName(input.name, 'editOptionValue', 'An option');
    const patch = changedFields(row, { name, sortOrder: input.sortOrder, status: input.status }, ['name', 'sortOrder', 'status']);
    if (Object.keys(patch).length === 0) return { id: row.id };
    const after = await menuRepo.updateOptionValue(trx, row.id, patch);
    await audit(trx, actor, 'menu_option_value_edit', 'menu_option_values', row.id, row, after);
    return { id: row.id };
  });
}

// -------------------------------------------------------------------------------------------------------------------
// Links: a group is attached to an item OR a variant (exactly one). Unlink is a DELETE.
// -------------------------------------------------------------------------------------------------------------------
export interface LinkOptionGroupInput {
  optionGroupId: string;
  menuItemId?: string;
  variantId?: string;
  sortOrder?: number;
}

export async function linkOptionGroup(actor: Actor, input: LinkOptionGroupInput, tx?: Tx): Promise<{ id: string }> {
  return inTx(tx, async (trx) => {
    await authorize(trx, actor, 'manage_menu', {});
    if (Boolean(input.menuItemId) === Boolean(input.variantId)) {
      throw refuse(
        'linkOptionGroup: exactly one of menuItemId / variantId is required.',
        'Attach the option group to one item or to one variant, not both and not neither.',
      );
    }
    const group = await menuRepo.getOptionGroup(trx, actor.orgId, input.optionGroupId);
    if (!group) throw gone(`linkOptionGroup: option group ${input.optionGroupId} does not exist.`, 'option group');
    if (input.menuItemId && !(await menuRepo.getItem(trx, actor.orgId, input.menuItemId))) {
      throw gone(`linkOptionGroup: item ${input.menuItemId} does not exist.`, 'menu item');
    }
    if (input.variantId && !(await menuRepo.getVariant(trx, actor.orgId, input.variantId))) {
      throw gone(`linkOptionGroup: variant ${input.variantId} does not exist.`, 'variant');
    }
    const row = await menuRepo.insertLink(trx, {
      orgId: actor.orgId,
      optionGroupId: group.id,
      menuItemId: input.menuItemId ?? null,
      variantId: input.variantId ?? null,
      sortOrder: input.sortOrder ?? 0,
      createdBy: actor.personId,
    });
    await audit(trx, actor, 'menu_option_group_link', 'menu_option_group_links', row.id, null, row);
    return { id: row.id };
  });
}

export async function unlinkOptionGroup(actor: Actor, input: { id: string }, tx?: Tx): Promise<{ id: string }> {
  return inTx(tx, async (trx) => {
    await authorize(trx, actor, 'manage_menu', {});
    const row = await menuRepo.getLink(trx, actor.orgId, input.id);
    if (!row) throw gone(`unlinkOptionGroup: link ${input.id} does not exist.`, 'option group link');
    await menuRepo.deleteLink(trx, row.id);
    await audit(trx, actor, 'menu_option_group_unlink', 'menu_option_group_links', row.id, row, null);
    return { id: row.id };
  });
}

// -------------------------------------------------------------------------------------------------------------------
// Package refills (R8): a package names its refills. No "empty means all" sentinel.
// -------------------------------------------------------------------------------------------------------------------
/**
 * REPLACES the set of refill items a package variant allows. The subject of the audit row is the package variant. Setting the
 * set it already has writes nothing. (package -> refill only is the database's rule; an empty list means NO refills.)
 */
export async function setPackageRefills(
  actor: Actor,
  input: { packageVariantId: string; refillItemIds: string[] },
  tx?: Tx,
): Promise<{ packageVariantId: string; refillItemIds: string[]; changed: boolean }> {
  return inTx(tx, async (trx) => {
    await authorize(trx, actor, 'manage_menu', {});
    const variant = await menuRepo.getVariant(trx, actor.orgId, input.packageVariantId);
    if (!variant) throw gone(`setPackageRefills: variant ${input.packageVariantId} does not exist.`, 'package variant');
    // Serialise with other edits of the same package: the variant row, then the set is read.
    await menuRepo.getItem(trx, actor.orgId, variant.menuItemId, true);
    const wanted = [...new Set(input.refillItemIds)].sort();
    for (const id of wanted) {
      if (!(await menuRepo.getItem(trx, actor.orgId, id))) throw gone(`setPackageRefills: refill item ${id} does not exist.`, 'refill');
    }
    const current = await menuRepo.refillItemIdsOfPackage(trx, actor.orgId, variant.id);
    const toRemove = current.filter((id) => !wanted.includes(id));
    const toAdd = wanted.filter((id) => !current.includes(id));
    if (toRemove.length === 0 && toAdd.length === 0) return { packageVariantId: variant.id, refillItemIds: wanted, changed: false };
    await menuRepo.deletePackageRefills(trx, variant.id, toRemove);
    await menuRepo.insertPackageRefills(trx, { orgId: actor.orgId, packageVariantId: variant.id, refillItemIds: toAdd, createdBy: actor.personId });
    await audit(
      trx,
      actor,
      'menu_package_refills_set',
      'menu_package_refills',
      variant.id,
      current.length ? { packageVariantId: variant.id, refillItemIds: current } : null,
      wanted.length ? { packageVariantId: variant.id, refillItemIds: wanted } : null,
    );
    return { packageVariantId: variant.id, refillItemIds: wanted, changed: true };
  });
}
