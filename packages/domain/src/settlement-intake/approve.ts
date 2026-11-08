/**
 * T-511 S7a - `approveDay`: one person approves one staged settlement day and the books move, in ONE transaction. docs/tasks/511-settlement-upload-s7-spec.md Rulings 1-6.
 *
 * Order (a throw anywhere rolls ALL of it back, including the sales correction):
 *   gate (the line's store) -> channel lock (as ingest and the charge booking take it) -> the line FOR UPDATE, still pending -> the uploader rule (separation of duties:
 *   refused if the actor uploaded either file of the day, unless the actor holds `override_period_lock`, the administrator test `reopenDay` uses) -> `dayBlockers` re-run
 *   INSIDE the transaction on the transaction's own Manila date (one clock: "will post on X" and the real date cannot differ) -> the platform file figure replaces the staff
 *   figure (`correctPlatformSales`, a no-op when they are equal) -> the carrier's charges -> an in-transaction preview, so a difference past tolerance asks for the approver's
 *   typed reason (`NEEDS_REASON`, the correction rolled back with it) -> `recordChannelSettlement` -> `markBooked` -> audit `settlement_day.approved`.
 *
 * Nothing here knows an account or an amount: the accounts are the named constants of the channel-settlement repo, reached by the two posting functions this calls.
 * The only door to `markBooked`.
 */
import { can, type Actor } from '@shareat/auth';
import { advisoryLocksRepo, auditLogRepo, channelSettlementsRepo, manilaToday, salesDaysRepo, settlementIntakeRepo, type Tx } from '@shareat/db';
import { correctPlatformSales, previewChannelSettlement, recordChannelSettlement } from '../channel-settlements';
import { carrierOfLine, dayBlockers } from './day-checks';
import { loanCheckForDay, loanCheckViewerOf } from './loan-check';
import { intakeRefusal, needsReasonSentence } from './refusal';
import { authorizeWith } from './review';
import { lineToSettlementInput, loanLegsForLine, type StagedLoanLeg } from './settlement-input';
import { plainDate } from './text';

export interface ApproveDayResult {
  settlementId: string;
  /** the sales correction posted by THIS call; null when the file figure already equalled the booked one */
  correctionId: string | null;
  /** the period charges this payout netted (the carrier day of a Foodpanda invoice) */
  chargeIds: string[];
  /** the date the settlement was booked on */
  postedOn: string;
}

