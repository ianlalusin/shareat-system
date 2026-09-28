/**
 * Owner equity — capital in, drawings out, and one register. T-127.
 *
 * ```
 * contribution   DR the money account      CR 3100 Owner's capital   (party = the owner)
 * drawing        DR 3200 Owner's drawings  CR the money account      (party = the owner)
 * ```
 *
 * ⭐ **`3200` is DEBIT-normal** — one of six accounts in the chart that break derive-from-type. A
 * drawing debits it to *increase* it, which *reduces* equity.
 *
 * ⛔ **No stored totals.** v1 keeps `totalCapital`, `totalDrawings` and `netEquity`, the last a
 * stored copy of a subtraction, plus a third copy in `EquityLedgerEntry` (DEF-072). Every figure
 * here is summed from the ledger by party.
 */
import { moneyAccountsRepo, ownersRepo, transaction, type Tx } from '@shareat/db';
import type { DrawingLimitPeriod, PersonalExpenseTreatment } from '@shareat/db/schema';
import { authorize, type Actor } from '@shareat/auth';
import { postEntry } from '../ledger/post-entry';
import { reverseEntry } from '../ledger/reverse-entry';
import { checkDraw } from '../money-accounts/overdraft';
import { parseMoneyInput } from '../shared/money-input';
import { refuse } from '../shared/refusal';

export const CAPITAL_CODE = '3100';
export const DRAWINGS_CODE = '3200';
/** Where a receivable goes when it is being recovered from pay — party_type `employee`. */
export const EMPLOYEE_ADVANCE_CODE = '1230';
// ⚠️ ONE definition, in routing.ts. Declaring a second here compiled fine and then collided at the
// package barrel — two constants named for the same account is how they drift apart.
import { DUE_FROM_OWNER_CODE } from '../expenses/routing';
export { DUE_FROM_OWNER_CODE };

// -------------------------------------------------------------------------------------
// Dates — the month is a unit here, so give it one home
// -------------------------------------------------------------------------------------

