'use server';

/**
 * Server actions for the expenses screens — docs/tasks/122-expenses.md.
 *
 * Every action here is a thin adapter: parse `FormData`, build the domain layer's own input
 * shape, run it inside `withOrgPrincipal` (real RLS), and redirect.
 *
 * ⭐ **The actor comes from `requireActor()`, never from the form** (T-138, bible §7.1). Until
 * 2026-08-25 these read a person the browser supplied, which made the create/approve segregation
 * unenforceable. No business rule is re-implemented here — `createExpense` / `approveExpense`
 * / `editExpense` / `voidExpense` (packages/domain/src/expenses/*.ts) already own every
 * invariant; this file only wires HTML forms to them.
 *
 * ⭐ T-364 / DEF-496 (bible §7 rule 1) — `parseExpenseForm` is authorised BEFORE any field is
 * judged or any row (an invoice, a store's money sources, a supplier) is read; the domain gate
 * inside `createExpense` / `recordExpenseForInvoice` is unchanged and still decides.
 */
import {
  approveExpense,
  createExpense,
  editExpense,
  voidExpense,
  deleteExpenseDraft,
  recordExpenseForInvoice,
  validateMoneyLines,
  internalFault,
  type ExpensePaymentMethod,
  type MoneyLine,
} from '@shareat/domain';
import { apRepo, expensesRepo, goneSentence } from '@shareat/db';
import { withOrgPrincipal } from './lib';
import { closedMonthOf, closedMonths, periodOverrideProblem, readPeriodOverride } from '../../lib/period-override';
import { loadMoneyLines } from '@/lib/money-lines/load';
import { requireActor } from '../../lib/session';
import { errorMessage as sharedErrorMessage } from '@/lib/constraint-messages';
import { authorize, type Actor, type Capability } from '@shareat/auth';
import { redirectWithFlash, splitReturnTo, type Nav } from '@/lib/flash';
import { keepTyping } from '@/lib/keep-typing';
import { EXPENSE_DRAFT_EDIT } from './typed-forms';

/**
 * ⭐ Screen-local, deliberately — T-266, migration 0141, and the same reasoning `till/actions.ts`
 * and `remittance/actions.ts` already follow.
 *
 * ⛔ These sentences are NOT in the shared `CONSTRAINT_MESSAGES`, because
 * `pre-session-message.ts` builds `WRITTEN_FOR_A_PERSON` as `new Set(Object.values(...))` of that
 * map, and that set gates **what text may appear in the URL of the unauthenticated `/setup`
 * page**. Neither of these constraints can fire on that path — `/setup` creates the first admin,
 * not suppliers or expense payments — so putting them there would widen a security allowlist for
 * no reachable benefit. Their NAMES are registered in `LOCALLY_MAPPED_CONSTRAINT_NAMES` so the
 * unmapped-constraint counter (DEF-246) does not record them as unhandled.
 */
const CONSTRAINT_MESSAGES: Record<string, string> = {
  suppliers_credit_terms_days_check:
    'Payment terms have to be between 0 and 365 days. Leave it blank if this supplier is ' +
    'cash-on-delivery — blank is what disables credit on the payment form.',
  expense_payments_cash_request_id_fkey:
    'That cash request does not exist. Pick a float from the list rather than typing an id — ' +
    'the float is what says whose money was spent.',
};

function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  for (const [constraint, message] of Object.entries(CONSTRAINT_MESSAGES)) {
    if (raw.includes(constraint)) return message;
  }
  return sharedErrorMessage(err);
}

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

/** Every action ends up back on a page carrying `org`/`store`/`as` (the "acting as"
 *  filter state the reports screens already use for org/store) so the picker state
 *  survives the round trip. */
/** Only filter state travels in the URL now — the org and the person come from the session. `redirectWithFlash`
 *  keeps the value only if it is a uuid, so a typed `storeId` never reaches the address (T-380). */