export async function approveDay(tx: Tx, actor: Actor, input: { lineId: string; differenceReason?: string; confirmedDifference?: string }): Promise<ApproveDayResult> {
  const orgId = actor.orgId;
  // Unlocked read: only to learn the line's store and channel (they never change) for the gate and the lock.
  const seen = await settlementIntakeRepo.dayLineById(tx, orgId, input.lineId);
  if (!seen) throw intakeRefusal('LINE_NOT_FOUND', 'This day was not found. Reload the page.');
  await authorizeWith(tx, actor, 'record_ar_collection', seen.storeId, 'You do not have permission to approve settlement days for this store.');

  await advisoryLocksRepo.lockSettlementChannel(tx, seen.channelId);
  const line = await settlementIntakeRepo.dayLineById(tx, orgId, seen.id, { forUpdate: true });
  if (!line) throw intakeRefusal('LINE_NOT_FOUND', 'This day was not found. Reload the page.');
  if (line.reviewState !== 'pending') {
    throw intakeRefusal('LINE_ALREADY_DECIDED', 'This day was already decided: it is booked or rejected. Reload the page to see what happened.');
  }

  // Separation of duties: the person who uploaded the file(s) of this day does not approve it, unless an administrator (one-admin shops, the accepted default).
  const administrator = await can(tx, actor, 'override_period_lock');
  if (!administrator && (await settlementIntakeRepo.uploaderIdsOfLine(tx, orgId, line.id)).includes(actor.personId)) {
    throw intakeRefusal('UPLOADER_CANNOT_APPROVE', 'You uploaded a file this day comes from, so another person has to approve it. Ask another manager.');
  }

  // The blockers again, now that the day is locked, on the transaction's own date. The first one is the refusal, in its own words.
  const today = await manilaToday(tx);
  const blocked = await dayBlockers(tx, actor, line, { today });
  if (blocked.blockers.length > 0) throw intakeRefusal('DAY_BLOCKED', blocked.blockers[0]!.sentence);

  const day = await salesDaysRepo.findByBusinessDate(tx, orgId, line.storeId, line.salesDate);
  if (!day) throw intakeRefusal('DAY_BLOCKED', 'There is no sales day for this date yet, so the payout cannot be booked.');

  // The platform file figure replaces the staff figure first; the settlement then clears the right amount. Plain text, within the correction's reason rule.
  const correction = await correctPlatformSales(tx, actor, {
    dayLineId: line.id,
    reason: `Platform file figure for ${plainDate(line.salesDate)} (upload ${line.sourceUploadId.slice(0, 8)}) replaces the staff figure`,
  });

  // The carrier day of a Foodpanda invoice (keyed on channel + invoice number, so a re-uploaded invoice keeps one) nets the charges the platform took out of the payout.
  const carrier = await carrierOfLine(tx, orgId, line);

  let legs: StagedLoanLeg[] = [];
  if (line.platform === 'grab') {
    const viewer = await loanCheckViewerOf(tx, orgId, actor.personId);
    legs = loanLegsForLine(line, (await loanCheckForDay(tx, actor, line.salesDate, { viewer })).result).legs;
  }
  const typed = (input.differenceReason ?? '').trim();
  const base = lineToSettlementInput(line, legs, { willPostOn: blocked.willPostOn, charges: carrier.charges });

  // In-transaction preview, with NO reason: only now (after the correction) does the books' difference show. Past tolerance the approver's reason is needed, and it counts only
  // for the difference they saw: `confirmedDifference` must equal the one computed NOW, or the refusal asks again with the current figure (a reason never carries to another amount).
  const bare = await previewChannelSettlement(tx, actor, base);
  const asksReason = bare.needsAcknowledgement;
  const refusals = asksReason ? bare.blockers.slice(0, -1) : bare.blockers;
  if (refusals.length > 0) throw intakeRefusal('DAY_BLOCKED', refusals[0]!);
  let staged = base;
  if (asksReason && bare.differenceSign !== 'none') {
    if (typed === '' || input.confirmedDifference !== bare.difference) {
      // the screen re-asks with a reason box: the figures travel as own properties
      throw Object.assign(intakeRefusal('NEEDS_REASON', needsReasonSentence(bare.difference, bare.differenceSign)), { difference: bare.difference, sign: bare.differenceSign });
    }
    staged = lineToSettlementInput(line, legs, { willPostOn: blocked.willPostOn, differenceReason: typed, charges: carrier.charges });
    const withReason = await previewChannelSettlement(tx, actor, staged);
    if (withReason.blockers.length > 0) throw intakeRefusal('DAY_BLOCKED', withReason.blockers[0]!);
  }

  const settled = await recordChannelSettlement(tx, actor, { ...staged, salesDayId: day.id });
  if (!(await settlementIntakeRepo.markBooked(tx, orgId, line.id, { decidedBy: actor.personId, settlementId: settled.settlementId }))) {
    throw intakeRefusal('LINE_ALREADY_DECIDED', 'This day was already decided by someone else. Reload the page to see what they decided.');
  }

  const stored = await channelSettlementsRepo.getById(tx, orgId, settled.settlementId);
  const source = await settlementIntakeRepo.findUploadById(tx, orgId, line.sourceUploadId);
  const chargeIds = carrier.charges?.ids ?? [];
  await auditLogRepo.append(tx, orgId, {
    actorPersonId: actor.personId,
    action: 'settlement_day.approved',
    storeId: line.storeId,
    entityId: line.id,
    before: { reviewState: 'pending' },
    after: {
      reviewState: 'booked',
      settlementId: settled.settlementId,
      correctionId: correction.corrected ? correction.correctionId : null,
      chargeIds,
      sourceUploadId: line.sourceUploadId,
      payoutUploadId: line.payoutUploadId,
      readerVersion: source?.readerVersion ?? null,
      // whether a difference reason was kept on the settlement, never its text
      differenceReasonGiven: Boolean(stored?.differenceReason),
    },
    source: 'web',
  });
  return { settlementId: settled.settlementId, correctionId: correction.corrected ? correction.correctionId : null, chargeIds, postedOn: staged.settledOn };
}
