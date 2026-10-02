/**
 * A missed month's depreciation or amortisation, caught up once in an open month. T-345.
 * docs/tasks/345-missed-month-depreciation-adjustment.md §3.2, closing T-344 Q5.
 *
 * ⭐ **The catch-up entry IS the record.** `bookMissedMonth` posts through the ordinary `postEntry`
 * path with the SAME `sourceType`/`sourceId`/idempotency-key SHAPE the scheduled run itself uses
 * (`asset:{id}:depreciation:{P}` / `prepaid:{id}:amortisation:{P}`) — only the booking DATE and the
 * memo differ. That is what makes `fixedAssetsRepo.postedDepreciationPeriods` /
 * `prepaidRepo.postedPeriods` and the §3.3 findings filter pick it up automatically, with no special
 * case for "this was a catch-up": an effective entry for P is an effective entry for P.
 *
 * `missed_month_adjustments` (packages/db/schema/missed-month-adjustments.ts) exists only so a
 * human reading the register can see WHICH month a catch-up entry counts as, and why — the
 * accounting effect never depends on that table existing.
 */
import { authorize, type Actor } from '@shareat/auth';
import {
  fiscalPeriodsRepo,
  fixedAssetsRepo,
  journalRepo,
  manilaToday,
  missedMonthsRepo,
  prepaidRepo,
  type MissedMonthSchedule,
  type Tx,
} from '@shareat/db';
import { periodDue, periodsThrough } from '../fixed-assets/schedule';
import { scheduleInputFor } from '../fixed-assets/depreciate';
import { checkFullyAmortised, prepaidSchedule } from '../prepaid';
import { periodsThroughOf, type SchedulePeriod } from '../shared/straight-line';
import { postEntry } from '../ledger/post-entry';

const DEPRECIATION_EXPENSE_CODE = '6700';
const ACCUMULATED_DEPRECIATION_CODE = '1590';
const AMORTISATION_EXPENSE_CODE = '6750';
const PREPAID_ACCOUNT_CODE = '1400';

export interface OrgPeriodContext {
  /** `[startsOn, endsOn]` for every OPEN period. */
  readonly openRanges: { startsOn: string; endsOn: string }[];
  /** `YYYY-MM` of the org's earliest fiscal period, or `null` when it has none at all
   *  (Amendment R3.1 — the floor below the books; nothing is ever bookable for such an org). */
  readonly earliestMonth: string | null;
}

/** The org's whole fiscal-period shape in one read — every OPEN range, and the earliest month —
 *  reused for every period a caller needs to classify, rather than one query per question. */
async function orgPeriodContext(tx: Tx, orgId: string): Promise<OrgPeriodContext> {
  // `through` only bounds `coverageHoles`'s own `.holes` computation, which nothing here reads —
  // `.periods` (ordered by starts_on) is the org's whole set regardless of the value passed.
  const { periods } = await fiscalPeriodsRepo.coverageHoles(tx, orgId, '9999-12-31');
  return {
    openRanges: periods.filter((p) => p.status === 'open').map((p) => ({ startsOn: p.startsOn, endsOn: p.endsOn })),
    earliestMonth: periods.length > 0 ? periods[0]!.startsOn.slice(0, 7) : null,
  };
}

/** Whether ANY open period overlaps `period`'s calendar month — the one test both `bookMissedMonth`
 *  step 6 and `missedMonths` below share, so "is P open" can never answer differently in the two
 *  places that ask it. */
function monthOverlapsOpenPeriod(period: string, openRanges: { startsOn: string; endsOn: string }[]): boolean {
  const { startsOn, endsOn } = fiscalPeriodsRepo.periodBounds(period);
  return openRanges.some((r) => r.startsOn <= endsOn && r.endsOn >= startsOn);
}

export interface BookMissedMonthInput {
  schedule: MissedMonthSchedule;
  subjectId: string;
  belongsToPeriod: string;
  reason: string;
  /** `YYYY-MM-DD`. Defaults to today (Manila). Must be after `belongsToPeriod`'s month and not
   *  after today (R1.5). */
  bookOn?: string;
}

