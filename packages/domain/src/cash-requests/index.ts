/**
 * Cash requests — a float handed to a person, and what comes back. T-144, bible row 159.
 *
 * ```
 * release   DR 1120 staff float   CR the funding account
 * spend     DR the expense        CR 1120                  ← T-122 ALREADY DOES THIS
 * return    DR the funding acct   CR 1120
 * shortage  DR 1230 advances to employees  CR 1120
 *                                        → 1120 nets to ZERO
 * ```
 *
 * Verified against real v1 data: `POSTING-PATTERNS.md` §Cash request, **82 release legs, 52 return
 * legs**.
 *
 * ## ⚠️ The REQUEST posts nothing
 *
 * Asking for money is not a financial event (bible §16.10); only the release is. Posting on request
 * would show a float in someone's hands before anyone handed it over.
 */
import { authorize, type Actor } from '@shareat/auth';
import { add, compare, formatMoney, money, ZERO, type Money } from '@shareat/core/money';
import { logger } from '@shareat/core/logger';
import { toBusinessDate } from '@shareat/core/datetime';
import { auditLogRepo, cashRequestsRepo, moneyAccountsRepo, personsRepo, storesRepo, type Tx } from '@shareat/db';
import { checkDraw } from '../money-accounts/overdraft';
import { postEntry } from '../ledger/post-entry';
import { parseMoneyInput } from '../shared/money-input';
import { gone, refuse } from '../shared/refusal';
import { capAuditText } from '../shared/audit-text';
import { assertFieldRules } from '../shared/field-rules-assert';
import {
  CASH_REQUEST_APPROVE_RULES,
  CASH_REQUEST_CREATE_RULES,
  CASH_REQUEST_REFUSE_RULES,
  CASH_REQUEST_RELEASE_RULES,
  CASH_REQUEST_SETTLE_RULES,
} from '../field-rules/cash-requests';

export const STAFF_FLOAT_CODE = '1120';
/**
 * Where an unaccounted-for float lands: a receivable from the person who held it.
 * ⚠️ `1230 Advances to employees` — party-requiring, `party_type = 'employee'`, which is exactly
 * why a shortage here can never be charged to nobody.
 */
export const STAFF_ADVANCE_CODE = '1230';

export interface CreateCashRequestInput {
  storeId: string;
  requestedFor: string;
  purpose: string;
  amount: string;
  on: string;
  notes?: string | null;
}

/** ⚠️ Records the ask. **No money moves** — see the header. */
export async function createCashRequest(
  tx: Tx,
  actor: Actor,
  input: CreateCashRequestInput,
): Promise<{ id: string }> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'create_expense', { storeId: input.storeId });
    // T-440 / S9: the screen's own rules judge the boxes AFTER the gate (T-364 order). Moved here from the action.
    assertFieldRules(CASH_REQUEST_CREATE_RULES, {
      storeId: input.storeId,
      requestedFor: input.requestedFor,
      purpose: input.purpose,
      amount: input.amount,
      on: input.on,
    });
    const purpose = input.purpose.trim();
    if (!purpose) throw new Error('createCashRequest: say what the money is for.');
    const amount = parseMoneyInput(input.amount, 'createCashRequest: the amount', 'The amount requested');
    if (compare(amount, ZERO) <= 0) {
      throw refuse('createCashRequest: the amount has to be greater than zero.', 'The amount requested has to be greater than zero.');
    }
    return cashRequestsRepo.insertRequest(trx, {
      orgId: actor.orgId,
      storeId: input.storeId,
      requestedFor: input.requestedFor,
      purpose,
      requestedAmount: amount,
      requestedOn: input.on,
      notes: input.notes?.trim() || null,
      createdBy: actor.personId,
    });
  };
  return run(tx);
}

/**
 * Approve or refuse.
 *
 * ⚠️ **`approve_expense`, not `create_expense`** — asking for money and agreeing to hand it over
 * are two decisions, and letting one person do both unilaterally is the control this separates.
 */
