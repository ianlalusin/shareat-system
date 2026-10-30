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
import { authorize, can, CAPABILITY_LABEL, type Actor, type Capability } from '@shareat/auth';
import { apRepo, auditLogRepo, cashRequestsRepo, expensesRepo, goneSentence, journalRepo, moneyAccountsRepo, ownersRepo, personsRepo, type Tx } from '@shareat/db';
import type { PeriodOverrideReason } from '@shareat/db/schema';
import { add, compare, formatMoney, money, subtract, ZERO, type Money } from '@shareat/core/money';
import { judgeDraw } from '../money-accounts/draw-verdict';
import {
  buildPeriodFacts,
  buildWouldPostFacts,
  capacityRefusal,
  periodRefusal,
  type InvoiceVerifiedFacts,
  type PeriodOpenFacts,
  type WouldPostFacts,
} from '../business-rules';
import { postEntry } from '../ledger/post-entry';
import { withInterStoreLegs } from '../ledger/inter-store';
import { routeExpense } from './routing';
import { capitalizeApprovedExpense } from '../fixed-assets/capitalize';
import { logger } from '@shareat/core/logger';
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
}

// ---------------------------------------------------------------------------------------------------------------------
// ⭐ T-475 S1 (spec section 4.1) - ONE evaluator for "would this draft post?", used by the real approval AND by the verify
// form's preview, so the preview can never disagree with the posting.
//
//   gatherApprovalFacts(tx, actor, id, { lock })   READS everything the checks need. `lock: true` is the real approval: it
//                                                  takes the invoice lock and the cash-request locks (FOR UPDATE) exactly where
//                                                  the old inline code did. `lock: false` is a preview: no lock, no write, no
//                                                  authorize() (so no denial row) - `can()` answers instead.
//   approvalVerdict(facts, options)                PURE. The FIRST blocker, in the order the old inline code refused, or null.
//   approveExpense                                 = authorize + gather(lock) + verdict + throw + post.
//
// First-refusal order (do not reorder; a test pins every adjacent pair): approve_expense -> voided -> the invoice (voided /
// not yet verified / room) -> category -> cash-request draws -> money accounts (exist, then transfer_funds) -> drawer
// balances -> routing -> the fiscal period.
// ---------------------------------------------------------------------------------------------------------------------
type ExpenseRowT = NonNullable<Awaited<ReturnType<typeof expensesRepo.getExpenseById>>>;
type CategoryRowT = Awaited<ReturnType<typeof expensesRepo.getCategoryById>>;
type PaymentRowT = Awaited<ReturnType<typeof expensesRepo.getPaymentsForExpense>>[number];
type CapacityT = Awaited<ReturnType<typeof apRepo.capacityOf>>;
type CashRequestT = Awaited<ReturnType<typeof cashRequestsRepo.getById>>;
type MoneyAccountT = NonNullable<Awaited<ReturnType<typeof moneyAccountsRepo.getById>>>;
type OwnerT = Awaited<ReturnType<typeof ownersRepo.getById>>;
type PeriodT = Awaited<ReturnType<typeof journalRepo.findPeriodForDate>>;

export interface ApprovalFacts {
  expense: ExpenseRowT;
  /** The actor may approve at the expense's store. The real path authorised just before gathering, so it is true there. */
  canApprove: boolean;
  /** null once the expense is no longer a draft: a posted or voided one reads nothing more. */
  detail: {
    capacity: CapacityT;
    category: CategoryRowT;
    payments: PaymentRowT[];
    /** Every cash request the payments draw on, in id order. */
    requests: Array<{ id: string; row: CashRequestT; holder: string; outstanding: Money | null }>;
    /** Every money account the payments name, in payment order. */
    wallets: Array<{ id: string; account: MoneyAccountT | undefined; crossStore: boolean; transferAllowed: boolean }>;
    /** The accounts the payments draw on directly (not via a cash request), with what the ledger says they hold. */
    drawers: Array<{ account: MoneyAccountT; available: Money; drawn: Money }>;
    owner: OwnerT | null;
    period: PeriodT;
  } | null;
}