function carryNav(fd: FormData): Nav {
  const store = str(fd, 'storeId');
  return store ? { store } : {};
}

interface ParsedExpenseForm {
  storeId: string;
  supplierId: string;
  supplierInvoiceId: string;
  categoryId: string;
  particulars: string;
  payments: { method: ExpensePaymentMethod; amount: string; staffId?: string; cashRequestId?: string; moneyAccountId?: string }[];
  /** The same-app path the form came from (DEF-603: never the raw `returnTo`), and the nav to take back to it. */
  returnPath: string;
  returnNav: Nav;
  /** The success page's nav: the form's own store. */
  carry: Nav;
}

/**
 * ⭐ Shared by both actions below — the two forms differ only in WHAT they call once the fields
 * are in hand (create a draft vs. record-and-post against an already-verified invoice), never in
 * how they are parsed. `supplierId` is resolved from the invoice when the form did not supply it
 * (the invoice already names its supplier — the form only has to pick ONE thing).
 *
 * ⭐ T-364 / DEF-496 — `capabilities` is authorised, in `@shareat/auth`'s own order, before any
 * field below is judged or any row (an invoice, a store's money sources, a supplier) is read.
 * `Choose a store.` stays the one check ahead of the gate because WITHOUT a store the gate's
 * refusal varies by role (`authorize` throws `noActiveRole` or `roleMayNot` before it ever reaches
 * the store-scope check) — running it anyway would re-open the oracle this task closes. It reads
 * nothing and reveals nothing.
 */