export async function decideCashRequest(
  tx: Tx,
  actor: Actor,
  input:
    | { requestId: string; decision: 'approve'; amount: string; on?: string }
    | { requestId: string; decision: 'reject'; reason: string; on?: string },
): Promise<void> {
  const run = async (trx: Tx) => {
    const req = await cashRequestsRepo.getById(trx, actor.orgId, input.requestId);
    if (!req) throw new Error(`decideCashRequest: request ${input.requestId} does not exist.`);
    await authorize(trx, actor, 'approve_expense', { storeId: req.storeId });
    // T-440 / S9: the screen's own rules judge the boxes AFTER the gate (T-364 order). Moved here from the action.
    if (input.decision === 'reject') assertFieldRules(CASH_REQUEST_REFUSE_RULES, { reason: input.reason });
    else assertFieldRules(CASH_REQUEST_APPROVE_RULES, { amount: input.amount });

    // ⛔ v1's `decisionLocked`, as behaviour rather than a column: once money has moved, the
    // approval behind it cannot be edited. Changing it would rewrite the reason a payment happened.
    if (req.status !== 'requested') {
      throw new Error(`decideCashRequest: this request is already ${req.status}.`);
    }

    const on = input.on ?? toBusinessDate();
    if (input.decision === 'reject') {
      const reason = input.reason.trim();
      if (!reason) throw new Error('decideCashRequest: a refusal needs a reason.');
      await cashRequestsRepo.update(trx, actor.orgId, req.id, {
        status: 'rejected',
        rejectReason: reason,
        approvedBy: actor.personId,
        decidedOn: on,
      });
      // T-402 S3 (C4): the decision's event, same transaction, after its own write.
      await auditLogRepo.append(trx, actor.orgId, {
        actorPersonId: actor.personId,
        action: 'cash_request.rejected',
        storeId: req.storeId,
        entityId: req.id,
        before: { status: req.status },
        after: { status: 'rejected', reason: capAuditText(reason) },
        source: 'web',
      });
      return;
    }

    const approvedAmount = parseMoneyInput(input.amount, 'decideCashRequest: the approved amount', 'The approved amount');
    if (compare(approvedAmount, ZERO) <= 0) {
      throw refuse('decideCashRequest: an approved amount has to be greater than zero.', 'The approved amount has to be greater than zero.');
    }
    // ⚠️ Approving MORE than was asked for is allowed and is not an error — a manager may know the
    // errand costs more. Approving less is the common case.
    await cashRequestsRepo.update(trx, actor.orgId, req.id, {
      status: 'approved',
      approvedAmount,
      approvedBy: actor.personId,
      decidedOn: on,
    });
    await auditLogRepo.append(trx, actor.orgId, {
      actorPersonId: actor.personId,
      action: 'cash_request.approved',
      storeId: req.storeId,
      entityId: req.id,
      before: { status: req.status },
      after: { status: 'approved', amount: String(approvedAmount) },
      source: 'web',
    });
  };
  return run(tx);
}

/**
 * Withdraw a request before the money moves.
 *
 * ⭐ **`create_expense`, not `approve_expense`** — and that asymmetry is deliberate. Withdrawing
 * your own ask is not an approval decision; requiring a manager to un-ask would leave dead requests
 * sitting in the queue because the only person who could clear them had no reason to look.
 *
 * ⛔ **Only before release.** Once cash is in someone's hands there is nothing to cancel — that is a
 * return, and it posts. A status that could erase a released float would erase the float with it.
 */
export async function cancelCashRequest(
  tx: Tx,
  actor: Actor,
  input: { requestId: string; reason?: string },
): Promise<void> {
  const run = async (trx: Tx) => {
    const req = await cashRequestsRepo.getById(trx, actor.orgId, input.requestId);
    if (!req) throw new Error(`cancelCashRequest: request ${input.requestId} does not exist.`);
    await authorize(trx, actor, 'create_expense', { storeId: req.storeId });

    if (req.status !== 'requested' && req.status !== 'approved') {
      throw new Error(
        `cancelCashRequest: this request is ${req.status} — only one that has not been released can be withdrawn.`,
      );
    }
    await cashRequestsRepo.update(trx, actor.orgId, req.id, {
      status: 'cancelled',
      // ⚠️ The approval is CLEARED, not kept: leaving `approved_amount` on a cancelled row would
      // read as "approved for ₱2,000" in every list that shows the amount.
      approvedAmount: null,
      approvedBy: null,
      decidedOn: null,
      rejectReason: input.reason?.trim() || null,
    });
  };
  return run(tx);
}

/**
 * The money changes hands. **DR `1120` (party = this request) · CR the funding account.**
 *
 * ⭐ This is also where the release becomes visible to remittance, and nothing had to be added for
 * that: crediting `1110` reduces the cashier's net movement for the date, which is exactly what
 * T-143's end-day report sums. Ian's *"out = cash request released by cashier"* falls out.
 */