export interface ApprovalBlocker {
  /** The raw diagnostic (T-343): ids and function names are fine here. */
  raw: string;
  /** What a person reads. */
  sentence: string;
  /** A CLOSED month: the override lifts this one (and only this one). */
  liftable?: true;
  /** T-475 P1 / P3: which part of the approval refused, so a page can show the invoice and the month on their own lines. */
  group?: 'invoice' | 'period';
  /** The refusal is an authorisation one: the real path calls `authorize()` with this so the ORIGINAL AuthorizationError is thrown. */
  authorize?: { capability: Capability; storeId: string };
}

/** What earlier drafts of the same invoice would already have drawn, when the verify cascade posts them oldest first. */
export interface ApprovalCarried {
  accounts: Map<string, Money>;
  requests: Map<string, Money>;
}

export interface ApprovalVerdictOptions extends ApproveExpenseOptions {
  /** The verify preview: the invoice is verified in the same transaction, just before its drafts post. Lifts ONLY the pending blocker. */
  invoiceVerifiedInThisTx?: boolean;
  /** T-475 F1 (preview only): skip the invoice checks entirely, so the first NON-invoice blocker shows. The real approval never sets it (R9). */
  skipInvoice?: boolean;
  carried?: ApprovalCarried;
}

/** The money this expense draws, per cash request and per money account (a split's rows are judged together, in exact centavos). */
export function approvalDraws(payments: readonly PaymentRowT[]): ApprovalCarried {
  const requests = new Map<string, Money>();
  const accounts = new Map<string, Money>();
  for (const p of payments) {
    if (p.cashRequestId) requests.set(p.cashRequestId, add(requests.get(p.cashRequestId) ?? ZERO, money(p.amount)));
  }
  for (const p of payments) {
    if (!p.moneyAccountId) continue; // credit, reimbursable and cash-request legs move no money now
    // T-414: a cash-request leg is judged against ITS request, not against the aggregate staff account.
    if (p.cashRequestId) continue;
    accounts.set(p.moneyAccountId, add(accounts.get(p.moneyAccountId) ?? ZERO, money(p.amount)));
  }
  return { requests, accounts };
}