/** The first of the month containing `day`. ⚠️ String maths on purpose — no `Date`, no timezone. */
export function monthOf(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

/** The first of the month AFTER the one containing `day` — an exclusive upper bound. */
export function nextMonthOf(day: string): string {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  return month === 12
    ? `${year + 1}-01-01`
    : `${year}-${String(month + 1).padStart(2, '0')}-01`;
}

// -------------------------------------------------------------------------------------
// The register
// -------------------------------------------------------------------------------------

export interface CreateOwnerInput {
  storeId: string;
  personId: string;
  role?: string | null;
  ownershipPercentage?: string | null;
  drawingLimit?: string | null;
  drawingLimitPeriod?: DrawingLimitPeriod | null;
  personalExpenseTreatment?: PersonalExpenseTreatment;
  notes?: string | null;
}

export async function createOwner(
  tx: Tx | null,
  actor: Actor,
  input: CreateOwnerInput,
): Promise<{ id: string }> {
  const run = async (trx: Tx) => {
    // ⚠️ Admin, not manager. Who owns a store and what they may withdraw is a governance fact, not
    // a daily operation — the same reasoning that made renaming a money account admin-only.
    await authorize(trx, actor, 'manage_chart_of_accounts', { storeId: input.storeId });

    const limit =
      input.drawingLimit != null
        ? parseMoneyInput(input.drawingLimit, 'createOwner: the drawing limit', 'The drawing limit')
        : null;
    const period = input.drawingLimitPeriod ?? null;
    // ⛔ Half a rule is not a rule — DEF-071 is what the second half looks like in production.
    if ((limit === null) !== (period === null)) {
      throw new Error(
        'createOwner: a drawing limit needs a period and a period needs a limit — one without the ' +
          'other cannot be enforced, which is exactly the defect this replaces.',
      );
    }
    if (limit !== null && Number(limit) <= 0) {
      throw refuse('createOwner: a drawing limit has to be greater than zero.', 'A drawing limit has to be greater than zero.');
    }

    // T-343 S5.5s / DEF-470 item 3 — no parse existed at all: a raw comma-typed or out-of-range
    // string reached `numeric(6,3)` and the unmapped `owners_ownership_percentage_range_check`.
    let ownershipPercentage: string | null = null;
    if (input.ownershipPercentage != null) {
      const raw = input.ownershipPercentage;
      const t = raw.trim();
      if (!/^\d{1,3}(\.\d{1,3})?$/.test(t) || !(Number(t) > 0) || Number(t) > 100) {
        throw refuse(
          `createOwner: ownershipPercentage must be above 0 and at most 100 with at most three decimal places, got ${JSON.stringify(raw)}.`,
          `The ownership percentage — "${raw}" is not a percentage. Use a number above 0 and up to 100, with at most three decimal places.`,
        );
      }
      ownershipPercentage = t;
    }

    return ownersRepo.insertOwner(trx, {
      orgId: actor.orgId,
      storeId: input.storeId,
      personId: input.personId,
      role: input.role?.trim() || null,
      ownershipPercentage,
      drawingLimit: limit,
      drawingLimitPeriod: period,
      personalExpenseTreatment: input.personalExpenseTreatment ?? 'repayable',
      notes: input.notes?.trim() || null,
      createdBy: actor.personId,
    });
  };
  if (tx) return run(tx);
  return transaction(run);
}

// -------------------------------------------------------------------------------------
// Capital in
// -------------------------------------------------------------------------------------

export async function recordContribution(
  tx: Tx | null,
  actor: Actor,
  input: { ownerId: string; amount: string; intoMoneyAccountId: string; on: string; memo?: string },
): Promise<{ entryId: string }> {
  const run = async (trx: Tx) => {
    const owner = await ownersRepo.getById(trx, actor.orgId, input.ownerId);
    if (!owner) throw new Error(`recordContribution: owner ${input.ownerId} does not exist.`);
    await authorize(trx, actor, 'transfer_funds', { storeId: owner.storeId });

    const amount = parseMoneyInput(input.amount, 'recordContribution: the amount', 'The contribution amount');
    if (Number(amount) <= 0) {
      // ⚠️ S5.5v — converted to `refuse` (satisfies the ratchet, T-343 R1.2) with the SAME text on
      // both sides: the tester's followups file pins this exact lowercase sentence as UNCHANGED.
      throw refuse('recordContribution: a contribution has to be greater than zero.', 'a contribution has to be greater than zero.');
    }
    const account = await moneyAccountsRepo.getById(trx, actor.orgId, input.intoMoneyAccountId);
    if (!account) throw new Error('recordContribution: that money account does not exist.');
    // ⛔ Money lands in ONE store, like every other movement here (rows 152–153).
    if (account.storeId !== owner.storeId) {
      throw new Error(
        'recordContribution: that account belongs to another store — capital funds the store whose ' +
          'owner is contributing it.',
      );
    }

    const result = await postEntry(trx, {
      orgId: actor.orgId,
      entryDate: input.on,
      sourceType: 'capital_contribution',
      sourceId: owner.id,
      idempotencyKey: `owner:${owner.id}:contribution:${input.on}:${amount}`,
      memo: input.memo?.trim() || 'Capital contribution',
      postedBy: actor.personId,
      lines: [
        {
          accountCode: account.glAccountCode,
          storeId: owner.storeId,
          debit: amount,
          ...(account.glAccountCode === '1140'
            ? { partyType: 'money_account' as const, partyId: account.id }
            : {}),
        },
        {
          accountCode: CAPITAL_CODE,
          storeId: owner.storeId,
          credit: amount,
          partyType: 'owner' as const,
          partyId: owner.id,
        },
      ],
    });
    return { entryId: result.entryId };
  };
  if (tx) return run(tx);
  return transaction(run);
}

// -------------------------------------------------------------------------------------
// ⭐ Drawings, and the limit that DEF-071 never enforced
// -------------------------------------------------------------------------------------

export interface DrawingLimitVerdict {
  allowed: boolean;
  message?: string;
}

/**
 * ⭐ **Both periods, and both measured from the LEDGER.**
 *
 * ⛔ DEF-071: v1 accepts `'monthly' | 'total'`, writes both, **displays both back to the owner as a
 * live constraint**, and only ever checks `=== 'total'`. A monthly cap is shown and enforced by
 * nothing — worse than no cap, because a displayed limit is a control people stop watching.
 *
 * ⚠️ **The monthly window keys on the DRAWING's own date, not on today.** Measuring against today
 * would let a back-dated withdrawal slip a month that is already at its cap.
 *
 * ⚠️ v1's check reads `owner.totalDrawings`, one of three drifting stored figures — and a limit
 * computed from a drifting total fails in the direction of letting money out.
 */
export async function judgeDrawingLimit(
  tx: Tx,
  orgId: string,
  owner: {
    id: string;
    personId: string;
    drawingLimit: string | null;
    drawingLimitPeriod: DrawingLimitPeriod | null;
  },
  amount: number,
  on: string,
): Promise<DrawingLimitVerdict> {
  if (owner.drawingLimit === null || owner.drawingLimitPeriod === null) return { allowed: true };

  const limit = Number(owner.drawingLimit);
  const window =
    owner.drawingLimitPeriod === 'monthly'
      ? { since: monthOf(on), until: nextMonthOf(on) }
      : {};
  const already = Number(await ownersRepo.drawnInWindow(tx, orgId, owner, window));

  if (already + amount <= limit) return { allowed: true };

  const scope =
    owner.drawingLimitPeriod === 'monthly' ? `in ${on.slice(0, 7)}` : 'in total';
  return {
    allowed: false,
    message:
      `this would take ₱${(already + amount).toFixed(2)} ${scope}, over the ₱${limit.toFixed(2)} ` +
      `${owner.drawingLimitPeriod} limit (₱${already.toFixed(2)} already). ` +
      // ⚠️ Say WHY the figure may look higher than the drawings alone. Without this the number
      // reads as wrong, and a limit a reader thinks is broken is a limit they route around.
      `Unrepaid personal expenses count towards this — including any moved to a salary advance, ` +
      `since no cash has come back yet. Repaying one in cash makes room again.`,
  };
}

/** ⛔ The cut-off. A drawing dated into a closed month is refused, not quietly accepted. */
async function assertMonthOpen(
  tx: Tx,
  orgId: string,
  ownerId: string,
  on: string,
  context: string,
): Promise<void> {
  const close = await ownersRepo.closeFor(tx, orgId, ownerId, monthOf(on));
  if (close) {
    throw new Error(
      `${context}: ${on.slice(0, 7)} is closed for this owner — it was agreed at ` +
        `₱${close.acknowledgedAmount} on ${close.closedOn}. Post this in an open month, or reopen ` +
        `that one deliberately; back-dating into an agreed month is what makes the agreement stop ` +
        `being true.`,
    );
  }
}

export async function recordDrawing(
  tx: Tx | null,
  actor: Actor,
  input: { ownerId: string; amount: string; fromMoneyAccountId: string; on: string; memo?: string },
): Promise<{ entryId: string; warning?: string }> {
  const run = async (trx: Tx) => {
    const owner = await ownersRepo.getById(trx, actor.orgId, input.ownerId);
    if (!owner) throw new Error(`recordDrawing: owner ${input.ownerId} does not exist.`);
    await authorize(trx, actor, 'transfer_funds', { storeId: owner.storeId });

    const parsed = parseMoneyInput(input.amount, 'recordDrawing: the amount', 'The drawing amount');
    const amount = Number(parsed);
    if (amount <= 0) throw refuse('recordDrawing: a drawing has to be greater than zero.', 'A drawing has to be greater than zero.');

    await assertMonthOpen(trx, actor.orgId, owner.id, input.on, 'recordDrawing');

    // ⛔ BLOCKS, unlike the overdraft guard (row 154). There is no "unverified count" ambiguity in a
    // drawing limit: it is a decision the owners made about themselves, measured against an exact
    // figure.
    const verdict = await judgeDrawingLimit(trx, actor.orgId, owner, amount, input.on);
    if (!verdict.allowed) throw new Error(`recordDrawing: ${verdict.message}`);

    const account = await moneyAccountsRepo.getById(trx, actor.orgId, input.fromMoneyAccountId);
    if (!account) throw new Error('recordDrawing: that money account does not exist.');
    if (account.storeId !== owner.storeId) {
      throw new Error('recordDrawing: that account belongs to another store.');
    }
    const warning = await checkDraw(trx, actor.orgId, account, amount, 'recordDrawing');

    const result = await postEntry(trx, {
      orgId: actor.orgId,
      entryDate: input.on,
      sourceType: 'drawing',
      sourceId: owner.id,
      idempotencyKey: `owner:${owner.id}:drawing:${input.on}:${amount.toFixed(2)}`,
      memo: input.memo?.trim() || 'Owner drawing',
      postedBy: actor.personId,
      lines: [
        {
          accountCode: DRAWINGS_CODE,
          storeId: owner.storeId,
          debit: parsed,
          partyType: 'owner' as const,
          partyId: owner.id,
        },
        {
          accountCode: account.glAccountCode,
          storeId: owner.storeId,
          credit: parsed,
          ...(account.glAccountCode === '1140'
            ? { partyType: 'money_account' as const, partyId: account.id }
            : {}),
        },
      ],
    });
    return { entryId: result.entryId, ...(warning ? { warning } : {}) };
  };
  if (tx) return run(tx);
  return transaction(run);
}

// -------------------------------------------------------------------------------------
// ⭐ Clearing a `1260` receivable — the two settlements that actually recover money
// -------------------------------------------------------------------------------------

/** Shared ceiling: you cannot settle more than is owed. */
async function assertWithinReceivable(
  trx: Tx,
  orgId: string,
  ownerId: string,
  amount: number,
  context: string,
): Promise<void> {
  if (amount <= 0) throw refuse(`${context}: the amount has to be greater than zero.`, 'The amount settled has to be greater than zero.');
  const outstanding = Number(await ownersRepo.receivableOf(trx, orgId, ownerId));
  if (amount > outstanding + 0.005) {
    throw new Error(
      `${context}: that is more than the ₱${outstanding.toFixed(2)} this owner still owes. ` +
        `Settling more would turn a receivable into a payable without anyone deciding to.`,
    );
  }
}

/**
 * ⭐ **Settlement 1 — the owner hands cash back.** `DR the money account · CR 1260`.
 *
 * The receivable clears and the money is really in the till, so this is the only settlement that
 * frees the owner's drawing limit — see `drawnInWindow`.
 */
export async function repayFromOwner(
  tx: Tx | null,
  actor: Actor,
  input: { ownerId: string; amount: string; intoMoneyAccountId: string; on: string; memo?: string },
): Promise<{ entryId: string; outstanding: string }> {
  const run = async (trx: Tx) => {
    const owner = await ownersRepo.getById(trx, actor.orgId, input.ownerId);
    if (!owner) throw new Error(`repayFromOwner: owner ${input.ownerId} does not exist.`);
    await authorize(trx, actor, 'transfer_funds', { storeId: owner.storeId });
    const parsed = parseMoneyInput(input.amount, 'repayFromOwner: the amount', 'The amount settled');
    await assertWithinReceivable(trx, actor.orgId, owner.id, Number(parsed), 'repayFromOwner');

    const account = await moneyAccountsRepo.getById(trx, actor.orgId, input.intoMoneyAccountId);
    if (!account) throw new Error('repayFromOwner: that money account does not exist.');
    if (account.storeId !== owner.storeId) {
      throw new Error('repayFromOwner: that account belongs to another store.');
    }

    const result = await postEntry(trx, {
      orgId: actor.orgId,
      entryDate: input.on,
      sourceType: 'owner_repayment',
      sourceId: owner.id,
      idempotencyKey: `owner:${owner.id}:repayment:${input.on}:${Number(parsed).toFixed(2)}`,
      memo: input.memo?.trim() || 'Owner repayment',
      postedBy: actor.personId,
      lines: [
        {
          accountCode: account.glAccountCode,
          storeId: owner.storeId,
          debit: parsed,
          ...(account.glAccountCode === '1140'
            ? { partyType: 'money_account' as const, partyId: account.id }
            : {}),
        },
        {
          accountCode: DUE_FROM_OWNER_CODE,
          storeId: owner.storeId,
          credit: parsed,
          partyType: 'owner' as const,
          partyId: owner.id,
        },
      ],
    });
    return {
      entryId: result.entryId,
      outstanding: await ownersRepo.receivableOf(trx, actor.orgId, owner.id),
    };
  };
  if (tx) return run(tx);
  return transaction(run);
}

/**
 * ⭐ **Settlement 2 — recover it from their pay.** `DR 1230 · CR 1260`.
 *
 * The balance moves from *"the owner owes us"* to *"this is an advance against their wages"*, where
 * `1230` is the account payroll already nets salary advances out of. The party changes with it: the
 * owner on `1260`, the PERSON on `1230`, because `1230`'s party_type is `employee`.
 *
 * ⚠️ **This is a reclassification, not a recovery, and the distinction is deliberate.** No cash has
 * come back — payroll nets it when payroll runs, and v2 has no payroll module yet. So it does NOT
 * free the drawing limit: `drawnInWindow` counts `1230` for this person for exactly that reason.
 * Otherwise "recover from pay" would clear the cap the instant it was clicked, which is the same
 * bypass as marking every personal expense repayable, one step further along.
 *
 * ⛔ Refused for an owner with no employment: recovering from a salary nobody is paid is a
 * receivable quietly parked where nothing will ever collect it.
 */
export async function recoverFromPay(
  tx: Tx | null,
  actor: Actor,
  input: { ownerId: string; amount: string; on: string; memo?: string },
): Promise<{ entryId: string; outstanding: string }> {
  const run = async (trx: Tx) => {
    const owner = await ownersRepo.getById(trx, actor.orgId, input.ownerId);
    if (!owner) throw new Error(`recoverFromPay: owner ${input.ownerId} does not exist.`);
    await authorize(trx, actor, 'approve_expense', { storeId: owner.storeId });
    const parsed = parseMoneyInput(input.amount, 'recoverFromPay: the amount', 'The amount settled');
    await assertWithinReceivable(trx, actor.orgId, owner.id, Number(parsed), 'recoverFromPay');

    // ⚠️ The best check available until payroll exists: this person must actually work here. It does
    // not prove they are PAID — nothing can, yet — and the screens say so rather than implying it.
    const employed = await ownersRepo.personHoldsActiveRole(trx, actor.orgId, owner.personId);
    if (!employed) {
      throw new Error(
        'recoverFromPay: this owner holds no active role, so there is no pay to recover from. ' +
          'Take it back in cash, or write it off deliberately at the monthly close.',
      );
    }

    const result = await postEntry(trx, {
      orgId: actor.orgId,
      entryDate: input.on,
      sourceType: 'owner_pay_recovery',
      sourceId: owner.id,
      idempotencyKey: `owner:${owner.id}:pay-recovery:${input.on}:${Number(parsed).toFixed(2)}`,
      memo: input.memo?.trim() || 'Owner receivable moved to salary advance',
      postedBy: actor.personId,
      lines: [
        {
          accountCode: EMPLOYEE_ADVANCE_CODE,
          storeId: owner.storeId,
          debit: parsed,
          partyType: 'employee' as const,
          partyId: owner.personId,
        },
        {
          accountCode: DUE_FROM_OWNER_CODE,
          storeId: owner.storeId,
          credit: parsed,
          partyType: 'owner' as const,
          partyId: owner.id,
        },
      ],
    });
    return {
      entryId: result.entryId,
      outstanding: await ownersRepo.receivableOf(trx, actor.orgId, owner.id),
    };
  };
  if (tx) return run(tx);
  return transaction(run);
}

/**
 * ⭐ **Settlement 3 — give up on it.** `DR 3200 · CR 1260`.
 *
 * The moment a receivable stops being one and becomes a drawing. ⚠️ **And the moment it becomes a
 * distribution for tax purposes**, which is why it needs a person and a date rather than a rule: a
 * payment the business no longer expects back is a constructive dividend however it was labelled
 * when it happened.
 *
 * ⛔ **Nothing triggers this automatically, and nothing should.** *"If not paid"* has no date — that
 * was the flaw in the three-route cascade this design replaced. Someone decides, on a day, with a
 * reason, and their name is on it.
 *
 * ⭐ **The drawing limit needs no check here, and that falls out rather than being waived.** The
 * money already consumed the limit while it sat in `1260`; this moves it to `3200`, which is also
 * counted. Net effect: zero. So a write-off can always be recorded — the books can be cleaned up
 * even at a cap — without opening a way to exceed one.
 *
 * ⚠️ It IS a drawing, so it respects the monthly close: writing off into an agreed month is refused
 * the same way a back-dated drawing is.
 */
export async function writeOffReceivable(
  tx: Tx | null,
  actor: Actor,
  input: { ownerId: string; amount: string; reason: string; on: string },
): Promise<{ entryId: string; outstanding: string }> {
  const run = async (trx: Tx) => {
    const owner = await ownersRepo.getById(trx, actor.orgId, input.ownerId);
    if (!owner) throw new Error(`writeOffReceivable: owner ${input.ownerId} does not exist.`);
    // ⚠️ `approve_expense`, not `transfer_funds`. Deciding the business will never see money again
    // is an approval, and the person who took it should not be the one who forgives it.
    await authorize(trx, actor, 'approve_expense', { storeId: owner.storeId });

    const reason = input.reason.trim();
    if (!reason) {
      throw new Error(
        'writeOffReceivable: say why. A receivable that becomes a drawing with no reason is ' +
          'indistinguishable from one that was never collected because nobody looked.',
      );
    }
    const parsed = parseMoneyInput(input.amount, 'writeOffReceivable: the amount', 'The amount settled');
    await assertWithinReceivable(
      trx,
      actor.orgId,
      owner.id,
      Number(parsed),
      'writeOffReceivable',
    );
    await assertMonthOpen(trx, actor.orgId, owner.id, input.on, 'writeOffReceivable');

    const result = await postEntry(trx, {
      orgId: actor.orgId,
      entryDate: input.on,
      sourceType: 'owner_writeoff',
      sourceId: owner.id,
      idempotencyKey: `owner:${owner.id}:writeoff:${input.on}:${Number(parsed).toFixed(2)}`,
      memo: `Owner receivable written off — ${reason}`,
      postedBy: actor.personId,
      lines: [
        {
          accountCode: DRAWINGS_CODE,
          storeId: owner.storeId,
          debit: parsed,
          partyType: 'owner' as const,
          partyId: owner.id,
          lineMemo: reason,
        },
        {
          accountCode: DUE_FROM_OWNER_CODE,
          storeId: owner.storeId,
          credit: parsed,
          partyType: 'owner' as const,
          partyId: owner.id,
        },
      ],
    });
    return {
      entryId: result.entryId,
      outstanding: await ownersRepo.receivableOf(trx, actor.orgId, owner.id),
    };
  };
  if (tx) return run(tx);
  return transaction(run);
}

// -------------------------------------------------------------------------------------
// ⭐ The monthly drawings close
// -------------------------------------------------------------------------------------

export interface ClosePreview {
  periodMonth: string;
  /** What the ledger says this owner drew in the month — the figure being agreed to. */
  ledgerAmount: string;
  alreadyClosed: boolean;
}

/** What the closer is being asked to agree to, before they agree to it. */
export async function previewDrawingClose(
  tx: Tx | null,
  actor: Actor,
  input: { ownerId: string; month: string },
): Promise<ClosePreview> {
  const run = async (trx: Tx) => {
    const owner = await ownersRepo.getById(trx, actor.orgId, input.ownerId);
    if (!owner) throw new Error(`previewDrawingClose: owner ${input.ownerId} does not exist.`);
    await authorize(trx, actor, 'transfer_funds', { storeId: owner.storeId });

    const periodMonth = monthOf(input.month);
    const ledgerAmount = await ownersRepo.drawnInWindow(trx, actor.orgId, owner, {
      since: periodMonth,
      until: nextMonthOf(periodMonth),
    });
    const existing = await ownersRepo.closeFor(trx, actor.orgId, owner.id, periodMonth);
    return { periodMonth, ledgerAmount, alreadyClosed: Boolean(existing) };
  };
  if (tx) return run(tx);
  return transaction(run);
}

/**
 * Agree a month's drawings and shut it.
 *
 * > **Ian, 2026-08-27:** *"all drawings within the cut-off period is reconciled and recorded
 * > properly and acknowledge adjustment if any visible and enforced."*
 *
 * ⭐ **An adjustment POSTS.** If the agreed figure differs from the ledger, the difference is
 * booked — `DR 3200 / CR 1260` when the owner owes more than the ledger shows, and the reverse when
 * they owe less. ⛔ *"Visible and enforced"* means the books move; a close that recorded a
 * discrepancy as a note would be a report, not a control.
 *
 * ⚠️ Closing LOCKS the month for this owner: `recordDrawing` refuses to post into it afterwards.
 * Without that, someone back-dates a withdrawal and the agreed figure quietly stops being true.
 */
export async function closeDrawingMonth(
  tx: Tx | null,
  actor: Actor,
  input: {
    ownerId: string;
    month: string;
    /** What the closer says the month should be. Omit to agree with the ledger exactly. */
    acknowledgedAmount?: string;
    adjustmentReason?: string;
    on: string;
    notes?: string | null;
  },
): Promise<{ closeId: string; acknowledgedAmount: string; adjustmentAmount: string | null }> {
  const run = async (trx: Tx) => {
    const owner = await ownersRepo.getById(trx, actor.orgId, input.ownerId);
    if (!owner) throw new Error(`closeDrawingMonth: owner ${input.ownerId} does not exist.`);
    // ⚠️ `approve_expense`, not `transfer_funds`: agreeing a month is an approval, and the person
    // who took the money should not be the one who signs it off.
    await authorize(trx, actor, 'approve_expense', { storeId: owner.storeId });

    const periodMonth = monthOf(input.month);
    if (await ownersRepo.closeFor(trx, actor.orgId, owner.id, periodMonth)) {
      throw new Error(
        `closeDrawingMonth: ${periodMonth.slice(0, 7)} is already closed for this owner.`,
      );
    }
    // ⛔ Closing a month that has not finished would lock out drawings that legitimately belong in
    // it — the cut-off has to be behind the cut-off date.
    if (nextMonthOf(periodMonth) > input.on) {
      throw new Error(
        `closeDrawingMonth: ${periodMonth.slice(0, 7)} has not ended yet — a month cannot be agreed ` +
          `while drawings can still legitimately land in it.`,
      );
    }

    const ledger = Number(
      await ownersRepo.drawnInWindow(trx, actor.orgId, owner, {
        since: periodMonth,
        until: nextMonthOf(periodMonth),
      }),
    );
    const acknowledged =
      input.acknowledgedAmount === undefined
        ? ledger
        : Number(parseMoneyInput(input.acknowledgedAmount, 'closeDrawingMonth: the agreed amount', 'The agreed amount'));
    if (acknowledged < 0) {
      throw refuse('closeDrawingMonth: an agreed amount cannot be negative.', 'The agreed amount cannot be negative.');
    }

    const difference = Number((acknowledged - ledger).toFixed(2));
    let adjustmentEntryId: string | null = null;
    let adjustmentReason: string | null = null;

    if (difference !== 0) {
      const reason = input.adjustmentReason?.trim();
      // ⛔ An unexplained difference is not a close. This is the "enforced" half.
      if (!reason) {
        throw new Error(
          `closeDrawingMonth: the agreed ₱${acknowledged.toFixed(2)} differs from the ledger's ` +
            `₱${ledger.toFixed(2)} by ₱${difference.toFixed(2)} — say why. An unexplained ` +
            `difference cannot be posted, and a close that swallowed it would be a report, not a ` +
            `control.`,
        );
      }
      const magnitude = Math.abs(difference).toFixed(2);
      // ⭐ The adjustment moves between drawings and the owner receivable, because those are the two
      // things it can be: either more was drawn than the ledger caught, or something booked as a
      // drawing is actually owed back.
      const result = await postEntry(trx, {
        orgId: actor.orgId,
        entryDate: input.on,
        sourceType: 'drawing_close_adjustment',
        sourceId: owner.id,
        idempotencyKey: `owner:${owner.id}:close:${periodMonth}:adjustment`,
        memo: `Drawings close ${periodMonth.slice(0, 7)} — ${reason}`,
        postedBy: actor.personId,
        lines:
          difference > 0
            ? [
                { accountCode: DRAWINGS_CODE, storeId: owner.storeId, debit: magnitude, partyType: 'owner' as const, partyId: owner.id },
                { accountCode: DUE_FROM_OWNER_CODE, storeId: owner.storeId, credit: magnitude, partyType: 'owner' as const, partyId: owner.id },
              ]
            : [
                { accountCode: DUE_FROM_OWNER_CODE, storeId: owner.storeId, debit: magnitude, partyType: 'owner' as const, partyId: owner.id },
                { accountCode: DRAWINGS_CODE, storeId: owner.storeId, credit: magnitude, partyType: 'owner' as const, partyId: owner.id },
              ],
      });
      adjustmentEntryId = result.entryId;
      adjustmentReason = reason;
    }

    const close = await ownersRepo.insertClose(trx, {
      orgId: actor.orgId,
      storeId: owner.storeId,
      ownerId: owner.id,
      periodMonth,
      acknowledgedAmount: acknowledged.toFixed(2),
      adjustmentAmount: difference === 0 ? null : difference.toFixed(2),
      adjustmentReason,
      adjustmentEntryId,
      closedOn: input.on,
      closedBy: actor.personId,
      notes: input.notes?.trim() || null,
    });

    return {
      closeId: close.id,
      acknowledgedAmount: acknowledged.toFixed(2),
      adjustmentAmount: difference === 0 ? null : difference.toFixed(2),
    };
  };
  if (tx) return run(tx);
  return transaction(run);
}

/** ⚠️ Reversal, not deletion — the original and its mirror both stay on the ledger. */
export async function reverseOwnerEntry(
  tx: Tx | null,
  actor: Actor,
  input: { ownerId: string; entryId: string; reason: string },
): Promise<{ entryId: string }> {
  const run = async (trx: Tx) => {
    const owner = await ownersRepo.getById(trx, actor.orgId, input.ownerId);
    if (!owner) throw new Error(`reverseOwnerEntry: owner ${input.ownerId} does not exist.`);
    await authorize(trx, actor, 'transfer_funds', { storeId: owner.storeId });
    const reason = input.reason.trim();
    if (!reason) throw new Error('reverseOwnerEntry: say why this is being reversed.');
    const result = await reverseEntry(trx, {
      entryId: input.entryId,
      reason,
      reversedBy: actor.personId,
    });
    return { entryId: result.reversalEntryId };
  };
  if (tx) return run(tx);
  return transaction(run);
}
