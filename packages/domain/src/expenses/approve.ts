/**
 * approveExpense — the posting step. docs/tasks/122-expenses.md §2, §5, §6.
 *
 * "create · approve · void, posting via postEntry" (Scope) — approve IS the post: there
 * is no separate fourth verb. It is also where every routing invariant (6-10) runs — a draft
 * may sit with an unmapped category or an unmapped payment method; only approving it is
 * blocked. (The former receipt-photo gate, invariant 11/DEF-055, relocated to
 * `supplier_invoices` at T-130 — see this file's comment at the old gate's site.)
 *
 * `idempotencyKey = expense:{id}:post`, exactly as the spec names it. Re-approving an
 * already-posted expense is a safe no-op (invariant 4) — this function short-circuits
 * before even loading the category/payments, mirroring `postEntry`'s own "idempotency
 * checked first" philosophy.
 */
import { authorize, type Actor } from '@shareat/auth';
import { apRepo, expensesRepo, journalRepo, moneyAccountsRepo, ownersRepo, transaction, type Tx } from '@shareat/db';
import type { PeriodOverrideReason } from '@shareat/db/schema';
import { add, money, ZERO, type Money } from '@shareat/core/money';
import { checkDraw } from '../money-accounts/overdraft';
import { postEntry } from '../ledger/post-entry';
import { withInterStoreLegs } from '../ledger/inter-store';
import { routeExpense } from './routing';
import { capitalizeApprovedExpense } from '../fixed-assets/capitalize';
import { refuse, gone, internalFault } from '../shared/refusal';

export interface ApproveExpenseResult {
  journalEntryId: string;
  /** false means this expense was already posted — nothing new was written. */
  created: boolean;
  /** The fixed asset this CAPEX expense was capitalised into, if it cleared the threshold.
   *  `null` for every non-CAPEX expense, and for a CAPEX one below the threshold — which is a
   *  normal outcome, not a failure (T-124 §6). */
  assetId?: string | null;
  /** ⚠️ Present when a CASHIER account could not cover its share but the posting was allowed
   *  anyway — the till holds money the ledger cannot see until the day is verified (bible row
   *  154). The caller MUST surface these: a warning nobody sees is v1's disease. */
  warnings?: string[];
}

/** T-369 S5b (DEF-314): post this one approval into a CLOSED month. Authorised inside `postEntry` against `actor`. */
interface ApproveExpenseOptions {
  periodOverride?: { reason: PeriodOverrideReason; note?: string | null };
  /**
   * The caller is a path that CANNOT carry an override (verifying a bill posts its draft expenses). A closed or
   * locked month is then refused with a sentence that names only what that person can actually do.
   */
  noPeriodOverride?: boolean;
}

