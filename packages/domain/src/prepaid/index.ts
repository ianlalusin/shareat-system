/**
 * Prepaid items — an expense already paid for but not yet used up. T-125.
 *
 * A year of insurance, a mayor's permit, six months of rent in advance. It sits at `1400` and is
 * released into the P&L a month at a time.
 *
 * ## ⭐ Read T-125 §10 before reusing anything from fixed assets
 *
 * | | Fixed asset | Prepaid |
 * |---|---|---|
 * | Account | `1510` at cost PLUS contra `1590` | ⭐ **`1400` alone, decremented directly** |
 * | Salvage | Yes | ⛔ None — runs to zero |
 * | Interval | monthly / quarterly / semi-annual / annual | ⛔ **Monthly only** |
 * | Term | `useful_life_months`, an ESTIMATE | `coverage_months`, a **CONTRACT** |
 *
 * v1 states the account difference outright (`amortization.builder.ts:12-14`): *"This differs from
 * depreciation (which uses a contra_asset account and preserves gross cost) — prepaid-expense
 * accounting directly reduces the current-asset balance."* ⛔ **Do not add a contra account for
 * symmetry.** The asymmetry is the correct treatment.
 *
 * ## The arithmetic is SHARED, not copied
 *
 * `shared/straight-line.ts` is called by both this and T-124. v1 hand-copied its two runners and
 * the copies drifted — assets gained a per-month void, prepaid never did. This file closes that
 * gap too (`reverseAmortisation`, §7.8).
 */
import { authorize, type Actor } from '@shareat/auth';
import {
  journalRepo,
  prepaidRepo,
  transaction,
  withSystemOrgPrincipal,
  type PrepaidCategory,
  type Tx,
} from '@shareat/db';
import { money, subtract, type Money } from '@shareat/core/money';
import { parseMoneyInput } from '../shared/money-input';
import { buildStraightLine, periodsThroughOf, type SchedulePeriod } from '../shared/straight-line';
import { readPolicyOrRefuse } from '../fixed-assets/policy';
import { postEntry } from '../ledger/post-entry';
import { reverseEntry } from '../ledger/reverse-entry';

export const PREPAID_ACCOUNT_CODE = '1400';
export const AMORTISATION_EXPENSE_CODE = '6750';

export interface CreatePrepaidItemInput {
  storeId: string;
  name: string;
  category: PrepaidCategory;
  coverageStartDate: string;
  coverageMonths: number;
  totalCost: string;
  sourceExpenseId?: string | null;
  /** ⭐ True only when the TERM was guessed from a category default rather than read off the
   *  document (§11). Never set by a human filling the form in — see `createPrepaidItem`. */
  needsReview?: boolean;
  notes?: string | null;
}

/**
 * The whole schedule for an item, in order. Exported because the screens show it and the tests
 * assert on it — and because a schedule you cannot see is a schedule nobody checks.
 */
export function prepaidSchedule(item: {
  coverageStartDate: string;
  coverageMonths: number;
  totalCost: string;
}) {
  return buildStraightLine({
    startsOn: item.coverageStartDate,
    // ⛔ No salvage. A prepaid runs to zero — that is what "used up" means.
    amount: money(item.totalCost),
    periods: item.coverageMonths,
    // ⛔ Monthly, always. §10: charging a 12-month policy quarterly would recognise cost for
    // months not yet covered, which is the error prepaid accounting exists to prevent.
    monthStep: 1,
  });
}

// -------------------------------------------------------------------------------------
// Create
// -------------------------------------------------------------------------------------

export async function createPrepaidItem(
  tx: Tx | null,
  actor: Actor,
  input: CreatePrepaidItemInput,
): Promise<{ id: string }> {
  if (tx) return runCreate(tx, actor, input);
  return transaction((trx) => runCreate(trx, actor, input));
}

