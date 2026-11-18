/**
 * T-511 S6c - `postPlatformCharge`: a platform charge with no sales day (the weekly platform fee, or any uncategorised Appendix B charge) is booked ONCE.
 * `docs/tasks/511-settlement-upload-s6c-spec.md` Design B, `docs/POSTING-PATTERNS.md` `channel_charge.period_fee`.
 *
 * The staged line is `period_charge`, `booked_as none` (S4): no day carries it, so no settlement books it. This function does, from the staged line and its stored VAT
 * (`settlement_other_lines.vat_amount`, the file's own rate, never a constant here):
 *
 *   total = net + VAT (whole centavos). total > 0: Dr 6400 (fee + VAT, one line, the memo says VAT is included, bible row 75) / Cr 1220 party the channel;
 *   total < 0 (a platform credit note, or a reversal): the same pair the other way round. T-511 S8b (Ian, 15 Nov): dated on the charge when ITS month is open; when that month is
 *   closed, TODAY (Manila) when today's month is open; when both are closed the charge is refused. A period is never reopened. The reason a charge was moved is kept on the entry,
 *   on the audit row and in the returned `dateNote`. Source type `channel_charge`, source_id = the charge row's id, key `channel_charge:{otherLine}:post` (never the date).
 *
 * ONE charge per staged line (`channel_period_charges`, unique per other line). The staged line is never touched: "posted" lives in that table.
 * ⛔ The double-count rule: a LATER payout that nets this charge says so (`settleChargeIds` on `recordChannelSettlement`), so the receivable is credited once and the charge is
 * never expensed a second time as a settlement variance. The accounts are the named constants of the channel-settlement repo (no literal here).
 *
 * T-606: a settlement clears ONLY the channel receivable (`outstandingFor` reads that one account, by design), so a channel on another receivable code is refused until its receivable is set to it.
 * No caller until slice 7 (approve a settlement upload) posts it.
 */
import { refuseStrandedChannelBalance } from './stranded-balance';
import { advisoryLocksRepo, auditLogRepo, channelSettlementsRepo, fiscalPeriodsRepo, journalRepo, manilaToday, salesDaysRepo, settlementIntakeRepo, type Tx } from '@shareat/db';
import { authorize, type Actor } from '@shareat/auth';
import { add, compare, isZero, money, negate, ZERO } from '@shareat/core/money';
import { parseBusinessDate } from '@shareat/core/datetime';
import { postEntry } from '../ledger/post-entry';
import { gone, humanDate, refuse } from '../shared/refusal';

const R = channelSettlementsRepo;

export interface PostPlatformChargeInput {
  /** The staged `settlement_other_lines` id of the charge (kind `period_charge`, no sales day). */
  readonly otherLineId: string;
}

export type PostPlatformChargeResult =
  | { readonly posted: false }
  | {
      readonly posted: true;
      readonly chargeId: string;
      readonly journalEntryId: string;
      /** T-511 S8b: why the entry is not dated on the charge ("Dated 5 Nov 2026 instead of 14 Oct 2026: October 2026 is closed."); null when it is */
      readonly dateNote: string | null;
    };

