'use server';

/**
 * Server actions for the customer and price-list screens. T-129.
 *
 * ⛔ The gates live in the services, not here. A gate in a server action protects one caller.
 */
import { redirect } from 'next/navigation';
import { arRepo } from '@shareat/db';
import { parseMoneyInput } from '@shareat/domain/money-input';
import { logger } from '@shareat/core/logger';
import {
  createCustomer,
  createPriceList,
  reconcileCustomer,
  recordCollection,
  setPrice,
  uploadFile,
  voidCharge,
  voidCollection,
  writeOffCharge,
  suggestCollectionAllocation,
} from '@shareat/domain';
import type { CustomerGroup } from '@shareat/db/schema';
import { withOrgPrincipal } from './lib';
import { requireActor } from '../../lib/session';
import { errorMessage } from '@/lib/constraint-messages';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

function back(path: string, params: Record<string, string>): never {
  redirect(`${path}?${new URLSearchParams(params).toString()}`);
}

export async function createCustomerAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  let message = '';
  try {
    // ⭐ ONE picker on the form, split here. Offering two independent dropdowns would let someone
    // fill both, and the whole point is that a customer has at most one counterparty.
    const link = str(formData, 'counterparty');
    const [kind, id] = link ? link.split(':') : ['', ''];

    const result = await withOrgPrincipal(actor.orgId, (tx) =>
      createCustomer(tx, actor, {
        name: str(formData, 'name'),
        address: str(formData, 'address') || null,
        contactNo: str(formData, 'contactNo') || null,
        counterpartyStoreId: kind === 'store' ? id! : null,
        counterpartyOrgId: kind === 'org' ? id! : null,
        priceListId: str(formData, 'priceListId') || null,
        customerGroup: (str(formData, 'customerGroup') || 'wholesale') as CustomerGroup,
        notes: str(formData, 'notes') || null,
      }),
    );
    // ⚠️ Says what the treatment MEANS, because "internal" alone does not tell anyone that the
    // movement will not be revenue.
    message =
      result.treatment === 'internal'
        ? 'Recorded as one of our own stores — movements to it eliminate and are never revenue.'
        : result.treatment === 'inter_entity'
          ? 'Recorded as another company — movements to it are real revenue and a real receivable.'
          : 'Recorded as an external customer — real revenue.';
  } catch (err) {
    back('/customers', { error: errorMessage(err) });
  }
  back('/customers', { ok: message });
}

export async function reconcileCustomerAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  let message = '';
  try {
    const asOf = str(formData, 'asOf');
    if (!asOf) throw new Error('Say which date they were verified at zero.');
    await withOrgPrincipal(actor.orgId, (tx) =>
      reconcileCustomer(tx, actor, { customerId: str(formData, 'customerId'), asOf }),
    );
    message = `Anchored at ${asOf}. Everything before it is treated as settled.`;
  } catch (err) {
    back('/customers', { error: errorMessage(err) });
  }
  back('/customers', { ok: message });
}

// -------------------------------------------------------------------------------------
// The four that CLEAR a receivable — T-226 / DEF-190
//
// ⛔ Until these existed, `1210` was raised automatically by trade dispatch and cleared by
// nothing any human could reach. `recordCollection`, `voidCollection` and `writeOffCharge`
// shipped with T-131 on 2 September, fully gated and fully tested, with zero callers under
// `apps/` — so a customer's debt could be created and never settled, and a customer who hit
// their credit limit could never be dispatched to again.
//
// ⛔ Every gate is `authorize()` INSIDE the service. Nothing is re-checked here: a gate in a
// server action protects one caller.
// -------------------------------------------------------------------------------------

/** Back to the customer, keeping the store the user was working in. */
function backToCustomer(customerId: string, storeId: string, params: Record<string, string>): never {
  back(`/customers/${customerId}`, storeId ? { store: storeId, ...params } : params);
}

export interface AutoAllocateCollectionRequest {
  customerId: string;
  storeId: string;
  amount: string;
  /** Boxes the operator has already typed into, by hand — never re-filled (Ian's ruling 2). */
  typed: { chargeId: string; amount: string }[];
}

export type AutoAllocateCollectionResponse =
  | { ok: true; allocations: { chargeId: string; amountApplied: string }[]; surplus: string }
  | { ok: false; error: string };

/**
 * T-330 — "Auto-allocate (oldest first)" for a customer collection. Mirrors AP's
 * `autoAllocatePaymentAction` exactly: called imperatively from the form, computes nothing
 * itself — `suggestCollectionAllocation` is read-only (invariant 5) — and never posts; the
 * operator still presses "Record collection" (§2). ⭐ AR's `openItems` already carries `dueDate`
 * and `referenceNo` (AMENDMENT 4 — no separate ordering-key lookup exists or is needed on this
 * side), so `keys` is built directly from `open`, never re-queried.
 */
