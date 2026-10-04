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
 * A handover posts NOTHING of its own: each line moves through `createMoneyTransfer` like any
 * other cashier→office transfer, and `remittance_lines.money_transfer_id` records which one. One
 * posting path. Growing a second is exactly how v1 ended up with two amortisation runners that
 * drifted apart.
 *
 * ⭐ **The one other posting is a CHARGED SHORTAGE** (T-366 S2, DEF-386): `resolveRemittanceVariance`
 * posts Dr 1230 (the person) / Cr the cashier account as a SECOND entry beside the transfer — never
 * merged into it — and writes `source 'charge'` allocation rows so the day reads remitted. Its
 * journal entry has `source_type 'remittance_variance'`, a custody movement excluded from what a
 * day owes (`CUSTODY_SOURCE_TYPES`), and reverses with the remittance. Both go through
 * `postStaffShortageCharge`, shared with the till (DEF-105).
 */
import { authorize, type Actor } from '@shareat/auth';
import { internalFault } from '../shared/refusal-leaf';
import { gone, refuse } from '../shared/refusal';
import { postEntry } from '../ledger/post-entry';
import { reverseEntry } from '../ledger/reverse-entry';
import { postStaffShortageCharge } from '../shared/staff-shortage-charge';
import {
  REMITTANCE_CADENCES,
  advisoryLocksRepo,
  moneyAccountsRepo,
  personsRepo,
  remittanceRepo,
  storesRepo,
  transaction,
  type RemittanceCadence,
  type Tx,
} from '@shareat/db';
import { add, compare, formatMoney, isZero, money, negate, subtract, ZERO, type Money } from '@shareat/core/money';
import { parseBusinessDate, toBusinessDate } from '@shareat/core/datetime';
import { createMoneyTransfer, voidMoneyTransfer } from '../money-transfers';
import { parseDecimalInput } from '../shared/money-input';
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
  // ⛔ T-366 S1 / DEF-374 — serialise per store BEFORE the first cap read below.
  await advisoryLocksRepo.lockStoreCashCustody(tx, input.storeId);

  if (input.lines.length === 0) {
    throw new Error('createRemittance: a remittance has to hand over something.');
  }

  // ⭐ T-371 R5/R6 — every line's amount is parsed HERE, after `authorize()` and before any read or
  // write, into a `Money` brand: a typed 'abc' or 'NaN' gets a sentence naming the field and quoting
  // the value, not `money()`'s raw TypeError. `remittance_lines.amount` is NOT NULL with no default,
  // so a blank is refused — never a guessed '0'.
  const parsedAmounts = new Map<RemittanceLineInput, Money>();
  for (const line of input.lines) {
    parsedAmounts.set(
      line,
      parseDecimalInput(line.amount, '14,2', 'createRemittance: the amount handed over', 'The amount handed over', {
        blank: 'refuse',
      }),
    );
  }
  const amountOf = (line: RemittanceLineInput): Money => {
    const parsed = parsedAmounts.get(line);
    if (parsed === undefined) throw internalFault('createRemittance: a line was not parsed.');
    return parsed;
  };

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
  }

  const handedOver: Money = input.lines.reduce((sum, l) => add(sum, amountOf(l)), money('0'));

  // ⭐ What the days are owed, oldest first — derived from the ledger, never from a column.
  // ⚠️ Only VERIFIED days: an unverified one has no signed count behind it, so there is nothing to
  // settle against.
  const reports = await remittanceRepo.endDayReports(tx, actor.orgId, {
    storeId: input.storeId,
    upTo: input.remittedOn,
  });
  const settleable = reports.filter((r) => r.remittable && compare(money(r.owed), ZERO) > 0);

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

  // `owed` is Postgres numeric(14,2) text; `.toFixed(2)` normalises its form for `money()` (see the
  // measured note at T-324 check 2 below).
  const totalOwed = settleable.reduce((sum, r) => add(sum, money(Number(r.owed).toFixed(2))), money('0'));

  // ⛔⛔ T-316 ✎S-1 — AT A FLOAT-CARRYING STORE A HANDOVER CARRIES WHAT THE VERIFIED DAYS OWE AND
  // NOTHING MORE. The float is a target on the cashier's drawer (1110), so the drawer is the
  // remittance source and the float must stay in it. Placed BEFORE T-324's two checks (so a float store is never advised to declare an overage that would then be refused) and BEFORE
  // `insertRemittance` and the transfer loop, so nothing is written when it fires. Strictly `>`:
  // handing over exactly `totalOwed` is the ordinary close. Reads NO `floatPosition`,
  // `cash_collected` or variance: a figure `recognise_income` can raise must not unlock a handover.
  // Stores without a float keep T-324 exactly as it is. No branch on the POS link (A5).
  const floatAccount = (
    await moneyAccountsRepo.listMoneyAccounts(tx, actor.orgId, { storeId: input.storeId })
  ).find((a) => a.floatTarget !== null);
  if (floatAccount && floatAccount.floatTarget !== null && compare(handedOver, totalOwed) > 0) {
    const store = await storesRepo.getById(tx, actor.orgId, input.storeId);
    const storeName = store?.name ?? 'This store';
    throw refuse(
      `createRemittance: ${formatMoney(handedOver)} handed over exceeds the ${formatMoney(totalOwed)} the ` +
        `verified days owe at float store ${input.storeId} (float ${floatAccount.floatTarget})`,
      `This hands over ${formatMoney(handedOver)}, but the verified days owe ${formatMoney(totalOwed)}. ` +
        `${storeName}'s till keeps a ${formatMoney(money(floatAccount.floatTarget))} float, so only what ` +
        "the verified days owe can be handed over. Cash from a day that isn't verified yet is handed " +
        'over after that day is verified. Extra float goes back to the office as a transfer.',
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
  // T-371 R6: `declared_overage` is nullable, so a blank is `null` — never a guessed '0' stored.
  const linesWithOverage = input.lines.map((line) => {
    const raw = line.declaredOverage;
    const parsed = parseDecimalInput(raw, '14,2', 'createRemittance: the declared overage', 'A declared overage', {
      blank: 'null',
    });
    const declared: Money = parsed ?? ZERO;
    if (compare(declared, ZERO) < 0) {
      throw new Error(`createRemittance: a declared overage cannot be negative — "${raw}" is.`);
    }
    return { line, amount: amountOf(line), declaredForCompare: declared, declaredToStore: parsed };
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
  for (const { line, amount, declaredForCompare } of linesWithOverage) {
    const entry = perAccount.get(line.fromMoneyAccountId) ?? {
      amountSum: money('0'),
      declaredSum: money('0'),
    };
    entry.amountSum = add(entry.amountSum, amount);
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
    // ⛔ Audit round (S6) — `r.owed` is already Postgres `numeric(14,2)` text; `money()` accepts 0,
    // 1 or 2 decimals natively (its own regex), so the `Number(...).toFixed(2)` round-trip through
    // a float was never load-bearing here, unlike check 2's own figure below (a different value,
    // with its own measured exemption comment) — this one is a plain exact parse.
    owed: money(r.owed),
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
  for (const { line, amount, declaredToStore } of linesWithOverage) {
    const transfer = await createMoneyTransfer(tx, actor, {
      fromMoneyAccountId: line.fromMoneyAccountId,
      toMoneyAccountId: line.toMoneyAccountId,
      amountOut: amount,
      amountIn: amount,
      transferDate: input.remittedOn,
      reference: input.reference ?? null,
      notes: `Remittance ${input.remittedOn}`,
    });
    await remittanceRepo.insertLine(tx, {
      remittanceId: id,
      fromMoneyAccountId: line.fromMoneyAccountId,
      toMoneyAccountId: line.toMoneyAccountId,
      amount,
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
      amount: a.amount,
      source: 'cash',
    });
  }

  let varianceId: string | null = null;
  if (!isZero(result.variance) && result.varianceDayId) {
    // ⛔ Recorded OPEN, with nobody attached. FIFO put the residual on this date; that says nothing
    // about who was holding the money. Charging it requires a person, named by a human (row 144).
    const row = await remittanceRepo.insertVariance(tx, {
      orgId: actor.orgId,
      remittanceId: id,
      businessDate: result.varianceDayId,
      salesDayId: byDate.get(result.varianceDayId)?.salesDayId ?? null,
      amount: result.variance,
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
    variance: isZero(result.variance) ? null : String(result.variance),
    varianceId,
  };
}

/**
 * ⛔ Reverse, never delete. Each line's transfer is reversed through `reverseEntry`, and the
 * allocations stop counting because the remittance is no longer `posted` — so the days it settled
 * become unsettled again, derived rather than repaired. An OPEN variance closes the same way
 * (T-373 R6: open = status open AND remittance posted); a charged one has its entry reversed.
 */
export async function reverseRemittance(
  tx: Tx | null,
  actor: Actor,
  input: { remittanceId: string; reason: string; reversedOn?: string },
): Promise<void> {
  const run = async (trx: Tx) => {
    const remittance = await remittanceRepo.getById(trx, actor.orgId, input.remittanceId);
    if (!remittance) {
      throw gone(`reverseRemittance: remittance ${input.remittanceId} does not exist.`, 'remittance');
    }
    await authorize(trx, actor, 'accept_remittance', { storeId: remittance.storeId });
    // ⛔ T-366 S1 / DEF-374 — lock, then RE-READ: the status read above is stale once we have
    // waited, and two reversals would both pass 'posted'. T-366 S2: the variance's status AND
    // journal_entry_id are read below, AFTER this lock, for the same reason — a charge that was
    // holding the lock has committed its entry by the time we get here.
    await advisoryLocksRepo.lockStoreCashCustody(trx, remittance.storeId);
    const locked = await remittanceRepo.getById(trx, actor.orgId, input.remittanceId);
    if (!locked) {
      throw internalFault(`reverseRemittance: remittance ${input.remittanceId} does not exist.`);
    }

    const reason = input.reason.trim();
    if (!reason) throw refuse('reverseRemittance: a reason is required.', 'Say why this handover is being reversed.');
    if (locked.status !== 'posted') {
      throw refuse(
        `reverseRemittance: this remittance is already ${locked.status}.`,
        'This handover was already reversed.',
      );
    }

    for (const line of await remittanceRepo.linesFor(trx, remittance.id)) {
      await voidMoneyTransfer(trx, actor, {
        moneyTransferId: line.moneyTransferId,
        reason: `Remittance reversed: ${reason}`,
        voidDate: input.reversedOn,
      });
    }

    // ⭐ T-366 S2 / DEF-386: the charge (or recognised overage) is a second entry beside the
    // transfers, so it reverses with them or the person's 1230 keeps a receivable for a handover
    // that no longer exists. Read AFTER the lock (see above).
    const variance = await remittanceRepo.varianceForRemittance(trx, remittance.id);
    if (variance?.journalEntryId) {
      await reverseEntry(trx, {
        entryId: variance.journalEntryId,
        reason: `Remittance reversed: ${reason}`,
        reversalDate: input.reversedOn,
        reversedBy: actor.personId,
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
 * Closes an open variance — a SHORTAGE charged to a named person, or an OVERAGE recognised as
 * other income (T-366 S3, DEF-386's overage half).
 *
 * ⛔ **A shortage cannot be charged to nobody.** v1's remittance builder throws rather than infer a
 * `chargeToStaffId`, and that refusal is ported here AND in a CHECK constraint, because inferring
 * the person from the date is exactly the wrong inference: FIFO put the residual on that date, and
 * the date says nothing about who was holding the money (bible rows 128, 144).
 *
 * ## ⭐ What a charge does (T-366 S2, DEF-386 + DEF-105)
 *
 * ```
 * Dr  1230  Advances to employees   party = the person          (source_type 'remittance_variance')
 *     Cr  <the cashier account the handover came from>
 * ```
 * beside the handover's own transfer — never merged into it — so the two together net to exactly
 * `POSTING-PATTERNS` `remittance.shortage`. It also writes `source 'charge'` settlement rows, so
 * "charge closes" (row 216(3)): the day reads remitted. And it is CAPPED at what is still owed
 * (R4): if a later cash remittance has covered part of the shortage, nobody is charged for money
 * that has since arrived.
 *
 * ## ⭐ What `recognise_income` does (T-366 S3, R1/R7)
 *
 * ```
 * Dr  <the cashier account the handover came from>
 *     Cr  7350  Cash over and short              (source_type 'remittance_variance')
 * ```
 * beside the handover's own transfer, never merged into it, so the two net to exactly
 * `POSTING-PATTERNS` `remittance.overage`. Manager-confirmed, never automatic (Amendment A1, Q3):
 * an overage often carries a day not yet verified, and verifying it later must never double-count
 * the same cash as both sales and 7350 income. No settlement rows: the days were already fully
 * allocated by the handover itself.
 *
 * ⛔ **`write_off` is retired** (Amendment A1, Ian 2026-09-30: "a shortage is always charged to
 * staff"). The action stays in the type so a stale caller gets a plain sentence, not a crash.
 * Existing `written_off` rows are untouched.
 */
export async function resolveRemittanceVariance(
  tx: Tx | null,
  actor: Actor,
  input:
    | {
        varianceId: string;
        action: 'charge';
        personId: string;
        /** Required only when the remittance handed over from more than one account (R5). */
        fromMoneyAccountId?: string | null;
        reason?: string | null;
        on?: string;
      }
    | {
        varianceId: string;
        action: 'recognise_income';
        /** Required only when the remittance handed over from more than one account (R5). */
        fromMoneyAccountId?: string | null;
        reason?: string | null;
        on?: string;
      }
    | { varianceId: string; action: 'write_off'; reason: string; on?: string },
): Promise<void> {
  const run = async (trx: Tx) => {
    // ⚠️ The store comes from the variance's remittance — `accept_remittance` is store-scoped, so
    // gating this without one would either fail loudly or, worse, not gate at all.
    const first = await remittanceRepo.getVarianceWithStore(trx, actor.orgId, input.varianceId);
    if (!first) {
      throw gone(`resolveRemittanceVariance: variance ${input.varianceId} does not exist.`, 'remittance variance');
    }
    await authorize(trx, actor, 'accept_remittance', { storeId: first.storeId });

    if (input.action === 'write_off') {
      throw refuse(
        'resolveRemittanceVariance: write_off is retired — a shortage is always charged.',
        "A shortage can't be written off. Charge it to the person responsible.",
      );
    }
    // ⛔ T-366 S3 audit — the only two actions the type still admits are 'charge' and
    // 'recognise_income', but a caller that bypasses the type (a stale form field, a hand-crafted
    // request) can send anything. Without this, an unknown action fell through to the sign check
    // below by elimination (a shortage got the "only an overage can be recognised" wording, which
    // is confusing but wrote nothing). On an OVERAGE it is worse in a different way: the sign check
    // passed, but `input.action === 'recognise_income'` below is false for a garbage action, so it
    // skipped that block too and fell into the charge tail with no `person` ever set — the `!person`
    // guard there caught it, so nothing was written either way, but as an opaque internalFault
    // instead of a clean, sayable refusal.
    if (input.action !== 'charge' && input.action !== 'recognise_income') {
      throw refuse(
        `resolveRemittanceVariance: unknown action ${String((input as { action: unknown }).action)}.`,
        'That action is not available.',
      );
    }

    // ⛔ T-366 S1 / DEF-374 — same per-store key as create and reverse.
    await advisoryLocksRepo.lockStoreCashCustody(trx, first.storeId);

    // ⭐ Re-read after the lock: the first read is stale once we have waited — a concurrent charge,
    // recognition or a reversal of this remittance may have committed while we queued.
    const variance = await remittanceRepo.getVarianceWithStore(trx, actor.orgId, input.varianceId);
    if (!variance || variance.status !== 'open') {
      throw refuse(
        `resolveRemittanceVariance: variance ${input.varianceId} is not open.`,
        'That variance has already been dealt with — reload the page to see where it stands.',
      );
    }

    if (input.action === 'charge') {
      if (compare(money(variance.amount), ZERO) >= 0) {
        throw refuse(
          'resolveRemittanceVariance: only a shortage (negative variance) can be charged.',
          'Only a shortage can be charged to a person. An overage is recognised as other income instead.',
        );
      }
    } else {
      if (compare(money(variance.amount), ZERO) <= 0) {
        throw refuse(
          'resolveRemittanceVariance: only an overage (positive variance) can be recognised as income.',
          'Only an overage can be recognised as other income. A shortage is charged to a person instead.',
        );
      }
    }
    if (variance.remittanceStatus !== 'posted') {
      throw refuse(
        'resolveRemittanceVariance: the remittance is reversed.',
        input.action === 'charge'
          ? 'That handover was reversed, so there is nothing left to charge.'
          : 'That handover was reversed, so there is nothing left to recognise.',
      );
    }

    let person: { displayName: string } | undefined;
    if (input.action === 'charge') {
      if (!input.personId) {
        throw refuse(
          'resolveRemittanceVariance: charging a shortage needs a person.',
          'Choose who is being charged. The date the shortage landed on says where the arithmetic ' +
            'stopped, not who was holding the money.',
        );
      }
      person = await personsRepo.getPersonById(trx, actor.orgId, input.personId);
      if (!person) {
        throw refuse(
          'resolveRemittanceVariance: the person does not exist in this organisation.',
          'That person could not be found — choose someone from the list.',
        );
      }
    }

    // R6 — the entry date: today in MANILA unless given, never before the handover.
    const on = input.on ? parseBusinessDate(input.on) : toBusinessDate();
    if (on < variance.remittedOn) {
      throw refuse(
        `resolveRemittanceVariance: ${on} is before the remittance date ${variance.remittedOn}.`,
        input.action === 'charge'
          ? `A shortage cannot be charged on a date before the handover it came from (${variance.remittedOn}).`
          : `An overage cannot be recognised on a date before the handover it came from (${variance.remittedOn}).`,
      );
    }

    // R5 — the cashier account is NAMED, never guessed.
    const fromAccounts = await remittanceRepo.fromAccountsFor(trx, variance.remittanceId);
    let account = fromAccounts.length === 1 ? fromAccounts[0] : undefined;
    if (fromAccounts.length > 1) {
      const names = fromAccounts.map((a) => `"${a.name}"`).join(', ');
      if (!input.fromMoneyAccountId) {
        throw refuse(
          'resolveRemittanceVariance: the remittance has several from-accounts; name one.',
          `This handover came from more than one account (${names}). Choose which account the ` +
            (input.action === 'charge' ? 'shortage comes out of.' : 'overage came into.'),
        );
      }
      account = fromAccounts.find((a) => a.id === input.fromMoneyAccountId);
      if (!account) {
        throw refuse(
          'resolveRemittanceVariance: the named account is not on the remittance.',
          `That account is not one this handover came from. Choose one of ${names}.`,
        );
      }
    } else if (input.fromMoneyAccountId && account && account.id !== input.fromMoneyAccountId) {
      throw refuse(
        'resolveRemittanceVariance: the named account is not on the remittance.',
        `That account is not the one this handover came from ("${account.name}").`,
      );
    }
    if (!account) {
      throw internalFault(`resolveRemittanceVariance: remittance ${variance.remittanceId} has no lines.`);
    }

    if (input.action === 'recognise_income') {
      // R7 — no cap, no FIFO settlement: the days were already fully allocated by the handover
      // itself (an overage means more came in than was owed). One entry, Dr the cashier account /
      // Cr 7350, and the variance closes to 'income'.
      const amount = money(variance.amount);
      const posted = await postEntry(trx, {
        orgId: actor.orgId,
        entryDate: on,
        sourceType: 'remittance_variance',
        sourceId: variance.id,
        idempotencyKey: `remittance-variance:${variance.id}:income`,
        memo: input.reason?.trim() || `Remittance overage ${variance.remittedOn} recognised as other income`,
        postedBy: actor.personId,
        lines: [
          {
            accountCode: account.glAccountCode,
            storeId: variance.storeId,
            debit: String(amount),
            // A 1140 wallet requires a party naming itself — payLiability's own conditional.
            ...(account.glAccountCode === '1140'
              ? { partyType: 'money_account', partyId: account.id }
              : {}),
          },
          {
            // 7350 Cash over and short (row 216(4)) — other income, per R1.
            accountCode: '7350',
            storeId: variance.storeId,
            credit: String(amount),
          },
        ],
      });

      await remittanceRepo.resolveVariance(trx, actor.orgId, variance.id, {
        status: 'income',
        chargedToPersonId: null,
        reason: input.reason?.trim() || null,
        resolvedBy: actor.personId,
        resolvedOn: on,
        journalEntryId: posted.entryId,
      });
      return;
    }

    // R4 — CAP at what is still owed. The days are the ones the handover could have settled:
    // verified and owing, on or before its date.
    const reports = await remittanceRepo.endDayReports(trx, actor.orgId, {
      storeId: variance.storeId,
      upTo: variance.remittedOn,
    });
    const owedDays: DayOwed[] = reports
      .filter((r) => r.remittable && compare(money(r.owed), ZERO) > 0)
      .map((r) => ({ salesDayId: r.businessDate, businessDate: r.businessDate, owed: money(r.owed) }));
    const stillOwed = owedDays.reduce((sum, d) => add(sum, d.owed), ZERO);
    const shortBy = negate(money(variance.amount));
    const chargeable = compare(shortBy, stillOwed) <= 0 ? shortBy : stillOwed;
    if (compare(chargeable, ZERO) <= 0) {
      throw refuse(
        'resolveRemittanceVariance: nothing is left to charge — the days are covered.',
        'That shortage has since been remitted in cash — nothing is left to charge.',
      );
    }

    // "Charge closes": settle the days the shortage left owing, oldest first.
    const settled = allocateFifo(owedDays, chargeable);
    const byDate = new Map(reports.map((r) => [r.businessDate, r]));
    for (const a of settled.allocations) {
      await remittanceRepo.insertAllocation(trx, {
        remittanceId: variance.remittanceId,
        businessDate: a.salesDayId,
        salesDayId: byDate.get(a.salesDayId)?.salesDayId ?? null,
        amount: a.amount,
        source: 'charge',
      });
    }

    // ⛔ Unreachable: `person` was looked up and null-checked above, in the same `action === 'charge'`
    // branch this code always falls through from (`recognise_income` already returned). Guarded,
    // not asserted, per RULES §13 row 206.
    if (!person) throw internalFault('resolveRemittanceVariance: person missing after validation.');
    const posted = await postStaffShortageCharge(trx, {
      orgId: actor.orgId,
      storeId: variance.storeId,
      personId: input.personId,
      amount: String(chargeable),
      creditAccountCode: account.glAccountCode,
      // A 1140 wallet requires a party naming itself — payLiability's own conditional.
      ...(account.glAccountCode === '1140'
        ? { creditParty: { partyType: 'money_account', partyId: account.id } }
        : {}),
      entryDate: on,
      sourceType: 'remittance_variance',
      sourceId: variance.id,
      idempotencyKey: `remittance-variance:${variance.id}:charge`,
      memo:
        input.reason?.trim() ||
        `Remittance shortage ${variance.remittedOn} charged to ${person.displayName}`,
      postedBy: actor.personId,
    });

    await remittanceRepo.resolveVariance(trx, actor.orgId, variance.id, {
      status: 'charged',
      chargedToPersonId: input.personId,
      reason: input.reason?.trim() || null,
      resolvedBy: actor.personId,
      resolvedOn: on,
      journalEntryId: posted.entryId,
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
  // T-371 C4: re-minted, so a malformed figure throws instead of NaN falling through every branch.
  const owed = money(report.movement);
  const done = money(report.allocated);
  // ⚠️ A day the cashier paid MORE out of than came in owes nothing — the office is out of pocket,
  // not the till. Calling that "not remitted" would put it on a list of things somebody has to
  // chase, which is the opposite of true.
  if (compare(owed, ZERO) <= 0 && compare(done, ZERO) <= 0) return 'nothing_owed';
  if (compare(done, ZERO) <= 0) return 'unremitted';
  if (compare(done, owed) >= 0) return 'remitted';
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
    /** T-371 R6: `unremitted_ceiling` is nullable, so a blank (or null) is stored as NULL — never 0. */
    unremittedCeiling: string | null | undefined;
  },
): Promise<void> {
  await authorize(tx, actor, 'set_cash_policy', { storeId: input.storeId });

  // T-371 R5 — parsed after `authorize()`, before anything is written.
  const unremittedCeiling = parseDecimalInput(
    input.unremittedCeiling,
    '14,2',
    'setStoreCashPolicy: the unremitted ceiling',
    'The un-remitted ceiling',
    { blank: 'null' },
  );

  if (!REMITTANCE_CADENCES.includes(input.remittanceCadence)) {
    throw new Error(
      `setStoreCashPolicy: ${input.remittanceCadence} is not a cadence. ` +
        `Expected one of ${REMITTANCE_CADENCES.join(', ')}.`,
    );
  }

  await storesRepo.setCashPolicy(tx, actor.orgId, {
    storeId: input.storeId,
    remittanceCadence: input.remittanceCadence,
    unremittedCeiling,
  });
}
