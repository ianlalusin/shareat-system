/**
 * T-511 S6b - `correctPlatformSales`: the platform's FILE figure replaces the staff figure in a day's sales and receivable, through a correcting entry.
 * `docs/tasks/511-settlement-upload-s6-spec.md` S6b, design decision 17 (option B), `docs/POSTING-PATTERNS.md` `sale.platform-correction`.
 *
 * The day's own entry and `sales_day_channels.amount` never change (a verified day is locked, and history is a new fact, not an edit). What is posted is the DIFFERENCE:
 *
 *   old   = the channel's receivable on the day's own entry plus the entries of its earlier platform corrections, read from `journal_lines` (what was POSTED);
 *   new   = the file figure of the staged line (`order_value`, net of the platform discount: what staff record);
 *   delta = new - old. Positive posts Dr receivable (party the channel) / Cr 4150; negative is the same pair the other way round; zero posts nothing.
 *
 * One correction per staged day line per sales day (`sales_day_platform_corrections`, unique per day and line), keyed `sales_day:{day}:platform_correction:{line}`. The entry's `source_id`
 * IS the correction's id, so reports, the dual-run reader and a void of the day find it. A correction is dated on the sales day when its month is open, else on the first
 * open date after it; a period is never reopened. Shaped after `postPosCorrection` (sales-days/correction.ts), which posts the POS delta only: a platform correction
 * stands because that function's `new` never carries platform rows the staff typed differently.
 *
 * Until slice 8 fixes `outstandingFor`, only the standard channel receivable is cleared by a settlement, so another receivable code is refused.
 * No caller until slice 7 (approve a settlement day) posts the correction first and the settlement second, in one transaction.
 */
import { auditLogRepo, channelSettlementsRepo, fiscalPeriodsRepo, journalRepo, manilaToday, posV1Repo, salesDaysRepo, settlementIntakeRepo, type Tx } from '@shareat/db';
import { authorize, type Actor } from '@shareat/auth';
import { add, compare, isZero, money, negate, subtract, ZERO } from '@shareat/core/money';
import { parseBusinessDate } from '@shareat/core/datetime';
import { postEntry } from '../ledger/post-entry';
import { SALES_DAY_ACCOUNTS } from '../sales-days/routing';
import { gone, humanDate, refuse } from '../shared/refusal';
import { assertFieldRules } from '../shared/field-rules-assert';
import { PLATFORM_CORRECTION_RULES } from '../field-rules/channel-settlements';

export interface CorrectPlatformSalesInput {
  /** The staged `settlement_day_lines` id: its `order_value` is the file figure, its channel, store and sales date name the day. */
  readonly dayLineId: string;
  readonly reason: string;
}

export type CorrectPlatformSalesResult =
  | { readonly corrected: false }
  | { readonly corrected: true; readonly correctionId: string; readonly journalEntryId: string };

function dayLabel(date: string): string {
  try {
    return humanDate(parseBusinessDate(date));
  } catch {
    return date;
  }
}

export async function correctPlatformSales(tx: Tx, actor: Actor, input: CorrectPlatformSalesInput): Promise<CorrectPlatformSalesResult> {
  return correctPlatformSalesOnClock(tx, actor, input);
}

/**
 * The test seam: `today` (YYYY-MM-DD) is the clock for "the first open date", the Manila date when omitted. It is not on the barrel and not on the production
 * signature, so no caller can date an entry in the future; the integration tests use it for sales days in their fixtures' own calendar.
 */