export async function autoAllocateCollectionAction(
  req: AutoAllocateCollectionRequest,
): Promise<AutoAllocateCollectionResponse> {
  const actor = await requireActor();
  try {
    const result = await withOrgPrincipal(actor.orgId, async (tx) => {
      const open = await arRepo.openItems(tx, actor.orgId, req.customerId, req.storeId);
      const keys = open.map((o) => ({
        chargeId: o.chargeId,
        dueDate: o.dueDate,
        chargeDate: o.chargeDate,
        referenceNo: o.referenceNo,
      }));
      return suggestCollectionAllocation(
        tx,
        actor,
        req.storeId,
        req.amount,
        open,
        keys,
        req.typed.map((t) => {
          // T-343 S5.5n / DEF-459 — logged before rethrowing: a malformed allocation amount is a
          // real-world typo worth seeing in the logs, not only on the screen the throw already
          // reaches.
          let amount: ReturnType<typeof parseMoneyInput>;
          try {
            amount = parseMoneyInput(t.amount, `suggestCollectionAllocation: the amount typed for charge ${t.chargeId}`, 'An amount you typed against a charge');
          } catch (err) {
            logger.info({ err }, 'suggestCollectionAllocation: malformed allocation amount');
            throw err;
          }
          return { id: t.chargeId, amount };
        }),
      );
    });
    return { ok: true, allocations: result.allocations, surplus: result.surplus };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function recordCollectionAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const customerId = str(formData, 'customerId');
  const storeId = str(formData, 'storeId');
  let message = '';
  try {
    if (!storeId) throw new Error('Choose a store — a collection settles one store’s charges.');

    // ⛔ One row per ticked charge. The domain refuses an empty `allocations[]` citing bible
    // §16.10 (*a collection must never float unallocated*) — v1 let money arrive tied to nothing
    // on 38 collections and there was then no way to re-apply it.
    const chargeIds = formData.getAll('allocateChargeId').map(String);
    // T-328/7th-shape — was `.filter((a) => a.amountApplied && Number(a.amountApplied) > 0)`.
    // `Number('abc') > 0` is false, so a mistyped allocation was silently dropped with no message
    // at all. Blank stays skipped (an unticked charge); anything else is left for `recordCollection`
    // to accept or refuse with a readable sentence.
    const allocations = chargeIds
      .map((chargeId) => ({ chargeId, amountApplied: str(formData, `allocateAmount_${chargeId}`) }))
      .filter((a) => a.amountApplied);

    const creditApplied = str(formData, 'creditApplied');

    // ⭐ The proof is UPLOADED, never typed — the same `uploadFile` path `/ap` uses (T-141), which
    // strips EXIF, derives the storage path from the session, and writes a `stored_files` row.
    // ⚠️ Upload and post share ONE transaction, so a collection can never reference a file that
    // was not written; a failed post leaves orphan bytes for T-141's sweep, the cheaper failure.
    const proof = formData.get('receiptPhoto');
    const hasProof = proof instanceof File && proof.size > 0;

    const result = await withOrgPrincipal(actor.orgId, async (tx) => {
      let receiptFileId: string | null = null;
      if (hasProof) {
        const uploaded = await uploadFile(tx, actor, {
          purpose: 'receipt_photo',
          storeId,
          contentType: (proof as File).type,
          bytes: new Uint8Array(await (proof as File).arrayBuffer()),
        });
        receiptFileId = uploaded.fileId;
      }
      return recordCollection(tx, actor, {
        storeId,
        customerId,
        collectionDate: str(formData, 'collectionDate'),
        // ⚠️ GROSS — what the receivable is relieved by. The bank receives this minus the fee.
        amount: str(formData, 'amount'),
        // ⛔ The fee is booked HERE and nowhere else. v1 recognised it twice, in the collection
        // and again as an expense document: ₱198,148.29 across two stores, 37 documents voided.
        platformFee: str(formData, 'platformFee') || '0',
        moneyAccountId: str(formData, 'moneyAccountId'),
        referenceNo: str(formData, 'referenceNo') || null,
        notes: str(formData, 'notes') || null,
        receiptFileId,
        // T-343 S5.5n / DEF-457 — was `creditApplied && Number(creditApplied) > 0`. `Number('1,000')`
        // is `NaN`, so a comma-typed credit was silently DROPPED rather than reaching
        // `recordCollection`'s own `parseMoneyInput`, and the collection posted as if no credit had
        // been applied at all. Blank stays omitted (the domain defaults to '0'); anything else,
        // '0' included, is left for `recordCollection` to accept or refuse with a readable sentence
        // — same fix shape as `allocations` above.
        ...(creditApplied ? { creditApplied } : {}),
        allocations,
      });
    });
    // ⚠️ Says where a surplus WENT. v1 showed a floating `unallocatedAmount` and no way to spend
    // it; here it is a real `2140` balance the next collection can draw on.
    message =
      `Collected. ₱${result.allocated} settled against named charges` +
      (Number(result.surplus) > 0
        ? `, and ₱${result.surplus} more than was owed is now store credit (2140) they can spend next time.`
        : '.');
  } catch (err) {
    backToCustomer(customerId, storeId, { error: errorMessage(err) });
  }
  backToCustomer(customerId, storeId, { ok: message });
}

export async function voidCollectionAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const customerId = str(formData, 'customerId');
  const storeId = str(formData, 'storeId');
  try {
    const reason = str(formData, 'reason');
    if (!reason) throw new Error('Say why this collection is being voided.');
    await withOrgPrincipal(actor.orgId, (tx) =>
      voidCollection(tx, actor, { collectionId: str(formData, 'collectionId'), reason }),
    );
  } catch (err) {
    backToCustomer(customerId, storeId, { error: errorMessage(err) });
  }
  // ⚠️ "Reversed, not deleted" is the whole point: the allocations stay, so the charges it
  // settled correctly reopen and the aging picks them up again.
  backToCustomer(customerId, storeId, {
    ok: 'Collection voided — reversed, not deleted, and the charges it settled are open again.',
  });
}

