'use server';

/**
 * Server actions for the trade-orders screens — DEF-138, 2026-09-03.
 *
 * Thin adapters: parse `FormData`, call the domain, redirect with a message. ⭐ The actor comes
 * from the session, never the form (T-138) — authorization is `createTradeOrder` /
 * `dispatchTradeOrder` / `receiveTradeOrder` / `voidTradeOrder`'s own first statement, not
 * repeated here. Every one of those runs under the org's RLS principal (`withOrgPrincipal`), the
 * same way the AP and item actions do.
 */
import { revalidatePath } from 'next/cache';
import { tradeRepo } from '@shareat/db';
import { compare, money, ZERO } from '@shareat/core/money';
import { assertFieldRules, createTradeOrder, dispatchTradeOrder, receiveTradeOrder, setBirInvoiceNo, uploadFile, voidTradeOrder } from '@shareat/domain';
import { TRADE_DISPATCH_RULES, TRADE_ORDER_RULES, TRADE_RECEIVE_RULES, TRADE_VOID_RULES } from '@shareat/domain/field-rules';
import { SHORTAGE_REASONS, type ShortageReason } from '@shareat/db/schema';
import { peso, withOrgPrincipal } from './lib';
import { requireActor } from '../../../lib/session';
import { errorMessage } from '@/lib/constraint-messages';
import { redirectWithFlash } from '@/lib/flash';
import { keepTyping } from '@/lib/keep-typing';
import { BIR_INVOICE_NO } from './typed-forms';
import { verifyAdminApproval } from '@shareat/auth';
import { loadDestructiveTarget, recordApproval } from '@/lib/destructive';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

/** Repeated fields — one per line row. Parallel arrays, in document order. */
function strs(fd: FormData, key: string): string[] {
  return fd.getAll(key).map((v) => (typeof v === 'string' ? v.trim() : ''));
}

export async function createOrderAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/trade/orders');
  const storeId = str(fd, 'storeId');

  const itemIds = strs(fd, 'itemId');
  const quantities = strs(fd, 'quantity');
  const rates = strs(fd, 'rate');
  // A row whose item was never picked is an empty row, not an error — skipped. A row WITH an
  // item and no quantity is a real mistake, and the domain says so.
  const lines = itemIds
    .map((itemId, i) => ({ itemId, quantity: quantities[i] ?? '', rate: rates[i] || null, lineNo: i + 1 }))
    .filter((l) => l.itemId);

  let orderId = '';
  let total = '';
  try {
    assertFieldRules(TRADE_ORDER_RULES, fd);
    const result = await withOrgPrincipal(actor.orgId, (tx) =>
      createTradeOrder(tx, actor, {
        storeId,
        customerId: str(fd, 'customerId'),
        orderDate: str(fd, 'orderDate'),
        lines,
        referenceNo: str(fd, 'referenceNo') || null,
        notes: str(fd, 'notes') || null,
        deliveryFee: str(fd, 'deliveryFee') || null,
        otherFees: str(fd, 'otherFees') || null,
      }),
    );
    orderId = result.orderId;
    total = result.totalAmount;
  } catch (err) {
    return await redirectWithFlash('/trade/orders', { store: storeId }, { error: errorMessage(err) });
  }
  revalidatePath('/trade/orders');
  return await redirectWithFlash(`/trade/orders/${orderId}`, {}, {
    ok: `Draft saved at ${peso(total)}. Nothing has posted — dispatch is the event that bills and moves stock.`,
  });
}

export async function dispatchOrderAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/trade/orders');
  const orderId = str(fd, 'orderId');
  let message = '';
  try {
    assertFieldRules(TRADE_DISPATCH_RULES, fd);
    // T-433 S1: a buyer who pays at the door. Blank amount = the old dispatch (billed, paid later on the customer's page).
    const payNowAmount = str(fd, 'payNowAmount');
    // ⭐ The proof is UPLOADED, never typed (same path as the customer page's collection). Upload, bill and collect share
    // ONE transaction, so a payment can never reference a file that was not written, nor a bill exist without its payment.
    const proof = fd.get('receiptPhoto');
    const hasProof = proof instanceof File && proof.size > 0;
    const result = await withOrgPrincipal(actor.orgId, async (tx) => {
      let payNow: { amount: string; moneyAccountId: string; receiptFileId: string | null; referenceNo: string | null } | null = null;
      if (payNowAmount) {
        let receiptFileId: string | null = null;
        if (hasProof) {
          const order = await tradeRepo.getOrderById(tx, actor.orgId, orderId);
          if (order) {
            const uploaded = await uploadFile(tx, actor, {
              purpose: 'receipt_photo',
              storeId: order.storeId,
              contentType: (proof as File).type,
              bytes: new Uint8Array(await (proof as File).arrayBuffer()),
            });
            receiptFileId = uploaded.fileId;
          }
        }
        payNow = {
          amount: payNowAmount,
          moneyAccountId: str(fd, 'moneyAccountId'),
          receiptFileId,
          referenceNo: str(fd, 'payNowReferenceNo') || null,
        };
      }
      return dispatchTradeOrder(tx, actor, {
        orderId,
        creditOverrideReason: str(fd, 'creditOverrideReason') || null,
        payNow,
      });
    });
    // ⭐ Says what the treatment DID to the books — "internal" and "external" are one word apart
    // and a world apart (the customers screen makes the same point).
    const overridden = result.creditOverridden ? ' ⚠️ The credit limit was exceeded on your stated reason, which is kept.' : '';
    if (result.treatment === 'internal') {
      message =
        'Dispatched. The goods are in transit at cost and the commissary’s stock is relieved; ' +
        'both stores’ books move when the branch confirms what actually arrived.';
    } else if (result.paidNow && result.balanceAfterPayment !== null) {
      message =
        `Dispatched, billed and paid ${peso(result.paidNow)}; ` +
        (compare(money(result.balanceAfterPayment), ZERO) > 0 ? `${peso(result.balanceAfterPayment)} still owed.` : 'nothing still owed.') +
        overridden;
    } else {
      message =
        'Dispatched and billed: the receivable is raised against the customer, stock is relieved ' +
        'and cost of sales posted.' +
        overridden;
    }
  } catch (err) {
    return await redirectWithFlash(`/trade/orders/${orderId}`, {}, { error: errorMessage(err) });
  }
  revalidatePath('/trade/orders');
  revalidatePath(`/trade/orders/${orderId}`);
  return await redirectWithFlash(`/trade/orders/${orderId}`, {}, { ok: message });
}