export async function correctPlatformSalesOnClock(tx: Tx, actor: Actor, input: CorrectPlatformSalesInput, today?: string): Promise<CorrectPlatformSalesResult> {
  const { orgId } = actor;
  // Unlocked read: only to learn the line's store and date (they never change) for the gate and the day lookup.
  const seen = await settlementIntakeRepo.dayLineById(tx, orgId, input.dayLineId);
  if (!seen) throw gone(`correctPlatformSales: staged day line ${input.dayLineId} does not exist in org ${orgId}`, 'settlement day');

  // The gate, with the line's store scope, before any figure of the day is read.
  await authorize(tx, actor, 'record_ar_collection', { storeId: seen.storeId });
  const reason = assertFieldRules(PLATFORM_CORRECTION_RULES, { reason: input.reason }).reason!;

  const when = dayLabel(seen.salesDate);
  const found = await salesDaysRepo.findByBusinessDate(tx, orgId, seen.storeId, seen.salesDate);
  if (!found) {
    throw refuse(`correctPlatformSales: no live sales day for store ${seen.storeId} on ${seen.salesDate}`, `There is no sales day for ${when} to correct.`);
  }
  // The day lock, as import / usage / POS correction take it, so two corrections and a void serialize.
  const day = await salesDaysRepo.getByIdForUpdate(tx, orgId, found.id);
  if (!day || day.status !== 'verified' || !day.journalEntryId) {
    throw refuse(
      `correctPlatformSales: sales day ${found.id} is ${day?.status ?? 'gone'}, not verified`,
      `${when} hasn't been verified yet, so there is no posted sales figure to correct.`,
    );
  }

  // Under the lock, re-read the line (a concurrent file upload, rejection or settlement may have changed it since the first read).
  const line = await settlementIntakeRepo.dayLineById(tx, orgId, seen.id, { forUpdate: true });
  if (!line) throw gone(`correctPlatformSales: staged day line ${seen.id} vanished in org ${orgId}`, 'settlement day');
  // A line that already carries its correction on THIS sales day is done: a repeat is a quiet no-op. (A voided day re-entered on the same date is a new sales day.)
  if (await settlementIntakeRepo.platformCorrectionForLine(tx, orgId, day.id, line.id)) return { corrected: false };
  if (!line.isCurrent) {
    throw refuse(`correctPlatformSales: staged day line ${line.id} is not the current line of its day`, `A newer file has replaced the figure for ${when}, so this one can't be posted.`);
  }
  if (line.reviewState !== 'pending') {
    throw refuse(
      `correctPlatformSales: staged day line ${line.id} is ${line.reviewState}, not pending`,
      line.reviewState === 'rejected'
        ? `The file figure for ${when} was rejected, so it can't be posted. Reopen the day first.`
        : `The file figure for ${when} is already booked, so it can't be posted again.`,
    );
  }

  const channel = await salesDaysRepo.channelById(tx, orgId, line.channelId);
  if (!channel) throw gone(`correctPlatformSales: channel ${line.channelId} does not exist in org ${orgId}`, 'sales channel');
  const receivable = channel.receivableAccountCode;
  if (receivable !== channelSettlementsRepo.CHANNEL_RECEIVABLE_CODE) {
    throw refuse(
      `correctPlatformSales: channel ${channel.id} receivable account is ${receivable ?? 'unset'}, not the standard channel receivable`,
      `${channel.name} doesn't use the standard channel receivable account, so its sales can't be corrected from a platform file yet.`,
    );
  }

  // ---- old: what was POSTED for this channel and day -----------------------------------------------------------------
  const priors = (await settlementIntakeRepo.listPlatformCorrectionsForDay(tx, orgId, day.id)).filter((c) => c.channelId === channel.id);
  const rows = await posV1Repo.postedNetForEntries(tx, orgId, [day.journalEntryId, ...priors.map((c) => c.journalEntryId)]);
  const old = add(ZERO, ...rows.filter((r) => r.accountCode === receivable && r.partyType === 'channel' && r.partyId === channel.id).map((r) => money(r.net)));
  const file = money(line.orderValue);
  const delta = subtract(file, old);
  if (isZero(delta)) return { corrected: false };

  // ---- dating: the sales day if its month is open, else the first open date after it; never a reopened period ---------
  const clock = today ?? (await manilaToday(tx));
  const open = await fiscalPeriodsRepo.firstOpenDateOnOrAfter(tx, orgId, day.businessDate, clock);
  if (!open) {
    throw refuse(
      `correctPlatformSales: every fiscal period from ${day.businessDate} up to ${clock} is closed or locked`,
      `Every month from ${when} up to today is closed, so the correction can't be dated. Ask an admin to open a month first.`,
    );
  }
  if (!(await journalRepo.findPeriodForDate(tx, orgId, open.date))) {
    throw refuse(`correctPlatformSales: no fiscal period covers ${open.date} for org ${orgId}`, `There is no fiscal period for ${dayLabel(open.date)} yet.`);
  }

  // ---- post, then record ------------------------------------------------------------------------------------------
  const up = compare(delta, ZERO) > 0;
  const amount = String(up ? delta : negate(delta));
  const memo = `${channel.name} file correction`;
  const channelLine = {
    accountCode: receivable,
    storeId: day.storeId,
    partyType: 'channel' as const,
    partyId: channel.id,
    debit: up ? amount : '0',
    credit: up ? '0' : amount,
    lineMemo: memo,
  };
  const salesLine = { accountCode: SALES_DAY_ACCOUNTS.ALA_CARTE, storeId: day.storeId, debit: up ? '0' : amount, credit: up ? amount : '0', lineMemo: memo };
  const correctionId = crypto.randomUUID();
  const posted = await postEntry(tx, {
    orgId,
    entryDate: open.date,
    sourceType: 'sale',
    sourceId: correctionId,
    idempotencyKey: `sales_day:${day.id}:platform_correction:${line.id}`,
    memo: `${channel.name} file correction for ${day.businessDate}: ${reason}`,
    postedBy: actor.personId,
    lines: up ? [channelLine, salesLine] : [salesLine, channelLine],
  });
  if (!posted.created) return { corrected: false };
  await settlementIntakeRepo.insertPlatformCorrection(tx, {
    id: correctionId,
    orgId,
    storeId: day.storeId,
    salesDayId: day.id,
    channelId: channel.id,
    dayLineId: line.id,
    fromAmount: old,
    toAmount: file,
    entryDate: open.date,
    journalEntryId: posted.entryId,
    reason,
    postedBy: actor.personId,
  });

  // Same transaction, only on a real write. `source: 'web'`: the ERP approve screen is the only caller (slice 7).
  await auditLogRepo.append(tx, orgId, {
    actorPersonId: actor.personId,
    action: 'platform_sales.corrected',
    storeId: day.storeId,
    entityId: correctionId,
    before: { figure: String(old) },
    after: { figure: String(file), entryDate: open.date, journalEntryId: posted.entryId },
    source: 'web',
  });
  return { corrected: true, correctionId, journalEntryId: posted.entryId };
}
