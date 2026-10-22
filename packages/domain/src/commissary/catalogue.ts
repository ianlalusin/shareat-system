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
import { decimal, type Decimal } from '@shareat/core/money';
import { gone, refuse } from '../shared/refusal';
import { assertFieldRules } from '../shared/field-rules-assert';
import { MANUAL_COST_PATTERN } from '../shared/manual-cost-pattern';
import { COMMISSARY_LINK_RULES, COMMISSARY_MAP_RULES, COMMISSARY_OFFERING_RULES } from '../field-rules/commissary';

export type LinkStatus = (typeof LINK_STATUSES)[number];

/** A non-negative amount, up to four decimals — the shape a cost-per-unit column needs when its
 *  column is declared with more than two decimal places of scale, as opposed to `parseMoneyInput`'s
 *  two-decimal money rule. ⛔ Never `Number()`'d for storage: the string passes through untouched,
 *  same discipline as `normaliseRate` in `commissary/orders.ts`. ⚠️ `upsertOffering` below still
 *  tests this pattern inline, with its own hand-written message — left that way DELIBERATELY
 *  (T-328/DEF-383): converging every existing caller onto one sentence-producing entry point is
 *  DEF-383's own remedy, its own task, and out of scope here. `parseFourDecimalCost` below is for
 *  new callers outside this file — `deliveries/documents.ts`'s `unitCost` is the first — so at
 *  least no THIRD shape of "test this pattern inline" gets added while DEF-383 is still open. */
// T-351 / DEF-483 — this comment used to claim the pattern only PRESERVED what already passed;
// S5.5w Amendment A1 item 1b actually WIDENED it, replacing `/^\d+(\.\d{1,4})?$/` (which required
// at least one digit before the decimal point, so it rejected ".5" and "1."). Of the three shapes
// named here, only ".5" and "1." are NEWLY accepted by that change — "005" already passed under
// the old pattern too, since a leading-zero digit run was never the problem. All three now pass
// for every user of this pattern: `parseFourDecimalCost`'s callers (deliveries, cutover, and AP
// invoice lines since T-351) and `upsertOffering`'s own manual cost (`:207`). The lookahead still
// requires at least one digit, so "" and "." are still structurally rejected. Code is unchanged.

/**
 * The `MANUAL_COST_PATTERN` shape, wrapped as a sentence-producing entry point — same relationship
 * `parseMoneyInput` has to `money()` (`packages/domain/src/shared/money-input.ts`): a bare pattern
 * test produces a boolean, never a message a cashier can act on. `rawLabel` identifies the field
 * in the raw diagnostic exactly as before this task (Invariant 1 — callers keep passing whatever
 * they always did, id included, since `.message` is a log, never a screen). `humanLabel` is the
 * SEPARATE, id-free phrase the userMessage uses — `deliveries/documents.ts`'s call passes
 * `Line ${n}: the unit cost`. T-328 — introduced for `deliveries/documents.ts`'s `unitCost`.
 */