async function parseExpenseForm(
  formData: FormData,
  actor: Actor,
  fallbackReturnTo: string,
  capabilities: readonly Capability[],
): Promise<ParsedExpenseForm> {
  const storeId = str(formData, 'storeId');
  if (!storeId) throw new Error('Choose a store.');
  // An empty list would authorise nothing while every read below still runs — an unreachable
  // invariant (both callers pass a fixed, non-empty list), never a user-facing refusal.
  if (capabilities.length === 0) throw internalFault('parseExpenseForm: capabilities must not be empty');
  await withOrgPrincipal(actor.orgId, async (tx) => {
    for (const c of capabilities) await authorize(tx, actor, c, { storeId });
  });

  const carry = carryNav(formData);
  // ⭐ Each form names where it actually lives (`/expenses/new` or `/ap/invoices/[id]`) — a
  // hardcoded error redirect back to one screen silently drops the other caller onto the wrong
  // page with every field wiped (caught in the browser, not by a test: an overdraft rejection
  // while smoketesting the embedded form). `fallbackReturnTo` only covers a form that omitted it.
  // DEF-603: `returnTo` is form-supplied. Only a same-app pathname and uuid-shaped nav keys survive; anything else is the fallback.
  const returned = splitReturnTo(str(formData, 'returnTo'), fallbackReturnTo);

  const categoryId = str(formData, 'categoryId');
  let supplierId = str(formData, 'supplierId');
  const supplierInvoiceId = str(formData, 'supplierInvoiceId');
  const particulars = str(formData, 'particulars');

  // ⭐ T-266 — `<MoneyLines>` posts a variable number of rows and says how many, replacing the
  // fixed 8-row grid. `lineAccount_`/`lineRequest_` are the component's HIDDEN resolved ids: the
  // visible picker holds one combined source key, and the component splits it, so a float carries
  // both the staff-float account (which resolves the 1120 GL code) and the request (its party).
  // T-374 S5 / DEF-579 — the count is judged, never clamped or defaulted: an unreadable one used to read as 0 lines
  // (`|| 0`) and a 51st line was silently dropped (`Math.min`). `<MoneyLines>` has no 50 cap, so above 50 refuses.
  const lineCountRaw = str(formData, 'lineCount');
  if (!/^\d+$/.test(lineCountRaw)) {
    throw new Error("The payment lines didn't arrive complete — reload the page and try again.");
  }
  const lineCount = Number(lineCountRaw);
  if (lineCount > 50) throw new Error('An expense can carry at most 50 payment lines.');
  const lines: MoneyLine[] = [];
  for (let i = 0; i < lineCount; i++) {
    const method = str(formData, `lineMethod_${i}`);
    const amount = str(formData, `lineAmount_${i}`);
    if (!method || !amount) continue;
    lines.push({
      method: method as MoneyLine['method'],
      amount,
      moneyAccountId: str(formData, `lineAccount_${i}`) || null,
      cashRequestId: str(formData, `lineRequest_${i}`) || null,
      staffId: str(formData, `lineStaff_${i}`) || null,
      referenceNo: str(formData, `lineRef_${i}`) || null,
    });
  }

  if (!supplierInvoiceId) throw new Error('Choose a supplier invoice.');
  if (!supplierId) {
    const invoice = await withOrgPrincipal(actor.orgId, (tx) =>
      apRepo.getSupplierInvoiceById(tx, actor.orgId, supplierInvoiceId),
    );
    // ⭐ T-367 S2 / R7 (DEF-508) — a store mismatch reads as NOT FOUND, the same id-free sentence
    // `createExpense`'s own check throws (Ian, T-364 Q1 (a): one uniform refusal). This lookup only
    // runs when the form omitted `supplierId`; the domain layer's own check (create.ts) is the real
    // gate either way, but a hand-posted payload that skips `supplierId` must not get a DIFFERENT,
    // more informative error from this screen-local shortcut than it would from the domain gate.
    if (!invoice || invoice.storeId !== storeId) {
      throw new Error(goneSentence('supplier invoice'));
    }
    supplierId = invoice.supplierId;
  }

  // ⭐ **THE SAME FUNCTION THE COMPONENT CALLS** — T-266 §1, and the whole architectural point.
  // v1 kept the offered-methods rule in its editor and the validation rule in a separate
  // validator, and they drifted: `enabledPaymentMethods` is computed in v1's expense editor and
  // never passed to the component, so a store that disabled Credit still offers it.
  //
  // ⛔ Re-run server-side regardless of what the browser did (RULES rule 7 — no client-side-only
  // authorization). The sources are re-fetched here rather than trusted from the form, so a
  // hand-posted payload naming an account at another store, or a drained float, is refused.
  // T-369 S6b: the list the page offered, including another branch's accounts where the actor may move that money.
  const loaded = await loadMoneyLines(actor.orgId, storeId, actor);
  const sources = [...loaded.sources, ...loaded.otherStoreSources];
  const supplier = await withOrgPrincipal(actor.orgId, (tx) =>
    apRepo.getSupplierById(tx, actor.orgId, supplierId),
  );
  const issues = validateMoneyLines({
    direction: 'out',
    lines,
    sources,
    supplierId,
    supplierName: supplier?.name ?? null,
    supplierCreditTermsDays: supplier?.creditTermsDays ?? null,
  });
  if (issues.length > 0) {
    // One sentence, the first one — the form shows them all inline; this is the fallback for a
    // payload that never went through the component.
    throw new Error(issues[0]!.message);
  }

  const payments: ParsedExpenseForm['payments'] = lines.map((l) => ({
    method: l.method as ExpensePaymentMethod,
    amount: l.amount,
    staffId: l.staffId || undefined,
    cashRequestId: l.cashRequestId || undefined,
    moneyAccountId: l.moneyAccountId || undefined,
  }));

  return { storeId, supplierId, supplierInvoiceId, categoryId, particulars, payments, returnPath: returned.path, returnNav: { ...returned.nav, ...carry }, carry };
}

