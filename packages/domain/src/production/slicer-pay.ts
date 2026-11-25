/**
 * Slicer pay. T-635 (docs/tasks/635-slicer-pay.md, MIGRATION 0279; bible row 326).
 *
 * The slicer records a slice run, another staff member confirms it, and the pay run pays the slicer per kg of paid slices as part of
 * salary. This file holds: the per-kg rate (set on screen, append-only, effective-dated), the pay maths, confirm / un-confirm, the plan
 * the pay run reads, and the freeze / release the pay run calls on post / void.
 *
 * ## Labour is booked ONCE
 * The slicer pay joins the payslip's gross, so the payslip's own entry (Dr 6100 gross) is the only place it is expensed. Nothing here
 * posts a journal entry. A slice record's `labour_cost` stays the capitalisation credit to 6100 it has always been (POSTING-PATTERNS
 * `production.conversion.slice`): it nets payroll's expense into the output's cost. The pay run only freezes the record.
 *
 * ## Dates
 * Attendance days keep their exact inclusive `between from and to` (`payrollRepo.payableDays`). A slice record is different (Ian, 25 Nov: late
 * confirmations are "paid in the next pay run"): a run pays every confirmed, posted, unpaid record with `produced_on <= periodEnd`. A record from before
 * the period's start is flagged "from an earlier period" on the slip and the Slicer pay view, and it is frozen like any other, so it is paid exactly once.
 * The period itself comes from `payroll/periods.ts`; there is no second date rule.
 *
 * ## Unpriceable records never block a run
 * A record with no rate in force, a unit that is not kg or g, or a slicer with no job that day is SKIPPED with a sentence (the preview shows it as a
 * warning) and stays unpaid and unfrozen, so it is paid by a later run once it is fixed.
 */
import { authorize, type Actor } from '@shareat/auth';
import { auditLogRepo, productionRepo, type Tx } from '@shareat/db';
import { ZERO, add, compare, type Money } from '@shareat/core/money';
import { parseMoneyInput } from '../shared/money-input';
import { humanDate } from '../shared/refusal-leaf';
import { refuse } from '../shared/refusal';
import { fromThousandths, toThousandths, type Quantity } from '../stock/quantity';
import { computeRecordPay, type SlicerPayLine } from './slicer-pay-math';

export * from './slicer-pay-math';

export const SLICER_POSITION = 'Slicer';

const refusal = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

// -------------------------------------------------------------------------------------------------
// The plan the pay run (and the slicer pay screen) read. No actor: the caller has already authorized.
// -------------------------------------------------------------------------------------------------
export interface SlicerPayPlanLine {
  readonly employmentId: string;
  readonly personId: string;
  readonly recordIds: string[];
  readonly slicerPay: Money;
  readonly slicerKg: Quantity;
  /** How many of `recordIds` were produced BEFORE the period's start (confirmed late; paid now). */
  readonly earlierRecords: number;
}

export interface SlicerPayPlan {
  readonly byEmployment: Map<string, SlicerPayPlanLine>;
  /** Sentences for what cannot be priced (no rate, a unit that is not kg or g, no employment). Shown as warnings; such a record is skipped, left unpaid, and never blocks the run. */
  readonly problems: string[];
}

export async function planSlicerPay(tx: Tx, orgId: string, input: { storeId: string; from: string; to: string }): Promise<SlicerPayPlan> {
  const rates = await productionRepo.listSlicerPayRates(tx, orgId);
  const { records, lines } = await productionRepo.payableSlicerRecords(tx, orgId, input);
  const byRecord = new Map<string, SlicerPayLine[]>();
  for (const l of lines) byRecord.set(l.recordId, [...(byRecord.get(l.recordId) ?? []), l]);

  const plan: SlicerPayPlan = { byEmployment: new Map(), problems: [] };
  const seen = new Set<string>();
  for (const r of records) {
    if (!r.employmentId) {
      plan.problems.push(`A slice record of ${humanDate(r.producedOn as never)} names a slicer who had no job at this store that day, so it cannot be paid on a payslip.`);
      continue;
    }
    const priced = computeRecordPay(r.producedOn, byRecord.get(r.recordId) ?? [], rates);
    if (!priced.ok) {
      if (!seen.has(priced.reason)) plan.problems.push(priced.reason);
      seen.add(priced.reason);
      continue;
    }
    const line = plan.byEmployment.get(r.employmentId) ?? { employmentId: r.employmentId, personId: r.personId, recordIds: [], slicerPay: ZERO, slicerKg: fromThousandths(0n), earlierRecords: 0 };
    plan.byEmployment.set(r.employmentId, {
      ...line,
      recordIds: [...line.recordIds, r.recordId],
      slicerPay: add(line.slicerPay, priced.pay),
      slicerKg: fromThousandths(toThousandths(line.slicerKg) + toThousandths(priced.kg)),
      earlierRecords: line.earlierRecords + (r.producedOn < input.from ? 1 : 0),
    });
  }
  return plan;
}

