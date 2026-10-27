/**
 * submitSalesDay · verifySalesDay · voidSalesDay. docs/tasks/123-sales-day.md §4, §6.
 *
 * ## ⭐ Verification IS the posting. That is the whole design
 *
 * An unverified day has no journal entry, so it contributes no revenue to any reader — not the
 * income statement, not a dashboard, not a roll-up. **v1 instead summed `salesDays.totalSales`,
 * making the mirror document the revenue, which forced the verified-only rule into three separate
 * readers with a code note saying "keep them in sync if you add a 4th."** A rule enforced in three
 * places is a rule that will one day be enforced in two (bible rows 118, 126).
 *
 * ## Segregation of duties
 *
 * `submit_sales_day` includes staff — a cashier closes their own day. `verify_sales_day` does not.
 * *"The person who submits should not be the one who verifies"* (CAPABILITY-MATRIX.md), and v1's
 * four-role `signoff` block shows the business already knows it.
 *
 * T-385 (Ian 2026-10-09): verify requires `submitted`. The check sits before routing and posting.
 */
import { authorize, type Actor, can } from '@shareat/auth';
import { auditLogRepo, journalRepo, posV1Repo, salesDaysRepo, type Tx } from '@shareat/db';
import type { PeriodOverrideReason } from '@shareat/db/schema';
import { buildPeriodFacts, periodRefusal } from '../business-rules';
import { postEntry } from '../ledger/post-entry';
import { reverseEntry } from '../ledger/reverse-entry';
import { routeInputForDay } from './compose';
import { routeSalesDay } from './routing';
import { refuse, gone, internalFault } from '../shared/refusal';

export interface VerifySalesDayResult {
  journalEntryId: string;
  /** false means this day was already verified — nothing new was written. */
  created: boolean;
}

// -------------------------------------------------------------------------------------
// submit
// -------------------------------------------------------------------------------------

export async function submitSalesDay(tx: Tx, actor: Actor, salesDayId: string): Promise<void> {
  return runSubmit(tx, actor, salesDayId);
}

async function runSubmit(tx: Tx, actor: Actor, salesDayId: string): Promise<void> {
  const day = await salesDaysRepo.getById(tx, actor.orgId, salesDayId);
  if (!day) throw gone(`submitSalesDay: sales day ${salesDayId} does not exist in org ${actor.orgId}`, 'sales day');

  await authorize(tx, actor, 'submit_sales_day', { storeId: day.storeId });

  if (day.status !== 'open') {
    throw refuse(
      `submitSalesDay: sales day ${salesDayId} is ${day.status} — only an open day may be submitted`,
      `Only an open sales day can be submitted — this one is ${day.status}.`,
    );
  }
  await salesDaysRepo.markSubmitted(tx, actor.orgId, salesDayId, actor.personId);
  // T-402 S3 (C4): the step's event, same transaction, after its own write.
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'sales_day.submitted',
    storeId: day.storeId,
    entityId: salesDayId,
    before: { status: day.status },
    after: { status: 'submitted' },
    source: 'web',
  });
}

// -------------------------------------------------------------------------------------
// verify — the posting step
// -------------------------------------------------------------------------------------

/**
 * T-487 (DEF-779): `periodOverride` lets an administrator post a day into a CLOSED month. It is forwarded to `postEntry` only
 * when the day's month IS closed (an open month ignores it, so an ordinary verify leaves no audit row), and `postEntry` itself
 * authorizes `override_period_lock` and writes the `period_overrides` row. A LOCKED month never takes it.
 */
export interface VerifySalesDayOptions {
  periodOverride?: { reason: PeriodOverrideReason; note?: string | null };
}

export async function verifySalesDay(
  tx: Tx,
  actor: Actor,
  salesDayId: string,
  options?: VerifySalesDayOptions,
): Promise<VerifySalesDayResult> {
  return runVerify(tx, actor, salesDayId, options);
}

