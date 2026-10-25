/**
 * Till custody — opening a shift, counting the till, closing it, and charging what is missing.
 * T-186. `docs/tasks/186-till-custody-shift.md`.
 *
 * ## ⭐ What this module makes true
 *
 * `remittance_variances` (T-143) rests on a sentence that was FALSE until this shipped:
 * *"once the till is counted daily and signed, a batch shortage cannot be a counting error."*
 * There was nowhere to record a count. This is that place — and it is also the first record that
 * lets a shortage **name a person**, which v1 cannot do (`cashierName` is a nullable free-text
 * string).
 *
 * ## ⚠️ Three variances, and confusing two of them charges the wrong person
 *
 * | | Compares | Who answers |
 * |---|---|---|
 * | `tillFloatOffTarget` (T-153) | **books' float position** vs target | ⛔ nobody — the office replenishes |
 * | **here** | **physical count** vs ledger | ⭐ the cashier |
 * | `remittance_variances` (T-143) | **batch** vs owed | whoever held the pool |
 */
import { money, compare, ZERO, type Money } from '@shareat/core/money';
import { authorize, type Actor } from '@shareat/auth';
import { moneyAccountsRepo, tillShiftsRepo, type Tx } from '@shareat/db';
import { postStaffShortageCharge } from '../shared/staff-shortage-charge';
import { parseMoneyInput } from '../shared/money-input';
import { refuse } from '../shared/refusal';

/** `1230 Advances to employees` — a receivable from the staffer, ⛔ never a P&L account. The same
 *  account `commissary/discrepancy.ts` and `cash-requests` already charge a person to. */
export const STAFF_ADVANCE_ACCOUNT = '1230';

export interface OpenShiftInput {
  storeId: string;
  businessDate: string;
  /** ⭐ The shift being taken over from. The handover chain, and the only record of whose custody
   *  the cash left. Omit for the first shift of a trading day. */
  prevShiftId?: string | null;
  /** ⚠️ A REFERENCE to attendance and nothing more — this module stores no clock times of its own. */
  attendanceDayId?: string | null;
  notes?: string | null;
}

export interface CountInput {
  shiftId: string;
  moment: 'open' | 'close';
  /** One entry per cash account counted. T-316: the float is a target on the single cashier drawer (1110), not a separate pot, so there is one cash row. */
  counts: { moneyAccountId: string; counted: string; notes?: string | null }[];
}

/**
 * Opens a custody period.
 *
 * ⛔ **A store may hold only one open shift**, and the database enforces it with a partial unique
 * index. This function converts that into a sentence a human can act on, because a raw
 * constraint-violation error at a till at 6am helps nobody.
 */
export async function openTillShift(
  tx: Tx,
  actor: Actor,
  input: OpenShiftInput,
): Promise<{ shiftId: string; shiftNo: number }> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'record_till_count', { storeId: input.storeId });

    const existing = await tillShiftsRepo.openShiftFor(trx, actor.orgId, input.storeId);
    if (existing) {
      throw new Error(
        `openTillShift: this store already has an open shift (no. ${existing.shiftNo} on ` +
          `${existing.businessDate}, opened by ${existing.openedByName ?? 'someone'}). ` +
          'Close it before opening another — two open shifts on one till means two people ' +
          'believe they hold the same cash.',
      );
    }

    if (input.prevShiftId) {
      const prev = await tillShiftsRepo.getShift(trx, actor.orgId, input.prevShiftId);
      if (!prev) {
        throw new Error('openTillShift: the shift being taken over from does not exist.');
      }
      if (prev.status !== 'closed') {
        throw new Error(
          'openTillShift: a shift can only be taken over from one that has been CLOSED. ' +
            'Cash cannot change hands while the person handing it over has not counted it.',
        );
      }
      if (prev.storeId !== input.storeId) {
        throw new Error('openTillShift: a handover cannot cross stores — that is a transfer.');
      }
      const successor = await tillShiftsRepo.successorOf(trx, actor.orgId, input.prevShiftId);
      if (successor) {
        throw new Error(
          'openTillShift: that shift has already been handed over. ⛔ A branching chain would ' +
            'let the same cash be inherited twice, by two people, both of whom could be charged.',
        );
      }
    }

    const shiftNo = await tillShiftsRepo.nextShiftNo(
      trx,
      actor.orgId,
      input.storeId,
      input.businessDate,
    );
    const shiftId = await tillShiftsRepo.createShift(trx, {
      orgId: actor.orgId,
      storeId: input.storeId,
      businessDate: input.businessDate,
      shiftNo,
      openedBy: actor.personId,
      prevShiftId: input.prevShiftId ?? null,
      attendanceDayId: input.attendanceDayId ?? null,
      notes: input.notes ?? null,
    });
    return { shiftId, shiftNo };
  };
  return run(tx);
}

