/**
 * Pooled remittance — one handover settling many end-day reports. T-143.
 * Bible rows 128–129, 144–147, **157**.
 *
 * ## ⭐ What is remitted is the END-DAY REPORT, not the sales report
 *
 * > **Ian, 2026-08-27:** *"Remittance is derived from sales report — they are one, actually. It
 * > must be END DAY REPORT, not sales report. The sales report is PART of that remittance /
 * > end-day report… the composition of all money movement of the day across transactions, on ERP."*
 *
 * So a day is owed **the cashier's net movement for that date**, not its remittable sales. The
 * sales day stays the POS-sourced sales component and, critically, the **lock**: a date becomes
 * remittable when its sales day is verified.
 *
 * ## ⭐ And a remittance IS a transfer, with allocations attached
 *
 * ⛔ **Nothing here posts to the ledger.** Each line moves through `createMoneyTransfer` like any
 * other cashier→office transfer, and `remittance_lines.money_transfer_id` records which one. One
 * posting path. Growing a second is exactly how v1 ended up with two amortisation runners that
 * drifted apart.
 */
import { authorize, type Actor } from '@shareat/auth';
import {
  REMITTANCE_CADENCES,
  moneyAccountsRepo,
  remittanceRepo,
  storesRepo,
  transaction,
  type RemittanceCadence,
  type Tx,
} from '@shareat/db';
import { add, money, type Money } from '@shareat/core/money';
import { createMoneyTransfer, voidMoneyTransfer } from '../money-transfers';
import { allocateFifo, type DayOwed } from './allocate';

export { allocateFifo } from './allocate';
export type { DayOwed, Allocation, AllocationResult } from './allocate';

export interface RemittanceLineInput {
  fromMoneyAccountId: string;
  toMoneyAccountId: string;
  amount: string;
}

export interface CreateRemittanceInput {
  storeId: string;
  remittedOn: string;
  /** One per money account handed over — the till and the wallet remit separately. */
  lines: RemittanceLineInput[];
  acceptedBy?: string | null;
  reference?: string | null;
  notes?: string | null;
}

export interface CreateRemittanceResult {
  id: string;
  /** What was actually handed over, across every line. */
  handedOver: string;
  settled: { businessDate: string; amount: string }[];
  /** ⚠️ Signed: negative short, positive over. Null when it balanced exactly. */
  variance: string | null;
  varianceId: string | null;
}

export async function createRemittance(
  tx: Tx | null,
  actor: Actor,
  input: CreateRemittanceInput,
): Promise<CreateRemittanceResult> {
  if (tx) return runCreate(tx, actor, input);
  return transaction((trx) => runCreate(trx, actor, input));
}