export interface BookMissedMonthResult {
  journalEntryId: string;
  amount: string;
}

/**
 * Books ONE scheduled charge — a month a schedule owed that could not post in its own month —
 * into an open month, once. Runs in one transaction; any refusal writes nothing.
 *
 * ⛔ Messages name things, never ids (DEF-417).
 */
export async function bookMissedMonth(
  tx: Tx,
  actor: Actor,
  input: BookMissedMonthInput,
): Promise<BookMissedMonthResult> {
  await authorize(tx, actor, 'book_missed_month', {});

  const reason = input.reason.trim();
  if (!reason) {
    throw new Error('bookMissedMonth: reason is required');
  }

  const belongsToPeriod = input.belongsToPeriod;

  // Step 3 — load the subject. Must be active.
  let name: string;
  let status: string;
  let storeId: string;
  let charge: SchedulePeriod | null;
  let itemSchedule: SchedulePeriod[] | null = null;

  if (input.schedule === 'depreciation') {
    const asset = await fixedAssetsRepo.getById(tx, actor.orgId, input.subjectId);
    if (!asset) {
      throw new Error(`bookMissedMonth: asset ${input.subjectId} does not exist in this organisation`);
    }
    ({ name, status, storeId } = asset);
    const scheduleInput = scheduleInputFor(asset);
    charge = scheduleInput ? periodDue(scheduleInput, belongsToPeriod) : null;
  } else {
    const item = await prepaidRepo.getById(tx, actor.orgId, input.subjectId);
    if (!item) {
      throw new Error(`bookMissedMonth: prepaid item ${input.subjectId} does not exist in this organisation`);
    }
    ({ name, status, storeId } = item);
    itemSchedule = prepaidSchedule(item);
    charge = itemSchedule.find((p) => p.period === belongsToPeriod) ?? null;
  }

  if (status !== 'active') {
    throw new Error(`bookMissedMonth: ${name} is ${status}; only an active asset or item can be caught up`);
  }

  // Step 4 — derive the charge. There is no amount parameter.
  if (!charge) {
    throw new Error(`bookMissedMonth: ${name} owes nothing for ${belongsToPeriod}`);
  }

  // Step 5 — a link row already exists for (subject, P)?
  const existingLink = await missedMonthsRepo.findLink(tx, actor.orgId, input.schedule, input.subjectId, belongsToPeriod);
  if (existingLink) {
    const entry = await journalRepo.findEntryById(tx, existingLink.journalEntryId);
    if (entry?.status === 'posted') {
      throw new Error(`bookMissedMonth: ${name} is already booked for ${belongsToPeriod}`);
    }
    // A link whose entry was REVERSED no longer counts: the month can be booked again (T-368 S2 / DEF-435),
    // under the next revision key below. `alreadyEffective` is the gate for what is still in force.
  }
  // No link row (or its entry landed in neither state above) — an effective entry for P may still
  // exist from the ordinary run itself.
  const alreadyEffective =
    input.schedule === 'depreciation'
      ? (await fixedAssetsRepo.postedDepreciationPeriods(tx, actor.orgId, input.subjectId)).includes(belongsToPeriod)
      : (await prepaidRepo.postedPeriods(tx, actor.orgId, input.subjectId)).has(belongsToPeriod);
  if (alreadyEffective) {
    throw new Error(`bookMissedMonth: ${name} is already booked for ${belongsToPeriod}`);
  }

  // Step 6 — P's own month must not be open (the monthly run owns an open month), and P must not
  // precede the org's earliest fiscal period (Amendment R3.1): earlier months precede the books,
  // their charge belongs in the opening balance, and booking them here would double-count
  // 1590/1400. An org with no fiscal periods at all has no valid floor, so it refuses outright.
  const { openRanges, earliestMonth } = await orgPeriodContext(tx, actor.orgId);
  if (earliestMonth === null || belongsToPeriod < earliestMonth) {
    throw new Error(
      earliestMonth === null
        ? 'bookMissedMonth: this organisation has no fiscal periods yet'
        : `bookMissedMonth: ${belongsToPeriod} is before the books began (${earliestMonth})`,
    );
  }
  if (monthOverlapsOpenPeriod(belongsToPeriod, openRanges)) {
    throw new Error(`bookMissedMonth: ${belongsToPeriod} is open — the monthly run books it in its own month`);
  }

  // Step 6b (R1.5) — P < month(bookOn) <= today (Manila).
  const today = await manilaToday(tx);
  const bookOn = input.bookOn ?? today;
  const bookOnMonth = bookOn.slice(0, 7);
  if (!(belongsToPeriod < bookOnMonth) || bookOn > today) {
    throw new Error(`bookMissedMonth: the booking date must be after ${belongsToPeriod} and not after today`);
  }

  // Step 7 — post the catch-up entry. Same shape the run itself would use.
  const amount = String(charge.amount);
  const idempotencyKey =
    input.schedule === 'depreciation'
      ? fixedAssetsRepo.depreciationRevisionKey(
          input.subjectId,
          belongsToPeriod,
          await fixedAssetsRepo.depreciationEntriesForPeriod(tx, actor.orgId, input.subjectId, belongsToPeriod),
        )
      : prepaidRepo.nextRevisionKey(
          input.subjectId,
          belongsToPeriod,
          await prepaidRepo.entriesForPeriod(tx, actor.orgId, input.subjectId, belongsToPeriod),
        );
  const memo =
    input.schedule === 'depreciation'
      ? `[prior period] Depreciation ${belongsToPeriod} — ${name}`
      : `[prior period] Amortisation — ${name} (${belongsToPeriod})`;
  const lines =
    input.schedule === 'depreciation'
      ? [
          { accountCode: DEPRECIATION_EXPENSE_CODE, storeId, debit: amount, credit: '0', lineMemo: name },
          { accountCode: ACCUMULATED_DEPRECIATION_CODE, storeId, debit: '0', credit: amount, lineMemo: name },
        ]
      : [
          { accountCode: AMORTISATION_EXPENSE_CODE, storeId, debit: amount },
          { accountCode: PREPAID_ACCOUNT_CODE, storeId, credit: amount },
        ];

  const result = await postEntry(tx, {
    orgId: actor.orgId,
    entryDate: bookOn,
    sourceType: input.schedule,
    sourceId: input.subjectId,
    idempotencyKey,
    memo,
    postedBy: actor.personId,
    lines,
  });
  // R1.6 — created:false means a concurrent booker already won this exact key.
  if (!result.created) {
    throw new Error(`bookMissedMonth: ${name} is already booked for ${belongsToPeriod}`);
  }

  // Step 8 — insert the link row. The migration's guard trigger is the backstop for steps 5-7.
  await missedMonthsRepo.insertLink(tx, {
    orgId: actor.orgId,
    schedule: input.schedule,
    fixedAssetId: input.schedule === 'depreciation' ? input.subjectId : null,
    prepaidItemId: input.schedule === 'amortisation' ? input.subjectId : null,
    belongsToPeriod,
    journalEntryId: result.entryId,
    reason,
    bookedBy: actor.personId,
  });

  // Step 9 — amortisation only: re-run the fully_amortised check, shared with the ordinary run.
  // ⚠️ Audit finding (2026-09-26): pass the SCHEDULE'S OWN LAST PERIOD, never `belongsToPeriod`.
  // `checkFullyAmortised` returns early when `asOfPeriod < last.period` — that guard means "we
  // have not processed far enough to know yet", which is true of an ordinary run's `through`, but
  // P here can be an EARLY month (e.g. month 3 of 24, missed and now caught up while everything
  // through month 24 already posted). Passing P would gate the check off and leave the item stuck
  // `active` forever — the next ordinary run never re-checks either, since it only calls this when
  // `posted.length > 0` for THAT run.
  if (input.schedule === 'amortisation' && itemSchedule) {
    const lastPeriod = itemSchedule[itemSchedule.length - 1]?.period;
    if (lastPeriod) {
      await checkFullyAmortised(tx, actor.orgId, input.subjectId, itemSchedule, lastPeriod);
    }
  }

  return { journalEntryId: result.entryId, amount };
}