/**
 * Records a physical count against one or more of the till's cash accounts.
 *
 * ⭐ **`expected` is captured HERE and stored**, which is the one deliberate exception to this
 * system's derive-on-read discipline. `balanceOf` has no `asOf`, and entries can be **backdated** —
 * an expense keyed tomorrow with today's date would change what "expected at close" evaluates to,
 * *after the count was taken and signed*. A count is an observation of a moment.
 */
export async function recordTillCount(
  tx: Tx,
  actor: Actor,
  input: CountInput,
): Promise<void> {
  const run = async (trx: Tx) => {
    const shift = await tillShiftsRepo.getShift(trx, actor.orgId, input.shiftId);
    if (!shift) throw new Error('recordTillCount: that shift does not exist.');
    await authorize(trx, actor, 'record_till_count', { storeId: shift.storeId });

    if (shift.status !== 'open') {
      throw new Error(
        `recordTillCount: this shift is ${shift.status}. ⛔ A closed shift's count is evidence ` +
          'somebody signed for — it is superseded by the next shift, never overwritten.',
      );
    }
    if (input.counts.length === 0) {
      throw new Error('recordTillCount: a count with no lines records nothing.');
    }

    for (const line of input.counts) {
      const account = await moneyAccountsRepo.getById(trx, actor.orgId, line.moneyAccountId);
      if (!account) {
        throw new Error(`recordTillCount: money account ${line.moneyAccountId} does not exist.`);
      }
      if (account.storeId !== shift.storeId) {
        throw new Error(
          'recordTillCount: that account belongs to another store. A till is counted against ' +
            'its own store’s accounts, or the variance lands on the wrong branch.',
        );
      }
      if (account.custodian !== 'cashier' || account.instrument !== 'cash') {
        throw new Error(
          `recordTillCount: ${account.name} is not a cashier cash account. ⚠️ An e-wallet ` +
            'balance is not something a person counts in a drawer, and asking for a physical ' +
            'count of one is how a made-up number enters the record.',
        );
      }

      const counted = parseMoneyInput(
        line.counted,
        `recordTillCount: the count for account ${account.id}`,
        `The count for ${account.name}`,
      );
      if (compare(counted, ZERO) < 0) {
        throw refuse(
          `recordTillCount: the count for account ${account.id} cannot be negative, got ${JSON.stringify(line.counted)}.`,
          `The count for ${account.name} cannot be negative.`,
        );
      }

      // ⭐ The ledger's answer, frozen at the moment of counting. See the docblock.
      const expected = await moneyAccountsRepo.balanceOf(trx, actor.orgId, {
        id: account.id,
        glAccountCode: account.glAccountCode,
        storeId: account.storeId,
      });

      await tillShiftsRepo.recordCount(trx, {
        shiftId: input.shiftId,
        moment: input.moment,
        moneyAccountId: line.moneyAccountId,
        counted,
        expected: money(expected),
        countedBy: actor.personId,
        notes: line.notes ?? null,
      });
    }
  };
  return run(tx);
}

/**
 * Closes the shift.
 *
 * ⛔ **A close REQUIRES a closing count on every account that was counted at open.** A shift that
 * opened with a count and closed without one is the exact hole this table was built to fill —
 * the money changed hands and nobody wrote down how much.
 */
