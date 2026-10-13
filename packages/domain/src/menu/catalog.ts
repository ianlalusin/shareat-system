/**
 * T-401 S2 - categories, items and variants. docs/tasks/401-erp-menu-catalog-master.md R1, R2, R9 and the S1 audit rulings.
 *
 * Every function: `(actor, input, tx?)`, `authorize()` first, one `audit_log` row in the same transaction. Gates (Ian, Q2):
 * `add_menu_item` (super admin only) for createMenuItem and addMenuVariant; `manage_menu` (super admin, admin) for everything else here.
 * The database triggers refuse what must never happen (a retired category holding an active item, an item_type change
 * once priced, a retire while a live offer exists); this file turns the commonest of them into sentences and keeps the
 * one rule the database cannot see from one row: an item is created WITH its default variant, and is never brought back
 * without an active one.
 */
import { authorize, type Actor } from '@shareat/auth';
import { menuRepo, type Tx } from '@shareat/db';
import { MENU_ITEM_TYPES, type MenuItemType, type MenuStatus } from '@shareat/db/schema';
import { gone, refuse } from '../shared/refusal';
import { audit, changedFields, inTx, requireName } from './shared';

const text = (raw: unknown) => (typeof raw === 'string' ? raw.trim() : '');

// -------------------------------------------------------------------------------------------------------------------
// Categories (R9)
// -------------------------------------------------------------------------------------------------------------------
export interface CreateMenuCategoryInput {
  name: string;
  parentId?: string | null;
  sortOrder?: number;
}

export async function createMenuCategory(actor: Actor, input: CreateMenuCategoryInput, tx?: Tx): Promise<{ id: string }> {
  return inTx(tx, async (trx) => {
    await authorize(trx, actor, 'manage_menu', {});
    const name = requireName(input.name, 'createMenuCategory', 'A category');
    if (await menuRepo.findCategoryByName(trx, actor.orgId, name)) {
      throw refuse(`createMenuCategory: a category named "${name}" exists.`, `There is already a category called "${name}".`);
    }
    if (input.parentId) await requireCategory(trx, actor, input.parentId);
    const row = await menuRepo.insertCategory(trx, {
      orgId: actor.orgId,
      name,
      parentId: input.parentId ?? null,
      sortOrder: input.sortOrder ?? 0,
      createdBy: actor.personId,
    });
    await audit(trx, actor, 'menu_category_create', 'menu_categories', row.id, null, row);
    return { id: row.id };
  });
}

export interface EditMenuCategoryInput {
  id: string;
  name?: string;
  parentId?: string | null;
  sortOrder?: number;
  status?: MenuStatus;
}

export async function editMenuCategory(actor: Actor, input: EditMenuCategoryInput, tx?: Tx): Promise<{ id: string }> {
  return inTx(tx, async (trx) => {
    await authorize(trx, actor, 'manage_menu', {});
    const row = await requireCategory(trx, actor, input.id);
    const name = input.name === undefined ? undefined : requireName(input.name, 'editMenuCategory', 'A category');
    if (name !== undefined && name.toLowerCase() !== row.name.toLowerCase()) {
      const same = await menuRepo.findCategoryByName(trx, actor.orgId, name);
      if (same && same.id !== row.id) {
        throw refuse(`editMenuCategory: a category named "${name}" exists.`, `There is already a category called "${name}".`);
      }
    }
    if (input.parentId) await requireCategory(trx, actor, input.parentId);
    const patch = changedFields(row, { name, parentId: input.parentId, sortOrder: input.sortOrder, status: input.status }, [
      'name',
      'parentId',
      'sortOrder',
      'status',
    ]);
    if (Object.keys(patch).length === 0) return { id: row.id };
    const after = await menuRepo.updateCategory(trx, row.id, patch);
    await audit(trx, actor, 'menu_category_edit', 'menu_categories', row.id, row, after);
    return { id: row.id };
  });
}

/** Refused by the database while the category still holds an active item (move or retire them first). */
export async function retireMenuCategory(actor: Actor, input: { id: string }, tx?: Tx): Promise<{ id: string }> {
  return editMenuCategory(actor, { id: input.id, status: 'retired' }, tx);
}

async function requireCategory(trx: Tx, actor: Actor, id: string) {
  const row = await menuRepo.getCategory(trx, actor.orgId, id);
  if (!row) throw gone(`menu: category ${id} does not exist.`, 'category');
  return row;
}

// -------------------------------------------------------------------------------------------------------------------
// Items (R1, R2)
// -------------------------------------------------------------------------------------------------------------------
export interface CreateMenuItemInput {
  categoryId: string;
  name: string;
  description?: string | null;
  itemType: MenuItemType;
  soldALaCarte?: boolean;
  soldInPackageSession?: boolean;
  dinerOrderable?: boolean;
  sortOrder?: number;
}

