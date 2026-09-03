/**
 * The commissary catalogue's business rules — links, offerings and the cross-store item map.
 * T-171 / DEF-129.
 *
 * ⭐ DEF-129: `commissary_item_map` had NO writer anywhere in application code — a real internal
 * branch↔commissary receipt was guaranteed to throw (`receiveTradeOrder`'s own error names this
 * table by hand). `commissary_links` and `commissary_item_offerings` were in the same state: a
 * branch may only order what its commissary has OFFERED, and only once the two stores are LINKED,
 * and nothing could create either row either. This file is the minimum admin surface for all three.
 *
 * ⚠️ **No pricing, no ordering, no bulk import here** — those are T-172/T-175's own scope
 * (`docs/tasks/171-commissary-catalogue-and-item-map.md` §8). This file only decides what a
 * commissary offers, who it offers it to, and what one of the branch's own items a commissary
 * line becomes.
 */
import {
  commissaryCatalogueRepo,
  commissaryRepo,
  customersRepo,
  expensesRepo,
  itemsRepo,
  transaction,
  type Tx,
} from '@shareat/db';
import { LINK_STATUSES } from '@shareat/db/schema';
import { authorize, type Actor } from '@shareat/auth';

export type LinkStatus = (typeof LINK_STATUSES)[number];

/** A manual cost as `numeric(14,4)` will store it — a non-negative amount, up to four decimals.
 *  ⛔ Never `Number()`'d for storage: the string passes through untouched, same discipline as
 *  `normaliseRate` in `commissary/orders.ts`. */
const MANUAL_COST_PATTERN = /^\d+(\.\d{1,4})?$/;

// -----------------------------------------------------------------------------------------
// commissary_links
// -----------------------------------------------------------------------------------------

export interface UpsertCommissaryLinkInput {
  commissaryStoreId: string;
  branchStoreId: string;
  status?: LinkStatus;
}

export interface UpsertCommissaryLinkResult {
  linkId: string;
  customerId: string;
  customerCreated: boolean;
}

/**
 * Link a branch to a commissary — and, ⭐ deliberately, make sure the branch has an INTERNAL
 * customer row to be named on a trade order at all.
 *
 * ⚠️ **Why this bypasses `createCustomer`'s admin-only gate (`manage_chart_of_accounts`).**
 * `createCustomer` gates on that capability because naming a customer is normally a governance
 * act — who we extend credit to. An internal customer is not that: nobody is being extended
 * credit (`dispatchTradeOrder`'s own header: "a branch is not extended credit"), and no revenue
 * is ever recognised against it (T-133 derives the `internal` treatment from
 * `counterparty_store_id`, which is exactly what ELIMINATES the movement rather than booking it).
 * The row exists only so `trade_orders.customer_id` — NOT NULL — has something to name when the
 * "buyer" is one of our own stores. It is a mechanical CONSEQUENCE of the link a manager with
 * `manage_commissary_offerings` just made, not a credit decision, and a branch is not a buyer.
 * Gating it behind admin would leave a manager able to create the link and still unable to use it.
 */
export async function upsertCommissaryLink(
  tx: Tx | null,
  actor: Actor,
  input: UpsertCommissaryLinkInput,
): Promise<UpsertCommissaryLinkResult> {
  const run = async (trx: Tx): Promise<UpsertCommissaryLinkResult> => {
    await authorize(trx, actor, 'manage_commissary_offerings', { storeId: input.commissaryStoreId });

    // ⛔ The database's own check (`commissary_links_not_self_check`) refuses this too; refusing it
    // here as well means the message explains WHY rather than naming a constraint.
    if (input.commissaryStoreId === input.branchStoreId) {
      throw new Error(
        'upsertCommissaryLink: a store cannot supply itself — the commissary and the branch must ' +
          'be two different stores.',
      );
    }

    const found = await commissaryCatalogueRepo.storesInOrg(trx, actor.orgId, [
      input.commissaryStoreId,
      input.branchStoreId,
    ]);
    const commissary = found.get(input.commissaryStoreId);
    const branch = found.get(input.branchStoreId);
    if (!commissary) {
      throw new Error(`upsertCommissaryLink: commissary store ${input.commissaryStoreId} does not exist in this organisation.`);
    }
    if (!branch) {
      throw new Error(`upsertCommissaryLink: branch store ${input.branchStoreId} does not exist in this organisation.`);
    }

    const { id: linkId } = await commissaryCatalogueRepo.upsertLink(trx, {
      orgId: actor.orgId,
      commissaryStoreId: input.commissaryStoreId,
      branchStoreId: input.branchStoreId,
      status: input.status ?? 'active',
      createdBy: actor.personId,
    });

    const existing = await commissaryRepo.internalCustomerFor(trx, actor.orgId, input.branchStoreId);
    if (existing) {
      return { linkId, customerId: existing.id, customerCreated: false };
    }

    const created = await customersRepo.insertCustomer(trx, {
      orgId: actor.orgId,
      name: `${branch.name} (internal)`,
      address: null,
      contactNo: null,
      counterpartyStoreId: input.branchStoreId,
      counterpartyOrgId: null,
      priceListId: null,
      customerGroup: 'internal',
      notes: null,
      createdBy: actor.personId,
    });
    return { linkId, customerId: created.id, customerCreated: true };
  };
  if (tx) return run(tx);
  return transaction(run);
}

// -----------------------------------------------------------------------------------------
// commissary_item_offerings
// -----------------------------------------------------------------------------------------

export interface UpsertOfferingInput {
  commissaryStoreId: string;
  itemId: string;
  manualCost?: string | null;
  status?: LinkStatus;
}

/** What a commissary offers. T-171 invariant 3: the item must be an item the commissary can
 *  actually supply — active and purchasable — refused otherwise. */