/** T-433 S2. Note (or clear) the number from the pre-printed BIR booklet; the delivery receipt then shows it. */
export async function setBirInvoiceNoAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/trade/orders');
  const orderId = str(fd, 'orderId');
  let message = '';
  try {
    const result = await withOrgPrincipal(actor.orgId, (tx) =>
      setBirInvoiceNo(tx, actor, { orderId, value: str(fd, 'birInvoiceNo') }),
    );
    message = result.birInvoiceNo ? `Invoice no. ${result.birInvoiceNo} noted on this order.` : 'Invoice no. cleared.';
  } catch (err) {
    return await redirectWithFlash(`/trade/orders/${orderId}`, {}, { error: errorMessage(err), typed: keepTyping(fd, BIR_INVOICE_NO, orderId, { actorId: actor.personId }) });
  }
  revalidatePath(`/trade/orders/${orderId}`);
  return await redirectWithFlash(`/trade/orders/${orderId}`, {}, { ok: message });
}

export async function receiveOrderAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/trade/orders');
  const orderId = str(fd, 'orderId');

  // Per-line inputs are present only for an INTERNAL transfer — what the branch actually signed
  // for (T-174's short-receipt input). An external sale's receipt is a signature, nothing more.
  const lineIds = strs(fd, 'lineId');
  const received = strs(fd, 'receivedQuantity');
  const reasons = strs(fd, 'shortageReason');
  const lines = lineIds
    .map((lineId, i) => ({
      lineId,
      receivedQuantity: received[i] || null,
      shortageReason: (SHORTAGE_REASONS as readonly string[]).includes(reasons[i] ?? '')
        ? (reasons[i] as ShortageReason)
        : null,
    }))
    .filter((l) => l.lineId);

  let message = '';
  try {
    assertFieldRules(TRADE_RECEIVE_RULES, fd);
    const result = await withOrgPrincipal(actor.orgId, (tx) =>
      receiveTradeOrder(tx, actor, {
        orderId,
        receivedOn: str(fd, 'receivedOn') || undefined,
        lines: lines.length > 0 ? lines : undefined,
      }),
    );
    message = result.entryId
      ? 'Receipt confirmed. Both stores’ books moved on what was actually signed for; any shortfall is an open transit discrepancy.'
      : 'Receipt recorded — who signed, and when. Nothing further posts for a sale: the value moved at dispatch.';
    // ⭐ T-372 S6b: an over-count is booked at what was sent, and said so — never silent.
    for (const o of result.overCounts) {
      message += ` ${o.itemName}: ${o.counted} counted, ${o.booked} booked — the extra ${o.excess} is waiting for the commissary to resolve.`;
    }
  } catch (err) {
    return await redirectWithFlash(`/trade/orders/${orderId}`, {}, { error: errorMessage(err) });
  }
  revalidatePath('/trade/orders');
  revalidatePath(`/trade/orders/${orderId}`);
  return await redirectWithFlash(`/trade/orders/${orderId}`, {}, { stamp: 'RECEIVED', ok: message });
}

export async function voidOrderAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/trade/orders');
  const orderId = str(fd, 'orderId');
  let message = '';
  try {
    assertFieldRules(TRADE_VOID_RULES, fd);
    // T-412 Tier P: an administrator's PIN, verified on the server against the RECORD's store.
    const target = await loadDestructiveTarget(actor, 'trade_order', orderId, ['approve_buyer', 'dispatch_branch_order']);
    const approval = await verifyAdminApproval(null, { actor, storeId: target.storeId, pin: str(fd, 'adminPin'), capability: 'approve_buyer' });
    const result = await withOrgPrincipal(actor.orgId, async (tx) => {
      const voided = await voidTradeOrder(tx, actor, { orderId, reason: str(fd, 'reason') });
      await recordApproval(tx, actor, approval, { capability: 'approve_buyer', entityType: 'trade_order', entityId: orderId, storeId: target.storeId });
      return voided;
    });
    message = result.reversedEntryId
      ? 'Voided. The posting is reversed — never deleted — and the stock it moved is given back.'
      : 'Voided. Nothing had posted yet, so nothing needed reversing.';
  } catch (err) {
    return await redirectWithFlash(`/trade/orders/${orderId}`, {}, { error: errorMessage(err) });
  }
  revalidatePath('/trade/orders');
  revalidatePath(`/trade/orders/${orderId}`);
  return await redirectWithFlash(`/trade/orders/${orderId}`, {}, { stamp: 'VOID', ok: message });
}