async function runCreate(
  tx: Tx,
  actor: Actor,
  input: CreateRemittanceInput,
): Promise<CreateRemittanceResult> {
  // DEF-052 records that in v1 this grant enforced NOTHING. It needs a denial test, and it has one.
  await authorize(tx, actor, 'accept_remittance', { storeId: input.storeId });

  if (input.lines.length === 0) {
    throw new Error('createRemittance: a remittance has to hand over something.');
  }

  // ⚠️ Every line must run cashier → office. A remittance that moved money the other way would be
  // a float top-up wearing a remittance's name, and would settle days it never funded.
  for (const line of input.lines) {
    const from = await moneyAccountsRepo.getById(tx, actor.orgId, line.fromMoneyAccountId);
    const to = await moneyAccountsRepo.getById(tx, actor.orgId, line.toMoneyAccountId);
    if (!from || !to) throw new Error('createRemittance: a line names an account that does not exist.');
    if (from.custodian !== 'cashier' || to.custodian !== 'office') {
      throw new Error(
        `createRemittance: a remittance moves money from the cashier to the office, and ` +
          `"${from.name}" (${from.custodian}) → "${to.name}" (${to.custodian}) does not.`,
      );
    }
  }

  const handedOver: Money = input.lines.reduce((sum, l) => add(sum, money(l.amount)), money('0'));

  // ⭐ What the days are owed, oldest first — derived from the ledger, never from a column.
  // ⚠️ Only VERIFIED days: an unverified one has no signed count behind it, so there is nothing to
  // settle against.
  const reports = await remittanceRepo.endDayReports(tx, actor.orgId, {
    storeId: input.storeId,
    upTo: input.remittedOn,
  });
  const settleable = reports.filter((r) => r.remittable && Number(r.owed) > 0);
  const days: DayOwed[] = settleable.map((r) => ({
    salesDayId: r.businessDate, // ⚠️ keyed by DATE (row 157), not by sales-day id
    businessDate: r.businessDate,
    owed: money(Number(r.owed).toFixed(2)),
  }));

  const result = allocateFifo(days, handedOver);

  const { id } = await remittanceRepo.insertRemittance(tx, {
    orgId: actor.orgId,
    storeId: input.storeId,
    remittedOn: input.remittedOn,
    reference: input.reference?.trim() || null,
    notes: input.notes?.trim() || null,
    acceptedBy: input.acceptedBy ?? actor.personId,
    createdBy: actor.personId,
  });

  // ⭐ The money moves through the ONE transfer path. Each line is an ordinary cashier→office
  // transfer, and it inherits every rule T-139 already enforces — including the cashier overdraft
  // WARNING (row 154), which is exactly right here: the till holds what the ledger cannot see
  // until the day is verified.
  for (const line of input.lines) {
    const transfer = await createMoneyTransfer(tx, actor, {
      fromMoneyAccountId: line.fromMoneyAccountId,
      toMoneyAccountId: line.toMoneyAccountId,
      amountOut: line.amount,
      amountIn: line.amount,
      transferDate: input.remittedOn,
      reference: input.reference ?? null,
      notes: `Remittance ${input.remittedOn}`,
    });
    await remittanceRepo.insertLine(tx, {
      remittanceId: id,
      fromMoneyAccountId: line.fromMoneyAccountId,
      toMoneyAccountId: line.toMoneyAccountId,
      amount: line.amount,
      moneyTransferId: transfer.id,
    });
  }

  const byDate = new Map(settleable.map((r) => [r.businessDate, r]));
  for (const a of result.allocations) {
    await remittanceRepo.insertAllocation(tx, {
      remittanceId: id,
      businessDate: a.salesDayId,
      salesDayId: byDate.get(a.salesDayId)?.salesDayId ?? null,
      amount: String(a.amount),
    });
  }

  let varianceId: string | null = null;
  if (Number(result.variance) !== 0 && result.varianceDayId) {
    // ⛔ Recorded OPEN, with nobody attached. FIFO put the residual on this date; that says nothing
    // about who was holding the money. Charging it requires a person, named by a human (row 144).
    const row = await remittanceRepo.insertVariance(tx, {
      orgId: actor.orgId,
      remittanceId: id,
      businessDate: result.varianceDayId,
      salesDayId: byDate.get(result.varianceDayId)?.salesDayId ?? null,
      amount: String(result.variance),
    });
    varianceId = row.id;
  }

  return {
    id,
    handedOver: String(handedOver),
    settled: result.allocations.map((a) => ({
      businessDate: a.salesDayId,
      amount: String(a.amount),
    })),
    variance: Number(result.variance) === 0 ? null : String(result.variance),
    varianceId,
  };
}

/**
 * ⛔ Reverse, never delete. Each line's transfer is reversed through `reverseEntry`, and the
 * allocations stop counting because the remittance is no longer `posted` — so the days it settled
 * become unsettled again, derived rather than repaired.
 */
export async function reverseRemittance(
  tx: Tx | null,
  actor: Actor,
  input: { remittanceId: string; reason: string; reversedOn?: string },
): Promise<void> {
  const run = async (trx: Tx) => {
    const remittance = await remittanceRepo.getById(trx, actor.orgId, input.remittanceId);
    if (!remittance) {
      throw new Error(`reverseRemittance: remittance ${input.remittanceId} does not exist.`);
    }
    await authorize(trx, actor, 'accept_remittance', { storeId: remittance.storeId });

    const reason = input.reason.trim();
    if (!reason) throw new Error('reverseRemittance: a reason is required.');
    if (remittance.status !== 'posted') {
      throw new Error(`reverseRemittance: this remittance is already ${remittance.status}.`);
    }

    for (const line of await remittanceRepo.linesFor(trx, remittance.id)) {
      await voidMoneyTransfer(trx, actor, {
        moneyTransferId: line.moneyTransferId,
        reason: `Remittance reversed: ${reason}`,
        voidDate: input.reversedOn,
      });
    }

    await remittanceRepo.markReversed(trx, actor.orgId, remittance.id, {
      reversedOn: input.reversedOn ?? remittance.remittedOn,
      reverseReason: reason,
    });
  };
  if (tx) return run(tx);
  return transaction(run);
}

/**
 * Closes an open variance — by charging a named person, or by writing it off with a reason.
 *
 * ⛔ **A shortage cannot be charged to nobody.** v1's remittance builder throws rather than infer a
 * `chargeToStaffId`, and that refusal is ported here AND in a CHECK constraint, because inferring
 * the person from the date is exactly the wrong inference: FIFO put the residual on that date, and
 * the date says nothing about who was holding the money (bible rows 128, 144).
 */