export async function gatherApprovalFacts(
  tx: Tx,
  actor: Actor,
  expenseId: string,
  options: { lock: boolean },
): Promise<ApprovalFacts> {
  let expense = await expensesRepo.getExpenseById(tx, actor.orgId, expenseId);
  if (!expense) {
    throw gone(`approveExpense: expense ${expenseId} does not exist in org ${actor.orgId}`, 'expense');
  }
  // The real path (lock) authorised `approve_expense` immediately before; a preview asks, without writing a denial row.
  const canApprove = options.lock ? true : await can(tx, actor, 'approve_expense', { storeId: expense.storeId });

  if (options.lock) {
    // ⭐ T-367 S2 / R4 (DEF-396) — lock the invoice BEFORE re-reading the expense's own status. A concurrent voidInvoice
    // (lockInvoiceForUpdate) or another approveExpense on the SAME invoice serialises here; the re-read right after is
    // what makes a double-approve resolve as the existing `created: false` retry rather than a second posting.
    await apRepo.lockInvoiceForRecording(tx, actor.orgId, expense.supplierInvoiceId);
    expense = await expensesRepo.getExpenseById(tx, actor.orgId, expenseId);
    if (!expense) {
      throw internalFault(`approveExpense: expense ${expenseId} vanished between its first read and the lock`);
    }
  }
  if (expense.status !== 'draft') return { expense, canApprove, detail: null };

  const capacity = await apRepo.capacityOf(tx, actor.orgId, expense.supplierInvoiceId, expense.id);
  const category = await expensesRepo.getCategoryById(tx, actor.orgId, expense.categoryId);
  const payments = await expensesRepo.getPaymentsForExpense(tx, expenseId);
  const draws = approvalDraws(payments);

  // ⭐ T-414 (rulings 6, 7): every cash-request leg is re-checked against the request's LIVE outstanding. The real path
  // locks the request rows FIRST (`FOR UPDATE`, id order) and reads the balance AFTER the lock; a preview reads without it.
  const requestIds = [...draws.requests.keys()].sort((a, b) => a.localeCompare(b));
  const lockedRows = options.lock ? await cashRequestsRepo.lockForSpend(tx, actor.orgId, requestIds) : null;
  const requests: NonNullable<ApprovalFacts['detail']>['requests'] = [];
  for (const id of requestIds) {
    const row = lockedRows ? lockedRows.find((r) => r.id === id) : await cashRequestsRepo.getById(tx, actor.orgId, id);
    const holder = row ? ((await personsRepo.getPersonById(tx, actor.orgId, row.requestedFor))?.displayName ?? 'The holder') : 'The holder';
    const outstanding = row ? money((await cashRequestsRepo.floatPositionOf(tx, actor.orgId, id)).outstanding) : null;
    requests.push({ id, row, holder, outstanding });
  }

  // Each payment's money account, resolved here: `routeExpense` is pure and cannot look one up. A named account that does
  // not exist blocks the posting rather than defaulting.
  const walletIds = [...new Set(payments.map((p) => p.moneyAccountId).filter(Boolean))] as string[];
  const wallets: NonNullable<ApprovalFacts['detail']>['wallets'] = [];
  for (const id of walletIds) {
    const account = await moneyAccountsRepo.getById(tx, actor.orgId, id);
    // ⭐ FUNDING AN EXPENSE FROM ANOTHER STORE'S ACCOUNT IS CROSS-STORE MONEY MOVEMENT (Ian, 2026-08-26; bible row 153).
    // `approve_expense` only proves the actor answers for THIS store; the movement needs `transfer_funds` at the other.
    const crossStore = !!account && account.storeId !== expense.storeId;
    const transferAllowed = crossStore ? await can(tx, actor, 'transfer_funds', { storeId: account!.storeId }) : true;
    wallets.push({ id, account, crossStore, transferAllowed });
  }

  // ⛔/⚠️ OVERDRAWING (bible row 154): the decision lives in `judgeDraw`, shared with `createMoneyTransfer`. Summed PER ACCOUNT
  // across the split (the DEF-065 family of error: a split's rows are only ever right when considered together).
  const drawers: NonNullable<ApprovalFacts['detail']>['drawers'] = [];
  // T-501 A1: on the posting path, lock every drawn account (ordered) BEFORE any balance is read.
  if (options.lock) {
    const present: string[] = []; // a missing account is already a blocker above; do not let the lock turn it into a throw
    for (const id of draws.accounts.keys()) if (await moneyAccountsRepo.getById(tx, actor.orgId, id)) present.push(id);
    await moneyAccountsRepo.lockForDraws(tx, actor.orgId, present);
  }
  for (const [id, drawn] of draws.accounts) {
    const account = wallets.find((w) => w.id === id)?.account ?? (await moneyAccountsRepo.getById(tx, actor.orgId, id));
    if (!account) continue; // a missing account is already a blocker above
    drawers.push({ account, available: money(await moneyAccountsRepo.balanceOf(tx, actor.orgId, account)), drawn });
  }

  // ⚠️ Looked up unconditionally rather than only for PERSONAL categories: a null here has to mean "no owner named", never
  // "we did not check", or the block in the verdict would silently stop firing.
  const owner = expense.ownerId ? await ownersRepo.getById(tx, actor.orgId, expense.ownerId) : null;
  const period = /^\d{4}-\d{2}-\d{2}$/.test(expense.businessDate)
    ? await journalRepo.findPeriodForDate(tx, actor.orgId, expense.businessDate)
    : undefined;

  return { expense, canApprove, detail: { capacity, category, payments, requests, wallets, drawers, owner: owner ?? null, period } };
}