/**
 * §3.3 — the SET of active subjects that owe `period` (per schedule) with no effective entry
 * keyed for it. T-346 S3, Amendment R5.4 — the ONE computation of "does anybody still owe this":
 * T-345's close check asks `.size === 0`, and `findings/index.ts`'s `periodicPostingsStillMissing`
 * builds its finding's DETAIL count from this same set, so "is anybody missing" and "how many are
 * missing" can never disagree.
 */
export async function subjectsOwingWithoutEntry(
  tx: Tx,
  orgId: string,
  schedule: MissedMonthSchedule,
  period: string,
): Promise<Set<string>> {
  const out = new Set<string>();
  if (schedule === 'depreciation') {
    const assets = await fixedAssetsRepo.listDepreciable(tx, orgId);
    // Amendment R3.3 — one batched read for every asset, never one query per asset in the loop.
    const postedByAsset = await fixedAssetsRepo.postedDepreciationPeriodsByAsset(tx, orgId);
    for (const asset of assets) {
      const scheduleInput = scheduleInputFor(asset);
      if (!scheduleInput || !periodDue(scheduleInput, period)) continue;
      if (!postedByAsset.get(asset.id)?.has(period)) out.add(asset.id);
    }
    return out;
  }
  const items = await prepaidRepo.listPrepaidItems(tx, orgId, { status: 'active' });
  const postedByItem = await prepaidRepo.postedPeriodsByItem(tx, orgId);
  for (const item of items) {
    const itemPeriods = prepaidSchedule(item);
    if (!itemPeriods.some((p) => p.period === period)) continue;
    if (!postedByItem.get(item.id)?.has(period)) out.add(item.id);
  }
  return out;
}