/** Post: freezes the records a slip paid. A short count means another run paid one first (the unique read-then-write race), and the post is refused. */
export async function applySlicerPayToRun(tx: Tx, input: { runId: string; recordIds: readonly string[] }): Promise<void> {
  const frozen = await productionRepo.freezeSlicerRecords(tx, input.recordIds, input.runId);
  if (frozen !== input.recordIds.length) {
    throw refuse(
      'postPayRun: a slicing record was paid by another run first',
      'A slicing record in this run was just paid by another pay run. Nothing was posted; run the preview again.',
    );
  }
}

/** Void: a voided run did not pay its slicing, so those records are payable again. */
export async function releaseSlicerPayOfRun(tx: Tx, runId: string): Promise<number> {
  return productionRepo.unfreezeSlicerRecordsOfRun(tx, runId);
}

// -------------------------------------------------------------------------------------------------
// Who sliced: the Slicer position rule, shared by draft and post.
// -------------------------------------------------------------------------------------------------
/** A sentence when `personId` does not hold the Slicer position at the store on that day; null when they do. */
export async function slicerRefusal(tx: Tx, orgId: string, personId: string, storeId: string, producedOn: string): Promise<string | null> {
  const employmentId = await productionRepo.slicerEmploymentOn(tx, orgId, personId, storeId, producedOn);
  return employmentId ? null : `That person does not hold the Slicer position at this store on ${humanDate(producedOn as never)}. Pick a slicer from the list, or give the person the Slicer position first.`;
}

// -------------------------------------------------------------------------------------------------
// Confirm / un-confirm. The confirmer is another staff member (any person with the stock-recording capability at the store).
// -------------------------------------------------------------------------------------------------
export type SlicingOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string };

async function loadSlice(tx: Tx, recordId: string) {
  const record = await productionRepo.getProductionRecord(tx, recordId);
  return record && record.kind === 'slice' ? record : null;
}

export async function confirmSlicing(tx: Tx, actor: Actor, input: { recordId: string }): Promise<SlicingOutcome> {
  const record = await loadSlice(tx, input.recordId);
  if (!record) return refusal('That slicing record does not exist.');
  await authorize(tx, actor, 'record_stock_movement', { storeId: record.storeId });
  if (record.status !== 'posted') return refusal('Only a posted slicing record can be confirmed. Post it first.');
  if (!record.performedByPersonId) return refusal('This slicing record does not say who sliced it, so there is nobody to pay. A manager can edit it to name the slicer.');
  if (record.performedByPersonId === actor.personId) {
    return refusal('You cannot confirm your own slicing. Ask another staff member to check it and confirm.');
  }
  // T-635 S2 (Ian: "Any staff except slicers"): a person who holds the Slicer position here is never the one who checks a slicer's work.
  if (await productionRepo.holdsSlicerNow(tx, record.orgId, actor.personId, record.storeId)) {
    return refusal('A slicer cannot confirm slicing. Ask another staff member who is not a slicer to check it and confirm.');
  }
  if (record.paidByPayRunId) return refusal('This slicing record was already paid in a pay run.');
  if (record.confirmedAt) return refusal('This slicing record is already confirmed.');
  if (!(await productionRepo.confirmRecord(tx, record.id, actor.personId))) return refusal('This slicing record just changed. Reload and try again.');
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'production.slicing_confirmed',
    storeId: record.storeId, entityId: record.id,
    before: { confirmedBy: null }, after: { confirmedBy: actor.personId, slicer: record.performedByPersonId }, source: 'web',
  });
  return { ok: true };
}