/**
 * ⭐ T-196 — creating no longer posts. `docs/tasks/196-draft-expense-on-a-pending-invoice.md` §3:
 * this now calls `createExpense`, never `recordExpenseForInvoice` — the result is a DRAFT, and
 * `create_expense` alone is sufficient to reach it. That is the whole point of the task: a
 * cashier can record what they spent, against the paper they are holding, with no manager
 * present and no verification wait. The invoice named may be `pending` OR `verified` — either
 * way this only ever drafts; posting still requires `approveExpense` (the expense's own detail
 * page offers it) or, for a pending invoice, waits for `verifyInvoice` to post it automatically.
 *
 * `recordExpenseForInvoiceAction` below is the OTHER entry point — unchanged, for the
 * already-verified case embedded on `/ap/invoices/[id]`, which still posts in one call.
 */
export async function createExpenseAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  let parsed: ParsedExpenseForm;
  try {
    parsed = await parseExpenseForm(formData, actor, '/expenses/new', ['create_expense']);
  } catch (err) {
    const returned = splitReturnTo(str(formData, 'returnTo'), '/expenses/new');
    return await redirectWithFlash(returned.path, { ...returned.nav, ...carryNav(formData) }, { error: errorMessage(err) });
  }

  let newId: string;
  try {
    const result = await withOrgPrincipal(actor.orgId, (tx) =>
      createExpense(tx, actor, {
        storeId: parsed.storeId,
        businessDate: '', // ignored — createExpense forces this from the invoice's own date
        categoryId: parsed.categoryId,
        supplierId: parsed.supplierId,
        supplierInvoiceId: parsed.supplierInvoiceId,
        particulars: parsed.particulars,
        payments: parsed.payments,
      }),
    );
    newId = result.id;
  } catch (err) {
    return await redirectWithFlash(parsed.returnPath, parsed.returnNav, { error: errorMessage(err) });
  }
  return await redirectWithFlash(`/expenses/${newId}`, parsed.carry);
}

/**
 * ⭐ T-196 — `recordExpenseForInvoice` stays, unchanged, for the already-verified case: the
 * embedded "record an expense" form on `/ap/invoices/[id]`, only ever shown once its invoice is
 * `verified` (that page's own `canRecord` check). A manager holding both `create_expense` and
 * `approve_expense` against a verified invoice should not be made to click twice — create then
 * separately approve — when one call already does both, in one transaction.
 */
export async function recordExpenseForInvoiceAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  let parsed: ParsedExpenseForm;
  try {
    parsed = await parseExpenseForm(formData, actor, '/ap', ['create_expense', 'approve_expense']);
  } catch (err) {
    const returned = splitReturnTo(str(formData, 'returnTo'), '/ap');
    return await redirectWithFlash(returned.path, { ...returned.nav, ...carryNav(formData) }, { error: errorMessage(err) });
  }

  let newId: string;
  try {
    // T-376 S1 (DEF-581), R5: `parseExpenseForm` already proved create_expense + approve_expense. The bill's date is
    // read on the server; the override is forwarded only when it falls in a CLOSED month.
    let periodOverride: ReturnType<typeof readPeriodOverride>;
    if (formData.get('periodOverrideConfirm') === 'on') {
      const invoice = await withOrgPrincipal(actor.orgId, (tx) =>
        apRepo.getSupplierInvoiceById(tx, actor.orgId, parsed.supplierInvoiceId),
      );
      if (invoice && closedMonthOf(await closedMonths(actor.orgId), invoice.invoiceDate)) {
        const problem = periodOverrideProblem(formData);
        if (problem) throw new Error(problem);
        periodOverride = readPeriodOverride(formData);
      }
    }
    const result = await withOrgPrincipal(actor.orgId, (tx) =>
      recordExpenseForInvoice(tx, actor, {
        storeId: parsed.storeId,
        supplierId: parsed.supplierId,
        supplierInvoiceId: parsed.supplierInvoiceId,
        categoryId: parsed.categoryId,
        particulars: parsed.particulars,
        payments: parsed.payments,
        ...(periodOverride ? { periodOverride } : {}),
      }),
    );
    newId = result.expenseId;
  } catch (err) {
    return await redirectWithFlash(parsed.returnPath, parsed.returnNav, { error: errorMessage(err) });
  }
  return await redirectWithFlash(`/expenses/${newId}`, parsed.carry);
}