function dayLabel(date: string): string {
  try {
    return humanDate(parseBusinessDate(date));
  } catch {
    return date;
  }
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;
/** `2026-10-14` -> `October 2026`. Anything that is not a date comes back as it was. (Written with Date methods only: this file does money and a scan keeps it free of float helpers.) */
function monthLabel(date: string): string {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00Z`) : null;
  const name = d && !Number.isNaN(d.getTime()) ? MONTH_NAMES[d.getUTCMonth()] : undefined;
  return d && name ? `${name} ${d.getUTCFullYear()}` : date;
}

/**
 * T-511 S8b: the sentence that says a charge was booked on another date than its own because its month is closed. One copy: the posting writes it on the entry, the audit row and
 * the success message, and the review screen rebuilds it from the two dates of a booked charge (`entryDate` differs from `chargeDate`).
 */
export function lateChargeNote(chargeDate: string, entryDate: string): string {
  return `Dated ${dayLabel(entryDate)} instead of ${dayLabel(chargeDate)}: ${monthLabel(chargeDate)} is closed.`;
}

export async function postPlatformCharge(tx: Tx, actor: Actor, input: PostPlatformChargeInput): Promise<PostPlatformChargeResult> {
  return postPlatformChargeOnClock(tx, actor, { otherLineId: input.otherLineId });
}

/**
 * The test seam: `today` (YYYY-MM-DD) is the clock for "the first open date", the Manila date when omitted. It is not on the barrel and not on the production
 * signature, so no caller can date an entry in the future; the integration tests use it for charges in their fixtures' own calendar.
 */
export async function postPlatformChargeOnClock(tx: Tx, actor: Actor, input: PostPlatformChargeInput, today?: string): Promise<PostPlatformChargeResult> {
  const { orgId } = actor;
  // Unlocked read: only to learn the line's store (it never changes) for the gate.
  const seen = await settlementIntakeRepo.otherLineWithUpload(tx, orgId, input.otherLineId);
  if (!seen) throw gone(`postPlatformCharge: staged line ${input.otherLineId} does not exist in org ${orgId}`, 'staged charge');

  // The gate, with the upload's store scope, before any figure is read.
  await authorize(tx, actor, 'record_ar_collection', { storeId: seen.storeId });

  // The channel lock the file upload takes, so a re-upload that retires this line and two posts of it serialise (never FOR UPDATE on an append-only table).
  await advisoryLocksRepo.lockSettlementChannel(tx, seen.channelId);
  const line = await settlementIntakeRepo.otherLineWithUpload(tx, orgId, seen.id);
  if (!line) throw gone(`postPlatformCharge: staged line ${seen.id} vanished in org ${orgId}`, 'staged charge');
  // A line already booked is done: a repeat is a quiet no-op.
  if (await R.chargeForOtherLine(tx, orgId, line.id)) return { posted: false };

  if (line.kind !== 'period_charge' || line.bookedAs !== 'none' || line.dayLineId !== null) {
    throw refuse(
      `postPlatformCharge: staged line ${line.id} is ${line.kind} booked as ${line.bookedAs}${line.dayLineId ? ' on a day' : ''}, not a charge with no sales day`,
      'This line is not a charge without a sales day. The settlement of its day books it, or it is never booked from a statement, so it can\'t be booked here.',
    );
  }
  if (!line.isCurrent) {
    throw refuse(`postPlatformCharge: staged line ${line.id} is not current`, 'A newer file has replaced this charge, so this one can\'t be booked.');
  }
  // Ingest marks the OLD upload replaced (same channel, kind and period) but never retires its period lines, so `isCurrent` above cannot catch a re-upload.
  if (line.uploadSupersededBy !== null) {
    throw refuse(
      `postPlatformCharge: staged line ${line.id} belongs to upload ${line.uploadId}, superseded by ${line.uploadSupersededBy}`,
      'This file was replaced by a newer upload; book the charge from the newer file.',
    );
  }
  if (line.vatAmount === null) {
    throw refuse(
      `postPlatformCharge: staged line ${line.id} has no VAT (staged before S6c)`,
      "This charge was saved before its VAT was kept, and the same file can't be uploaded again. Ask for a corrected file, or ask the owner to fix it.",
    );
  }
  if (line.lineDate === null) {
    throw refuse(`postPlatformCharge: staged line ${line.id} has no date`, 'This charge has no date on the statement, so it can\'t be booked. Ask for help.');
  }
  const chargeDate = line.lineDate;
  const copy = await R.bookedCopyOfCharge(tx, orgId, {
    otherLineId: line.id, uploadId: line.uploadId, storeId: line.storeId, channelId: line.channelId, chargeDate, netAmount: String(money(line.amount)), description: line.description,
    officialDocument: line.officialDocument,
  });
  // shortcut: two genuinely identical charges (same day, amount and description) cannot both be posted from a platform file; revisit if the platforms ever print them.
  if (copy) {
    throw refuse(
      `postPlatformCharge: staged line ${line.id} matches charge ${copy.id} already booked from line ${copy.otherLineId}`,
      `A charge of ₱${copy.totalAmount} dated ${dayLabel(copy.chargeDate)} with the same description is already booked, probably from an earlier copy of this file. If it really is a second, separate charge, ask the owner.`,
    );
  }

  // S8b audit 6: the same document booked before from another file with other figures (a re-issue that changed) is not booked on top of it
  if (
    line.officialDocument !== null &&
    (await R.bookedChargeOfDocumentWithOtherFigures(tx, orgId, {
      otherLineId: line.id, uploadId: line.uploadId, channelId: line.channelId, officialDocument: line.officialDocument, chargeDate, netAmount: String(money(line.amount)), description: line.description,
    }))
  ) {
    throw refuse(
      `postPlatformCharge: staged line ${line.id} shares its document number with a booked charge of another file, with other figures`,
      'Foodpanda printed this document before with different figures; ask for help before booking.',
    );
  }

  const channel = await salesDaysRepo.channelById(tx, orgId, line.channelId);
  if (!channel) throw gone(`postPlatformCharge: channel ${line.channelId} does not exist in org ${orgId}`, 'sales channel');
  if (channel.receivableAccountCode !== R.CHANNEL_RECEIVABLE_CODE) {
    throw refuse(
      `postPlatformCharge: channel ${channel.id} receivable account is ${channel.receivableAccountCode ?? 'unset'}, not the standard channel receivable`,
      `${channel.name}'s sales go to a different receivable account, so its charges can't be booked from a platform file. Open Settings › Sales channels and set this channel's receivable account to ${R.CHANNEL_RECEIVABLE_CODE} Channel receivable.`,
    );
  }

  // T-606: and not while the channel still holds a balance on another account (see `refuseStrandedChannelBalance`).
  await refuseStrandedChannelBalance(tx, orgId, channel, R.CHANNEL_RECEIVABLE_CODE, 'postPlatformCharge');

  // ---- the figures: whole centavos, never a float ---------------------------------------------------------------------
  const net = money(line.amount);
  const vat = money(line.vatAmount);
  const total = add(net, vat);
  if (isZero(total)) {
    throw refuse(`postPlatformCharge: staged line ${line.id} totals zero`, 'This charge comes to nothing, so there is nothing to book.');
  }

  // ---- dating (Ian, 15 Nov): the charge date if ITS month is open; else TODAY if today's month is open; else refused. The same period check the other modules use. ------
  const clock = today ?? (await manilaToday(tx));
  if (chargeDate.localeCompare(clock) > 0) {
    throw refuse(
      `postPlatformCharge: charge date ${chargeDate} is after today ${clock}`,
      `This charge is dated in the future (${dayLabel(chargeDate)}), so it can't be booked yet. Book it on or after that date, or check the date on the statement.`,
    );
  }
  const own = await fiscalPeriodsRepo.firstOpenDateOnOrAfter(tx, orgId, chargeDate, clock);
  let entryDate = chargeDate;
  let dateNote: string | null = null;
  if (own === null || own.shutBy !== null) {
    const current = await fiscalPeriodsRepo.firstOpenDateOnOrAfter(tx, orgId, clock, clock);
    if (current === null || current.shutBy !== null) {
      throw refuse(
        `postPlatformCharge: the periods of ${chargeDate} and of today ${clock} are both closed or locked`,
        `Every month from ${dayLabel(chargeDate)} up to today is closed, so the charge can't be dated. Ask an admin to open a month first.`,
      );
    }
    entryDate = clock;
    dateNote = lateChargeNote(chargeDate, clock);
  }
  if (!(await journalRepo.findPeriodForDate(tx, orgId, entryDate))) {
    throw refuse(`postPlatformCharge: no fiscal period covers ${entryDate} for org ${orgId}`, `There is no fiscal period for ${dayLabel(entryDate)} yet.`);
  }

  // ---- post, then record ------------------------------------------------------------------------------------------
  const debit = compare(total, ZERO) > 0;
  const amount = String(debit ? total : negate(total));
  const memo = `${channel.name} platform charge (VAT included) dated ${chargeDate}${dateNote ? `. ${dateNote}` : ''}`;
  const expenseLine = {
    accountCode: R.PLATFORM_FEE_CODE,
    storeId: line.storeId,
    debit: debit ? amount : '0',
    credit: debit ? '0' : amount,
    lineMemo: memo,
  };
  const receivableLine = {
    accountCode: R.CHANNEL_RECEIVABLE_CODE,
    storeId: line.storeId,
    partyType: R.PARTY_TYPE,
    partyId: channel.id,
    debit: debit ? '0' : amount,
    credit: debit ? amount : '0',
    lineMemo: memo,
  };
  const chargeId = crypto.randomUUID();
  const posted = await postEntry(tx, {
    orgId,
    entryDate,
    sourceType: 'channel_charge',
    sourceId: chargeId,
    idempotencyKey: `channel_charge:${line.id}:post`,
    memo: `${channel.name} platform charge of ${chargeDate}${dateNote ? `. ${dateNote}` : ''}`,
    postedBy: actor.personId,
    lines: debit ? [expenseLine, receivableLine] : [receivableLine, expenseLine],
  });
  if (!posted.created) return { posted: false };
  await R.insertPeriodCharge(tx, {
    id: chargeId,
    orgId,
    storeId: line.storeId,
    channelId: channel.id,
    otherLineId: line.id,
    uploadId: line.uploadId,
    chargeDate,
    netAmount: net,
    vatAmount: vat,
    totalAmount: total,
    entryDate,
    journalEntryId: posted.entryId,
    description: line.description,
    postedBy: actor.personId,
  });

  // Same transaction, only on a real write. `source: 'web'`: the ERP approve screen is the only caller (slice 7).
  await auditLogRepo.append(tx, orgId, {
    actorPersonId: actor.personId,
    action: 'channel_charge.posted',
    storeId: line.storeId,
    entityId: chargeId,
    before: null,
    after: { net: String(net), vat: String(vat), total: String(total), chargeDate, entryDate, dateNote, journalEntryId: posted.entryId },
    source: 'web',
  });
  return { posted: true, chargeId, journalEntryId: posted.entryId, dateNote };
}
