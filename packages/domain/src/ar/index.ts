/**
 * Accounts receivable. T-131 — `docs/tasks/131-accounts-receivable.md`.
 *
 * ⭐ Deliberately the mirror of `domain/src/ap`: the same allocation discipline, the same lock,
 * the same refusal to store a balance. Where AP's surplus becomes `1240 Advances to suppliers`,
 * AR's becomes `2140 Customer store credits payable`.
 *
 * ⛔ **The platform fee is booked here, once.** v1 recognised it twice and it cost ₱198,148.29
 * across two stores. `POSTING-PATTERNS.md`'s `ar_collection` is the authority for these legs.
 */
import { arRepo, customersRepo, moneyAccountsRepo, transaction, type Tx } from '@shareat/db';
import { authorize, AuthorizationError, type Actor } from '@shareat/auth';
import { postEntry } from '../ledger/post-entry';
import { reverseEntry } from '../ledger/reverse-entry';

export const AR_CONTROL_CODE = arRepo.AR_CONTROL_CODE;
export const STORE_CREDIT_CODE = arRepo.STORE_CREDIT_CODE;

/** Decimal noise only — matches the tolerance every other money comparison in this codebase uses. */
const EPSILON = 0.005;

// -------------------------------------------------------------------------------------
// Charges
// -------------------------------------------------------------------------------------

export interface RecordChargeInput {
  storeId: string;
  customerId: string;
  chargeDate: string;
  dueDate?: string | null;
  totalAmount: string;
  revenueAccountCode: string;
  referenceNo?: string | null;
  notes?: string | null;
  /** DEF-158: the reason for going over the customer's credit limit, if it applies. */
  creditOverrideReason?: string | null;
}

/**
 * A customer owes us money. Posts `Dr 1210 (party=customer) / Cr <revenue>` immediately —
 * there is no draft step, matching the "verification IS the approval" shape T-130 settled.
 *
 * DEF-158: the credit-limit gate lives HERE, not only in `trade/index.ts`'s one caller — this is
 * the general AR-charge primitive and bible §16.4 names the limit as enforced "at exactly one
 * gate." A second caller of `recordCharge` (a manual billing screen, a catering charge) must not
 * be able to bypass it just by not re-implementing the check trade/index.ts happened to add.
 */
export async function recordCharge(
  tx: Tx | null,
  actor: Actor,
  input: RecordChargeInput,
): Promise<{ chargeId: string; entryId: string; creditOverrideBy: string | null; creditOverrideReason: string | null }> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'approve_buyer', { storeId: input.storeId });

    const customer = await customersRepo.getById(trx, actor.orgId, input.customerId);
    if (!customer) throw new Error(`recordCharge: customer ${input.customerId} does not exist.`);
    if (customer.status !== 'active') {
      throw new Error(`recordCharge: ${customer.name} is ${customer.status}, not active.`);
    }
    if (Number(input.totalAmount) <= 0) {
      throw new Error('recordCharge: a charge has to be greater than zero.');
    }

    // ⛔ ONE gate, here, because this is the one act that creates AR exposure — every caller
    // (trade orders today, anything else tomorrow) goes through it.
    let creditOverrideBy: string | null = null;
    let creditOverrideReason: string | null = null;
    if (customer.creditLimit !== null) {
      // ⚠️ Derived from the ledger, never a stored balance — org-wide, because a credit limit is
      // extended to a BUYER, not to a buyer at one branch.
      const { controlBalance } = await arRepo.positionOf(trx, actor.orgId, input.customerId);
      const after = Number(controlBalance) + Number(input.totalAmount);
      if (after > Number(customer.creditLimit) + EPSILON) {
        const reason = input.creditOverrideReason?.trim() || '';
        let mayOverride = true;
        try {
          await authorize(trx, actor, 'override_credit_limit', { storeId: input.storeId });
        } catch (e) {
          if (!(e instanceof AuthorizationError)) throw e;
          mayOverride = false;
        }
        if (!mayOverride || !reason) {
          throw new Error(
            `recordCharge: ${customer.name} owes ₱${controlBalance} and this charge is ` +
              `₱${input.totalAmount}, which would take them to ₱${after.toFixed(2)} against a ` +
              `limit of ₱${customer.creditLimit}. A manager or admin can charge it anyway by ` +
              'saying why.',
          );
        }
        creditOverrideBy = actor.personId;
        creditOverrideReason = reason;
      }
    }

    const { id: chargeId } = await arRepo.insertCharge(trx, {
      orgId: actor.orgId,
      storeId: input.storeId,
      customerId: input.customerId,
      chargeDate: input.chargeDate,
      dueDate: input.dueDate ?? null,
      referenceNo: input.referenceNo?.trim() || null,
      notes: input.notes?.trim() || null,
      totalAmount: input.totalAmount,
      revenueAccountCode: input.revenueAccountCode,
      createdBy: actor.personId,
    });

    const result = await postEntry(trx, {
      orgId: actor.orgId,
      entryDate: input.chargeDate,
      sourceType: 'ar_charge',
      sourceId: chargeId,
      idempotencyKey: `ar_charge:${chargeId}:post`,
      memo: `Credit sale — ${customer.name}`,
      postedBy: actor.personId,
      lines: [
        {
          accountCode: AR_CONTROL_CODE,
          storeId: input.storeId,
          debit: input.totalAmount,
          partyType: 'customer' as const,
          partyId: input.customerId,
          lineMemo: `Credit sale — ${customer.name}`,
        },
        {
          accountCode: input.revenueAccountCode,
          storeId: input.storeId,
          credit: input.totalAmount,
          lineMemo: `Credit sale — ${customer.name}`,
        },
      ],
    });

    if (result.created) await arRepo.markChargePosted(trx, actor.orgId, chargeId, { journalEntryId: result.entryId });
    return { chargeId, entryId: result.entryId, creditOverrideBy, creditOverrideReason };
  };
  if (tx) return run(tx);
  return transaction(run);
}