/** The routing of a gathered draft (pure). Shared by the verdict and by the posting, so both route the same facts. */
function routeFacts(facts: ApprovalFacts & { detail: NonNullable<ApprovalFacts['detail']> }) {
  const { expense } = facts;
  const { category, owner, payments, wallets } = facts.detail;
  const glOf = new Map(wallets.map((w) => [w.id, w.account] as const));
  return routeExpense({
    totalAmount: money(expense.totalAmount),
    supplierId: expense.supplierId,
    categoryName: category!.category,
    categoryAccountCode: category!.accountCode,
    // ⭐ T-127: a PERSONAL expense belongs to an owner, and that owner's policy decides whether it is a receivable (1260)
    // or a drawing (3200). Resolved at gather because `routeExpense` is pure.
    owner: owner && { id: owner.id, treatment: owner.personalExpenseTreatment },
    payments: payments.map((p) => ({
      method: p.method,
      amount: money(p.amount),
      staffId: p.staffId,
      cashRequestId: p.cashRequestId,
      moneyAccountId: p.moneyAccountId,
      moneyAccountGlCode: p.moneyAccountId ? glOf.get(p.moneyAccountId)?.glAccountCode : null,
      // T-369 S8 (DEF-551): the credit is posted at the ACCOUNT's store.
      moneyAccountStoreId: p.moneyAccountId ? glOf.get(p.moneyAccountId)?.storeId : null,
    })),
  });
}

function carriedFor(carried: ApprovalCarried | undefined, map: 'accounts' | 'requests', id: string): Money {
  return carried?.[map].get(id) ?? ZERO;
}