function requireItemType(raw: unknown, rawLabel: string): MenuItemType {
  if (!(MENU_ITEM_TYPES as readonly unknown[]).includes(raw)) {
    throw refuse(`${rawLabel}: item type must be one of ${MENU_ITEM_TYPES.join(', ')}.`, 'Choose a type: a la carte, package or refill.');
  }
  return raw as MenuItemType;
}

/** R2: a refill is a zero-price serving a package entitles; it is not itself sold. */
function requireRefillNotSold(itemType: MenuItemType, soldALaCarte: boolean, soldInPackageSession: boolean, rawLabel: string): void {
  if (itemType === 'refill' && (soldALaCarte || soldInPackageSession)) {
    throw refuse(
      `${rawLabel}: a refill is never sold on its own.`,
      'A refill is a serving a package entitles. It cannot also be sold on its own or as an add-on.',
    );
  }
}

/** Creates the item AND its default variant (unlabelled, active) in the caller's transaction. One audit row, naming both. */
export async function createMenuItem(actor: Actor, input: CreateMenuItemInput, tx?: Tx): Promise<{ id: string; defaultVariantId: string }> {
  return inTx(tx, async (trx) => {
    await authorize(trx, actor, 'add_menu_item', {});
    const name = requireName(input.name, 'createMenuItem', 'An item');
    const itemType = requireItemType(input.itemType, 'createMenuItem');
    const soldALaCarte = input.soldALaCarte ?? itemType === 'a_la_carte';
    const soldInPackageSession = input.soldInPackageSession ?? false;
    requireRefillNotSold(itemType, soldALaCarte, soldInPackageSession, 'createMenuItem');
    await requireCategory(trx, actor, input.categoryId);
    if (await menuRepo.findItemByTypeAndName(trx, actor.orgId, itemType, name)) {
      throw refuse(`createMenuItem: a ${itemType} item named "${name}" exists.`, `There is already an item called "${name}" of that type.`);
    }
    const item = await menuRepo.insertItem(trx, {
      orgId: actor.orgId,
      categoryId: input.categoryId,
      name,
      description: text(input.description) || null,
      itemType,
      soldALaCarte,
      soldInPackageSession,
      dinerOrderable: input.dinerOrderable ?? true,
      sortOrder: input.sortOrder ?? 0,
      createdBy: actor.personId,
    });
    const variant = await menuRepo.insertVariant(trx, {
      orgId: actor.orgId,
      menuItemId: item.id,
      label: null,
      isDefault: true,
      createdBy: actor.personId,
    });
    await audit(trx, actor, 'menu_item_create', 'menu_items', item.id, null, { ...item, defaultVariantId: variant.id });
    return { id: item.id, defaultVariantId: variant.id };
  });
}

export interface EditMenuItemInput {
  id: string;
  categoryId?: string;
  name?: string;
  description?: string | null;
  itemType?: MenuItemType;
  soldALaCarte?: boolean;
  soldInPackageSession?: boolean;
  dinerOrderable?: boolean;
  sortOrder?: number;
  status?: MenuStatus;
}

/** `status: 'active'` brings a retired item back. Refused unless it has an active default variant (S1 audit ruling). */
export async function editMenuItem(actor: Actor, input: EditMenuItemInput, tx?: Tx): Promise<{ id: string }> {
  return inTx(tx, async (trx) => {
    await authorize(trx, actor, 'manage_menu', {});
    const row = await menuRepo.getItem(trx, actor.orgId, input.id, true);
    if (!row) throw gone(`editMenuItem: item ${input.id} does not exist.`, 'menu item');
    const name = input.name === undefined ? undefined : requireName(input.name, 'editMenuItem', 'An item');
    const itemType = input.itemType === undefined ? undefined : requireItemType(input.itemType, 'editMenuItem');
    const patch = changedFields(
      row,
      {
        categoryId: input.categoryId,
        name,
        description: input.description === undefined ? undefined : text(input.description) || null,
        itemType,
        soldALaCarte: input.soldALaCarte,
        soldInPackageSession: input.soldInPackageSession,
        dinerOrderable: input.dinerOrderable,
        sortOrder: input.sortOrder,
        status: input.status,
      },
      ['categoryId', 'name', 'description', 'itemType', 'soldALaCarte', 'soldInPackageSession', 'dinerOrderable', 'sortOrder', 'status'],
    );
    if (Object.keys(patch).length === 0) return { id: row.id };

    requireRefillNotSold(
      patch.itemType ?? row.itemType,
      patch.soldALaCarte ?? row.soldALaCarte,
      patch.soldInPackageSession ?? row.soldInPackageSession,
      'editMenuItem',
    );
    if (patch.categoryId) await requireCategory(trx, actor, patch.categoryId);
    if (patch.name !== undefined || patch.itemType !== undefined) {
      const same = await menuRepo.findItemByTypeAndName(trx, actor.orgId, patch.itemType ?? row.itemType, patch.name ?? row.name);
      if (same && same.id !== row.id) {
        throw refuse('editMenuItem: another item has that name and type.', `There is already an item called "${patch.name ?? row.name}" of that type.`);
      }
    }
    if (patch.status === 'active' && row.status !== 'active') {
      const variants = await menuRepo.variantsOfItem(trx, actor.orgId, row.id);
      if (!variants.some((v) => v.isDefault && v.status === 'active')) {
        throw refuse(
          `editMenuItem: item ${row.id} has no active default variant, so it cannot be re-activated.`,
          'This item has no active default variant, so it cannot be brought back. Re-activate or add a variant first.',
        );
      }
    }
    const after = await menuRepo.updateItem(trx, row.id, patch);
    await audit(trx, actor, 'menu_item_edit', 'menu_items', row.id, row, after);
    return { id: row.id };
  });
}