export async function voidCharge(
  tx: Tx | null,
  actor: Actor,
  input: { chargeId: string; reason: string },
): Promise<{ entryId: string }> {
  const run = async (trx: Tx) => {
    const charge = await arRepo.getChargeById(trx, actor.orgId, input.chargeId);
    if (!charge) throw new Error(`voidCharge: charge ${input.chargeId} does not exist.`);
    await authorize(trx, actor, 'approve_buyer', { storeId: charge.storeId });
    if (charge.status !== 'posted') throw new Error(`voidCharge: charge is ${charge.status}, not posted.`);
    if (!charge.journalEntryId) throw new Error('voidCharge: posted charge carries no journal entry.');
    const reason = input.reason.trim();
    if (!reason) throw new Error('voidCharge: say why this charge is being voided.');

    const result = await reverseEntry(trx, {
      entryId: charge.journalEntryId,
      reason,
      reversedBy: actor.personId,
    });
    if (result.created) {
      await arRepo.markChargeVoided(trx, actor.orgId, input.chargeId, {
        voidedBy: actor.personId,
        voidReason: reason,
      });
    }
    return { entryId: result.reversalEntryId };
  };
  if (tx) return run(tx);
  return transaction(run);
}

// -------------------------------------------------------------------------------------
// Collections
// -------------------------------------------------------------------------------------

export interface ArAllocationInput {
  chargeId: string;
  amountApplied: string;
}

export interface RecordCollectionInput {
  storeId: string;
  customerId: string;
  collectionDate: string;
  /** GROSS — what the receivable is relieved by. The bank receives this minus the fee. */
  amount: string;
  platformFee?: string;
  moneyAccountId: string;
  /** Required when the money arrived online. v1's rule, ported. */
  receiptFileId?: string | null;
  referenceNo?: string | null;
  notes?: string | null;
  allocations: ArAllocationInput[];
  /**
   * ⭐ T-179. Store credit spent against this collection instead of cash — mirrors T-170's
   * `recordPayment`/`creditApplied` on the AP side exactly, pointed the other way: `2140` is
   * drawn down instead of `1240`. ⚠️ `moneyAccountId` is still required even when this covers the
   * whole amount — `ar_collections.money_account_id` is NOT NULL, the same attribution-only
   * shape `ap_payments.money_account_id` already accepts for a fully-credit-funded payment.
   */
  creditApplied?: string;
}