export async function closeTillShift(
  tx: Tx,
  actor: Actor,
  input: { shiftId: string; notes?: string | null },
): Promise<void> {
  const run = async (trx: Tx) => {
    const shift = await tillShiftsRepo.getShift(trx, actor.orgId, input.shiftId);
    if (!shift) throw new Error('closeTillShift: that shift does not exist.');
    await authorize(trx, actor, 'record_till_count', { storeId: shift.storeId });

    if (shift.status !== 'open') {
      throw new Error(`closeTillShift: this shift is already ${shift.status}.`);
    }

    const counts = await tillShiftsRepo.countsFor(trx, input.shiftId);
    const closed = new Set(
      counts.filter((c) => c.moment === 'close').map((c) => c.moneyAccountId),
    );
    if (closed.size === 0) {
      throw new Error(
        'closeTillShift: record the closing count first. ⛔ A shift closed without one is ' +
          'the exact hole this record exists to fill — the money changed hands and nobody ' +
          'wrote down how much.',
      );
    }
    const missing = counts
      .filter((c) => c.moment === 'open' && !closed.has(c.moneyAccountId))
      .map((c) => c.moneyAccountName);
    if (missing.length > 0) {
      throw new Error(
        `closeTillShift: ${missing.join(', ')} was counted at open but not at close. ` +
          'Every pocket counted in must be counted out, or its variance is unattributable.',
      );
    }

    const ok = await tillShiftsRepo.closeShift(trx, actor.orgId, input.shiftId, {
      closedBy: actor.personId,
      notes: input.notes ?? null,
    });
    if (!ok) throw new Error('closeTillShift: the shift was closed by someone else first.');
  };
  return run(tx);
}

/**
 * ⭐ Charges a counted SHORTAGE to the cashier — T-153 §13.1, Ian's rule verbatim:
 *
 * > *"charge to cashier, then office will replenish on the day it is counted as short."*
 *
 * ```
 * Dr  1230  Advances to employees      party_type = 'employee'
 *     Cr  <the account that came up short>
 * ```
 *
 * ⚠️ **The office replenishment is NOT part of this posting.** It is an ordinary money transfer
 * that already exists (T-153 §3.4). Fusing the two would let the shortage vanish into a transfer
 * with nobody answering for it — the order is the control.
 *
 * ⛔ **An OVERAGE posts NOTHING**, and that is the correct implementation rather than a dodge
 * (T-153 §13.2). A physical overage is money that was never in the books: the ledger says the pot
 * holds its target, the pocket happens to hold more, and the extra goes to the tip box. Removing
 * money the ledger never knew about is not a ledger event. ⛔ Never `7350` (that is for a
 * *remittance* variance, where the money genuinely was the business's) and never an income account.
 */
export async function chargeTillShortage(
  tx: Tx,
  actor: Actor,
  input: { countLineId: string; personId: string; note?: string | null },
): Promise<{ posted: boolean; reason?: string }> {
  const run = async (trx: Tx): Promise<{ posted: boolean; reason?: string }> => {
    const line = await tillShiftsRepo.countLineWithShift(trx, actor.orgId, input.countLineId);
    if (!line) throw new Error('chargeTillShortage: that count does not exist.');

    // ⛔ Manager-and-above only. A cashier must never be able to charge, forgive, or write off
    // their own count — the asymmetry with `record_till_count` IS the control.
    await authorize(trx, actor, 'resolve_till_variance', { storeId: line.storeId });

    if (!input.personId) {
      throw new Error(
        'chargeTillShortage: charging a shortage needs a person. ⛔ Inferring one from the ' +
          'date is the wrong inference — the same refusal bible row 128 requires of remittance.',
      );
    }

    const variance: Money = money(line.variance);
    const cmp = compare(variance, ZERO);

    if (cmp === 0) {
      return { posted: false, reason: 'The count matched the ledger — there is nothing to charge.' };
    }
    if (cmp > 0) {
      // ⭐ Doing nothing IS the implementation. See the docblock.
      return {
        posted: false,
        reason:
          'Counted OVER. ⛔ An overage posts nothing at all — it is money that was never in ' +
          'the books, and it goes to the tip box. The ledger was right before and after.',
      };
    }

    // Short: the variance is negative, so the amount charged is its magnitude.
    const amount = money(variance.toString().replace('-', ''));

    await postStaffShortageCharge(trx, {
      orgId: actor.orgId,
      storeId: line.storeId,
      personId: input.personId,
      amount,
      creditAccountCode: line.glAccountCode,
      // No credit-line party: HEAD's till credit line carries none (T-366 S2 R8 — byte-identical).
      entryDate: line.businessDate,
      sourceType: 'tillcountshortage',
      sourceId: input.countLineId,
      // ⚠️ Derived from the count line, never from a timestamp — a double-click must be a no-op.
      idempotencyKey: `tillcount:${input.countLineId}:shortage`,
      memo:
        input.note?.trim() ||
        `Counted shortage on ${line.moneyAccountName}, shift ${line.shiftNo} ${line.businessDate}`,
      postedBy: actor.personId,
    });

    return { posted: true };
  };
  return run(tx);
}