async function runCreate(
  tx: Tx,
  actor: Actor,
  input: CreatePrepaidItemInput,
): Promise<{ id: string }> {
  await authorize(tx, actor, 'manage_prepaid_items', {});

  const name = input.name.trim();
  if (!name) throw new Error('createPrepaidItem: a prepaid item needs a name people will recognise.');

  // ⭐ ONE threshold, shared with fixed assets (bible row 141, ₱5,000). v1 kept TWO — an org-level
  // one for assets and a store-scoped one for prepaid, same default by coincidence, different
  // scope, never reconciled; v1's own blueprint still lists the split as unresolved. Settled here
  // by not having two.
  //
  // ⚠️ Fails CLOSED: unreadable stops the creation with a message saying what was not recorded and
  // why. v1's prepaid path refuses too, but only incidentally — the exception escapes as a generic
  // "Failed to save prepaid item."
  const policy = await readPolicyOrRefuse(tx, actor.orgId);
  if (Number(input.totalCost) < Number(policy.threshold)) {
    throw new Error(
      `createPrepaidItem: total cost ${input.totalCost} is below the capitalisation threshold ` +
        `(${policy.threshold}). File it as an immediate expense instead — spreading something this ` +
        'small over months costs more attention than the accuracy is worth.',
    );
  }

  return prepaidRepo.insertPrepaidItem(tx, {
    orgId: actor.orgId,
    storeId: input.storeId,
    name,
    category: input.category,
    coverageStartDate: input.coverageStartDate,
    coverageMonths: input.coverageMonths,
    totalCost: input.totalCost,
    // ⚠️ A human filling in the form has READ the document, so the term is not a guess. The flag
    // means "these are defaults nobody has confirmed", which is only ever true of the automatic
    // path from an expense category.
    needsReview: input.needsReview ?? false,
    sourceExpenseId: input.sourceExpenseId ?? null,
    notes: input.notes?.trim() || null,
    createdBy: actor.personId,
  });
}

/**
 * Confirms or corrects a guessed coverage term (§11.2).
 *
 * ⭐ **This is the only thing that clears `needs_review`.** Nothing expires the queue and nothing
 * auto-accepts after N days: a default silently becoming permanent is the exact failure this task
 * is built against.
 */
export async function confirmPrepaidTerm(
  tx: Tx | null,
  actor: Actor,
  input: { prepaidItemId: string; coverageMonths: number; coverageStartDate: string },
): Promise<void> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'manage_prepaid_items', {});
    if (!Number.isInteger(input.coverageMonths) || input.coverageMonths < 1) {
      throw new Error('confirmPrepaidTerm: coverage must be a whole number of months, at least 1.');
    }
    const item = await prepaidRepo.getById(trx, actor.orgId, input.prepaidItemId);
    if (!item) {
      throw new Error(`confirmPrepaidTerm: prepaid item ${input.prepaidItemId} does not exist.`);
    }
    // ⚠️ Shortening the term below what has ALREADY posted would leave the item amortised past its
    // own cost — invariant 3 read backwards. Refused with both figures, because the reviewer needs
    // to know which months are already out.
    const posted = await prepaidRepo.postedPeriods(trx, actor.orgId, item.id);
    if (posted.size > input.coverageMonths) {
      throw new Error(
        `confirmPrepaidTerm: ${posted.size} months have already been released, so the term cannot ` +
          `be shortened to ${input.coverageMonths}. Reverse the extra months first.`,
      );
    }
    await prepaidRepo.confirmTerm(trx, actor.orgId, item.id, {
      coverageMonths: input.coverageMonths,
      coverageStartDate: input.coverageStartDate,
    });
  };
  if (tx) return run(tx);
  return transaction(run);
}

// -------------------------------------------------------------------------------------
// ⭐ Amortise — idempotent per (item, period), so catching up is running it again
// -------------------------------------------------------------------------------------

export interface AmortiseResult {
  /** Periods this call actually posted, oldest first. Empty means everything was already done. */
  posted: string[];
  /** Periods that were already posted and were skipped. */
  skipped: string[];
}

/**
 * Releases every period from the coverage start through `asOfPeriod` that has not posted yet.
 *
 * ⭐ **This IS the DEF-044 answer.** With an idempotent posting per period, catching up after a
 * stopped scheduler is not a repair script — it is **running the same thing again**, and the
 * months already out no-op. v1's scheduler silently stopped for two months and its register still
 * looked fine, because the register was a maintained column.
 */