export async function recordCollection(
  tx: Tx | null,
  actor: Actor,
  input: RecordCollectionInput,
): Promise<{ collectionId: string; entryId: string; allocated: string; surplus: string }> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'record_ar_collection', { storeId: input.storeId });

    const customer = await customersRepo.getById(trx, actor.orgId, input.customerId);
    if (!customer) throw new Error(`recordCollection: customer ${input.customerId} does not exist.`);

    const amount = Number(input.amount);
    const fee = Number(input.platformFee ?? '0');
    if (amount <= 0) throw new Error('recordCollection: a collection has to be greater than zero.');
    if (fee < 0) throw new Error('recordCollection: a platform fee cannot be negative.');
    if (fee > amount) {
      throw new Error(
        `recordCollection: a fee of ₱${input.platformFee} exceeds the ₱${input.amount} collected — ` +
          'that would clear the debt while receiving nothing.',
      );
    }
    if (input.allocations.length === 0) {
      throw new Error(
        'recordCollection: name at least one charge this settles (bible §16.10 — a collection ' +
          'must never float unallocated).',
      );
    }

    const account = await moneyAccountsRepo.getById(trx, actor.orgId, input.moneyAccountId);
    if (!account) throw new Error('recordCollection: that money account does not exist.');

    const creditApplied = Number(input.creditApplied ?? '0');
    if (creditApplied < 0) throw new Error('recordCollection: creditApplied cannot be negative.');
    if (creditApplied > 0) {
      const balance = Number(await arRepo.creditBalanceOf(trx, actor.orgId, input.customerId));
      if (creditApplied > balance + 0.005) {
        throw new Error(
          `recordCollection: ${customer.name} holds only ₱${balance.toFixed(2)} of store credit — ` +
            `₱${input.creditApplied} does not fit.`,
        );
      }
    }
    // ⭐ v1's real rule: proof is required when the money arrived online, never for cash. ⚠️ Only
    // when cash is actually moving — a fully credit-funded collection touches no account.
    if (creditApplied < amount - fee - 0.005 && account.instrument !== 'cash' && !input.receiptFileId) {
      throw new Error(
        'recordCollection: an online collection needs proof of payment — attach the deposit slip ' +
          'or transfer screenshot.',
      );
    }

    // ⛔ Lock before reading. AP's equivalent test passed on timing alone before its lock existed.
    await arRepo.lockChargesForAllocation(trx, actor.orgId, input.allocations.map((a) => a.chargeId));

    const open = await arRepo.openItems(trx, actor.orgId, input.customerId, input.storeId);
    const byCharge = new Map(open.map((o) => [o.chargeId, o]));
    let allocatedTotal = 0;
    for (const a of input.allocations) {
      const item = byCharge.get(a.chargeId);
      if (!item) {
        throw new Error(
          `recordCollection: charge ${a.chargeId} is not open for this customer at this store — ` +
            'it may belong to another customer or store, already be settled, or not be posted.',
        );
      }
      const applied = Number(a.amountApplied);
      if (applied <= 0) throw new Error(`recordCollection: allocation for ${a.chargeId} must be above zero.`);
      if (applied > Number(item.outstanding) + 0.005) {
        throw new Error(
          `recordCollection: charge ${a.chargeId} has only ₱${item.outstanding} outstanding — ` +
            `₱${a.amountApplied} does not fit.`,
        );
      }
      allocatedTotal += applied;
    }
    if (allocatedTotal > amount + 0.005) {
      throw new Error(
        `recordCollection: allocations total ₱${allocatedTotal.toFixed(2)}, more than the ` +
          `₱${input.amount} collected.`,
      );
    }

    const surplus = Math.max(0, amount - allocatedTotal);
    const net = amount - fee;
    if (creditApplied > net + 0.005) {
      throw new Error(
        `recordCollection: creditApplied (₱${input.creditApplied}) cannot exceed the ₱${net.toFixed(2)} ` +
          'the collection nets after its fee.',
      );
    }
    const cashPortion = net - creditApplied;

    /**
     * ⭐ POSTING-PATTERNS.md `ar_collection`, ported exactly, plus T-179's credit leg:
     *   Dr money account   cashPortion (net − creditApplied)   ← ONLY when there is one
     *   Dr 2140            creditApplied  party = customer     ← ONLY when there is one
     *   Dr 6400            fee            ← ONLY when there is one. Never a zero leg.
     *   Cr 1210            allocated      party = customer
     *   Cr 2140            surplus        party = customer, only when there is one
     */
    const lines = [
      ...(cashPortion > 0
        ? [
            {
              accountCode: account.glAccountCode,
              storeId: input.storeId,
              debit: cashPortion.toFixed(2),
              ...(account.glAccountCode === '1140'
                ? { partyType: 'money_account' as const, partyId: account.id }
                : {}),
              lineMemo: `Collection — ${customer.name}`,
            },
          ]
        : []),
      ...(creditApplied > 0
        ? [
            {
              accountCode: STORE_CREDIT_CODE,
              storeId: input.storeId,
              debit: creditApplied.toFixed(2),
              partyType: 'customer' as const,
              partyId: input.customerId,
              lineMemo: `Store credit applied — ${customer.name}`,
            },
          ]
        : []),
      ...(fee > 0
        ? [
            {
              accountCode: arRepo.PLATFORM_FEE_CODE,
              storeId: input.storeId,
              debit: fee.toFixed(2),
              lineMemo: `Platform fee — ${customer.name}`,
            },
          ]
        : []),
      {
        accountCode: AR_CONTROL_CODE,
        storeId: input.storeId,
        credit: allocatedTotal.toFixed(2),
        partyType: 'customer' as const,
        partyId: input.customerId,
        lineMemo: `Collection — ${customer.name}`,
      },
      ...(surplus > 0
        ? [
            {
              accountCode: STORE_CREDIT_CODE,
              storeId: input.storeId,
              credit: surplus.toFixed(2),
              partyType: 'customer' as const,
              partyId: input.customerId,
              lineMemo: `Overpayment held as store credit — ${customer.name}`,
            },
          ]
        : []),
    ];

    const { id: collectionId } = await arRepo.insertCollection(trx, {
      orgId: actor.orgId,
      storeId: input.storeId,
      customerId: input.customerId,
      collectionDate: input.collectionDate,
      amount: input.amount,
      platformFee: fee.toFixed(2),
      moneyAccountId: input.moneyAccountId,
      referenceNo: input.referenceNo?.trim() || null,
      notes: input.notes?.trim() || null,
      receiptFileId: input.receiptFileId ?? null,
      createdBy: actor.personId,
    });

    const result = await postEntry(trx, {
      orgId: actor.orgId,
      entryDate: input.collectionDate,
      sourceType: 'ar_collection',
      sourceId: collectionId,
      idempotencyKey: `ar_collection:${collectionId}:post`,
      memo: `Collection from ${customer.name}`,
      postedBy: actor.personId,
      lines,
    });

    if (result.created) {
      await arRepo.markCollectionPosted(trx, actor.orgId, collectionId, { journalEntryId: result.entryId });
      await arRepo.insertAllocations(
        trx,
        collectionId,
        input.allocations.map((a) => ({ chargeId: a.chargeId, amountApplied: a.amountApplied })),
      );
    }

    return {
      collectionId,
      entryId: result.entryId,
      allocated: allocatedTotal.toFixed(2),
      surplus: surplus.toFixed(2),
    };
  };
  if (tx) return run(tx);
  return transaction(run);
}

