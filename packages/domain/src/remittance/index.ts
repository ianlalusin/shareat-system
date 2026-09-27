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
import { add, compare, formatMoney, money, subtract, type Money } from '@shareat/core/money';
import { createMoneyTransfer, voidMoneyTransfer } from '../money-transfers';
import { parseMoneyInput } from '../shared/money-input';
import { allocateFifo, type DayOwed } from './allocate';

export { allocateFifo } from './allocate';
export type { DayOwed, Allocation, AllocationResult } from './allocate';

export interface RemittanceLineInput {
  fromMoneyAccountId: string;
  toMoneyAccountId: string;
  amount: string;
  /**
   * How much MORE than this account can account for the person is knowingly handing over.
   *
   * Read by both caps in `runCreate`: per-account (check 1) and pooled (check 2). Absent or empty
   * means zero for the comparison and is stored as NULL — NULL is "never asked", `'0'` is "I
   * declare no overage" (`packages/core/src/money.ts:15-16`). Negative is refused.
   *
   * ⚠️ This comment previously read "DECLARED, UNREAD, AND DELIBERATELY SO UNTIL THE BUILDER LANDS
   * THE CAP" / "Nothing reads this yet". That was true when the field was pre-wired so the tester's
   * §7.4 cases would fail on the ASSERTION rather than on a typecheck error for a missing symbol.
   * T-324 slice A (`1404609`) landed the cap and both checks now read it, which made those two
   * sentences false in committed code. **Nothing in slice A's diff touched this comment** — it went
   * stale because of a change made elsewhere, which is bible row 214's mirror, and it was caught by
   * the slice B builder reading the file rather than by any review of the diff that broke it.
   *
   * ⭐ See `docs/tasks/324-cap-the-cash-handover.md` §3.5 — the ruling that this figure is
   * deliberately UNBOUNDED lives there and nowhere else. ⚠️ That pointer was in the sentences this
   * comment replaced and the rewrite dropped it; restored after the auditor caught it. A rewrite is
   * a deletion, and a citation is part of the removed side even when every sentence around it was
   * replaced with a truer one.
   */
  declaredOverage?: string | null;
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
  // ⭐ T-324: also collects each `fromMoneyAccountId`'s name, for check 1's refusal message below —
  // one lookup, not a second round trip once the cap needs to name an account.
  const fromAccountNames = new Map<string, string>();
  for (const line of input.lines) {
    const from = await moneyAccountsRepo.getById(tx, actor.orgId, line.fromMoneyAccountId);
    const to = await moneyAccountsRepo.getById(tx, actor.orgId, line.toMoneyAccountId);
    if (!from || !to) throw new Error('createRemittance: a line names an account that does not exist.');
    fromAccountNames.set(line.fromMoneyAccountId, from.name);
    if (from.custodian !== 'cashier' || to.custodian !== 'office') {
      throw new Error(
        `createRemittance: a remittance moves money from the cashier to the office, and ` +
          `"${from.name}" (${from.custodian}) → "${to.name}" (${to.custodian}) does not.`,
      );
    }
    // ⛔ T-153 — A TILL FLOAT IS NEVER REMITTED, and the custodian check above cannot catch it:
    // a float pot IS custodian 'cashier', so without this it would sit in the remittance picker
    // one click from being handed to the office.
    //
    // > **Ian, 2026-08-29:** *"extra cash float that is NOT remitted to the manager or admin — it
    // > sits on till forever… separated from the money being remitted."*
    //
    // ⚠️ A service-layer rule rather than a database one on purpose: the money may legitimately
    // leave this account (an expense paid from the float, a transfer resizing it). What is refused
    // is this DOCUMENT moving it — which is a question about the document, not about the value.
    if (from.floatTarget !== null) {
      throw new Error(
        `createRemittance: "${from.name}" is a till float, and a float is never remitted — it ` +
          'sits in the till and is counted against its target. Remit the takings drawer instead.',
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

  // ⛔⛔ DEF-358/T-319 — REFUSE BEFORE ANY WRITE. Placed here, immediately after `settleable` is
  // computed and BEFORE `insertRemittance` and the transfer loop below: those move real money and
  // write real rows, and a refusal placed after either of them would leave that damage done for a
  // call that then throws. Without this, an empty `settleable` reaches `allocateFifo` with `days:
  // []`, which returns a non-zero `variance` and a null `varianceDayId` (nothing to attribute it
  // to) — and the guard at this file's variance write below treats a null `varianceDayId` as "skip
  // the row", so the cash moves through the transfer loop and NOTHING records the gap. That is
  // DEF-358, reproduced with a real red control in `remittance.test.ts` before this existed.
  //
  // Two distinct refusals, not one: the remedy differs, and a single message would send someone to
  // verify a day that is already verified and already fully settled.
  if (settleable.length === 0) {
    if (!reports.some((r) => r.remittable)) {
      throw new Error(
        `createRemittance: no sales day at or before ${input.remittedOn} has been verified yet — ` +
          'verify a day before remitting.',
      );
    }
    throw new Error(
      `createRemittance: every verified day at or before ${input.remittedOn} already owes ` +
        'nothing — there is nothing to settle.',
    );
  }

  // ⛔⛔ T-324 — CAP THE HANDOVER, PER CASHIER ACCOUNT. Placed here, after the refusal above and
  // BEFORE `insertRemittance` and the transfer loop below, so nothing is written when either of
  // the two checks fires. A single pooled cap (check 2 alone) is defeated, centavo for centavo, by
  // a store's default two-cashier-account shape — spec §3.1 — so check 1 below closes that hole
  // per account.
  const settleableDates = settleable.map((r) => r.businessDate);
  let movementByAccount: Map<string, string>;
  try {
    movementByAccount = await remittanceRepo.cashierMovementByAccount(
      tx,
      actor.orgId,
      input.storeId,
      settleableDates,
    );
  } catch (err) {
    // Re-prefixed: the ambiguous-configuration refusal originates in the repo read, but it is a
    // createRemittance refusal from every caller's point of view.
    throw new Error(`createRemittance: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Parse and validate the declared overage per line. Absent/empty ⇒ zero for comparison, stored
  // as NULL ("never asked"); an explicit "0" compares as zero and is stored as "0.00" ("I declare
  // no overage") — packages/core/src/money.ts:15-16, zero is a legitimate value, not "unset".
  const linesWithOverage = input.lines.map((line) => {
    const raw = line.declaredOverage;
    const isAbsent = raw == null || raw.trim() === '';
    const declared: Money = isAbsent
      ? money('0')
      : parseMoneyInput(raw, 'createRemittance: the declared overage', 'A declared overage');
    if (compare(declared, money('0')) < 0) {
      throw new Error(`createRemittance: a declared overage cannot be negative — "${raw}" is.`);
    }
    return { line, declaredForCompare: declared, declaredToStore: isAbsent ? null : String(declared) };
  });

  // Check 1 — per ACCOUNT, not per line: nothing makes `fromMoneyAccountId` unique across
  // `input.lines` (no unique index on it, `schema/remittance.ts`), so two lines against the same
  // account must be summed before comparing, or the masking case (§3.1) is reachable THROUGH this
  // check instead of around it.
  //
  // ⛔ Bounds against MOVEMENT, not owed, and deliberately so (spec §3.3): `owed = movement −
  // allocated`, and `remittance_allocations` has no account dimension, so a prior allocation
  // cannot be split per account without a schema change to the allocation key (out of scope).
  // Movement is always >= that account's true owed, so this bound is LOOSER than truth — it can
  // never refuse a legitimate handover, and check 2 below still bounds the total exactly. Do not
  // "tighten" this to owed without giving `remittance_allocations` an account dimension — that
  // would start refusing correct remittances.
  const perAccount = new Map<string, { amountSum: Money; declaredSum: Money }>();
  for (const { line, declaredForCompare } of linesWithOverage) {
    const entry = perAccount.get(line.fromMoneyAccountId) ?? {
      amountSum: money('0'),
      declaredSum: money('0'),
    };
    entry.amountSum = add(entry.amountSum, money(line.amount));
    entry.declaredSum = add(entry.declaredSum, declaredForCompare);
    perAccount.set(line.fromMoneyAccountId, entry);
  }
  for (const [accountId, { amountSum, declaredSum }] of perAccount) {
    const accountMovement = money(movementByAccount.get(accountId) ?? '0');
    const allowance = add(accountMovement, declaredSum);
    if (compare(amountSum, allowance) > 0) {
      const name = fromAccountNames.get(accountId) ?? accountId;
      // ⭐ Names which account, what it handed over, what it can account for, and what declaring
      // would take FOR THIS CHECK. ⛔ It does NOT claim to clear the handover — `amountSum -
      // accountMovement` clears check 1 only. Check 2 bounds on OWED, which is <= movement
      // whenever a settleable date is partly allocated, so a check-1-clearing declaration can
      // still leave check 2 short; check 2 below names its own, separate, actionable total. The
      // total here is independent of `declaredSum` by construction, so it is what the field needs
      // to hold, never a number to add to what is already typed there; the parenthetical exists
      // so it is not misread as "on top of" whatever was already declared.
      throw new Error(
        `createRemittance: "${name}" hands over ${formatMoney(amountSum)} in this remittance, ` +
          `but it only moved ${formatMoney(accountMovement)} over the settleable dates — declare ` +
          `at least ${formatMoney(subtract(amountSum, accountMovement))} total overage for this ` +
          `account${
            compare(declaredSum, money('0')) > 0
              ? ` (${formatMoney(declaredSum)} of that is already declared)`
              : ''
          }.`,
      );
    }
  }

  // Check 2 — pooled, retained: bounds the total exactly, independent of how it is split by line.
  // ⚠️ `Number(r.owed).toFixed(2)` — kept by DECISION, not caught by the DEF-272 census (its regex
  // only matches `Number(x) <op> 0`, never a bare re-stringify like this one). `r.owed` is already
  // Postgres `numeric(14,2)` text; `.toFixed(2)` only normalises its representation (`"5000"` →
  // `"5000.00"`), which is LOAD-BEARING because `money()` immediately after THROWS on anything not
  // already exactly 2dp — the same conversion the pre-existing `days` map below already performs
  // on this same field. Measured, not assumed: 500,007 two-decimal strings SAMPLED across the
  // `numeric(14,2)` range through this exact `Number(...).toFixed(2)` path — 300k at
  // 0.00–2,999.99, 200k near 10^9, plus its maximum 999999999999.99 — with ZERO lossy results.
  // This is a normalisation of a database `::text` value, not a comparison against a raw human
  // input, so DEF-272's guard does not apply to it.
  const totalOwed = settleable.reduce((sum, r) => add(sum, money(Number(r.owed).toFixed(2))), money('0'));
  const totalDeclared = linesWithOverage.reduce((sum, l) => add(sum, l.declaredForCompare), money('0'));
  if (compare(handedOver, add(totalOwed, totalDeclared)) > 0) {
    // ⭐ Unlike check 1's account-scoped figure, this total DOES clear the handover: check 1 has
    // already passed for every account at the current `declaredSum` values, and more declared
    // overage on any line only widens check 1's allowance for that account, never narrows it — so
    // ADDING this much — split however you like across the lines, WITHOUT REDUCING any line's
    // existing figure — satisfies both checks. Always positive here: the guard above requires
    // `handedOver > totalOwed + totalDeclared`, and `totalDeclared >= 0` forces
    // `handedOver > totalOwed`.
    //
    // ⛔ NOT "any split of the TOTAL". The field holds an absolute value the cashier OVERWRITES,
    // so someone who REDISTRIBUTES to reach this figure rather than adding to it can drop a line
    // below its own check-1 minimum: Till movement ₱5,000 handing over ₱10,000 with ₱5,000
    // declared passes check 1; rebalancing to ₱3,500/₱3,500 across two lines still totals the
    // figure named here and check 1 then refuses the Till at 10,000 > 5,000 + 3,500.
    // ⭐ It always converges, so this is one extra round-trip and never a dead end: with
    // `M = Σ max(0, amountSum(A) − movement(A))`, check 1 passing implies `totalDeclared >= M` and
    // check 2 failing implies this figure `> totalDeclared`, hence `> M` — a valid split always
    // exists, and an overshooting cashier is bounced to check 1, which names the account and its
    // own minimum.
    throw new Error(
      `createRemittance: ${formatMoney(handedOver)} was handed over, but the settleable days owe ` +
        `only ${formatMoney(totalOwed)}${
          compare(totalDeclared, money('0')) > 0 ? ` plus ${formatMoney(totalDeclared)} declared` : ''
        } — declare at least ${formatMoney(subtract(handedOver, totalOwed))} total overage ` +
        `across the lines to hand over that much.`,
    );
  }

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
  for (const { line, declaredToStore } of linesWithOverage) {
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
      declaredOverage: declaredToStore,
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
 * ⭐ **`set_cash_policy` — admin and above, NOT manager.** Ian, 2026-08-29:
 * *"configure the peso ceiling for unremitted by store configurable by admin."*
 *
 * ⛔ **The ceiling is the number a store's cash custody is measured against, so whoever is
 * measured must not be able to move it.** A manager running late on remittance could otherwise
 * raise the ceiling and watch the finding disappear — a control quietly deleting its own
 * evidence. Row 129 says the peso figures *"belong to whoever carries the risk"*, and that is not
 * the person holding the cash.
 *
 * ⚠️ Deliberately NOT `manage_store_settings`, which managers hold because *"store settings [are]
 * tied to operation"*. A risk limit is not an operating setting. And deliberately not
 * `accept_remittance` either, or whoever accepts the handover could raise their own bar.
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
  await authorize(tx, actor, 'set_cash_policy', { storeId: input.storeId });

  if (!REMITTANCE_CADENCES.includes(input.remittanceCadence)) {
    throw new Error(
      `setStoreCashPolicy: ${input.remittanceCadence} is not a cadence. ` +
        `Expected one of ${REMITTANCE_CADENCES.join(', ')}.`,
    );
  }

  await storesRepo.setCashPolicy(tx, actor.orgId, input);
}