export async function releaseCashRequest(
  tx: Tx,
  actor: Actor,
  input: { requestId: string; amount: string; fromMoneyAccountId: string; on: string },
): Promise<{ entryId: string; warning?: string }> {
  const run = async (trx: Tx) => {
    const req = await cashRequestsRepo.getById(trx, actor.orgId, input.requestId);
    if (!req) throw new Error(`releaseCashRequest: request ${input.requestId} does not exist.`);
    await authorize(trx, actor, 'approve_expense', { storeId: req.storeId });
    // T-440 / S9: the screen's own rules judge the boxes AFTER the gate (T-364 order). Moved here from the action.
    assertFieldRules(CASH_REQUEST_RELEASE_RULES, { amount: input.amount, fromMoneyAccountId: input.fromMoneyAccountId, on: input.on });

    if (req.status !== 'approved') {
      throw new Error(
        `releaseCashRequest: this request is ${req.status} — only an approved one can be released.`,
      );
    }
    const amount = parseMoneyInput(input.amount, 'releaseCashRequest: the amount', 'The amount released');
    if (compare(amount, ZERO) <= 0) {
      throw refuse('releaseCashRequest: the amount released has to be greater than zero.', 'The amount released has to be greater than zero.');
    }
    // ⛔ The approval is the authority for the amount. Releasing more would make the approval
    // decorative.
    // T-371 R4: the stored approval is re-minted, never trusted as a bare string, before it is compared.
    if (compare(amount, req.approvedAmount == null ? ZERO : money(req.approvedAmount)) > 0) {
      throw new Error(
        `releaseCashRequest: ${amount} is more than the ${req.approvedAmount} approved.`,
      );
    }

    // DEF-159 / bible §16.10: "enforce liquidation before a new advance to the same person."
    // A float is created here (release), not at request or approval, so this is the one point
    // that actually creates the exposure the rule is protecting against.
    const openForPerson = (await cashRequestsRepo.openFloats(trx, actor.orgId)).filter(
      (r) => r.requestedFor === req.requestedFor,
    );
    if (openForPerson.length > 0) {
      const other = openForPerson[0]!;
      throw new Error(
        `releaseCashRequest: this person already holds an unliquidated float of ` +
          `${other.approvedAmount} (request ${other.id}, released ${other.releasedOn}). ` +
          'Liquidate it before releasing a new one.',
      );
    }

    const account = await moneyAccountsRepo.getById(trx, actor.orgId, input.fromMoneyAccountId);
    if (!account) throw new Error('releaseCashRequest: that money account does not exist.');
    // ⚠️ Cross-store funding is T-144 §6's named next slice — it needs the 1250/2150 pair, which
    // exists and is tested, but is not wired here.
    if (account.storeId !== req.storeId) {
      throw new Error(
        'releaseCashRequest: funding a float from another store is not built yet — it has to ' +
          'record what one store owes the other, and that is its own slice.',
      );
    }

    // T-139's rule: a cashier account warns, an office account refuses (row 154).
    const warning = await checkDraw(
      trx,
      actor.orgId,
      account,
      amount,
      'releaseCashRequest',
    );

    // ⭐ T-414 / R-AUTO (Ian, 2026-10-16): the store always has a staff cash account once a float is out, so the released
    // money has a place to go. Created here in the SAME transaction (idempotent under concurrency), audited only when made.
    const staffAccount = await moneyAccountsRepo.ensureStaffCashAccount(trx, actor.orgId, req.storeId);
    // T-415 (DEF-659): `null` means the account was NOT made (a same-name non-staff account exists). The release still
    // posts - it debits 1120 directly - but the releaser is told.
    let staffWarning: string | undefined;
    if (!staffAccount) {
      logger.warn({ storeId: req.storeId, cashRequestId: req.id }, 'releaseCashRequest: no staff cash account was made for the store');
      const storeName = (await storesRepo.getById(trx, actor.orgId, req.storeId))?.name ?? 'this store';
      staffWarning =
        `No staff cash account was made for this store: another money account already uses the name "Staff cash — ${storeName}". ` +
        'Rename it, then the next release makes one.';
    }
    if (staffAccount?.created) {
      await auditLogRepo.append(trx, actor.orgId, {
        actorPersonId: actor.personId,
        action: 'money_account.created',
        storeId: req.storeId,
        entityId: staffAccount.id,
        before: null,
        after: { name: staffAccount.name, custodian: 'staff', instrument: 'cash', glAccountCode: '1120', source: 'cash_request_release', cashRequestId: req.id },
        source: 'web',
      });
    }

    const result = await postEntry(trx, {
      orgId: actor.orgId,
      entryDate: input.on,
      sourceType: 'cash_request_release',
      sourceId: req.id,
      idempotencyKey: `cash-request:${req.id}:release`,
      memo: `Cash request released — ${req.purpose}`,
      postedBy: actor.personId,
      lines: [
        // ⭐ The party is the REQUEST. One staff-float account per store and two people able to
        // hold floats at once means the ACCOUNT cannot decompose itself — v1 knows the holder from
        // the request document, and pays for it by storing `remainingAmount` there.
        {
          accountCode: STAFF_FLOAT_CODE,
          storeId: req.storeId,
          debit: amount,
          partyType: 'cash_request' as const,
          partyId: req.id,
        },
        {
          accountCode: account.glAccountCode,
          storeId: req.storeId,
          credit: amount,
          ...(account.glAccountCode === '1140'
            ? { partyType: 'money_account' as const, partyId: account.id }
            : {}),
        },
      ],
    });

    await cashRequestsRepo.update(trx, actor.orgId, req.id, {
      status: 'released',
      releasedFromMoneyAccountId: account.id,
      releasedOn: input.on,
      releasedBy: actor.personId,
    });

    const allWarnings = [warning, staffWarning].filter((w): w is string => !!w).join(' ');
    return { entryId: result.entryId, ...(allWarnings ? { warning: allWarnings } : {}) };
  };
  return run(tx);
}