/** The FIRST thing that stops this draft posting, or null. Pure: same facts, same answer. */
export function approvalVerdict(facts: ApprovalFacts, options: ApprovalVerdictOptions = {}): ApprovalBlocker | null {
  const { expense } = facts;
  const expenseId = expense.id;

  if (!facts.canApprove) {
    return {
      raw: `approveExpense: the actor may not ${CAPABILITY_LABEL.approve_expense} at store ${expense.storeId}`,
      sentence: `Your role can't ${CAPABILITY_LABEL.approve_expense}. Ask an admin if you need to.`,
      authorize: { capability: 'approve_expense', storeId: expense.storeId },
    };
  }
  if (expense.status === 'voided') {
    return {
      raw: `approveExpense: expense ${expenseId} is voided — cannot post`,
      sentence: "This expense has been voided, so it can't be posted.",
    };
  }
  const detail = facts.detail;
  if (expense.status !== 'draft' || !detail) return null; // already posted: re-approving is a safe no-op

  // ⭐ T-196 — the gate moved from EXISTENCE to POSTING: a draft may stand against a PENDING invoice, but cannot post until
  // the invoice is verified. The trigger (`expenses_check_invoice_open_for_recording`, migration 0113) is the backstop.
  const invoiceId = expense.supplierInvoiceId;
  if (!detail.capacity && !options.skipInvoice) {
    return { raw: `approveExpense: supplier invoice ${invoiceId} does not exist in org`, sentence: goneSentence('supplier invoice'), group: 'invoice' };
  }
  const room = options.skipInvoice || !detail.capacity ? null : capacityRefusal(detail.capacity, expense.totalAmount, 'posted', { skipPending: options.invoiceVerifiedInThisTx === true });
  if (room) {
    const c = detail.capacity!;
    const raw =
      room.kind === 'voided'
        ? `assertOpenForRecording: supplier invoice ${invoiceId} is voided — nothing further may be recorded against it`
        : room.kind === 'pending'
          ? `assertOpenForRecording: supplier invoice ${invoiceId} is ${c.status} — a draft may stand against it, but it cannot post until it is verified`
          : `assertOpenForRecording: supplier invoice ${invoiceId} has only ₱${c.remaining} remaining (total ₱${c.totalAmount}, already recorded ₱${c.recorded}) — ₱${expense.totalAmount} does not fit`;
    return { raw, sentence: room.sentence, group: 'invoice' };
  }

  if (!detail.category) {
    return {
      raw: `approveExpense: category ${expense.categoryId} for expense ${expenseId} no longer exists`,
      sentence: 'The category on this expense no longer exists. Pick another category, then approve it.',
    };
  }

  const draws = approvalDraws(detail.payments);
  for (const { id: requestId, row: req, holder, outstanding } of detail.requests) {
    const drawn = draws.requests.get(requestId) ?? ZERO;
    if (!req) {
      return {
        raw: `approveExpense: expense ${expenseId} draws on cash request ${requestId}, which does not exist in org ${expense.orgId}`,
        sentence: goneSentence('cash request'),
      };
    }
    if (req.status !== 'released') {
      return {
        raw: `approveExpense: expense ${expenseId} draws on cash request ${requestId}, which is ${req.status}, not released`,
        sentence: `${holder}'s cash request is no longer open (${req.status}). Pick another source.`,
      };
    }
    if (req.storeId !== expense.storeId) {
      return {
        raw: `approveExpense: expense ${expenseId} (store ${expense.storeId}) draws on cash request ${requestId}, released at store ${req.storeId}`,
        sentence: `${holder}'s cash request belongs to another store, so this expense cannot draw from it. Pick another source.`,
      };
    }
    // What earlier drafts of the same invoice would already have spent of this float, when the cascade posts them in turn.
    const left = subtract(outstanding ?? ZERO, carriedFor(options.carried, 'requests', requestId));
    if (compare(drawn, left) > 0) {
      return {
        raw: `approveExpense: expense ${expenseId} draws ${drawn} from cash request ${requestId}, which has ${left} left`,
        sentence: `${holder}'s cash request has ${formatMoney(left)} left — this expense draws ${formatMoney(drawn)} from it. Lower the amount or pay the rest another way.`,
      };
    }
  }

  for (const w of detail.wallets) {
    if (!w.account) {
      return {
        raw: `approveExpense: expense ${expenseId} names money account ${w.id}, which does not exist in this org`,
        sentence: 'A money account on this expense no longer exists. Edit the payment, then approve it.',
      };
    }
    if (w.crossStore && !w.transferAllowed) {
      return {
        raw: `approveExpense: expense ${expenseId} (store ${expense.storeId}) draws on money account ${w.id} of store ${w.account.storeId}, and the actor may not ${CAPABILITY_LABEL.transfer_funds} there`,
        sentence: `Your role can't ${CAPABILITY_LABEL.transfer_funds}. Ask an admin if you need to.`,
        authorize: { capability: 'transfer_funds', storeId: w.account.storeId },
      };
    }
  }

  // ⛔ BLOCKED for an office or staff account, WARNED for a cashier one (see `approvalWarnings`).
  for (const d of detail.drawers) {
    const drawn = add(d.drawn, carriedFor(options.carried, 'accounts', d.account.id));
    const judged = judgeDraw(d.account, d.available, drawn);
    if (judged.blocked) {
      const message = judged.message ?? `"${d.account.name}" cannot cover this.`;
      return { raw: `approveExpense: expense ${expenseId} cannot post: ${message}`, sentence: message };
    }
  }

  const routed = routeFacts({ ...facts, detail });
  if (!routed.ok) {
    // Invariants 7, 8, 9, 10 all surface here, by name, never a bare exception. The expense itself is UNCHANGED.
    return {
      raw: `approveExpense: expense ${expenseId} cannot post — ${routed.reason}`,
      sentence: `This expense can't be posted yet: ${routed.reason}.`,
    };
  }

  // T-369 S5b: say, in words, when the expense's month will not take the posting - `postEntry`'s own refusal is a developer
  // sentence carrying ids.
  // T-475 P2: the month's sentences live in the shared rule leaf, so the approve card's live line says the same words.
  const month = periodRefusal(buildPeriodFacts(detail.period), { override: !!options.periodOverride });
  if (month?.kind === 'locked') {
    return { raw: `approveExpense: the fiscal period covering ${expense.businessDate} is locked.`, sentence: month.sentence, group: 'period' };
  }
  if (month?.kind === 'closed') {
    return {
      raw: `approveExpense: the fiscal period covering ${expense.businessDate} is closed and no periodOverride was given.`,
      sentence: month.sentence,
      liftable: true,
      group: 'period',
    };
  }
  return null;
}

