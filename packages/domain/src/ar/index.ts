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
import { arRepo, customersRepo, journalRepo, moneyAccountsRepo, transaction, type Tx } from '@shareat/db';
import { authorize, AuthorizationError, type Actor } from '@shareat/auth';
import { add, compare, money, subtract, ZERO, type Money } from '@shareat/core/money';
import { logger } from '@shareat/core/logger';
import { postEntry } from '../ledger/post-entry';
import { authorizeOtherStores, withInterStoreLegs } from '../ledger/inter-store';
import { reverseEntry } from '../ledger/reverse-entry';
import { parseDecimalInput, parseMoneyInput } from '../shared/money-input';
import { refuse } from '../shared/refusal';
import { allocateOldestFirst, type AllocationItem, type TypedAmount } from '../shared/allocate-oldest-first';

export const AR_CONTROL_CODE = arRepo.AR_CONTROL_CODE;
export const STORE_CREDIT_CODE = arRepo.STORE_CREDIT_CODE;

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
    const totalAmount = parseMoneyInput(input.totalAmount, 'recordCharge: the charge amount', 'The charge amount');
    // T-371 C4 — ordered in scaled bigint on the branded value, never `Number()` (NaN-blind).
    if (compare(totalAmount, ZERO) <= 0) {
      throw new Error('recordCharge: a charge has to be greater than zero.');
    }

    // ⛔ ONE gate, here, because this is the one act that creates AR exposure — every caller
    // (trade orders today, anything else tomorrow) goes through it.
    let creditOverrideBy: string | null = null;
    let creditOverrideReason: string | null = null;
    if (customer.creditLimit !== null) {
      // ⚠️ Derived from the ledger, never a stored balance — org-wide, because a credit limit is
      // extended to a BUYER, not to a buyer at one branch.
      // T-371 R4/C4 — the ledger figure and the stored limit are re-minted and compared exactly; on 2dp values the old
      // `+ 0.005` tolerance decided nothing an exact comparison does not.
      const controlBalance = money((await arRepo.positionOf(trx, actor.orgId, input.customerId)).controlBalance);
      const after = add(controlBalance, totalAmount);
      if (compare(after, money(customer.creditLimit)) > 0) {
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
              `₱${totalAmount}, which would take them to ₱${after} against a ` +
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
      totalAmount,
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
          debit: totalAmount,
          partyType: 'customer' as const,
          partyId: input.customerId,
          lineMemo: `Credit sale — ${customer.name}`,
        },
        {
          accountCode: input.revenueAccountCode,
          storeId: input.storeId,
          credit: totalAmount,
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

/**
 * DEF-546 (T-364 Q1 (a) shape, same as `writeOffCharge`'s `CHARGE_OUT_OF_REACH`) — the ONE sentence
 * an unauthorised caller gets for a charge id, whether it exists and is out of reach or does not
 * exist at all.
 */
const CHARGE_VOID_OUT_OF_REACH = 'That charge does not exist, or it is not at a store where you may void it.';

export async function voidCharge(
  tx: Tx | null,
  actor: Actor,
  input: { chargeId: string; reason: string },
): Promise<{ entryId: string }> {
  const run = async (trx: Tx) => {
    // DEF-546 — see `writeOffCharge`'s identical comment: the lookup stays first for the gate's
    // store, but a missing charge and one the caller may not act on surface as ONE refusal.
    const charge = await arRepo.getChargeById(trx, actor.orgId, input.chargeId);
    if (!charge) {
      const raw = `voidCharge: no charge ${input.chargeId} in org ${actor.orgId}`;
      logger.warn({ chargeId: input.chargeId, actorOrgId: actor.orgId }, raw);
      throw new AuthorizationError(raw, 'approve_buyer', CHARGE_VOID_OUT_OF_REACH);
    }
    try {
      await authorize(trx, actor, 'approve_buyer', { storeId: charge.storeId });
    } catch (err) {
      if (err instanceof AuthorizationError) {
        logger.warn({ chargeId: input.chargeId, err }, `voidCharge: ${err.message}`);
        const uniform = new AuthorizationError(`voidCharge: ${err.message}`, 'approve_buyer', CHARGE_VOID_OUT_OF_REACH);
        uniform.cause = err;
        throw uniform;
      }
      throw err;
    }
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

    // T-328/DEF-382 — this file's OWN `recordCharge` (above, `parseMoneyInput` at its own site)
    // already routes through the parser; this function, `recordCollection`, did not: `amount`,
    // `platformFee` and `creditApplied` were bare `Number()`, and `Number('abc') <= 0` is `false`,
    // so a mistyped figure passed every guard below silently. Parsing first turns that into the
    // parser's own readable refusal, same as every other converted site in this task.
    // T-371 R6 — `ar_collections.platform_fee` is NOT NULL DEFAULT '0': a blank or absent fee is omitted (no fee),
    // never a typed '0'. `ZERO` below is only the arithmetic for "no fee leg" (C4: every order below is exact).
    const amount = parseMoneyInput(input.amount, 'recordCollection: the amount', 'The amount collected');
    const parsedFee = parseDecimalInput(input.platformFee, '14,2', 'recordCollection: the platform fee', 'The platform fee', {
      blank: 'omit',
    });
    const fee: Money = parsedFee ?? ZERO;
    if (compare(amount, ZERO) <= 0) throw new Error('recordCollection: a collection has to be greater than zero.');
    if (compare(fee, ZERO) < 0) throw new Error('recordCollection: a platform fee cannot be negative.');
    if (compare(fee, amount) > 0) {
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
    // T-371 — store credit applied is no column (a journal leg only); absent or blank means none applied.
    const creditApplied: Money =
      parseDecimalInput(input.creditApplied, '14,2', 'recordCollection: creditApplied', 'The store credit applied', {
        blank: 'omit',
      }) ?? ZERO;
    // T-343 S5.5p / DEF-461 — was a plain, developer-worded Error. DEF-457/S5.5n's app-layer fix
    // (`customers/actions.ts`'s `creditApplied ? { creditApplied } : {}`, no positivity test) forwards
    // a negative credit for real now, so this needed a presentable sentence too. Raw byte-identical.
    if (compare(creditApplied, ZERO) < 0) {
      throw refuse('recordCollection: creditApplied cannot be negative.', 'The store credit applied cannot be negative.');
    }
    // T-369 S8b (DEF-556): collecting INTO another store's account moves money there, so it needs the right to
    // move money THERE - the same gate `payReimbursement`, `approveExpense` and `recordPayment` apply. ONLY when cash
    // actually lands in the account: a fully credit-funded collection (`trade/returns.ts` applyCredit) touches no
    // account, and the cash portion is `amount - fee - creditApplied`, already known here from the parsed input.
    // Before the credit-balance read and the charge lock, so a non-holder reads and waits on nothing.
    const net = subtract(amount, fee);
    const cashPortion = subtract(net, creditApplied);
    const cashMoves = compare(cashPortion, ZERO) > 0;
    if (account.storeId !== input.storeId && cashMoves) {
      await authorize(trx, actor, 'transfer_funds', { storeId: account.storeId });
    }
    if (compare(creditApplied, ZERO) > 0) {
      const balance = money(await arRepo.creditBalanceOf(trx, actor.orgId, input.customerId));
      if (compare(creditApplied, balance) > 0) {
        throw new Error(
          `recordCollection: ${customer.name} holds only ₱${balance} of store credit — ` +
            `₱${input.creditApplied} does not fit.`,
        );
      }
    }
    // ⭐ v1's real rule: proof is required when the money arrived online, never for cash. ⚠️ Only
    // when cash is actually moving — a fully credit-funded collection touches no account.
    if (cashMoves && account.instrument !== 'cash' && !input.receiptFileId) {
      throw new Error(
        'recordCollection: an online collection needs proof of payment — attach the deposit slip ' +
          'or transfer screenshot.',
      );
    }

    // T-328/DEF-382 — parsed here, once, before any lock or read, same pattern `recordPayment`
    // already uses for its own allocations: every downstream use sees the same validated value,
    // never the raw form, and a malformed one throws before a lock is even taken.
    const allocations = input.allocations.map((a) => {
      // T-343 S5.5n / DEF-459 — logged before rethrowing: a malformed allocation amount is a
      // real-world typo worth seeing in the logs, not only on the screen the throw already reaches.
      let amountApplied: ReturnType<typeof parseMoneyInput>;
      try {
        amountApplied = parseMoneyInput(
          a.amountApplied,
          `recordCollection: the allocation for charge ${a.chargeId}`,
          'An amount applied to a charge',
        );
      } catch (err) {
        logger.info({ err }, 'recordCollection: malformed allocation amount');
        throw err;
      }
      return { chargeId: a.chargeId, amountApplied };
    });

    // ⛔ Lock before reading. AP's equivalent test passed on timing alone before its lock existed.
    await arRepo.lockChargesForAllocation(trx, actor.orgId, allocations.map((a) => a.chargeId));

    const open = await arRepo.openItems(trx, actor.orgId, input.customerId, input.storeId);
    const byCharge = new Map(open.map((o) => [o.chargeId, o]));
    let allocatedTotal: Money = ZERO;
    for (const a of allocations) {
      const item = byCharge.get(a.chargeId);
      if (!item) {
        throw new Error(
          `recordCollection: charge ${a.chargeId} is not open for this customer at this store — ` +
            'it may belong to another customer or store, already be settled, or not be posted.',
        );
      }
      const applied = a.amountApplied;
      if (compare(applied, ZERO) <= 0) throw new Error(`recordCollection: allocation for ${a.chargeId} must be above zero.`);
      if (compare(applied, money(item.outstanding)) > 0) {
        throw new Error(
          `recordCollection: charge ${a.chargeId} has only ₱${item.outstanding} outstanding — ` +
            `₱${a.amountApplied} does not fit.`,
        );
      }
      allocatedTotal = add(allocatedTotal, applied);
    }
    if (compare(allocatedTotal, amount) > 0) {
      throw new Error(
        `recordCollection: allocations total ₱${allocatedTotal}, more than the ` +
          `₱${input.amount} collected.`,
      );
    }

    const surplus = compare(amount, allocatedTotal) > 0 ? subtract(amount, allocatedTotal) : ZERO;
    if (compare(creditApplied, net) > 0) {
      throw new Error(
        `recordCollection: creditApplied (₱${input.creditApplied}) cannot exceed the ₱${net} ` +
          'the collection nets after its fee.',
      );
    }

    /**
     * ⭐ POSTING-PATTERNS.md `ar_collection`, ported exactly, plus T-179's credit leg:
     *   Dr money account   cashPortion (net − creditApplied)   ← ONLY when there is one
     *   Dr 2140            creditApplied  party = customer     ← ONLY when there is one
     *   Dr 6400            fee            ← ONLY when there is one. Never a zero leg.
     *   Cr 1210            allocated      party = customer
     *   Cr 2140            surplus        party = customer, only when there is one
     */
    const collectionLines = [
      ...(cashMoves
        ? [
            {
              accountCode: account.glAccountCode,
              // T-369 S8b: the cash debit sits at the ACCOUNT's store - `balanceOf` reads a safe there.
              storeId: account.storeId,
              debit: cashPortion,
              ...(account.glAccountCode === '1140'
                ? { partyType: 'money_account' as const, partyId: account.id }
                : {}),
              lineMemo: `Collection — ${customer.name}`,
            },
          ]
        : []),
      ...(compare(creditApplied, ZERO) > 0
        ? [
            {
              accountCode: STORE_CREDIT_CODE,
              storeId: input.storeId,
              debit: creditApplied,
              partyType: 'customer' as const,
              partyId: input.customerId,
              lineMemo: `Store credit applied — ${customer.name}`,
            },
          ]
        : []),
      ...(compare(fee, ZERO) > 0
        ? [
            {
              accountCode: arRepo.PLATFORM_FEE_CODE,
              storeId: input.storeId,
              debit: fee,
              lineMemo: `Platform fee — ${customer.name}`,
            },
          ]
        : []),
      {
        accountCode: AR_CONTROL_CODE,
        storeId: input.storeId,
        credit: allocatedTotal,
        partyType: 'customer' as const,
        partyId: input.customerId,
        lineMemo: `Collection — ${customer.name}`,
      },
      ...(compare(surplus, ZERO) > 0
        ? [
            {
              accountCode: STORE_CREDIT_CODE,
              storeId: input.storeId,
              credit: surplus,
              partyType: 'customer' as const,
              partyId: input.customerId,
              lineMemo: `Overpayment held as store credit — ${customer.name}`,
            },
          ]
        : []),
    ];
    // A collection into another store's account gains the 1250/2150 pair for the CASH portion only (the credit
    // applied, the fee and the receivable never touched that account). `ar_collections.store_id` stays
    // `input.storeId`: the collection belongs to the owing store's receivables.
    const lines = await withInterStoreLegs(trx, actor.orgId, {
      owingStoreId: input.storeId,
      memo: `Collection from ${customer.name}`,
      lines: collectionLines,
    });

    const { id: collectionId } = await arRepo.insertCollection(trx, {
      orgId: actor.orgId,
      storeId: input.storeId,
      customerId: input.customerId,
      collectionDate: input.collectionDate,
      // T-328 — the validated, normalised value, same as `platformFee` immediately below (was
      // `input.amount`, the raw un-normalised form the parser had already validated but not
      // reshaped).
      amount,
      platformFee: parsedFee, // R13: a blank is omitted, so the column default applies
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
        // T-328 — the parsed array, not `input.allocations`: same reasoning as `createRemittance`
        // storing `String(declared)` rather than the raw form (packages/domain/src/remittance/index.ts).
        allocations.map((a) => ({ chargeId: a.chargeId, amountApplied: a.amountApplied })),
      );
    }

    return {
      collectionId,
      entryId: result.entryId,
      allocated: allocatedTotal,
      surplus,
    };
  };
  if (tx) return run(tx);
  return transaction(run);
}

/** Reversal, never deletion. The allocations stay so the charge correctly reopens. */
/**
 * DEF-546 (T-364 Q1 (a) shape, same as `writeOffCharge`'s `CHARGE_OUT_OF_REACH`) — the ONE sentence
 * an unauthorised caller gets for a collection id, whether it exists and is out of reach or does
 * not exist at all.
 */
const COLLECTION_VOID_OUT_OF_REACH = 'That collection does not exist, or it is not at a store where you may void it.';

export async function voidCollection(
  tx: Tx | null,
  actor: Actor,
  input: { collectionId: string; reason: string },
): Promise<{ entryId: string }> {
  const run = async (trx: Tx) => {
    // DEF-546 — see `writeOffCharge`'s identical comment: the lookup stays first for the gate's
    // store, but a missing collection and one the caller may not act on surface as ONE refusal.
    const collection = await arRepo.getCollectionById(trx, actor.orgId, input.collectionId);
    if (!collection) {
      const raw = `voidCollection: no collection ${input.collectionId} in org ${actor.orgId}`;
      logger.warn({ collectionId: input.collectionId, actorOrgId: actor.orgId }, raw);
      throw new AuthorizationError(raw, 'record_ar_collection', COLLECTION_VOID_OUT_OF_REACH);
    }
    try {
      await authorize(trx, actor, 'record_ar_collection', { storeId: collection.storeId });
    } catch (err) {
      if (err instanceof AuthorizationError) {
        logger.warn({ collectionId: input.collectionId, err }, `voidCollection: ${err.message}`);
        const uniform = new AuthorizationError(`voidCollection: ${err.message}`, 'record_ar_collection', COLLECTION_VOID_OUT_OF_REACH);
        uniform.cause = err;
        throw uniform;
      }
      throw err;
    }
    // T-369 S9 A1 (DEF-573): reversing a collection that landed in ANOTHER store's account moves that store's money
    // again, so the void needs `transfer_funds` there too. After the uniform-refusal block above (its own refusal
    // keeps its one sentence; this gate must not be wrapped by it) and before any status refusal.
    if (collection.journalEntryId) {
      await authorizeOtherStores(trx, actor, {
        lines: await journalRepo.findLinesForEntryWithAccountCodes(trx, collection.journalEntryId),
        documentStoreId: collection.storeId,
      });
    }
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
 * ⛔ **Admin or manager, store-scoped — `write_off_receivable` (CAPABILITY-MATRIX) — and never by
 * the charge's own author.**
 *
 * What v1 has NO check for anywhere in AR is identity: nothing compares the actor to the person
 * who created the record. Writing off your own receivable is how a shortfall gets buried, so the
 * second-party control T-130 added to invoice verification applies here too.
 *
 * T-367 / DEF-201 / DEF-517 / DEF-520 (R1, R3, R8):
 * - **R3** — the charge row is LOCKED (`lockChargesForAllocation`) right after `authorize`, before
 *   anything reads what is owed, so two different write-offs on one charge (DEF-517) serialise with
 *   each other and with `recordCollection` on the same charge, instead of both reading a
 *   pre-write-off outstanding figure and together clearing more than is owed.
 * - **R1** — the idempotency key is looked up AFTER the lock but BEFORE the outstanding cap: a
 *   double-click (DEF-201) must resolve as a harmless retry even when the SAME amount would now
 *   exceed what the first write-off already left outstanding — meeting the cap instead of the retry
 *   would tell a double-click "only ₱X is outstanding" rather than "already recorded".
 * - **R8** — the amount is parsed once, with `parseMoneyInput`, so a non-numeric amount (DEF-520,
 *   `Number()` was NaN-blind) is refused in a plain sentence instead of reaching Postgres as a raw
 *   23514/22P02.
 */
/**
 * T-367 S1 audit finding 4 — the ONE sentence an unauthorised caller gets for a charge id, whether
 * the id exists and is out of reach or does not exist at all (the DEF-497 oracle shape; T-364 Q1
 * (a): one uniform refusal).
 */
const CHARGE_OUT_OF_REACH = 'That charge does not exist, or it is not at a store where you may write off receivables.';

export async function writeOffCharge(
  tx: Tx | null,
  actor: Actor,
  input: { chargeId: string; amount: string; reason: string },
): Promise<{ writeOffId: string; entryId: string; alreadyRecorded: boolean }> {
  const run = async (trx: Tx) => {
    // T-367 S1 audit finding 4 — the lookup stays first because it supplies the gate's store, but a
    // missing charge and one the caller may not act on both surface as ONE refusal (AuthorizationError,
    // same userMessage), so the reply cannot be used to probe ids. The real diagnosis goes to the
    // server log (never the screen) and rides on `cause`.
    const charge = await arRepo.getChargeById(trx, actor.orgId, input.chargeId);
    if (!charge) {
      const raw = `writeOffCharge: no charge ${input.chargeId} in org ${actor.orgId}`;
      logger.warn({ chargeId: input.chargeId, actorOrgId: actor.orgId }, raw);
      throw new AuthorizationError(raw, 'write_off_receivable', CHARGE_OUT_OF_REACH);
    }
    try {
      await authorize(trx, actor, 'write_off_receivable', { storeId: charge.storeId });
    } catch (err) {
      if (err instanceof AuthorizationError) {
        logger.warn({ chargeId: input.chargeId, err }, `writeOffCharge: ${err.message}`);
        const uniform = new AuthorizationError(`writeOffCharge: ${err.message}`, 'write_off_receivable', CHARGE_OUT_OF_REACH);
        uniform.cause = err;
        throw uniform;
      }
      throw err;
    }

    // T-367 S1 audit finding 3 — the self-author refusal sits BEFORE the lock, so a refused caller
    // never waits on it ("the charge's own author (X) is refused immediately (without waiting)
    // while A holds the lock", t367-s1-write-off-once.test.ts, pins this).
    if (charge.createdBy === actor.personId) {
      throw new Error(
        'writeOffCharge: you recorded this charge, so you cannot also write it off. Declaring a ' +
          'debt uncollectible needs a second pair of eyes — ask another admin.',
      );
    }

    // ⛔ T-367 / DEF-517 (R3) — lock BEFORE re-reading what is owed, then re-read: a write-off that
    // was waiting on this lock must see whatever the lock-holder just committed, not a stale row.
    await arRepo.lockChargesForAllocation(trx, actor.orgId, [charge.id]);
    const locked = await arRepo.getChargeById(trx, actor.orgId, input.chargeId);
    // ⛔ Unreachable in practice (a charge already confirmed to exist, moments earlier, in this SAME
    // transaction, is never deleted) — `refuse`, not a new raw throw (T-343 ratchet, packages/domain
    // stays at its ceiling).
    if (!locked) {
      throw refuse(
        `writeOffCharge: charge ${input.chargeId} vanished between its first read and the lock.`,
        'Something went wrong loading this charge. Try again, or contact support if it keeps happening.',
      );
    }

    if (locked.status !== 'posted') throw new Error(`writeOffCharge: charge is ${locked.status}, not posted.`);

    const reason = input.reason.trim();
    if (!reason) throw new Error('writeOffCharge: say why this is uncollectible.');
    const amount = parseMoneyInput(input.amount, 'writeOffCharge: the amount', 'The write-off amount');
    if (compare(amount, ZERO) <= 0) throw new Error('writeOffCharge: a write-off has to be greater than zero.');

    // ⛔ T-367 / DEF-201 (R1) — the retry check comes BEFORE the outstanding cap: a double-click of
    // an amount that would now exceed what is left outstanding must still resolve as a retry, not
    // meet the cap sentence (W1b).
    const idempotencyKey = `ar_write_off:${locked.id}:${amount}:${actor.personId}`;
    const existing = await journalRepo.findEntryByIdempotencyKey(trx, actor.orgId, idempotencyKey);
    if (existing) {
      const writeOff = await arRepo.getWriteOffByEntryId(trx, actor.orgId, existing.id);
      if (writeOff) return { writeOffId: writeOff.id, entryId: existing.id, alreadyRecorded: true };
    }

    const open = await arRepo.openItems(trx, actor.orgId, locked.customerId, locked.storeId);
    const item = open.find((o) => o.chargeId === locked.id);
    if (!item) throw new Error('writeOffCharge: that charge has nothing left outstanding.');
    if (compare(amount, money(item.outstanding)) > 0) {
      throw new Error(
        `writeOffCharge: only ₱${item.outstanding} is outstanding — ₱${input.amount} is more than that.`,
      );
    }

    const customer = await customersRepo.getById(trx, actor.orgId, locked.customerId);
    const result = await postEntry(trx, {
      orgId: actor.orgId,
      entryDate: locked.chargeDate,
      sourceType: 'ar_write_off',
      sourceId: locked.id,
      // ⚠️ Partial write-offs repeat on one charge, so the key carries the amount and the actor —
      // two identical keys would silently collapse into one posting. `amount` is already rendered
      // to 2dp by `parseMoneyInput` (a `Money` string), byte-equal to the lookup key above.
      idempotencyKey,
      memo: `Bad debt — ${customer?.name ?? locked.customerId}`,
      postedBy: actor.personId,
      lines: [
        {
          accountCode: arRepo.BAD_DEBT_CODE,
          storeId: locked.storeId,
          debit: amount,
          lineMemo: reason,
        },
        {
          accountCode: AR_CONTROL_CODE,
          storeId: locked.storeId,
          credit: amount,
          partyType: 'customer' as const,
          partyId: locked.customerId,
          lineMemo: reason,
        },
      ],
    });

    // ⛔ Bible §15.11 — `postEntry`'s OWN idempotency check is the second layer beyond the lookup
    // above: if it still found the entry first (an edge this lock should make unreachable), read
    // the write-off row back rather than inserting a second one.
    if (!result.created) {
      const writeOff = await arRepo.getWriteOffByEntryId(trx, actor.orgId, result.entryId);
      if (writeOff) return { writeOffId: writeOff.id, entryId: result.entryId, alreadyRecorded: true };
    }
    const { id: writeOffId } = await arRepo.insertWriteOff(trx, {
      orgId: actor.orgId,
      arChargeId: locked.id,
      amount,
      reason,
      journalEntryId: result.entryId,
      writtenOffBy: actor.personId,
    });
    return { writeOffId, entryId: result.entryId, alreadyRecorded: false };
  };
  if (tx) return run(tx);
  return transaction(run);
}

// -------------------------------------------------------------------------------------
// T-330 — auto-allocation SUGGESTION, the AR mirror.
// -------------------------------------------------------------------------------------

/**
 * Ordering keys for one open AR charge, keyed by its id.
 * ⭐ Unlike AP, AR needs no grain correction: the allocation grain IS `ar_charges.id`. ⛔ AMENDMENT
 * 4 found AR shares AP's `created_at` defect rather than being exempt from it — `ar_charges.
 * created_at` is also `defaultNow()` (`packages/db/schema/ar.ts:64`), identical for every row one
 * transaction writes, so it CANNOT be what makes the sort total and must not be added as a key.
 * `chargeId` (`uuidv7()` — unique and creation-ordered) is the sort's real, always-deciding final
 * key, which `allocateOldestFirst` uses as the item's `id`. `referenceNo` is AR's equivalent of
 * Ian's invoice-number tie-break — a reference, not an invoice number, and nullable.
 */
export interface ArOrderingKeys {
  readonly chargeId: string;
  /** `ar_charges.due_date` — NULLABLE, handed in RAW. */
  readonly dueDate: string | null;
  /** `ar_charges.charge_date` — NOT NULL. The pure module resolves the fallback. */
  readonly chargeDate: string;
  readonly referenceNo: string | null;
}

export interface SuggestArAllocationResult {
  readonly allocations: ArAllocationInput[];
  readonly surplus: string;
}

/**
 * Suggests an oldest-first allocation of `amount` across `open`, via the pure
 * `allocateOldestFirst`. Never posts anything.
 *
 * ⛔ WRITES NOTHING (invariant 5); `recordCollection` commits and already books a genuine
 * overpayment as `surplus` (DEF-394-sanctioned, `:306`). ⛔ `open` is PASSED IN, never queried
 * here. Gated by `authorize(...)` on `record_ar_collection` — `AuthorizationError` is already
 * imported in this file, and the TESTER's case 5 asserts on that exact class.
 */
export async function suggestCollectionAllocation(
  tx: Tx | null,
  actor: Actor,
  storeId: string,
  amount: string,
  open: Awaited<ReturnType<typeof arRepo.openItems>>,
  keys: readonly ArOrderingKeys[],
  /** ⭐ Amounts the operator ALREADY TYPED. Ian's ruling 2: fill only the EMPTY boxes — these
   *  are skipped, the payment available is reduced by their sum, and a sum exceeding the payment
   *  is refused. Defaults to empty, so existing call sites are unaffected. AMENDMENT 7. */
  typed: readonly TypedAmount[] = [],
): Promise<SuggestArAllocationResult> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'record_ar_collection', { storeId });

    for (const o of open) {
      if (o.storeId !== storeId) {
        throw new Error(
          `suggestCollectionAllocation: charge ${o.chargeId} belongs to store ${o.storeId}, not ` +
            `${storeId} — refusing to propose an allocation outside the collection's own store.`,
        );
      }
    }

    const keyByChargeId = new Map(keys.map((k) => [k.chargeId, k]));
    const items: AllocationItem[] = open.map((o) => {
      const key = keyByChargeId.get(o.chargeId);
      if (!key) {
        throw new Error(
          `suggestCollectionAllocation: charge ${o.chargeId} is open but has no ordering key — ` +
            'cannot sort it safely.',
        );
      }
      return {
        id: o.chargeId,
        dueDate: key.dueDate,
        documentDate: key.chargeDate,
        tieBreak: key.referenceNo,
        outstanding: money(o.outstanding),
      };
    });

    const plan = allocateOldestFirst(items, parseMoneyInput(amount, 'suggestCollectionAllocation: the amount', 'The amount collected'), typed);
    return {
      allocations: plan.allocations.map((a) => ({ chargeId: a.id, amountApplied: a.amount })),
      surplus: plan.remainder,
    };
  };
  if (tx) return run(tx);
  return transaction(run);
}