/** Refused by the database while a live offer for any of its variants is in force or scheduled (withdraw first). */
export async function retireMenuItem(actor: Actor, input: { id: string }, tx?: Tx): Promise<{ id: string }> {
  return editMenuItem(actor, { id: input.id, status: 'retired' }, tx);
}

// -------------------------------------------------------------------------------------------------------------------
// Variants (R1)
// -------------------------------------------------------------------------------------------------------------------
export async function addMenuVariant(
  actor: Actor,
  input: { menuItemId: string; label: string; sortOrder?: number },
  tx?: Tx,
): Promise<{ id: string }> {
  return inTx(tx, async (trx) => {
    await authorize(trx, actor, 'add_menu_item', {});
    const label = requireName(input.label, 'addMenuVariant', 'A variant');
    const item = await menuRepo.getItem(trx, actor.orgId, input.menuItemId, true);
    if (!item) throw gone(`addMenuVariant: item ${input.menuItemId} does not exist.`, 'menu item');
    const variants = await menuRepo.variantsOfItem(trx, actor.orgId, item.id);
    if (variants.some((v) => v.label !== null && v.label.toLowerCase() === label.toLowerCase())) {
      throw refuse(`addMenuVariant: variant "${label}" exists on this item.`, `This item already has a variant called "${label}".`);
    }
    const row = await menuRepo.insertVariant(trx, {
      orgId: actor.orgId,
      menuItemId: item.id,
      label,
      isDefault: false,
      sortOrder: input.sortOrder ?? 0,
      createdBy: actor.personId,
    });
    await audit(trx, actor, 'menu_variant_create', 'menu_item_variants', row.id, null, row);
    return { id: row.id };
  });
}

export interface EditMenuVariantInput {
  id: string;
  label?: string;
  sortOrder?: number;
  status?: MenuStatus;
}

export async function editMenuVariant(actor: Actor, input: EditMenuVariantInput, tx?: Tx): Promise<{ id: string }> {
  return inTx(tx, async (trx) => {
    await authorize(trx, actor, 'manage_menu', {});
    const row = await menuRepo.getVariant(trx, actor.orgId, input.id);
    if (!row) throw gone(`editMenuVariant: variant ${input.id} does not exist.`, 'variant');
    const label = input.label === undefined ? undefined : requireName(input.label, 'editMenuVariant', 'A variant');
    if (label !== undefined) {
      const siblings = await menuRepo.variantsOfItem(trx, actor.orgId, row.menuItemId);
      if (siblings.some((v) => v.id !== row.id && v.label !== null && v.label.toLowerCase() === label.toLowerCase())) {
        throw refuse(`editMenuVariant: variant "${label}" exists on this item.`, `This item already has a variant called "${label}".`);
      }
    }
    const patch = changedFields(row, { label, sortOrder: input.sortOrder, status: input.status }, ['label', 'sortOrder', 'status']);
    if (Object.keys(patch).length === 0) return { id: row.id };
    const after = await menuRepo.updateVariant(trx, row.id, patch);
    await audit(trx, actor, 'menu_variant_edit', 'menu_item_variants', row.id, row, after);
    return { id: row.id };
  });
}

/** Refused by the database while a live offer for it is in force or scheduled, and for an active item's only default. */
export async function retireMenuVariant(actor: Actor, input: { id: string }, tx?: Tx): Promise<{ id: string }> {
  return editMenuVariant(actor, { id: input.id, status: 'retired' }, tx);
}
