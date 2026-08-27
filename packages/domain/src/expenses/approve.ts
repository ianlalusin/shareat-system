/**
 * approveExpense — the posting step. docs/tasks/122-expenses.md §2, §5, §6.
 *
 * "create · approve · void, posting via postEntry" (Scope) — approve IS the post: there
 * is no separate fourth verb. It is also where every routing invariant (6-10) and the
 * receipt-photo gate (invariant 11, DEF-055) actually run — a draft may sit with an
 * unmapped category or an unmapped payment method; only approving it is blocked.
 *
 * `idempotencyKey = expense:{id}:post`, exactly as the spec names it. Re-approving an
 * already-posted expense is a safe no-op (invariant 4) — this function short-circuits
 * before even loading the category/payments, mirroring `postEntry`'s own "idempotency
 * checked first" philosophy.
 */
import { authorize, type Actor } from '@shareat/auth';
import { expensesRepo, moneyAccountsRepo, ownersRepo, transaction, type Tx } from '@shareat/db';
import { money } from '@shareat/core/money';
import { filesRepo } from '@shareat/db';
import { checkDraw } from '../money-accounts/overdraft';
import { postEntry } from '../ledger/post-entry';
import { routeExpense } from './routing';
import { capitalizeApprovedExpense } from '../fixed-assets/capitalize';

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

export async function approveExpense(
  tx: Tx | null,
  actor: Actor,
  expenseId: string,
): Promise<ApproveExpenseResult> {
  if (tx) return runApproveExpense(tx, actor, expenseId);
  return transaction((trx) => runApproveExpense(trx, actor, expenseId));
}

async function runApproveExpense(tx: Tx, actor: Actor, expenseId: string): Promise<ApproveExpenseResult> {
  // Org-scoped read before authorize() — see edit.ts's identical comment: the capability
  // is store-scoped and the store is a property of the resource itself.
  const expense = await expensesRepo.getExpenseById(tx, actor.orgId, expenseId);
  if (!expense) {
    throw new Error(`approveExpense: expense ${expenseId} does not exist in org ${actor.orgId}`);
  }

  await authorize(tx, actor, 'approve_expense', { storeId: expense.storeId });

  if (expense.status === 'posted') {
    if (!expense.journalEntryId) {
      throw new Error(`approveExpense: expense ${expenseId} is posted but carries no journalEntryId — data inconsistency`);
    }
    return { journalEntryId: expense.journalEntryId, created: false };
  }
  if (expense.status === 'voided') {
    throw new Error(`approveExpense: expense ${expenseId} is voided — cannot post`);
  }

  // Invariant 11 — no photo, no posting. Enforced HERE, server-side, at post — never
  // merely in the form (DEF-055: every expense recorded through this module is external
  // by construction, so the gate is simply "no photo, no posting", with no further
  // condition to evaluate).
  //
  // ⭐ T-141: the gate now checks a ROW, not a string. `receipt_photo_url` is a plain text field,
  // so the old check was satisfied by typing `x` — the rule was real, the evidence behind it was
  // not. A brokered file cannot be forged: its path is derived from the session.
  //
  // ⚠️ EXPAND PHASE (bible §15.5): a legacy URL still satisfies the gate while old drafts exist.
  // Contracting to file-only is a later, deliberate step — not a silent one.
  if (expense.receiptFileId) {
    const file = await filesRepo.getById(tx, actor.orgId, expense.receiptFileId);
    // ⛔ The org check is implicit (RLS + the orgId argument), but the STORE check is not, and it
    // is the one that matters: a receipt belonging to another store is not evidence for this
    // expense, however real the file is.
    if (!file) {
      throw new Error(
        `approveExpense: expense ${expenseId} names a receipt file that does not exist in this org`,
      );
    }
    if (file.storeId && file.storeId !== expense.storeId) {
      throw new Error(
        `approveExpense: expense ${expenseId} names a receipt belonging to another store — ` +
          'a photo from somewhere else is not evidence for this expense',
      );
    }
  } else if (!expense.receiptPhotoUrl || !expense.receiptPhotoUrl.trim()) {
    throw new Error(
      `approveExpense: expense ${expenseId} has no receipt photo — cannot post (invariant 11, DEF-055)`,
    );
  }

  const category = await expensesRepo.getCategoryById(tx, actor.orgId, expense.categoryId);
  if (!category) {
    throw new Error(`approveExpense: category ${expense.categoryId} for expense ${expenseId} no longer exists`);
  }

  const payments = await expensesRepo.getPaymentsForExpense(tx, expenseId);

  // ⭐ Resolve each payment's money account to its GL code HERE. `routeExpense` is pure and cannot
  // look one up, and the account is what decides both where the credit lands and who owned it
  // (DEF-058). A named account that does not exist blocks the posting rather than defaulting.
  const walletIds = [...new Set(payments.map((p) => p.moneyAccountId).filter(Boolean))] as string[];
  const wallets = new Map<string, string>();
  for (const id of walletIds) {
    const acct = await moneyAccountsRepo.getById(tx, actor.orgId, id);
    if (!acct) {
      throw new Error(
        `approveExpense: expense ${expenseId} names money account ${id}, which does not exist in this org`,
      );
    }
    wallets.set(id, acct.glAccountCode);

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
  const drawnPerAccount = new Map<string, number>();
  for (const p of payments) {
    if (!p.moneyAccountId) continue; // credit, reimbursable and cash-request legs move no money now
    drawnPerAccount.set(
      p.moneyAccountId,
      (drawnPerAccount.get(p.moneyAccountId) ?? 0) + Number(p.amount),
    );
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
      moneyAccountGlCode: p.moneyAccountId ? wallets.get(p.moneyAccountId) : null,
    })),
  });

  if (!routed.ok) {
    // Invariants 7, 8, 9, 10 all surface here, by name, never a bare exception. The
    // expense itself is UNCHANGED — still a draft, fixable and re-approvable.
    throw new Error(`approveExpense: expense ${expenseId} cannot post — ${routed.reason}`);
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
    lines: routed.lines.map((l) => ({
      accountCode: l.accountCode,
      storeId: expense.storeId,
      partyType: l.partyType ?? null,
      partyId: l.partyId ?? null,
      debit: l.side === 'debit' ? l.amount : '0',
      credit: l.side === 'credit' ? l.amount : '0',
      lineMemo: l.lineMemo ?? null,
    })),
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