/** Reversal, never deletion. The allocations stay so the charge correctly reopens. */
export async function voidCollection(
  tx: Tx | null,
  actor: Actor,
  input: { collectionId: string; reason: string },
): Promise<{ entryId: string }> {
  const run = async (trx: Tx) => {
    const collection = await arRepo.getCollectionById(trx, actor.orgId, input.collectionId);
    if (!collection) throw new Error(`voidCollection: collection ${input.collectionId} does not exist.`);
    await authorize(trx, actor, 'record_ar_collection', { storeId: collection.storeId });
    if (collection.status !== 'posted') throw new Error(`voidCollection: it is ${collection.status}, not posted.`);
    if (!collection.journalEntryId) throw new Error('voidCollection: posted collection carries no journal entry.');
    const reason = input.reason.trim();
    if (!reason) throw new Error('voidCollection: say why this collection is being voided.');

    const result = await reverseEntry(trx, {
      entryId: collection.journalEntryId,
      reason,
      reversedBy: actor.personId,
    });
    if (result.created) {
      await arRepo.markCollectionVoided(trx, actor.orgId, input.collectionId, {
        voidedBy: actor.personId,
        voidReason: reason,
      });
    }
    return { entryId: result.reversalEntryId };
  };
  if (tx) return run(tx);
  return transaction(run);
}