export async function approveExpenseAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const expenseId = str(formData, 'expenseId');
  const nav = carryNav(formData);

  try {
    // T-369 S5b (DEF-314): the closed-month override is forwarded only when the EXPENSE's own date (read here,
    // never from the form) falls in a CLOSED month - otherwise an ordinary approval would leave an audit row.
    // T-364 order: nothing derived from the expense (its month, a sentence about it) is said until the actor has
    // proven `approve_expense` at the expense's store. A refusal here is the generic authorization one.
    const expense = await withOrgPrincipal(actor.orgId, async (tx) => {
      const found = await expensesRepo.getExpenseById(tx, actor.orgId, expenseId);
      if (found) await authorize(tx, actor, 'approve_expense', { storeId: found.storeId });
      return found;
    });
    const asked = readPeriodOverride(formData);
    const inClosedMonth = !!expense && !!closedMonthOf(await closedMonths(actor.orgId), expense.businessDate);
    const periodOverride = asked && inClosedMonth ? asked : undefined;
    const problem = inClosedMonth ? periodOverrideProblem(formData) : null;
    if (problem) throw new Error(problem);
    await withOrgPrincipal(actor.orgId, (tx) =>
      approveExpense(tx, actor, expenseId, periodOverride ? { periodOverride } : undefined),
    );
  } catch (err) {
    return await redirectWithFlash(`/expenses/${expenseId}`, nav, { error: errorMessage(err) });
  }
  return await redirectWithFlash(`/expenses/${expenseId}`, nav);
}

export async function voidExpenseAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const expenseId = str(formData, 'expenseId');
  const reason = str(formData, 'reason');
  const nav = carryNav(formData);

  try {
    await withOrgPrincipal(actor.orgId, (tx) => voidExpense(tx, actor, expenseId, reason));
  } catch (err) {
    return await redirectWithFlash(`/expenses/${expenseId}`, nav, { error: errorMessage(err) });
  }
  return await redirectWithFlash(`/expenses/${expenseId}`, nav);
}

/** The one edit surface this UI exposes: category, particulars and the receipt photo —
 *  covers the central draft-fixup case (attach a photo, correct the category) without
 *  building a full dynamic payment-row editor on top of the create form's (bible
 *  §0.2/§0.5 — "not licence for scope creep"). editExpense itself supports replacing
 *  payments too; a screen for that is a reasonable follow-up, not required for this task's
 *  smoketest. */
export async function updateDraftAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const expenseId = str(formData, 'expenseId');
  const nav = carryNav(formData);

  const categoryId = str(formData, 'categoryId');
  const particulars = str(formData, 'particulars');

  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      editExpense(tx, actor, expenseId, {
        categoryId: categoryId || undefined,
        particulars: particulars || undefined,
      }),
    );
  } catch (err) {
    return await redirectWithFlash(`/expenses/${expenseId}`, nav, { error: errorMessage(err), typed: keepTyping(formData, EXPENSE_DRAFT_EDIT, expenseId, { actorId: actor.personId }) });
  }
  return await redirectWithFlash(`/expenses/${expenseId}`, nav);
}

/** Deleting a DRAFT — Ian 2026-08-25: "delete for simplicity." Redirects to the LIST, not
 *  back to the record: there is no record any more, and sending the browser to a page that
 *  now 404s would make a successful delete look like a failure. */
export async function deleteDraftAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const expenseId = str(formData, 'expenseId');
  const nav = carryNav(formData);

  try {
    await withOrgPrincipal(actor.orgId, (tx) => deleteExpenseDraft(tx, actor, expenseId));
  } catch (err) {
    return await redirectWithFlash(`/expenses/${expenseId}`, nav, { error: errorMessage(err) });
  }
  return await redirectWithFlash('/expenses', nav);
}