/** ⚠️ Cashier-account shortfalls that are allowed but must be SURFACED (bible row 154: a warning nobody sees is v1's disease). */
export function approvalWarnings(facts: ApprovalFacts): string[] {
  const warnings: string[] = [];
  for (const d of facts.detail?.drawers ?? []) {
    const judged = judgeDraw(d.account, d.available, d.drawn);
    if (!judged.blocked && judged.message) warnings.push(judged.message);
  }
  return warnings;
}

/**
 * ⭐ T-475 R13 - what verifying an invoice would do to each of its drafts, oldest first, exactly as the cascade posts them: the
 * invoice counts as verified, and each draft that would post uses up its draws before the next is judged (two drafts that
 * each fit a drawer but together overdraw it name the SECOND). Reads only: no lock, no write, no denial row.
 */
export async function previewInvoiceDrafts(
  tx: Tx,
  actor: Actor,
  invoiceId: string,
): Promise<Array<{ draftId: string; particulars: string; verdict: ApprovalBlocker | null }>> {
  const live = await apRepo.liveExpensesForInvoice(tx, actor.orgId, invoiceId);
  const carried: ApprovalCarried = { accounts: new Map(), requests: new Map() };
  const rows: Array<{ draftId: string; particulars: string; verdict: ApprovalBlocker | null }> = [];
  for (const d of live.filter((e) => e.status === 'draft')) {
    const facts = await gatherApprovalFacts(tx, actor, d.id, { lock: false });
    const verdict = approvalVerdict(facts, { invoiceVerifiedInThisTx: true, carried });
    rows.push({ draftId: d.id, particulars: facts.expense.particulars, verdict });
    // A draft that would post (or only waits on the closed-month override) spends its draws before the next is judged.
    if (verdict === null || verdict.liftable) {
      const draws = approvalDraws(facts.detail?.payments ?? []);
      for (const [id, amount] of draws.accounts) carried.accounts.set(id, add(carried.accounts.get(id) ?? ZERO, amount));
      for (const [id, amount] of draws.requests) carried.requests.set(id, add(carried.requests.get(id) ?? ZERO, amount));
    }
  }
  return rows;
}

/**
 * ⭐ T-475 P1-P3 (R8, R9, R10) - the facts the "Approve & post" card's live lines read, from the SAME evaluator the real approval
 * runs (gather without a lock, then the pure verdict), so the card can never disagree with the posting. Reads only: no lock, no
 * write, and `can()` where the real path calls `authorize()` (a page view writes no denial row).
 *
 * P1 (the invoice) and P2 (the month) get their own lines; P3 is the first OTHER blocker, judged as if the invoice were verified
 * and the month open, so the three never repeat each other. `canOverride`: the viewer holds `override_period_lock`.
 * Null when the expense is not a draft; a preview that cannot be read gives null (the server re-checks every approval).
 */