// -------------------------------------------------------------------------------------
// Write-off
// -------------------------------------------------------------------------------------

/**
 * ⛔ **Admin only, and never by the charge's own author.**
 *
 * v1 makes write-off admin-only — stricter than its manager-level void — and that part is ported.
 * What v1 has NO check for anywhere in AR is identity: nothing compares the actor to the person
 * who created the record. Writing off your own receivable is how a shortfall gets buried, so the
 * second-party control T-130 added to invoice verification applies here too.
 */
export async function writeOffCharge(
  tx: Tx | null,
  actor: Actor,
  input: { chargeId: string; amount: string; reason: string },
): Promise<{ writeOffId: string; entryId: string }> {
  const run = async (trx: Tx) => {
    const charge = await arRepo.getChargeById(trx, actor.orgId, input.chargeId);
    if (!charge) throw new Error(`writeOffCharge: charge ${input.chargeId} does not exist.`);
    await authorize(trx, actor, 'write_off_receivable', { storeId: charge.storeId });

    if (charge.createdBy === actor.personId) {
      throw new Error(
        'writeOffCharge: you recorded this charge, so you cannot also write it off. Declaring a ' +
          'debt uncollectible needs a second pair of eyes — ask another admin.',
      );
    }
    if (charge.status !== 'posted') throw new Error(`writeOffCharge: charge is ${charge.status}, not posted.`);

    const reason = input.reason.trim();
    if (!reason) throw new Error('writeOffCharge: say why this is uncollectible.');
    const amount = Number(input.amount);
    if (amount <= 0) throw new Error('writeOffCharge: a write-off has to be greater than zero.');

    const open = await arRepo.openItems(trx, actor.orgId, charge.customerId, charge.storeId);
    const item = open.find((o) => o.chargeId === charge.id);
    if (!item) throw new Error('writeOffCharge: that charge has nothing left outstanding.');
    if (amount > Number(item.outstanding) + 0.005) {
      throw new Error(
        `writeOffCharge: only ₱${item.outstanding} is outstanding — ₱${input.amount} is more than that.`,
      );
    }

    const customer = await customersRepo.getById(trx, actor.orgId, charge.customerId);
    const result = await postEntry(trx, {
      orgId: actor.orgId,
      entryDate: charge.chargeDate,
      sourceType: 'ar_write_off',
      sourceId: charge.id,
      // ⚠️ Partial write-offs repeat on one charge, so the key carries the amount and the actor —
      // two identical keys would silently collapse into one posting.
      idempotencyKey: `ar_write_off:${charge.id}:${amount.toFixed(2)}:${actor.personId}`,
      memo: `Bad debt — ${customer?.name ?? charge.customerId}`,
      postedBy: actor.personId,
      lines: [
        {
          accountCode: arRepo.BAD_DEBT_CODE,
          storeId: charge.storeId,
          debit: amount.toFixed(2),
          lineMemo: reason,
        },
        {
          accountCode: AR_CONTROL_CODE,
          storeId: charge.storeId,
          credit: amount.toFixed(2),
          partyType: 'customer' as const,
          partyId: charge.customerId,
          lineMemo: reason,
        },
      ],
    });

    const { id: writeOffId } = await arRepo.insertWriteOff(trx, {
      orgId: actor.orgId,
      arChargeId: charge.id,
      amount: amount.toFixed(2),
      reason,
      journalEntryId: result.entryId,
      writtenOffBy: actor.personId,
    });
    return { writeOffId, entryId: result.entryId };
  };
  if (tx) return run(tx);
  return transaction(run);
}
