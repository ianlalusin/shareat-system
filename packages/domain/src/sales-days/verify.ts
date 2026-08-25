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
 */
import { authorize, type Actor } from '@shareat/auth';
import { salesDaysRepo, transaction, type Tx } from '@shareat/db';
import { money } from '@shareat/core/money';
import { postEntry } from '../ledger/post-entry';
import { reverseEntry } from '../ledger/reverse-entry';
import { routeSalesDay } from './routing';

export interface VerifySalesDayResult {
  journalEntryId: string;
  /** false means this day was already verified — nothing new was written. */
  created: boolean;
}

// -------------------------------------------------------------------------------------
// submit
// -------------------------------------------------------------------------------------

export async function submitSalesDay(tx: Tx | null, actor: Actor, salesDayId: string): Promise<void> {
  if (tx) return runSubmit(tx, actor, salesDayId);
  return transaction((trx) => runSubmit(trx, actor, salesDayId));
}

async function runSubmit(tx: Tx, actor: Actor, salesDayId: string): Promise<void> {
  const day = await salesDaysRepo.getById(tx, actor.orgId, salesDayId);
  if (!day) throw new Error(`submitSalesDay: sales day ${salesDayId} does not exist in org ${actor.orgId}`);

  await authorize(tx, actor, 'submit_sales_day', { storeId: day.storeId });

  if (day.status !== 'open') {
    throw new Error(`submitSalesDay: sales day ${salesDayId} is ${day.status} — only an open day may be submitted`);
  }
  await salesDaysRepo.markSubmitted(tx, actor.orgId, salesDayId, actor.personId);
}

// -------------------------------------------------------------------------------------
// verify — the posting step
// -------------------------------------------------------------------------------------

export async function verifySalesDay(
  tx: Tx | null,
  actor: Actor,
  salesDayId: string,
): Promise<VerifySalesDayResult> {
  if (tx) return runVerify(tx, actor, salesDayId);
  return transaction((trx) => runVerify(trx, actor, salesDayId));
}

async function runVerify(tx: Tx, actor: Actor, salesDayId: string): Promise<VerifySalesDayResult> {
  const day = await salesDaysRepo.getById(tx, actor.orgId, salesDayId);
  if (!day) throw new Error(`verifySalesDay: sales day ${salesDayId} does not exist in org ${actor.orgId}`);

  await authorize(tx, actor, 'verify_sales_day', { storeId: day.storeId });

  // Idempotent, like approveExpense: re-verifying an already-verified day is a safe no-op rather
  // than a second entry.
  if (day.status === 'verified') {
    if (!day.journalEntryId) {
      throw new Error(
        `verifySalesDay: sales day ${salesDayId} is verified but carries no journalEntryId — data inconsistency`,
      );
    }
    return { journalEntryId: day.journalEntryId, created: false };
  }
  if (day.status === 'voided') {
    throw new Error(`verifySalesDay: sales day ${salesDayId} is voided — cannot post`);
  }

  const channels = await salesDaysRepo.getChannelsForDay(tx, salesDayId);

  const routed = routeSalesDay({
    totalSales: money(day.totalSales),
    unliSales: money(day.unliSales),
    alaCarteSales: money(day.alaCarteSales),
    seniorDiscount: money(day.seniorDiscount),
    pwdDiscount: money(day.pwdDiscount),
    otherDiscount: money(day.otherDiscount),
    comps: money(day.comps),
    cashCollected: money(day.cashCollected),
    onlineCollected: money(day.onlineCollected),
    creditSales: money(day.creditSales),
    channels: channels.map((c) => ({
      channelId: c.channelId,
      channelName: c.channelName,
      isRemittedDaily: c.isRemittedDaily,
      receivableAccountCode: c.receivableAccountCode,
      amount: money(c.amount),
      noSales: c.noSales,
    })),
  });

  if (!routed.ok) {
    // ⚠️ The day is UNCHANGED — still open or submitted, fixable and re-verifiable. A day that
    // cannot balance quarantines rather than posting a guessed entry, and the reason names what
    // disagrees with what.
    throw new Error(`verifySalesDay: sales day ${salesDayId} cannot post — ${routed.reason}`);
  }

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
  }

  return { journalEntryId: result.entryId, created: result.created };
}

// -------------------------------------------------------------------------------------
// void — a reversal, never a deletion
// -------------------------------------------------------------------------------------

export async function voidSalesDay(
  tx: Tx | null,
  actor: Actor,
  salesDayId: string,
  reason: string,
): Promise<{ reversalEntryId: string }> {
  if (tx) return runVoid(tx, actor, salesDayId, reason);
  return transaction((trx) => runVoid(trx, actor, salesDayId, reason));
}

async function runVoid(
  tx: Tx,
  actor: Actor,
  salesDayId: string,
  reason: string,
): Promise<{ reversalEntryId: string }> {
  const day = await salesDaysRepo.getById(tx, actor.orgId, salesDayId);
  if (!day) throw new Error(`voidSalesDay: sales day ${salesDayId} does not exist in org ${actor.orgId}`);

  await authorize(tx, actor, 'void_sales_day', { storeId: day.storeId });

  // ⚠️ Status first, before any posting work: an unverified day has nothing to reverse, and a
  // voided one has already been reversed.
  if (day.status !== 'verified') {
    throw new Error(
      `voidSalesDay: sales day ${salesDayId} is ${day.status} — only a verified day has a posting to ` +
        `reverse. An unverified day is edited or left alone; nothing has been recognised from it`,
    );
  }
  if (!day.journalEntryId) {
    throw new Error(`voidSalesDay: sales day ${salesDayId} is verified but carries no journalEntryId — data inconsistency`);
  }

  const trimmed = (reason ?? '').trim();
  if (!trimmed) {
    throw new Error('voidSalesDay: reason is required and cannot be empty or whitespace-only');
  }

  // The ORIGINAL entry stands. Both sides remain in the ledger (bible §4) — this is the same
  // treatment an expense void gets, and for the same reason: a void is a statement about what
  // happened, not an erasure of it.
  const reversal = await reverseEntry(tx, {
    entryId: day.journalEntryId,
    reason: `Sales day ${day.businessDate} voided: ${trimmed}`,
    reversedBy: actor.personId,
  });

  await salesDaysRepo.markVoided(tx, actor.orgId, salesDayId, {
    voidedBy: actor.personId,
    voidReason: trimmed,
  });

  return { reversalEntryId: reversal.reversalEntryId };
}