export async function amortisePrepaidItem(
  tx: Tx | null,
  actor: Actor,
  input: { prepaidItemId: string; asOfPeriod: string },
): Promise<AmortiseResult> {
  if (tx) return runAmortise(tx, actor, input);
  return transaction((trx) => runAmortise(trx, actor, input));
}

async function runAmortise(
  tx: Tx,
  actor: Actor,
  input: { prepaidItemId: string; asOfPeriod: string },
): Promise<AmortiseResult> {
  // ⭐ The gate is at the boundary; `amortiseItemCore` below is shared with the scheduled run.
  await authorize(tx, actor, 'run_amortisation', {});
  return amortiseItemCore(tx, actor.orgId, actor.personId, input);
}

async function amortiseItemCore(
  tx: Tx,
  orgId: string,
  postedBy: string | null,
  input: { prepaidItemId: string; asOfPeriod: string },
): Promise<AmortiseResult> {
  const actor = { orgId, personId: postedBy } as Actor;
  const item = await prepaidRepo.getById(tx, actor.orgId, input.prepaidItemId);
  if (!item) {
    throw new Error(`amortisePrepaidItem: prepaid item ${input.prepaidItemId} does not exist.`);
  }
  // Invariant 5 — a written-off or finished item stops. Not an error: running the whole register
  // will sweep over these every month, and a refusal would turn a normal state into noise.
  if (item.status !== 'active') return { posted: [], skipped: [] };

  const schedule = prepaidSchedule(item);
  const due = periodsThroughOf(schedule, input.asOfPeriod);
  const already = await prepaidRepo.postedPeriods(tx, actor.orgId, item.id);

  const posted: string[] = [];
  const skipped: string[] = [];

  for (const period of due) {
    if (already.has(period.period)) {
      skipped.push(period.period);
      continue;
    }
    // ⭐ The key IS the record of what ran, and the partial unique index makes the guarantee.
    // ⚠️ A period that was posted and then REVERSED needs a fresh key, or `postEntry` finds the
    // reversed entry and silently no-ops — which would make per-month reversal (§7.8) useless,
    // since the whole point is to correct a month and put it back.
    const priorAttempts = await prepaidRepo.entriesForPeriod(
      tx,
      actor.orgId,
      item.id,
      period.period,
    );
    const result = await postEntry(tx, {
      orgId: actor.orgId,
      entryDate: period.entryDate,
      sourceType: 'amortisation',
      sourceId: item.id,
      idempotencyKey: prepaidRepo.nextRevisionKey(item.id, period.period, priorAttempts),
      memo: `Amortisation — ${item.name} (${period.period})`,
      postedBy: actor.personId,
      lines: [
        // ⭐ DR 6750, CR 1400. No contra account: the asset balance runs DOWN.
        { accountCode: AMORTISATION_EXPENSE_CODE, storeId: item.storeId, debit: period.amount },
        { accountCode: PREPAID_ACCOUNT_CODE, storeId: item.storeId, credit: period.amount },
      ],
    });
    (result.created ? posted : skipped).push(period.period);
  }

  // The schedule finished. Only worth checking when this run actually posted something — behaviour
  // unchanged, see `checkFullyAmortised` below.
  if (posted.length > 0) {
    await checkFullyAmortised(tx, actor.orgId, item.id, schedule, input.asOfPeriod);
  }

  return { posted, skipped };
}

/**
 * ⭐ T-345 §3.2 step 9 — shared, not copied: `bookMissedMonth` re-runs this after catching up a
 * missed month, the same way the ordinary run does after posting one. Derived from the schedule's
 * own last period, never from a running total — there is no running total.
 */
export async function checkFullyAmortised(
  tx: Tx,
  orgId: string,
  itemId: string,
  schedule: SchedulePeriod[],
  asOfPeriod: string,
): Promise<void> {
  const last = schedule[schedule.length - 1];
  if (!last || asOfPeriod < last.period) return;
  const releasedAll = (await prepaidRepo.postedPeriods(tx, orgId, itemId)).size;
  if (releasedAll >= schedule.length) {
    await prepaidRepo.markStatus(tx, orgId, itemId, { status: 'fully_amortised' });
  }
}