export async function unconfirmSlicing(tx: Tx, actor: Actor, input: { recordId: string }): Promise<SlicingOutcome> {
  const record = await loadSlice(tx, input.recordId);
  if (!record) return refusal('That slicing record does not exist.');
  await authorize(tx, actor, 'record_stock_movement', { storeId: record.storeId });
  if (record.paidByPayRunId) return refusal('This slicing record was already paid in a pay run, so its confirmation is locked. Void that pay run first.');
  if (!record.confirmedAt) return refusal('This slicing record is not confirmed.');
  const before = { confirmedBy: record.confirmedByPersonId };
  if (!(await productionRepo.unconfirmRecord(tx, record.id))) return refusal('This slicing record just changed. Reload and try again.');
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'production.slicing_unconfirmed',
    storeId: record.storeId, entityId: record.id,
    before, after: { confirmedBy: null }, source: 'web',
  });
  return { ok: true };
}

/**
 * A DRAFT slice record: who sliced it and which output lines are paid (every output line whose id is in `paidLineIds`; the rest are not).
 * Same bar as drafting (`record_stock_movement`). A posted record is changed by a manager through `editPostedProduction`.
 */
export async function updateSliceDraft(
  tx: Tx,
  actor: Actor,
  input: { recordId: string; performedByPersonId: string | null; paidLineIds: readonly string[] },
): Promise<SlicingOutcome> {
  const record = await loadSlice(tx, input.recordId);
  if (!record) return refusal('That slicing record does not exist.');
  await authorize(tx, actor, 'record_stock_movement', { storeId: record.storeId });
  if (record.status !== 'draft') return refusal('Only a draft can be changed here. A manager edits a posted record.');
  if (input.performedByPersonId) {
    const notSlicer = await slicerRefusal(tx, record.orgId, input.performedByPersonId, record.storeId, record.producedOn);
    if (notSlicer) return refusal(notSlicer);
  }
  await productionRepo.setPerformedBy(tx, record.id, input.performedByPersonId);
  await productionRepo.setOutputLinesPaid(tx, record.id, input.paidLineIds);
  return { ok: true };
}

// -------------------------------------------------------------------------------------------------
// The per-kg rate, set on screen. Same gate as a pay rate (`set_pay_rate`: admin, never a manager).
// -------------------------------------------------------------------------------------------------
export interface SetSlicerRateInput {
  readonly storeId: string;
  /** Null = the org default for every slice item. */
  readonly itemId: string | null;
  readonly ratePerKg: string;
  readonly effectiveFrom: string;
  readonly note?: string | null;
}

export async function setSlicerPayRate(tx: Tx, actor: Actor, input: SetSlicerRateInput): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
  await authorize(tx, actor, 'set_pay_rate', { storeId: input.storeId });
  const rate = parseMoneyInput(input.ratePerKg, 'setSlicerPayRate: the rate', 'The rate per kg');
  if (compare(rate, ZERO) <= 0) return refusal('The rate per kg has to be more than zero.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveFrom)) return refusal('Say the date the rate starts.');
  let itemName: string | null = null;
  if (input.itemId) {
    const item = await productionRepo.getItemForProduction(tx, actor.orgId, input.itemId);
    if (!item) return refusal('That item does not exist.');
    if (item.kind !== 'meat_sliced') return refusal(`${item.name} is not a sliced product, so it has no slicer rate. Pick a sliced product, or leave the item empty for the default.`);
    itemName = item.name;
  }
  const existing = await productionRepo.listSlicerPayRates(tx, actor.orgId);
  if (existing.some((r) => r.itemId === input.itemId && r.effectiveFrom === input.effectiveFrom)) {
    return refusal(`${itemName ?? 'The default'} already has a rate starting that day. A rate is never changed; pick a later date for the new one.`);
  }
  const { id } = await productionRepo.insertSlicerPayRate(tx, {
    orgId: actor.orgId, itemId: input.itemId, ratePerKg: rate, effectiveFrom: input.effectiveFrom, note: input.note?.trim() || null, createdBy: actor.personId,
  });
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'slicer_rate.set',
    storeId: null, entityId: id,
    before: null, after: { itemId: input.itemId, ratePerKg: rate, effectiveFrom: input.effectiveFrom }, source: 'web',
  });
  return { ok: true, id };
}