export interface SettleResult {
  /** ⚠️ One entry per EVENT — a return and a shortage are separate postings (see below). */
  entryIds: string[];
  outstanding: string;
  liquidated: boolean;
}

/**
 * What comes back, and what does not.
 *
 * - **Return** → DR the funding account · CR `1120`
 * - **Shortage** → DR `1230` advances to employees · CR `1120`
 *
 * ⛔ **A shortage needs a person, and here it is never in doubt** — the float was handed to
 * `requested_for`. That is the difference from a remittance variance, where FIFO's date says
 * nothing about who was holding the money (row 144): a float has a named holder by construction.
 */
export async function settleCashRequest(
  tx: Tx,
  actor: Actor,
  input: {
    requestId: string;
    returnedAmount?: string;
    shortAmount?: string;
    shortReason?: string;
    toMoneyAccountId?: string;
    on: string;
  },
): Promise<SettleResult> {
  const run = async (trx: Tx) => {
    // ⭐ T-415 (DEF-658): lock the request row BEFORE reading its status or balance, so a concurrent approve, AP payment,
    // settle or void is waited for and its committed result is what this settle reads.
    const [req] = await cashRequestsRepo.lockForSpend(trx, actor.orgId, [input.requestId]);
    if (!req) throw gone(`settleCashRequest: request ${input.requestId} does not exist.`, 'cash request');
    await authorize(trx, actor, 'approve_expense', { storeId: req.storeId });
    // T-440 / S9: the screen's own rules judge the boxes AFTER the gate (T-364 order). Moved here from the action.
    assertFieldRules(CASH_REQUEST_SETTLE_RULES, { returnedAmount: input.returnedAmount, shortAmount: input.shortAmount, on: input.on });
    const holder = (await personsRepo.getPersonById(trx, actor.orgId, req.requestedFor))?.displayName ?? 'The holder';
    if (req.status !== 'released') {
      throw refuse(
        `settleCashRequest: this request is ${req.status}, not released.`,
        `${holder}'s cash request is already ${req.status}, so there is nothing left to settle.`,
      );
    }

    const before = await cashRequestsRepo.floatPositionOf(trx, actor.orgId, req.id);
    // T-371: both figures stay branded Money end to end; an absent one is ZERO (it is not a column value — nothing is
    // written for it, its leg is simply not posted).
    const returned: Money =
      input.returnedAmount === undefined
        ? ZERO
        : parseMoneyInput(input.returnedAmount, 'settleCashRequest: the returned amount', 'The returned amount');
    const short: Money =
      input.shortAmount === undefined
        ? ZERO
        : parseMoneyInput(input.shortAmount, 'settleCashRequest: the short amount', 'The short amount');
    const held = money(before.outstanding);
    // T-343 S5.5s / DEF-470 item 6 — before "nothing to settle": a lone negative return used to read
    // as "nothing to settle", the wrong reason (an order bug, not a missing check).
    if (compare(returned, ZERO) < 0 || compare(short, ZERO) < 0) {
      throw refuse(
        'settleCashRequest: a returned or short amount cannot be negative.',
        'A returned or short amount cannot be negative.',
      );
    }
    if (compare(returned, ZERO) <= 0 && compare(short, ZERO) <= 0) {
      throw new Error('settleCashRequest: nothing to settle — give a return, a shortage, or both.');
    }
    // ⛔ You cannot account for more than is still held. The rest was spent, and spending is an
    // expense, not a settlement.
    // Both sides are (14,2), so the old half-centavo tolerance is exact equality in centavos.
    const accounted = add(returned, short);
    if (compare(accounted, held) > 0) {
      throw refuse(
        `settleCashRequest: ${accounted} is more than the ${before.outstanding} still held.`,
        `Only ${formatMoney(held)} is still held on this cash request. Anything spent is recorded as an expense, not settled here.`,
      );
    }
    if (compare(short, ZERO) > 0 && !input.shortReason?.trim()) {
      throw new Error('settleCashRequest: a shortage needs a reason.');
    }

    // ⭐ TWO EVENTS, TWO ENTRIES — and the first version got this wrong.
    //
    // Posting a return and a shortage as ONE entry with ONE credit to 1120 destroys the breakdown:
    // the combined leg cannot say how much came back and how much did not, and the position query
    // reported the whole thing as "returned". Its own test caught it.
    //
    // ⚠️ They are genuinely two events anyway — money arriving, and money failing to arrive — and
    // they can happen on different days. One entry each also means either can be reversed alone.
    const entryIds: string[] = [];

    if (compare(returned, ZERO) > 0) {
      if (!input.toMoneyAccountId) {
        throw new Error('settleCashRequest: say which account the money came back into.');
      }
      const account = await moneyAccountsRepo.getById(trx, actor.orgId, input.toMoneyAccountId);
      if (!account) throw new Error('settleCashRequest: that money account does not exist.');

      const r = await postEntry(trx, {
        orgId: actor.orgId,
        entryDate: input.on,
        sourceType: 'cash_request_return',
        sourceId: req.id,
        idempotencyKey: `cash-request:${req.id}:return:${input.on}:${returned}`,
        memo: `Cash request returned — ${req.purpose}`,
        postedBy: actor.personId,
        lines: [
          {
            accountCode: account.glAccountCode,
            storeId: req.storeId,
            debit: returned,
            ...(account.glAccountCode === '1140'
              ? { partyType: 'money_account' as const, partyId: account.id }
              : {}),
          },
          {
            accountCode: STAFF_FLOAT_CODE,
            storeId: req.storeId,
            credit: returned,
            partyType: 'cash_request' as const,
            partyId: req.id,
          },
        ],
      });
      entryIds.push(r.entryId);
    }

    if (compare(short, ZERO) > 0) {
      const r = await postEntry(trx, {
        orgId: actor.orgId,
        entryDate: input.on,
        sourceType: 'cash_request_shortage',
        sourceId: req.id,
        idempotencyKey: `cash-request:${req.id}:shortage:${input.on}:${short}`,
        memo: `Cash request shortage — ${req.purpose}`,
        postedBy: actor.personId,
        lines: [
          // ⭐ A receivable from the HOLDER, named on the line — 1230 is party-requiring, which is
          // why a float shortage can never be charged to nobody. ⚠️ Unlike a remittance variance,
          // there is nothing to work out here: the float was handed to this person.
          {
            accountCode: STAFF_ADVANCE_CODE,
            storeId: req.storeId,
            debit: short,
            partyType: 'employee' as const,
            partyId: req.requestedFor,
            lineMemo: input.shortReason?.trim(),
          },
          {
            accountCode: STAFF_FLOAT_CODE,
            storeId: req.storeId,
            credit: short,
            partyType: 'cash_request' as const,
            partyId: req.id,
          },
        ],
      });
      entryIds.push(r.entryId);
    }

    const after = await cashRequestsRepo.floatPositionOf(trx, actor.orgId, req.id);
    // ⭐ Zero closes it, and zero is the LEDGER's answer — the four postings net to nothing when the
    // request is done, which is the whole shape of a float.
    const liquidated = compare(money(after.outstanding), ZERO) <= 0;
    if (liquidated) {
      await cashRequestsRepo.update(trx, actor.orgId, req.id, { status: 'liquidated' });
    }

    return { entryIds, outstanding: after.outstanding, liquidated };
  };
  return run(tx);
}