// -------------------------------------------------------------------------------------
// ⭐ Reverse ONE month — the place v2 exceeds v1 (§7.8)
// -------------------------------------------------------------------------------------

/**
 * Undoes a single posted month, leaving every other month alone.
 *
 * ⭐ **v1 has no equivalent** (grep-confirmed, zero hits): its only undo is voiding the whole item,
 * which cascade-reverses every leg *including the original purchase*, so fixing one bad month
 * means re-creating the item and re-running every prior period.
 *
 * ⭐ **It is nearly free here, and the reason is the whole design.** Because the balance is
 * DERIVED, reversing the entry restores the correct figure with no column to walk back. In v1 it
 * was expensive precisely because the stored totals had to be repaired — the missing feature and
 * the stored column are the same problem wearing two hats.
 */
export async function reverseAmortisation(
  tx: Tx | null,
  actor: Actor,
  input: { prepaidItemId: string; period: string; reason: string },
): Promise<{ reversalEntryId: string }> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'run_amortisation', {});

    const reason = input.reason.trim();
    if (!reason) {
      throw new Error('reverseAmortisation: a reason is required — a reversal with no reason is a gap.');
    }
    const item = await prepaidRepo.getById(trx, actor.orgId, input.prepaidItemId);
    if (!item) {
      throw new Error(`reverseAmortisation: prepaid item ${input.prepaidItemId} does not exist.`);
    }
    const entry = await prepaidRepo.activeEntryForPeriod(trx, actor.orgId, item.id, input.period);
    if (!entry) {
      throw new Error(
        `reverseAmortisation: ${item.name} has nothing posted for ${input.period}.`,
      );
    }
    // ⚠️ No explicit idempotency key — `reverseEntry`'s own default is `reverse:{entryId}`, which
    // is already unique per attempt. Naming one per (item, period) would collide the moment a
    // month was reversed, re-posted and reversed again.
    const reversal = await reverseEntry(trx, {
      entryId: entry.id,
      reason,
      reversedBy: actor.personId,
    });

    // ⚠️ A finished item that loses a month is active again — otherwise the re-run would refuse
    // it as `fully_amortised` and the month could never be put back.
    if (item.status === 'fully_amortised') {
      await prepaidRepo.markStatus(trx, actor.orgId, item.id, { status: 'active' });
    }
    return { reversalEntryId: reversal.reversalEntryId };
  };
  if (tx) return run(tx);
  return transaction(run);
}

// -------------------------------------------------------------------------------------
// Write off — early termination, with an optional refund
// -------------------------------------------------------------------------------------

export interface WriteOffInput {
  prepaidItemId: string;
  writtenOffOn: string;
  reason: string;
  /** What actually came back. ⚠️ Cash returning is NOT income — see below. */
  refundAmount?: string;
  /** Where the refund landed. Required when `refundAmount` is set. */
  refundAccountCode?: string;
}

/**
 * Terminates an item early: whatever is left is recognised, and any refund comes back.
 *
 * ## ⚠️ A REFUND NEVER TOUCHES THE P&L
 *
 * Cancel a ₱24,000 policy at month 7 with ₱10,000 refunded. ₱14,000 is a real loss and hits
 * `6750`; the ₱10,000 is cash coming back and moves **balance sheet to balance sheet only**.
 * Booking the whole remainder as expense AND the refund as income would double-count the
 * cancellation — the entry would still balance, which is exactly why it needs saying.
 */
export async function writeOffPrepaidItem(
  tx: Tx | null,
  actor: Actor,
  input: WriteOffInput,
): Promise<{ entryId: string; expensed: string; refunded: string }> {
  if (tx) return runWriteOff(tx, actor, input);
  return transaction((trx) => runWriteOff(trx, actor, input));
}