async function runVerify(tx: Tx, actor: Actor, salesDayId: string, options?: VerifySalesDayOptions): Promise<VerifySalesDayResult> {
  // T-369 S3 / R5: `FOR UPDATE`, so an edit in flight finishes first and verify posts ITS figures.
  const day = await salesDaysRepo.getByIdForUpdate(tx, actor.orgId, salesDayId);
  if (!day) throw gone(`verifySalesDay: sales day ${salesDayId} does not exist in org ${actor.orgId}`, 'sales day');

  await authorize(tx, actor, 'verify_sales_day', { storeId: day.storeId });

  // Idempotent, like approveExpense: re-verifying an already-verified day is a safe no-op rather
  // than a second entry.
  if (day.status === 'verified') {
    if (!day.journalEntryId) {
      throw internalFault(
        `verifySalesDay: sales day ${salesDayId} is verified but carries no journalEntryId — data inconsistency`,
      );
    }
    return { journalEntryId: day.journalEntryId, created: false };
  }
  if (day.status === 'voided') {
    throw refuse(
      `verifySalesDay: sales day ${salesDayId} is voided — cannot post`,
      "This sales day has been voided, so it can't be posted.",
    );
  }
  // T-385 (Ian 2026-10-09): verify and post only after submit. Before routing, so no entry is attempted.
  if (day.status !== 'submitted') {
    throw refuse(
      `verifySalesDay: sales day ${salesDayId} is ${day.status} — only a submitted day may be verified`,
      "This sales day hasn't been submitted yet. Submit it first; it can be verified and posted after that.",
    );
  }

  // T-385 S3: the person who submitted a day may not verify it, unless they hold verify_own_sales_day (super-admin only).
  if (day.submittedBy && day.submittedBy === actor.personId) {
    const exempt = await can(tx, actor, 'verify_own_sales_day');
    if (!exempt) {
      throw refuse(
        `verifySalesDay: sales day ${salesDayId} was submitted by the actor — a different person must verify`,
        'You submitted this day, so someone else has to verify it.',
      );
    }
  }

  const channels = await salesDaysRepo.getChannelsForDay(tx, salesDayId);
  const tenders = await salesDaysRepo.getTendersForDay(tx, salesDayId);

  // T-375 S4 (R8): `routeInputForDay` composes a feed day's platform sales; a typed day routes as it always did.
  const routed = routeSalesDay(routeInputForDay(day, channels, tenders));

  if (!routed.ok) {
    // ⚠️ The day is UNCHANGED — still open or submitted, fixable and re-verifiable. A day that
    // cannot balance quarantines rather than posting a guessed entry, and the reason names what
    // disagrees with what.
    throw refuse(
      `verifySalesDay: sales day ${salesDayId} cannot post — ${routed.reason}`,
      `This sales day can't be posted yet: ${routed.reason}.`,
    );
  }

  // T-487 (DEF-779): say, in words, when the day's month will not take the posting - `postEntry`'s own refusal is a developer
  // sentence carrying ids. The same pair `approveExpense` uses (T-475 P2); nothing is written when it refuses.
  const period = await journalRepo.findPeriodForDate(tx, actor.orgId, day.businessDate);
  const month = periodRefusal(buildPeriodFacts(period), { override: !!options?.periodOverride });
  if (month?.kind === 'locked') {
    throw refuse(`verifySalesDay: the fiscal period covering ${day.businessDate} is locked.`, month.sentence);
  }
  if (month?.kind === 'closed') {
    throw refuse(
      `verifySalesDay: the fiscal period covering ${day.businessDate} is closed and no periodOverride was given.`,
      month.sentence,
    );
  }
  // The override is passed on ONLY when the month is closed, so an open month leaves no audit row and never asks for `override_period_lock`.
  const periodOverride = period?.status === 'closed' ? options?.periodOverride : undefined;

  const result = await postEntry(tx, {
    orgId: actor.orgId,
    // ⭐ The BUSINESS DATE, never now() (bible row 126). A 31 December day verified on 2 January
    // is December revenue — without this the create-block would merely relocate the error into
    // the wrong month.
    entryDate: day.businessDate,
    sourceType: 'sale',
    sourceId: salesDayId,
    idempotencyKey: `sales_day:${salesDayId}:post`,
    memo: `Sales for ${day.businessDate}`,
    postedBy: actor.personId,
    ...(periodOverride ? { periodOverride: { actor, reason: periodOverride.reason, note: periodOverride.note ?? null } } : {}),
    lines: routed.lines.map((l) => ({
      accountCode: l.accountCode,
      storeId: day.storeId,
      partyType: l.partyType ?? null,
      partyId: l.partyId ?? null,
      debit: l.side === 'debit' ? String(l.amount) : '0',
      credit: l.side === 'credit' ? String(l.amount) : '0',
      lineMemo: l.lineMemo ?? null,
    })),
  });

  if (result.created) {
    await salesDaysRepo.markVerified(tx, actor.orgId, salesDayId, {
      verifiedBy: actor.personId,
      journalEntryId: result.entryId,
    });
    // T-402 S3 (C4): the verification step's event, same transaction, after the posting and its own write.
    await auditLogRepo.append(tx, actor.orgId, {
      actorPersonId: actor.personId,
      action: 'sales_day.verified',
      storeId: day.storeId,
      entityId: salesDayId,
      before: { status: day.status },
      after: { status: 'verified', journalEntryId: result.entryId },
      source: 'web',
    });
  }

  return { journalEntryId: result.entryId, created: result.created };
}