export async function previewExpenseApproval(
  tx: Tx,
  actor: Actor,
  expenseId: string,
  options: { canOverride: boolean },
): Promise<{ invoice: InvoiceVerifiedFacts | undefined; period: PeriodOpenFacts; wouldPost: WouldPostFacts } | null> {
  // F2: a savepoint, so a failed read rolls back only itself and cannot poison the page's transaction.
  try {
    return await tx.transaction(async (t) => {
    const gathered = await gatherApprovalFacts(t, actor, expenseId, { lock: false });
    const detail = gathered.detail;
    if (!detail) return null;
    const other = approvalVerdict({ ...gathered, detail: { ...detail, period: undefined } }, { skipInvoice: true });
    return {
      invoice: detail.capacity ? { capacity: detail.capacity, amount: gathered.expense.totalAmount } : undefined,
      period: { period: buildPeriodFacts(detail.period), canOverride: options.canOverride },
      wouldPost: buildWouldPostFacts(other),
    };
    });
  } catch (err) {
    logger.warn({ err, expenseId }, 'previewExpenseApproval: the preview failed; the page shows no verdict and approve re-checks');
    return null;
  }
}

export async function approveExpense(
  tx: Tx,
  actor: Actor,
  expenseId: string,
  options?: ApproveExpenseOptions,
): Promise<ApproveExpenseResult> {
  return runApproveExpense(tx, actor, expenseId, options);
}

async function runApproveExpense(
  tx: Tx,
  actor: Actor,
  expenseId: string,
  options?: ApproveExpenseOptions,
): Promise<ApproveExpenseResult> {
  // Org-scoped read before authorize() — see edit.ts's identical comment: the capability
  // is store-scoped and the store is a property of the resource itself.
  const found = await expensesRepo.getExpenseById(tx, actor.orgId, expenseId);
  if (!found) {
    throw gone(`approveExpense: expense ${expenseId} does not exist in org ${actor.orgId}`, 'expense');
  }

  await authorize(tx, actor, 'approve_expense', { storeId: found.storeId });

  // Gather (locking, as the inline code did), then judge the gathered facts with the SAME function the verify preview uses.
  const facts = await gatherApprovalFacts(tx, actor, expenseId, { lock: true });
  const expense = facts.expense;

  if (expense.status === 'posted') {
    if (!expense.journalEntryId) {
      throw internalFault(`approveExpense: expense ${expenseId} is posted but carries no journalEntryId — data inconsistency`);
    }
    return { journalEntryId: expense.journalEntryId, created: false };
  }

  const blocker = approvalVerdict(facts, { periodOverride: options?.periodOverride });
  if (blocker) {
    // An authorisation refusal re-asks with authorize(): the ORIGINAL AuthorizationError (and its denial log) is what is thrown.
    if (blocker.authorize) await authorize(tx, actor, blocker.authorize.capability, { storeId: blocker.authorize.storeId });
    throw refuse(blocker.raw, blocker.sentence);
  }
  const detail = facts.detail!;

  // ⭐ T-130: the DEF-055 photo gate RELOCATED to `verifyInvoice` (the evidence lives on `supplier_invoices`). No replacement
  // check belongs here: by the time an expense reaches `approve`, its invoice's evidence has already been proven.
  const warnings = approvalWarnings(facts);
  const routed = routeFacts({ ...facts, detail });
  if (!routed.ok) throw internalFault(`approveExpense: expense ${expenseId} routed differently between the verdict and the posting`);

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

  // The override is passed on ONLY when the month is closed: for an open month it is ignored, so an ordinary approval leaves
  // no audit row and never asks for `override_period_lock`.
  const periodOverride = detail.period?.status === 'closed' ? options?.periodOverride : undefined;
  const category = detail.category!;

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

  // T-402 S3 (C4): the approval step's event, same transaction, after the posting and its own writes.
  if (result.created) {
    await auditLogRepo.append(tx, actor.orgId, {
      actorPersonId: actor.personId,
      action: 'expense.approved',
      storeId: expense.storeId,
      entityId: expenseId,
      before: { status: 'draft' },
      after: { status: 'posted', amount: expense.totalAmount, journalEntryId: result.entryId },
      source: 'web',
    });
  }

  return {
    journalEntryId: result.entryId,
    created: result.created,
    assetId: capitalised?.assetId ?? null,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