async function runWriteOff(
  tx: Tx,
  actor: Actor,
  input: WriteOffInput,
): Promise<{ entryId: string; expensed: string; refunded: string }> {
  await authorize(tx, actor, 'manage_prepaid_items', {});

  const reason = input.reason.trim();
  if (!reason) throw new Error('writeOffPrepaidItem: a reason is required.');

  const item = await prepaidRepo.getById(tx, actor.orgId, input.prepaidItemId);
  if (!item) {
    throw new Error(`writeOffPrepaidItem: prepaid item ${input.prepaidItemId} does not exist.`);
  }
  if (item.status !== 'active') {
    throw new Error(`writeOffPrepaidItem: ${item.name} is already ${item.status}.`);
  }

  // ⭐ Remaining is DERIVED — cost less what the ledger says has been released. There is no
  // `remaining` column to trust or repair.
  const amortised = await prepaidRepo.amortisedFromLedger(tx, actor.orgId, item.id);
  const remaining: Money = subtract(money(item.totalCost), money(amortised));
  if (Number(remaining) <= 0) {
    throw new Error(
      `writeOffPrepaidItem: ${item.name} has nothing left to write off — it is fully released.`,
    );
  }

  // DEF-272: was a raw `money()` call — well-formed already, but its TypeError is a developer
  // message, not a written sentence. `parseMoneyInput` is the shared entry point that fixes that.
  const refunded = parseMoneyInput(input.refundAmount ?? '0', 'writeOffPrepaidItem: the refund amount');
  if (Number(refunded) < 0) {
    throw new Error('writeOffPrepaidItem: a refund cannot be negative.');
  }
  // Invariant 6 — write-off plus refund can never exceed what is left.
  if (Number(refunded) > Number(remaining)) {
    throw new Error(
      `writeOffPrepaidItem: the refund ${refunded} is more than the ${remaining} still unused. ` +
        'Money coming back beyond what was prepaid is income, not a refund.',
    );
  }
  if (Number(refunded) > 0 && !input.refundAccountCode) {
    throw new Error('writeOffPrepaidItem: a refund has to say which account it landed in.');
  }

  const expensed: Money = subtract(remaining, refunded);

  const lines = [
    // ⚠️ The unrecovered part is the ONLY thing that reaches the P&L.
    ...(Number(expensed) > 0
      ? [{ accountCode: AMORTISATION_EXPENSE_CODE, storeId: item.storeId, debit: expensed }]
      : []),
    ...(Number(refunded) > 0
      ? [{ accountCode: input.refundAccountCode!, storeId: item.storeId, debit: refunded }]
      : []),
    { accountCode: PREPAID_ACCOUNT_CODE, storeId: item.storeId, credit: remaining },
  ];

  const result = await postEntry(tx, {
    orgId: actor.orgId,
    entryDate: input.writtenOffOn,
    sourceType: 'prepaid_write_off',
    sourceId: item.id,
    idempotencyKey: `prepaid:${item.id}:write-off`,
    memo: `Write-off — ${item.name}: ${reason}`,
    postedBy: actor.personId,
    lines,
  });

  await prepaidRepo.markStatus(tx, actor.orgId, item.id, {
    status: 'written_off',
    writtenOffOn: input.writtenOffOn,
    writeOffReason: reason,
    writtenOffBy: actor.personId,
  });

  return { entryId: result.entryId, expensed: String(expensed), refunded: String(refunded) };
}

/**
 * DEF-163 — the missing counterpart to `reverseAmortisation`. A write-off wrongly recorded
 * (wrong item, cancelled by mistake) had no undo of its own — only the generic `reverseEntry`
 * on the entry id directly, which restores the ledger but leaves `prepaid_items.status` stuck
 * at `written_off`, with nothing to move it back and no way to resume amortising.
 */