export async function upsertOffering(
  tx: Tx | null,
  actor: Actor,
  input: UpsertOfferingInput,
): Promise<{ id: string }> {
  const run = async (trx: Tx): Promise<{ id: string }> => {
    await authorize(trx, actor, 'manage_commissary_offerings', { storeId: input.commissaryStoreId });

    const item = await itemsRepo.getItemById(trx, actor.orgId, input.itemId);
    if (!item) throw new Error(`upsertOffering: item ${input.itemId} does not exist.`);
    if (item.status !== 'active') {
      throw new Error(`upsertOffering: ${item.name} is ${item.status}, not active — only an active item can be offered.`);
    }
    if (!item.isPurchasable) {
      throw new Error(`upsertOffering: ${item.name} is not marked purchasable, so this commissary cannot supply it.`);
    }

    let manualCost: string | null = null;
    if (input.manualCost != null && input.manualCost.trim() !== '') {
      const trimmed = input.manualCost.trim();
      if (!MANUAL_COST_PATTERN.test(trimmed)) {
        throw new Error(
          `upsertOffering: "${input.manualCost}" is not a manual cost — a non-negative amount, up to four decimals.`,
        );
      }
      manualCost = trimmed;
    }

    return commissaryCatalogueRepo.upsertOffering(trx, {
      orgId: actor.orgId,
      commissaryStoreId: input.commissaryStoreId,
      itemId: input.itemId,
      manualCost,
      status: input.status ?? 'active',
      createdBy: actor.personId,
    });
  };
  if (tx) return run(tx);
  return transaction(run);
}

// -----------------------------------------------------------------------------------------
// commissary_item_map — the cross-store correspondence
// -----------------------------------------------------------------------------------------

export interface UpsertMapInput {
  commissaryStoreId: string;
  branchStoreId: string;
  commissaryItemId: string;
  branchItemId: string;
  isLedgerOnly?: boolean;
  expenseCategoryId?: string | null;
}

/**
 * Which of the branch's OWN items a commissary line becomes. T-171 invariant 9: this is the
 * BRANCH's to own — `authorize` checks `manage_commissary_map` at `branchStoreId`, never the
 * commissary's.
 */
export async function upsertMap(
  tx: Tx | null,
  actor: Actor,
  input: UpsertMapInput,
): Promise<{ id: string }> {
  const run = async (trx: Tx): Promise<{ id: string }> => {
    await authorize(trx, actor, 'manage_commissary_map', { storeId: input.branchStoreId });

    const linked = await commissaryRepo.activeLinkExists(trx, actor.orgId, input.commissaryStoreId, input.branchStoreId);
    if (!linked) {
      throw new Error(
        'upsertMap: this branch has no active link to that commissary — link the two stores ' +
          '(T-171) before mapping an item between them.',
      );
    }

    const commissaryItem = await itemsRepo.getItemById(trx, actor.orgId, input.commissaryItemId);
    if (!commissaryItem) throw new Error(`upsertMap: commissary item ${input.commissaryItemId} does not exist.`);
    if (commissaryItem.status !== 'active') {
      throw new Error(`upsertMap: ${commissaryItem.name} is ${commissaryItem.status}, not active.`);
    }

    const branchItem = await itemsRepo.getItemById(trx, actor.orgId, input.branchItemId);
    if (!branchItem) throw new Error(`upsertMap: branch item ${input.branchItemId} does not exist.`);
    if (branchItem.status !== 'active') {
      throw new Error(`upsertMap: ${branchItem.name} is ${branchItem.status}, not active.`);
    }

    // ⭐ T-171 invariant 8. Never guess a conversion — `confirmReceipt` would otherwise refuse the
    // stock at receipt time, far downstream of where the mismatch was actually made.
    if (commissaryItem.baseUnit !== branchItem.baseUnit) {
      throw new Error(
        `upsertMap: ${commissaryItem.name} is measured in ${commissaryItem.baseUnit} and ` +
          `${branchItem.name} in ${branchItem.baseUnit} — fix the branch item's base unit first. ` +
          'Nothing here guesses a conversion.',
      );
    }

    let expenseCategoryId: string | null = null;
    if (input.expenseCategoryId) {
      const category = await expensesRepo.getCategoryById(trx, actor.orgId, input.expenseCategoryId);
      if (!category) throw new Error(`upsertMap: expense category ${input.expenseCategoryId} does not exist.`);
      expenseCategoryId = category.id;
    }

    return commissaryCatalogueRepo.upsertMap(trx, {
      orgId: actor.orgId,
      commissaryStoreId: input.commissaryStoreId,
      branchStoreId: input.branchStoreId,
      commissaryItemId: input.commissaryItemId,
      branchItemId: input.branchItemId,
      isLedgerOnly: input.isLedgerOnly ?? false,
      expenseCategoryId,
      createdBy: actor.personId,
    });
  };
  if (tx) return run(tx);
  return transaction(run);
}

export async function removeMap(
  tx: Tx | null,
  actor: Actor,
  input: { id: string },
): Promise<{ removed: boolean }> {
  const run = async (trx: Tx): Promise<{ removed: boolean }> => {
    const row = await commissaryCatalogueRepo.getMapById(trx, actor.orgId, input.id);
    if (!row) throw new Error(`removeMap: map ${input.id} does not exist.`);
    // ⭐ The map is the BRANCH's to own (T-171 invariant 9) — checked at the row's own
    // `branchStoreId`, never the commissary's, same as `upsertMap`.
    await authorize(trx, actor, 'manage_commissary_map', { storeId: row.branchStoreId });
    const removed = await commissaryCatalogueRepo.removeMap(trx, actor.orgId, input.id);
    return { removed };
  };
  if (tx) return run(tx);
  return transaction(run);
}
