/**
 * Customers and price lists. T-129, ADR-008 §2, §3, §11.
 *
 * ## ⛔ A retail diner is NOT a customer
 *
 * > **ADR-008 §11:** *"A `customers` row exists because there is a BALANCE or a credit
 * > relationship. A diner who pays at the point of sale has neither."*
 *
 * ⚠️ The test is not org-vs-individual. This module has nothing to do with à la carte orders.
 *
 * ## ⭐ The treatment is derived from the links
 *
 * `counterparty_store_id` → internal, eliminates. `counterparty_org_id` → inter-entity, real
 * revenue. Neither → external, real revenue. ⛔ `customer_group` never decides any of it.
 */
import { customersRepo, itemsRepo, transaction, type Tx } from '@shareat/db';
import type { CustomerGroup, CustomerTreatment } from '@shareat/db/schema';
import { authorize, type Actor } from '@shareat/auth';
import { gone, refuse } from '../shared/refusal';

export { treatmentOf } from '@shareat/db';

export interface CreateCustomerInput {
  name: string;
  address?: string | null;
  contactNo?: string | null;
  /** ⛔ At most ONE of these. Both is refused here and by a CHECK. */
  counterpartyStoreId?: string | null;
  counterpartyOrgId?: string | null;
  priceListId?: string | null;
  customerGroup?: CustomerGroup;
  notes?: string | null;
}

export async function createCustomer(
  tx: Tx | null,
  actor: Actor,
  input: CreateCustomerInput,
): Promise<{ id: string; treatment: CustomerTreatment }> {
  const run = async (trx: Tx) => {
    // ⚠️ Admin. Who the business extends credit to, and whether a counterparty is one of its own
    // stores, decides whether a movement is revenue at all — that is a governance fact, not a daily
    // operation.
    await authorize(trx, actor, 'manage_chart_of_accounts', {});

    const name = input.name.trim();
    if (!name) throw refuse('createCustomer: a customer needs a name people will recognise.', 'A customer needs a name people will recognise.');

    const storeLink = input.counterpartyStoreId ?? null;
    const orgLink = input.counterpartyOrgId ?? null;
    // ⛔ ADR-008 §2. The CHECK refuses this too; refusing it here as well means the message explains
    // WHY rather than naming a constraint.
    if (storeLink && orgLink) {
      throw refuse(
        'createCustomer: a customer is either one of our own stores or another company, never ' +
          'both. One treatment eliminates the movement and the other books real revenue, so ' +
          'setting both would make it ambiguous — and nothing on any screen would look wrong.',
        'A customer is either one of our own stores or another company, never both. One treatment ' +
          'eliminates the movement and the other books real revenue, so setting both would make it ' +
          'ambiguous — and nothing on any screen would look wrong.',
      );
    }
    // ⚠️ Our OWN org is not a counterparty org. It would derive as an inter-entity sale to
    // ourselves — real revenue against no external party.
    if (orgLink && orgLink === actor.orgId) {
      throw refuse(
        'createCustomer: that is this organisation. A counterparty org is ANOTHER company — use ' +
          'the store link for one of our own stores.',
        'That is this organisation. A counterparty org is ANOTHER company — use the store link for ' +
          'one of our own stores.',
      );
    }

    const created = await customersRepo.insertCustomer(trx, {
      orgId: actor.orgId,
      name,
      address: input.address?.trim() || null,
      contactNo: input.contactNo?.trim() || null,
      counterpartyStoreId: storeLink,
      counterpartyOrgId: orgLink,
      priceListId: input.priceListId ?? null,
      customerGroup: input.customerGroup ?? 'wholesale',
      notes: input.notes?.trim() || null,
      createdBy: actor.personId,
    });
    return {
      id: created.id,
      treatment: customersRepo.treatmentOf({
        counterpartyStoreId: storeLink,
        counterpartyOrgId: orgLink,
      }),
    };
  };
  if (tx) return run(tx);
  return transaction(run);
}

/**
 * ⭐ **Stamp the reconciliation anchor** — ported from v1, where it means *"everything before this
 * date is considered settled."*
 *
 * ⚠️ **An attestation, not a balance.** It records that a named person agreed this customer owed
 * nothing on a named date, and it does NOT change when the ledger does — which is what makes a
 * later disagreement visible. Same shape as T-127's drawings close.
 *
 * ⛔ Refused while the customer still owes money: an anchor claiming zero against a real balance
 * would tell every aging report after it that a live debt was settled.
 */