export async function undoWriteOff(
  tx: Tx | null,
  actor: Actor,
  input: { prepaidItemId: string; reason: string },
): Promise<{ reversalEntryId: string }> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'manage_prepaid_items', {});

    const reason = input.reason.trim();
    if (!reason) throw new Error('undoWriteOff: a reason is required.');

    const item = await prepaidRepo.getById(trx, actor.orgId, input.prepaidItemId);
    if (!item) {
      throw new Error(`undoWriteOff: prepaid item ${input.prepaidItemId} does not exist.`);
    }
    if (item.status !== 'written_off') {
      throw new Error(`undoWriteOff: ${item.name} is ${item.status}, not written_off.`);
    }

    const entries = await journalRepo.findPostedEntriesBySource(
      trx,
      actor.orgId,
      'prepaid_write_off',
      item.id,
    );
    const entry = entries[0];
    if (!entry) {
      throw new Error(`undoWriteOff: ${item.name} has no posted write-off entry to reverse.`);
    }

    const reversal = await reverseEntry(trx, {
      entryId: entry.id,
      reason,
      reversedBy: actor.personId,
    });

    // Mirrors reverseAmortisation's own reasoning for the fully_amortised case: a status this
    // ledger event caused must be undone alongside it, or the item is stuck in a state nothing
    // can act on — no amortisation, no write-off, no way forward.
    await prepaidRepo.markStatus(trx, actor.orgId, item.id, {
      status: 'active',
      writtenOffOn: null,
      writeOffReason: null,
      writtenOffBy: null,
    });

    return { reversalEntryId: reversal.reversalEntryId };
  };
  if (tx) return run(tx);
  return transaction(run);
}

// -------------------------------------------------------------------------------------
// ⭐ The scheduled run (T-140)
// -------------------------------------------------------------------------------------

export interface AmortiseAllResult {
  posted: { itemId: string; itemName: string; periods: string[] }[];
  failed: { itemId: string; itemName: string; error: string }[];
  skipped: number;
}

/**
 * Every active prepaid item in one org, caught up through `asOfPeriod`.
 *
 * ⛔ Never reachable from a request handler — the only caller is the month-end CLI. There is no
 * capability check and no invented person: the control that matters is that this entry point can
 * do exactly one thing, not that a fabricated service account holds a role letting it do
 * everything an admin can (T-140 §2).
 *
 * ⚠️ **Each item gets its OWN transaction**, so one failure — most likely *"no fiscal period
 * covers 2026-06-30"* — cannot roll back the items that succeeded. The register is derived, so a
 * partial run is incomplete, never inconsistent.
 *
 * ## ⛔ Every one of those transactions carries its own principal — DEF-287
 *
 * Until 2026-09-11 none of them did: this function was named `…AsSystem` and opened bare,
 * principal-less transactions, so the name promised a database identity it never set. ⚠️ **And
 * the sentence directly above is the trap in miniature** — it names *"no fiscal period covers"*
 * as the expected failure, which is also exactly what a principal-less READ produces when the
 * period is present and simply invisible. A real missing period and a missing principal are
 * indistinguishable from the message, so the message could never have led anyone here. That
 * signature accounted for **344** of the 623 failures when the tenancy lock was first armed
 * (`docs/tasks/265-def-218-restricted-role-repair.md`).
 *
 * ⛔ **The principal has to be applied inside each per-item transaction, not once around the
 * loop** — the per-item isolation the paragraph above describes is exactly what makes an
 * outer principal unreachable.
 */
export async function runAmortisationAsSystem(
  orgId: string,
  asOfPeriod: string,
): Promise<AmortiseAllResult> {
  const items = await withSystemOrgPrincipal(orgId, (trx) =>
    prepaidRepo.listPrepaidItems(trx, orgId, { status: 'active' }),
  );

  const posted: AmortiseAllResult['posted'] = [];
  const failed: AmortiseAllResult['failed'] = [];
  let skipped = 0;

  for (const item of items) {
    try {
      const result = await withSystemOrgPrincipal(orgId, (trx) =>
        amortiseItemCore(trx, orgId, null, { prepaidItemId: item.id, asOfPeriod }),
      );
      if (result.posted.length === 0) skipped += 1;
      else posted.push({ itemId: item.id, itemName: item.name, periods: result.posted });
    } catch (err) {
      failed.push({
        itemId: item.id,
        itemName: item.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { posted, failed, skipped };
}