export async function voidChargeAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const customerId = str(formData, 'customerId');
  const storeId = str(formData, 'storeId');
  try {
    const reason = str(formData, 'reason');
    if (!reason) throw new Error('Say why this charge is being voided.');
    await withOrgPrincipal(actor.orgId, (tx) =>
      voidCharge(tx, actor, { chargeId: str(formData, 'chargeId'), reason }),
    );
  } catch (err) {
    backToCustomer(customerId, storeId, { error: errorMessage(err) });
  }
  backToCustomer(customerId, storeId, { ok: 'Charge voided — the entry is reversed, and it stays listed.' });
}

export async function writeOffChargeAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const customerId = str(formData, 'customerId');
  const storeId = str(formData, 'storeId');
  let message = '';
  try {
    const amount = str(formData, 'amount');
    const reason = str(formData, 'reason');
    if (!reason) throw new Error('Say why this debt is uncollectible — a write-off without a reason is a hole.');
    const result = await withOrgPrincipal(actor.orgId, (tx) =>
      writeOffCharge(tx, actor, { chargeId: str(formData, 'chargeId'), amount, reason }),
    );
    message = `₱${amount} written off to bad debt (6860). Entry ${result.entryId.slice(0, 8)}.`;
  } catch (err) {
    // ⛔ The domain refuses the charge's own author, and that refusal is SURFACED rather than
    // pre-empted. Hiding the button for that person would teach that write-off is unavailable,
    // when the truth is that it needs a second pair of eyes.
    backToCustomer(customerId, storeId, { error: errorMessage(err) });
  }
  backToCustomer(customerId, storeId, { ok: message });
}

export async function createPriceListAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  let id = '';
  try {
    const created = await withOrgPrincipal(actor.orgId, (tx) =>
      createPriceList(tx, actor, {
        name: str(formData, 'name'),
        description: str(formData, 'description') || null,
      }),
    );
    id = created.id;
  } catch (err) {
    back('/customers/price-lists', { error: errorMessage(err) });
  }
  back(`/customers/price-lists/${id}`, { ok: 'Created. Add rates to it below.' });
}

export async function setPriceAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const priceListId = str(formData, 'priceListId');
  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      setPrice(tx, actor, {
        priceListId,
        // ⭐ T-145: the form picks a real item now. The old free-text code is what allowed the
        // same product to exist under three spellings on three lists.
        itemId: str(formData, 'itemId'),
        rate: str(formData, 'rate'),
        unit: str(formData, 'unit') || null,
      }),
    );
  } catch (err) {
    back(`/customers/price-lists/${priceListId}`, { error: errorMessage(err) });
  }
  back(`/customers/price-lists/${priceListId}`, {
    // ⚠️ Says "replaced", because re-quoting an item does not add a second row.
    ok: 'Rate saved. Re-quoting an item replaces its rate — a list holds one price per item.',
  });
}