// -------------------------------------------------------------------------------------
// void — a reversal, never a deletion
// -------------------------------------------------------------------------------------

export async function voidSalesDay(
  tx: Tx,
  actor: Actor,
  salesDayId: string,
  reason: string,
): Promise<{ reversalEntryId: string | null }> {
  return runVoid(tx, actor, salesDayId, reason);
}

async function runVoid(
  tx: Tx,
  actor: Actor,
  salesDayId: string,
  reason: string,
): Promise<{ reversalEntryId: string | null }> {
  // T-369 S3 / R5: `FOR UPDATE`, so a withdraw and a verify (or an edit) of one day serialise.
  const day = await salesDaysRepo.getByIdForUpdate(tx, actor.orgId, salesDayId);
  if (!day) throw gone(`voidSalesDay: sales day ${salesDayId} does not exist in org ${actor.orgId}`, 'sales day');

  await authorize(tx, actor, 'void_sales_day', { storeId: day.storeId });

  if (day.status === 'voided') {
    throw refuse(`voidSalesDay: sales day ${salesDayId} is already voided`, 'This sales day is already voided.');
  }

  const trimmed = (reason ?? '').trim();
  const needReason = () =>
    refuse(
      'voidSalesDay: reason is required and cannot be empty or whitespace-only',
      'Reason is required and cannot be empty or whitespace-only.',
    );

  // T-369 S3 / R3: an UNVERIFIED day posted nothing, so there is nothing to reverse - it is just
  // withdrawn. Refused while something else still hangs off it; that is undone first, on its own screen.
  if (day.status !== 'verified') {
    if (!trimmed) throw needReason();
    const blockers = await salesDaysRepo.withdrawBlockers(tx, actor.orgId, day);
    if (blockers.usagePull) {
      throw refuse(
        `voidSalesDay: sales day ${salesDayId} has a live POS usage pull`,
        'This day has a POS usage pull. Void it first under Inventory › POS usage.',
      );
    }
    if (blockers.wastage) {
      throw refuse(
        `voidSalesDay: sales day ${salesDayId} has order wastage recorded against it`,
        "Wastage is recorded against this day, so it can't be withdrawn." +
          (day.source === 'pos_v1_day_feed'
            ? ' Re-import it from POS instead.'
            : (await posV1Repo.getLinkByStore(tx, actor.orgId, day.storeId))
              ? ''
              : ' Edit its figures instead.'),
      );
    }
    if (blockers.remittance) {
      throw refuse(
        `voidSalesDay: sales day ${salesDayId} has a posted remittance counted against it`,
        'Cash handed over has been counted against this day. Reverse that handover first.',
      );
    }
    await salesDaysRepo.markUnverifiedVoided(tx, actor.orgId, salesDayId, {
      voidedBy: actor.personId,
      voidReason: trimmed,
    });
    return { reversalEntryId: null };
  }

  if (!day.journalEntryId) {
    throw internalFault(`voidSalesDay: sales day ${salesDayId} is verified but carries no journalEntryId — data inconsistency`);
  }
  if (!trimmed) throw needReason();

  // The ORIGINAL entry stands. Both sides remain in the ledger (bible §4) — this is the same
  // treatment an expense void gets, and for the same reason: a void is a statement about what
  // happened, not an erasure of it.
  const reversal = await reverseEntry(tx, {
    entryId: day.journalEntryId,
    reason: `Sales day ${day.businessDate} voided: ${trimmed}`,
    reversedBy: actor.personId,
  });

  // T-375 S6 (R10, V3): a corrected day's correction entries are reversed too, newest first, in this transaction. The
  // correction rows stay (append-only); each reversal keeps the sale source and the correction's own source id.
  const corrections = await posV1Repo.listCorrectionsForDay(tx, actor.orgId, salesDayId);
  for (const c of [...corrections].reverse()) {
    await reverseEntry(tx, {
      entryId: c.journalEntryId,
      reason: `Sales day ${day.businessDate} voided: ${trimmed} (POS correction)`,
      reversedBy: actor.personId,
    });
  }

  await salesDaysRepo.markVoided(tx, actor.orgId, salesDayId, {
    voidedBy: actor.personId,
    voidReason: trimmed,
  });

  return { reversalEntryId: reversal.reversalEntryId };
}