export function parseFourDecimalCost(raw: string, rawLabel: string, humanLabel: string): Decimal<'14,4'> {
  const trimmed = raw.trim();
  if (!MANUAL_COST_PATTERN.test(trimmed)) {
    throw refuse(
      `${rawLabel} — "${raw}" is not a valid amount. Use a non-negative number with up to four ` +
        'decimal places.',
      `${humanLabel} — "${raw}" is not a valid amount. Use a non-negative number with up to four decimal places.`,
    );
  }
  // S5.5w Amendment A1 item 1 — the pattern above caps decimals but not the integer part, and
  // every caller writes numeric(14,4): an 11+-digit integer part reaches Postgres and returns the
  // generic DB-refused fallback instead of naming what is wrong.
  const integerPart = (trimmed.split('.')[0] ?? '').replace(/^0+(?=\d)/, '');
  if (integerPart.length > 10) {
    throw refuse(
      `${rawLabel} — "${raw}" is too large. Use a number below 10000000000.`,
      `${humanLabel} — "${raw}" is too large. Use a number below 10000000000.`,
    );
  }
  // ⭐ T-371 R2: the accepted set and the sentences above are unchanged; the RETURN VALUE now passes through `decimal()`,
  // the one mint, at the (14,4) shape every caller writes. The pattern also accepts ".5" and "1.", which `decimal()` does
  // not, so the shape is canonicalised first (a missing whole part is `0`, a bare `.` is dropped).
  const [whole = '', frac = ''] = trimmed.split('.');
  return decimal(`${whole || '0'}${frac ? `.${frac}` : ''}`, '14,4');
}

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
    assertFieldRules(COMMISSARY_LINK_RULES, { branchStoreId: input.branchStoreId });

    // ⛔ The database's own check (`commissary_links_not_self_check`) refuses this too; refusing it
    // here as well means the message explains WHY rather than naming a constraint.
    if (input.commissaryStoreId === input.branchStoreId) {
      throw refuse(
        'upsertCommissaryLink: a store cannot supply itself — the commissary and the branch must ' +
          'be two different stores.',
        'A store cannot supply itself — the commissary and the branch must be two different stores.',
      );
    }

    const found = await commissaryCatalogueRepo.storesInOrg(trx, actor.orgId, [
      input.commissaryStoreId,
      input.branchStoreId,
    ]);
    const commissary = found.get(input.commissaryStoreId);
    const branch = found.get(input.branchStoreId);
    if (!commissary) {
      throw gone(`upsertCommissaryLink: commissary store ${input.commissaryStoreId} does not exist in this organisation.`, 'commissary store');
    }
    if (!branch) {
      throw gone(`upsertCommissaryLink: branch store ${input.branchStoreId} does not exist in this organisation.`, 'branch store');
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
    assertFieldRules(COMMISSARY_OFFERING_RULES, { itemId: input.itemId, manualCost: input.manualCost });

    const item = await itemsRepo.getItemById(trx, actor.orgId, input.itemId);
    if (!item) throw gone(`upsertOffering: item ${input.itemId} does not exist.`, 'item');
    if (item.status !== 'active') {
      throw refuse(
        `upsertOffering: ${item.name} is ${item.status}, not active — only an active item can be offered.`,
        `${item.name} is ${item.status}, not active — only an active item can be offered.`,
      );
    }
    if (!item.isPurchasable) {
      throw refuse(
        `upsertOffering: ${item.name} is not marked purchasable, so this commissary cannot supply it.`,
        `${item.name} is not marked purchasable, so this commissary cannot supply it.`,
      );
    }

    // T-371 R6: `commissary_item_offerings.manual_cost` is NULLABLE, so a blank stores null (never a guessed '0').
    let manualCost: Decimal<'14,4'> | null = null;
    if (input.manualCost != null && input.manualCost.trim() !== '') {
      const trimmed = input.manualCost.trim();
      if (!MANUAL_COST_PATTERN.test(trimmed)) {
        throw refuse(
          `upsertOffering: "${input.manualCost}" is not a manual cost — a non-negative amount, up to four decimals.`,
          `"${input.manualCost}" is not a manual cost — a non-negative amount, up to four decimals.`,
        );
      }
      // T-371 R2: minted through `decimal()` at the column's (14,4) shape. The pattern accepts ".5" and "1.", which
      // `decimal()` does not, so the shape is canonicalised first; an 11+-digit whole part (which the pattern does not
      // cap, and Postgres would refuse) gets a sentence instead of the generic DB-refused fallback.
      const [whole = '', frac = ''] = trimmed.split('.');
      try {
        manualCost = decimal(`${whole || '0'}${frac ? `.${frac}` : ''}`, '14,4');
      } catch {
        throw refuse(
          `upsertOffering: "${input.manualCost}" is too large for a manual cost. Use a number below 10000000000.`,
          `"${input.manualCost}" is too large for a manual cost. Use a number below 10000000000.`,
        );
      }
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
    assertFieldRules(COMMISSARY_MAP_RULES, { commissaryItemId: input.commissaryItemId, branchItemId: input.branchItemId });

    const linked = await commissaryRepo.activeLinkExists(trx, actor.orgId, input.commissaryStoreId, input.branchStoreId);
    if (!linked) {
      // R4.9 :232 — rule 2 (stores as `Name (CODE)`), one refusal-path org-scoped read of both
      // stores (rule 6/7). `upsertMap` is not used as a probe inside a continuing tx — its one
      // production caller (`apps/erp/src/app/commissary/catalogue/actions.ts`'s `upsertMapAction`)
      // opens a transaction for this call alone, so a plain read needs no savepoint.
      // ⚠️ rule 6 — a naming lookup's own failure must never break the refusal it decorates: any
      // error here (a dropped connection) falls back to the same deictic phrases, same shape as
      // `ap/index.ts`'s `expenseKey` (S5.2 audit CHANGES).
      let branchName = 'This branch';
      let commissaryName = 'that commissary';
      try {
        const stores = await commissaryCatalogueRepo.storesInOrg(trx, actor.orgId, [
          input.commissaryStoreId,
          input.branchStoreId,
        ]);
        const commissaryStore = stores.get(input.commissaryStoreId);
        const branchStore = stores.get(input.branchStoreId);
        if (branchStore) branchName = `${branchStore.name} (${branchStore.code})`;
        if (commissaryStore) commissaryName = `${commissaryStore.name} (${commissaryStore.code})`;
      } catch {
        // Falls back to the deictic phrases already set above.
      }
      throw refuse(
        'upsertMap: this branch has no active link to that commissary — link the two stores ' +
          '(T-171) before mapping an item between them.',
        `${branchName} has no active link to ${commissaryName} — link the two stores before mapping an item between them.`,
      );
    }

    const commissaryItem = await itemsRepo.getItemById(trx, actor.orgId, input.commissaryItemId);
    if (!commissaryItem) throw gone(`upsertMap: commissary item ${input.commissaryItemId} does not exist.`, 'commissary item');
    if (commissaryItem.status !== 'active') {
      throw refuse(
        `upsertMap: ${commissaryItem.name} is ${commissaryItem.status}, not active.`,
        `${commissaryItem.name} is ${commissaryItem.status}, not active.`,
      );
    }

    const branchItem = await itemsRepo.getItemById(trx, actor.orgId, input.branchItemId);
    if (!branchItem) throw gone(`upsertMap: branch item ${input.branchItemId} does not exist.`, 'branch item');
    if (branchItem.status !== 'active') {
      throw refuse(
        `upsertMap: ${branchItem.name} is ${branchItem.status}, not active.`,
        `${branchItem.name} is ${branchItem.status}, not active.`,
      );
    }

    // ⭐ T-171 invariant 8. Never guess a conversion — `confirmReceipt` would otherwise refuse the
    // stock at receipt time, far downstream of where the mismatch was actually made.
    if (commissaryItem.baseUnit !== branchItem.baseUnit) {
      throw refuse(
        `upsertMap: ${commissaryItem.name} is measured in ${commissaryItem.baseUnit} and ` +
          `${branchItem.name} in ${branchItem.baseUnit} — fix the branch item's base unit first. ` +
          'Nothing here guesses a conversion.',
        `${commissaryItem.name} is measured in ${commissaryItem.baseUnit} and ${branchItem.name} ` +
          `in ${branchItem.baseUnit} — fix the branch item's base unit first. Nothing here guesses a conversion.`,
      );
    }

    let expenseCategoryId: string | null = null;
    if (input.expenseCategoryId) {
      const category = await expensesRepo.getCategoryById(trx, actor.orgId, input.expenseCategoryId);
      if (!category) throw gone(`upsertMap: expense category ${input.expenseCategoryId} does not exist.`, 'expense category');
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
    if (!row) throw gone(`removeMap: map ${input.id} does not exist.`, 'item mapping');
    // ⭐ The map is the BRANCH's to own (T-171 invariant 9) — checked at the row's own
    // `branchStoreId`, never the commissary's, same as `upsertMap`.
    await authorize(trx, actor, 'manage_commissary_map', { storeId: row.branchStoreId });
    const removed = await commissaryCatalogueRepo.removeMap(trx, actor.orgId, input.id);
    return { removed };
  };
  if (tx) return run(tx);
  return transaction(run);
}