/** "January 2026" - the month a fiscal period covers, for a sentence a person reads. */
function monthLabel(startsOn: string): string {
  return new Date(`${startsOn}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

export async function approveExpense(
  tx: Tx | null,
  actor: Actor,
  expenseId: string,
  options?: ApproveExpenseOptions,
): Promise<ApproveExpenseResult> {
  if (tx) return runApproveExpense(tx, actor, expenseId, options);
  return transaction((trx) => runApproveExpense(trx, actor, expenseId, options));
}

async function runApproveExpense(
  tx: Tx,
  actor: Actor,
  expenseId: string,
  options?: ApproveExpenseOptions,
): Promise<ApproveExpenseResult> {
  // Org-scoped read before authorize() — see edit.ts's identical comment: the capability
  // is store-scoped and the store is a property of the resource itself.
  let expense = await expensesRepo.getExpenseById(tx, actor.orgId, expenseId);
  if (!expense) {
    throw gone(`approveExpense: expense ${expenseId} does not exist in org ${actor.orgId}`, 'expense');
  }

  await authorize(tx, actor, 'approve_expense', { storeId: expense.storeId });

  // ⭐ T-367 S2 / R4 (DEF-396) — lock the invoice BEFORE re-reading the expense's own status. A
  // concurrent voidInvoice (lockInvoiceForUpdate) or another approveExpense on the SAME invoice
  // serialises here; the re-read right after is what makes a double-approve resolve as the
  // existing `created: false` retry below rather than a second posting.
  await apRepo.lockInvoiceForRecording(tx, actor.orgId, expense.supplierInvoiceId);
  expense = await expensesRepo.getExpenseById(tx, actor.orgId, expenseId);
  if (!expense) {
    throw internalFault(`approveExpense: expense ${expenseId} vanished between its first read and the lock`);
  }

  if (expense.status === 'posted') {
    if (!expense.journalEntryId) {
      throw internalFault(`approveExpense: expense ${expenseId} is posted but carries no journalEntryId — data inconsistency`);
    }
    return { journalEntryId: expense.journalEntryId, created: false };
  }
  if (expense.status === 'voided') {
    throw refuse(
      `approveExpense: expense ${expenseId} is voided — cannot post`,
      "This expense has been voided, so it can't be posted.",
    );
  }

  // ⭐ T-196 — the gate moved from EXISTENCE to POSTING. `createExpense` no longer refuses a
  // draft against a PENDING invoice (docs/tasks/196-draft-expense-on-a-pending-invoice.md), so
  // by the time a draft reaches here its invoice may still be unverified. This is "the approval
  // path" the spec means by `assertOpenForRecording(..., 'posted')` — checked here for a clean,
  // named error (invariant 5); the trigger (`expenses_check_invoice_open_for_recording`,
  // migration 0113) is the actual backstop when this service is bypassed, e.g. a raw
  // `UPDATE expenses SET status = 'posted'`, same discipline as createExpense's own check.
  await apRepo.assertOpenForRecording(
    tx,
    actor.orgId,
    expense.supplierInvoiceId,
    expense.totalAmount,
    'posted',
    expense.id,
  );

  // ⭐ T-130: the DEF-055 photo gate RELOCATED. It used to live here ("invariant 11 — no photo,
  // no posting"), checking `expense.receiptFileId`/`receiptPhotoUrl`. Those columns are gone —
  // the evidence now lives on `supplier_invoices`, checked once at `verifyInvoice`, and this
  // expense could not exist at all unless its invoice was already verified (the
  // `expenses_check_invoice_open_for_recording` trigger, DEF-073, is the backstop). No
  // replacement check belongs here: by the time an expense reaches `approve`, its invoice's
  // evidence has already been proven, in a different transaction, by a different actor.

  const category = await expensesRepo.getCategoryById(tx, actor.orgId, expense.categoryId);
  if (!category) {
    throw refuse(
      `approveExpense: category ${expense.categoryId} for expense ${expenseId} no longer exists`,
      'The category on this expense no longer exists. Pick another category, then approve it.',
    );
  }

  const payments = await expensesRepo.getPaymentsForExpense(tx, expenseId);

  // ⭐ Resolve each payment's money account to its GL code HERE. `routeExpense` is pure and cannot
  // look one up, and the account is what decides both where the credit lands and who owned it
  // (DEF-058). A named account that does not exist blocks the posting rather than defaulting.
  const walletIds = [...new Set(payments.map((p) => p.moneyAccountId).filter(Boolean))] as string[];
  const wallets = new Map<string, { glCode: string; storeId: string }>();
  for (const id of walletIds) {
    const acct = await moneyAccountsRepo.getById(tx, actor.orgId, id);
    if (!acct) {
      throw refuse(
        `approveExpense: expense ${expenseId} names money account ${id}, which does not exist in this org`,
        'A money account on this expense no longer exists. Edit the payment, then approve it.',
      );
    }
    wallets.set(id, { glCode: acct.glAccountCode, storeId: acct.storeId });

    // ⭐ FUNDING AN EXPENSE FROM ANOTHER STORE'S ACCOUNT IS CROSS-STORE MONEY MOVEMENT
    // (Ian, 2026-08-26; bible row 153) — *"cross store money movement will only be possible for
    // manager initiated transactions, with manager having access … to both stores."*
    //
    // ⚠️ The rule is about the MOVEMENT, not the screen it was reached through. An expense at
    // Lipa paid from Malvar's safe moves Malvar's money just as surely as a transfer does, and
    // `approve_expense` above only ever proved the actor answers for **Lipa**. Without this,
    // gating transfers alone would leave the identical act reachable one menu across.
    if (acct.storeId !== expense.storeId) {
      await authorize(tx, actor, 'transfer_funds', { storeId: acct.storeId });
    }
  }

  // ⛔/⚠️ OVERDRAWING — blocked for an office or staff account, WARNED for a cashier one
  // (bible row 154). The decision itself lives in `checkDraw`, shared with `createMoneyTransfer`.
  //
  // ⭐ **This is the surface that actually needed it.** Expense payment is ~34% of v1's ledger
  // activity against a transfer's 7%, so a drawer is far likelier to be driven negative by
  // spending than by moving money. Nothing checked it before.
  //
  // ⚠️ Checked at APPROVE, never at create — this file's own rule, and correct here for a second
  // reason: a draft is not a posting, so a draft naming money that has not arrived yet is a
  // legitimate thing to be holding. Only the moment it posts has to be true.
  //
  // ⚠️ Summed PER ACCOUNT across the split, not per payment row. Two ₱600 cash lines against one
  // ₱1,000 drawer are individually affordable and together are not — checking them one at a time
  // would let exactly that through (the DEF-065 family of error: a split's rows are only ever
  // right when considered together).
  // T-371 (R4): summed in exact centavos from re-minted rows, not a float `+`; `checkDraw` takes the `Money` sum.
  const drawnPerAccount = new Map<string, Money>();
  for (const p of payments) {
    if (!p.moneyAccountId) continue; // credit, reimbursable and cash-request legs move no money now
    drawnPerAccount.set(p.moneyAccountId, add(drawnPerAccount.get(p.moneyAccountId) ?? ZERO, money(p.amount)));
  }
  const warnings: string[] = [];
  for (const [id, drawn] of drawnPerAccount) {
    const acct = await moneyAccountsRepo.getById(tx, actor.orgId, id);
    const warning = await checkDraw(
      tx,
      actor.orgId,
      acct!,
      drawn,
      `approveExpense: expense ${expenseId} cannot post`,
    );
    if (warning) warnings.push(warning);
  }

  // ⚠️ Looked up unconditionally rather than only for PERSONAL categories: a null here has to mean
  // "no owner named", never "we did not check", or the block below would silently stop firing.
  const owner = expense.ownerId
    ? await ownersRepo.getById(tx, actor.orgId, expense.ownerId)
    : null;

  const routed = routeExpense({
    totalAmount: money(expense.totalAmount),
    supplierId: expense.supplierId,
    categoryName: category.category,
    categoryAccountCode: category.accountCode,
    // ⭐ T-127: a PERSONAL expense belongs to an owner, and that owner's policy decides whether it
    // is a receivable (1260) or a drawing (3200). Resolved here because `routeExpense` is pure.
    owner: owner && { id: owner.id, treatment: owner.personalExpenseTreatment },
    payments: payments.map((p) => ({
      method: p.method,
      amount: money(p.amount),
      staffId: p.staffId,
      cashRequestId: p.cashRequestId,
      moneyAccountId: p.moneyAccountId,
      moneyAccountGlCode: p.moneyAccountId ? wallets.get(p.moneyAccountId)?.glCode : null,
      // T-369 S8 (DEF-551): the credit is posted at the ACCOUNT's store.
      moneyAccountStoreId: p.moneyAccountId ? wallets.get(p.moneyAccountId)?.storeId : null,
    })),
  });

  if (!routed.ok) {
    // Invariants 7, 8, 9, 10 all surface here, by name, never a bare exception. The
    // expense itself is UNCHANGED — still a draft, fixable and re-approvable.
    throw refuse(
      `approveExpense: expense ${expenseId} cannot post — ${routed.reason}`,
      `This expense can't be posted yet: ${routed.reason}.`,
    );
  }

  // T-369 S8 (DEF-551): every routed line sits at the expense's store EXCEPT a money-account credit, which sits at
  // the account's store; a cross-store draw then gains the 1250/2150 pair for what that store paid (not the total).
  const lines = await withInterStoreLegs(tx, actor.orgId, {
    owingStoreId: expense.storeId,
    memo: expense.particulars,
    lines: routed.lines.map((l) => ({
      accountCode: l.accountCode,
      storeId: l.storeId ?? expense.storeId,
      partyType: l.partyType ?? null,
      partyId: l.partyId ?? null,
      debit: l.side === 'debit' ? l.amount : ZERO,
      credit: l.side === 'credit' ? l.amount : ZERO,
      lineMemo: l.lineMemo ?? null,
    })),
  });

  // T-369 S5b: say, in words, when the expense's month will not take the posting - `postEntry`'s own refusal is a
  // developer sentence carrying ids. The override is passed on ONLY when the month is closed: for an open month it
  // is ignored, so an ordinary approval leaves no audit row and never asks for `override_period_lock`.
  let periodOverride: ApproveExpenseOptions['periodOverride'];
  if (/^\d{4}-\d{2}-\d{2}$/.test(expense.businessDate)) {
    const period = await journalRepo.findPeriodForDate(tx, actor.orgId, expense.businessDate);
    if (period?.status === 'closed') periodOverride = options?.periodOverride;
    if (period?.status === 'locked') {
      throw refuse(
        `approveExpense: the fiscal period covering ${expense.businessDate} is locked.`,
        options?.noPeriodOverride
          ? `${monthLabel(period.startsOn)} is locked, so this bill's expense can't be posted into it. Nothing was saved.`
          : `${monthLabel(period.startsOn)} is locked. Nothing can be posted into it, not even with the closed-month override.`,
      );
    }
    if (period?.status === 'closed' && !options?.periodOverride) {
      throw refuse(
        `approveExpense: the fiscal period covering ${expense.businessDate} is closed and no periodOverride was given.`,
        options?.noPeriodOverride
          ? `${monthLabel(period.startsOn)} is closed, and a bill's expense can't be posted into a closed month from the bills screen yet. Nothing was saved.`
          : `${monthLabel(period.startsOn)} is closed. Ask an administrator to post this one entry into it.`,
      );
    }
  }

  const result = await postEntry(tx, {
    orgId: actor.orgId,
    entryDate: expense.businessDate,
    // The real v1 sourceType (packages/etl/src/leg-mapping.ts's own finding: the spec's
    // pretty name "expense" is actually written as `expense_payment`) — reused here so
    // this module's postings sit in the same taxonomy POSTING-PATTERNS.md already
    // documents ("Expense payment (`expense_payment`) — 4,396 legs, #1").
    sourceType: 'expense_payment',
    sourceId: expenseId,
    idempotencyKey: `expense:${expenseId}:post`,
    memo: expense.particulars,
    postedBy: actor.personId,
    ...(periodOverride
      ? { periodOverride: { actor, reason: periodOverride.reason, note: periodOverride.note ?? null } }
      : {}),
    lines,
  });

  if (result.created) {
    await expensesRepo.markExpensePosted(tx, actor.orgId, expenseId, {
      journalEntryId: result.entryId,
      approvedBy: actor.personId,
    });
  }

  // ⭐ T-124's seam. A CAPEX category's account IS 1510, so the line above has ALREADY put
  // the money in the asset account — what is still missing is the REGISTER ROW that knows the
  // ₱45,000 sitting there is a chest freezer with a life. Without this, the cost lands in 1510
  // and nothing ever depreciates it.
  //
  // ⛔ Runs INSIDE the approving transaction, deliberately. If the capitalisation policy cannot
  // be read this throws, and the whole approval rolls back — which is v1's behaviour and its
  // reasoning: *"posting it now would capitalize the asset on default terms instead of yours"*,
  // and those terms are permanent. An expense posted without its asset is worse than an expense
  // not posted at all, because only one of those two states is obvious to anybody.
  const capitalised =
    category.group === 'CAPEX' ? await capitalizeApprovedExpense(tx, actor, expenseId) : null;

  return {
    journalEntryId: result.entryId,
    created: result.created,
    assetId: capitalised?.assetId ?? null,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