export interface MissedMonthRow {
  schedule: MissedMonthSchedule;
  subjectId: string;
  subjectName: string;
  belongsToPeriod: string;
  amount: string;
}

/**
 * §3.2's screen list — per active subject, each period it owes through `through` that has no
 * effective entry and whose calendar month is not open, with the amount the schedule says.
 */
export async function missedMonths(tx: Tx, orgId: string, through: string): Promise<MissedMonthRow[]> {
  const { openRanges, earliestMonth } = await orgPeriodContext(tx, orgId);
  const out: MissedMonthRow[] = [];
  // Amendment R3.1 — nothing is bookable for an org with no fiscal periods at all.
  if (earliestMonth === null) return out;

  const assets = await fixedAssetsRepo.listDepreciable(tx, orgId);
  // Amendment R3.3 — one batched read for every asset, never one query per asset in the loop.
  const postedByAsset = await fixedAssetsRepo.postedDepreciationPeriodsByAsset(tx, orgId);
  for (const asset of assets) {
    const scheduleInput = scheduleInputFor(asset);
    if (!scheduleInput) continue;
    const owed = periodsThrough(scheduleInput, through);
    const posted = postedByAsset.get(asset.id) ?? new Set<string>();
    for (const p of owed) {
      if (p.period < earliestMonth) continue;
      if (posted.has(p.period)) continue;
      if (monthOverlapsOpenPeriod(p.period, openRanges)) continue;
      out.push({
        schedule: 'depreciation',
        subjectId: asset.id,
        subjectName: asset.name,
        belongsToPeriod: p.period,
        amount: String(p.amount),
      });
    }
  }

  const items = await prepaidRepo.listPrepaidItems(tx, orgId, { status: 'active' });
  const postedByItem = await prepaidRepo.postedPeriodsByItem(tx, orgId);
  for (const item of items) {
    const schedule = prepaidSchedule(item);
    const owed = periodsThroughOf(schedule, through);
    const posted = postedByItem.get(item.id) ?? new Set<string>();
    for (const p of owed) {
      if (p.period < earliestMonth) continue;
      if (posted.has(p.period)) continue;
      if (monthOverlapsOpenPeriod(p.period, openRanges)) continue;
      out.push({
        schedule: 'amortisation',
        subjectId: item.id,
        subjectName: item.name,
        belongsToPeriod: p.period,
        amount: String(p.amount),
      });
    }
  }

  return out;
}