// -------------------------------------------------------------------------------------------------
// The slicer pay screen: per slicer, for a period.
// -------------------------------------------------------------------------------------------------
export interface SlicerPayRow {
  readonly personId: string;
  readonly personName: string;
  readonly unconfirmed: number;
  readonly confirmedRecords: number;
  readonly confirmedKg: Quantity;
  /** Confirmed and not yet paid: what the next pay run will add to the payslip. Includes records confirmed late from before the period. */
  readonly amountDue: Money;
  /** How many of the unpaid confirmed records are "from an earlier period" (produced before the period's start). */
  readonly earlierRecords: number;
  readonly paidRecords: number;
  readonly paidAmount: Money;
}

export interface SlicerPayOverview {
  readonly rows: SlicerPayRow[];
  readonly problems: string[];
}

/** Read-only. Gated like the pay run itself (`run_payroll`); it shows what people are owed. */
export async function slicerPayOverview(tx: Tx, actor: Actor, input: { storeId: string; from: string; to: string }): Promise<SlicerPayOverview> {
  await authorize(tx, actor, 'run_payroll', { storeId: input.storeId });
  const rates = await productionRepo.listSlicerPayRates(tx, actor.orgId);
  const all = await productionRepo.slicerRecordsInPeriod(tx, actor.orgId, input);
  const { records, lines } = await productionRepo.payableSlicerRecords(tx, actor.orgId, { ...input, includePaid: true });
  const byRecord = new Map<string, SlicerPayLine[]>();
  for (const l of lines) byRecord.set(l.recordId, [...(byRecord.get(l.recordId) ?? []), l]);

  const acc = new Map<string, { name: string; unconfirmed: number; kg: bigint; due: Money; confirmed: number; paidN: number; paid: Money; earlier: number }>();
  for (const r of all) {
    const a = acc.get(r.personId) ?? { name: r.personName, unconfirmed: 0, kg: 0n, due: ZERO, confirmed: 0, paidN: 0, paid: ZERO, earlier: 0 };
    if (!r.confirmedAt) a.unconfirmed += 1;
    acc.set(r.personId, a);
  }
  const problems: string[] = [];
  for (const r of records) {
    // A slicer whose only open record is a late confirmation from an earlier period has no record in this period, but is still owed.
    const a = acc.get(r.personId) ?? { name: r.personName, unconfirmed: 0, kg: 0n, due: ZERO, confirmed: 0, paidN: 0, paid: ZERO, earlier: 0 };
    acc.set(r.personId, a);
    const priced = computeRecordPay(r.producedOn, byRecord.get(r.recordId) ?? [], rates);
    if (!priced.ok) {
      if (!problems.includes(priced.reason)) problems.push(priced.reason);
      continue;
    }
    a.confirmed += 1;
    a.kg += toThousandths(priced.kg);
    if (r.paidByPayRunId) {
      a.paidN += 1;
      a.paid = add(a.paid, priced.pay);
    } else {
      a.due = add(a.due, priced.pay);
      if (r.producedOn < input.from) a.earlier += 1;
    }
  }
  const rows = [...acc.entries()]
    .map(([personId, a]) => ({
      personId, personName: a.name, unconfirmed: a.unconfirmed, confirmedRecords: a.confirmed, confirmedKg: fromThousandths(a.kg),
      amountDue: a.due, earlierRecords: a.earlier, paidRecords: a.paidN, paidAmount: a.paid,
    }))
    .sort((x, y) => x.personName.localeCompare(y.personName));
  return { rows, problems };
}

export async function listSlicerPayRatesFor(tx: Tx, actor: Actor, input: { storeId: string }) {
  await authorize(tx, actor, 'run_payroll', { storeId: input.storeId });
  return productionRepo.listSlicerPayRates(tx, actor.orgId);
}