export async function resolveRemittanceVariance(
  tx: Tx | null,
  actor: Actor,
  input:
    | { varianceId: string; action: 'charge'; personId: string; reason?: string | null; on?: string }
    | { varianceId: string; action: 'write_off'; reason: string; on?: string },
): Promise<void> {
  const run = async (trx: Tx) => {
    // ⚠️ The store comes from the variance's remittance — `accept_remittance` is store-scoped, so
    // gating this without one would either fail loudly or, worse, not gate at all.
    const variance = await remittanceRepo.getVarianceWithStore(trx, actor.orgId, input.varianceId);
    if (!variance) {
      throw new Error(`resolveRemittanceVariance: variance ${input.varianceId} does not exist.`);
    }
    await authorize(trx, actor, 'accept_remittance', { storeId: variance.storeId });

    if (input.action === 'charge') {
      if (!input.personId) {
        throw new Error(
          'resolveRemittanceVariance: charging a shortage needs a person. The date FIFO left it ' +
            'on says where the arithmetic stopped, not who was holding the money.',
        );
      }
      await remittanceRepo.resolveVariance(trx, actor.orgId, input.varianceId, {
        status: 'charged',
        chargedToPersonId: input.personId,
        reason: input.reason?.trim() || null,
        resolvedBy: actor.personId,
        resolvedOn: input.on ?? new Date().toISOString().slice(0, 10),
      });
      return;
    }

    const reason = input.reason.trim();
    if (!reason) {
      throw new Error('resolveRemittanceVariance: writing a variance off needs a reason.');
    }
    await remittanceRepo.resolveVariance(trx, actor.orgId, input.varianceId, {
      status: 'written_off',
      chargedToPersonId: null,
      reason,
      resolvedBy: actor.personId,
      resolvedOn: input.on ?? new Date().toISOString().slice(0, 10),
    });
  };
  if (tx) return run(tx);
  return transaction(run);
}

/**
 * A date's remittance state, derived. ⚠️ `partially_remitted` keeps v1's word but is NOT a column
 * — `sales_days`' own header forbids one as *"precisely the shape that blocks pooling."*
 */
export function remittanceStateOf(report: {
  movement: string;
  allocated: string;
}): 'nothing_owed' | 'unremitted' | 'partially_remitted' | 'remitted' {
  const owed = Number(report.movement);
  const done = Number(report.allocated);
  // ⚠️ A day the cashier paid MORE out of than came in owes nothing — the office is out of pocket,
  // not the till. Calling that "not remitted" would put it on a list of things somebody has to
  // chase, which is the opposite of true.
  if (owed <= 0 && done <= 0) return 'nothing_owed';
  if (done <= 0) return 'unremitted';
  if (done >= owed) return 'remitted';
  return 'partially_remitted';
}

// -------------------------------------------------------------------------------------
// T-152 — the cash-custody policy
// -------------------------------------------------------------------------------------

/**
 * Set a store's remittance cadence and un-remitted ceiling. Bible row 129.
 *
 * ⭐ **`manage_store_settings`, not `accept_remittance`.** Accepting a handover is an operational
 * act a cashier's supervisor does daily; deciding how much cash may sit in a drawer is a policy
 * that governs it. Row 129: *"a peso ceiling and an imprest amount are business policy, and they
 * belong to whoever carries the risk."* Gating both on one capability would let whoever accepts
 * remittances also raise the ceiling they are measured against.
 *
 * ⛔ **The safe-combination rule is NOT re-checked here.** `stores_pooling_requires_ceiling_check`
 * refuses a non-daily cadence with no ceiling in the database, and bible §6.3 is explicit that a
 * second copy in TypeScript is a second source of truth. A violation arrives as the constraint's
 * own error, which is the one that cannot drift.
 */
export async function setStoreCashPolicy(
  tx: Tx,
  actor: Actor,
  input: {
    storeId: string;
    remittanceCadence: RemittanceCadence;
    unremittedCeiling: string | null;
  },
): Promise<void> {
  await authorize(tx, actor, 'manage_store_settings', { storeId: input.storeId });

  if (!REMITTANCE_CADENCES.includes(input.remittanceCadence)) {
    throw new Error(
      `setStoreCashPolicy: ${input.remittanceCadence} is not a cadence. ` +
        `Expected one of ${REMITTANCE_CADENCES.join(', ')}.`,
    );
  }

  await storesRepo.setCashPolicy(tx, actor.orgId, input);
}