export async function reconcileCustomer(
  tx: Tx | null,
  actor: Actor,
  input: { customerId: string; asOf: string },
): Promise<{ balanceAtStamp: string }> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'manage_chart_of_accounts', {});
    const customer = await customersRepo.getById(trx, actor.orgId, input.customerId);
    if (!customer) throw gone(`reconcileCustomer: customer ${input.customerId} does not exist.`, 'customer');

    const balance = await customersRepo.balanceOf(trx, actor.orgId, customer.id);
    if (Math.abs(Number(balance)) > 0.005) {
      throw refuse(
        `reconcileCustomer: this customer owes ₱${balance}. An anchor says they were verified at ` +
          `ZERO on a date, so stamping one now would tell every later aging report that a live ` +
          `debt was settled.`,
        `This customer owes ₱${balance}. An anchor says they were verified at ZERO on a date, so ` +
          'stamping one now would tell every later aging report that a live debt was settled.',
      );
    }

    await customersRepo.updateCustomer(trx, actor.orgId, customer.id, {
      reconciledAsOf: input.asOf,
      reconciledAt: new Date(),
      reconciledBy: actor.personId,
    });
    return { balanceAtStamp: balance };
  };
  if (tx) return run(tx);
  return transaction(run);
}

// -------------------------------------------------------------------------------------
// Price lists
// -------------------------------------------------------------------------------------

export async function createPriceList(
  tx: Tx | null,
  actor: Actor,
  input: { name: string; description?: string | null },
): Promise<{ id: string }> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'manage_chart_of_accounts', {});
    const name = input.name.trim();
    if (!name) throw refuse('createPriceList: a price list needs a name.', 'A price list needs a name.');
    return customersRepo.insertPriceList(trx, {
      orgId: actor.orgId,
      name,
      description: input.description?.trim() || null,
      createdBy: actor.personId,
    });
  };
  if (tx) return run(tx);
  return transaction(run);
}

/** ⭐ Re-quoting an item REPLACES its rate. A price list holds one rate per item, not a history. */
export async function setPrice(
  tx: Tx | null,
  actor: Actor,
  input: {
    priceListId: string;
    /** ⭐ T-145: a real item, not an opaque code. The name comes from the item. */
    itemId: string;
    rate: string;
    unit?: string | null;
  },
): Promise<void> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'manage_chart_of_accounts', {});
    const list = await customersRepo.getPriceList(trx, actor.orgId, input.priceListId);
    if (!list) throw gone(`setPrice: price list ${input.priceListId} does not exist.`, 'price list');

    const item = await itemsRepo.getItemById(trx, actor.orgId, input.itemId);
    if (!item) throw gone(`setPrice: item ${input.itemId} does not exist.`, 'item');
    if (item.status !== 'active') {
      throw refuse(`setPrice: ${item.name} is inactive — reactivate it before quoting a rate.`, `${item.name} is inactive — reactivate it before quoting a rate.`);
    }
    // ⭐ T-149, and the reason this task exists: nothing previously stopped someone quoting cooked
    // food to a franchisee. A price list is a wholesale instrument, so an item on one must be
    // something we actually sell wholesale.
    // ⚠️ ANYWHERE in the org, not at one store: a price list is an org-wide rate card, not a
    // per-branch one. If Lipa sells bulgogi sauce wholesale, the rate is quotable.
    const wholesaleSomewhere = await itemsRepo.sellableWholesaleAnywhere(trx, actor.orgId, item.id);
    if (!wholesaleSomewhere) {
      throw refuse(
        `setPrice: ${item.name} is not sold wholesale, so it cannot go on a price list. A bento ` +
          'box is sold à la carte and not to a franchisee. Mark it wholesale-sellable first if ' +
          'that is genuinely what you mean.',
        `${item.name} is not sold wholesale, so it cannot go on a price list. A bento box is sold ` +
          'à la carte and not to a franchisee. Mark it wholesale-sellable first if that is ' +
          'genuinely what you mean.',
      );
    }
    // ⚠️ Zero is allowed — a genuinely free line exists (a sample, a promotional unit) and refusing
    // it would push people to enter 0.01. Negative is not: that is a discount, not a price.
    if (Number(input.rate) < 0) {
      throw refuse('setPrice: a rate cannot be negative. A negative price is a discount.', 'A rate cannot be negative. A negative price is a discount.');
    }

    await customersRepo.upsertPriceListItem(trx, {
      orgId: actor.orgId,
      priceListId: list.id,
      itemId: item.id,
      rate: input.rate,
      unit: input.unit?.trim() || null,
    });
  };
  if (tx) return run(tx);
  return transaction(run);
}
