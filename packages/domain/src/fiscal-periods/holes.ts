/**
 * T-344 / DEF-422 — every coverage hole an org has, classified, and the admin action that fills
 * the ones inside closed books. `docs/tasks/344-def-422-fiscal-period-holes.md` §3.2-§3.3.
 *
 * ⭐ **`classifyHoles` is the ONE classifier** — the monthly seed job (`../scheduler`), the
 * `/findings` screen and `createMissingClosedPeriod` below all read the SAME classification, so
 * "the job says it's missing" and "the screen shows it as fillable" can never disagree.
 */
import { fiscalPeriodsRepo, type Tx } from '@shareat/db';
import { authorize, type Actor } from '@shareat/auth';
import { closeBlockers } from './index';

export type HolePieceClass = 'A' | 'B' | 'C' | 'D';

export interface ClassifiedHolePiece {
  /** A: fillable, open books. B: whole month missing inside closed books. C: part-month missing
   *  inside closed books. D: part-month hole in open books — never filled by anything. */
  readonly class: HolePieceClass;
  readonly startsOn: string;
  readonly endsOn: string;
  /** The one calendar month this piece belongs to. */
  readonly yearMonth: string;
  /** Whole calendar month (A/B) vs. part of one (C/D). */
  readonly whole: boolean;
  /** B/C only — `locked` if the piece's calendar year is closed (R1.1), else `closed`. */
  readonly targetStatus?: 'closed' | 'locked';
}

export interface ClassifyHolesResult {
  readonly pieces: ClassifiedHolePiece[];
  /** This org's periods, ordered — carried through from `coverageHoles`'s own read so a caller
   *  (the action below) can check for an overlapping period without a second SELECT. */
  readonly periods: { startsOn: string; endsOn: string; status: 'open' | 'closed' | 'locked' }[];
}

/** The last day of `month1based` in `year`, as `YYYY-MM-DD`. */
function monthEnd(year: number, month1based: number): string {
  return new Date(Date.UTC(year, month1based, 0)).toISOString().slice(0, 10);
}
function addOneDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}
function subtractOneDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

interface RawPiece {
  startsOn: string;
  endsOn: string;
  yearMonth: string;
  whole: boolean;
}

/** Splits `[startsOn, endsOn]` into calendar-month-aligned pieces — whole where the piece covers
 *  an entire month, part where it covers only the start or end of one. */
function splitIntoMonthPieces(startsOn: string, endsOn: string): RawPiece[] {
  const pieces: RawPiece[] = [];
  let cursor = startsOn;
  while (cursor <= endsOn) {
    const [y, m] = cursor.split('-').map(Number) as [number, number];
    const monthStart = `${y}-${String(m).padStart(2, '0')}-01`;
    const monthLast = monthEnd(y, m);
    const pieceEnd = monthLast < endsOn ? monthLast : endsOn;
    pieces.push({
      startsOn: cursor,
      endsOn: pieceEnd,
      yearMonth: `${y}-${String(m).padStart(2, '0')}`,
      whole: cursor === monthStart && pieceEnd === monthLast,
    });
    cursor = addOneDay(pieceEnd);
  }
  return pieces;
}

/**
 * Every hole in `orgId`'s fiscal-period coverage through `through`, split at month boundaries and
 * classified A-D (§3.2's table). A hole entirely "before the close frontier" (some closed/locked
 * period starts after it) OR in a calendar year that is closed (R1.1) is B (whole month) or C
 * (part); otherwise A (whole) or D (part). Both checks are uniform across one hole's pieces except
 * the year check, which can differ if a hole spans a year boundary — computed per piece.
 */
export async function classifyHoles(tx: Tx, orgId: string, through: string): Promise<ClassifyHolesResult> {
  const { periods, holes, closeFrontierStartsOn } = await fiscalPeriodsRepo.coverageHoles(tx, orgId, through);
  const closedYearSet = await fiscalPeriodsRepo.closedYears(tx, orgId);

  const pieces: ClassifiedHolePiece[] = [];
  for (const hole of holes) {
    for (const piece of splitIntoMonthPieces(hole.startsOn, hole.endsOn)) {
      const pieceYear = Number(piece.yearMonth.slice(0, 4));
      const afterCloseFrontier = closeFrontierStartsOn !== null && piece.endsOn < closeFrontierStartsOn;
      const yearClosed = closedYearSet.has(pieceYear);
      const insideClosedBooks = afterCloseFrontier || yearClosed;
      pieces.push({
        class: insideClosedBooks ? (piece.whole ? 'B' : 'C') : piece.whole ? 'A' : 'D',
        startsOn: piece.startsOn,
        endsOn: piece.endsOn,
        yearMonth: piece.yearMonth,
        whole: piece.whole,
        targetStatus: insideClosedBooks ? (yearClosed ? 'locked' : 'closed') : undefined,
      });
    }
  }
  return { pieces, periods };
}

export interface CreateMissingClosedPeriodInput {
  readonly startsOn: string;
  readonly endsOn: string;
  readonly reason: string;
}

export interface CreateMissingClosedPeriodResult {
  readonly periodId: string;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly status: 'closed' | 'locked';
}

function draftLabel(d: { kind: 'expense' | 'delivery'; dateOn: string; counterpartyName: string | null }): string {
  const who = d.counterpartyName ?? 'unknown';
  return d.kind === 'expense'
    ? `draft expense dated ${d.dateOn} — ${who}`
    : `draft delivery dated ${d.dateOn} — ${who}`;
}

/**
 * T-344 §3.3 — the admin action: fills exactly one missing whole month, or the missing part of
 * one, inside closed books. Everything runs in this one transaction; any refusal writes nothing.
 */
export async function createMissingClosedPeriod(
  tx: Tx,
  actor: Actor,
  input: CreateMissingClosedPeriodInput,
): Promise<CreateMissingClosedPeriodResult> {
  // 1.
  await authorize(tx, actor, 'create_missing_period', {});

  // 2.
  const reason = input.reason.trim();
  if (reason === '') {
    throw new Error('createMissingClosedPeriod: reason is required');
  }

  // 3.
  const month = input.startsOn.slice(0, 7);
  if (month !== input.endsOn.slice(0, 7)) {
    throw new Error(
      `createMissingClosedPeriod: ${input.startsOn}..${input.endsOn} spans more than one month; ` +
        'create one month at a time',
    );
  }

  // ⚠️ Classified through the END OF THE REQUESTED MONTH, never `input.endsOn` alone (review
  // finding, LOW): `input.endsOn` can be short of the month's last day (Q4, a part-month request),
  // and using it as the scan boundary would cut a TAIL hole off exactly at the request — making
  // step 5's "whole missing piece" check trivially pass no matter how little of the real hole the
  // request actually covers. A single month is the most this call ever needs classified.
  const [monthY, monthM] = month.split('-').map(Number) as [number, number];
  const { pieces, periods } = await classifyHoles(tx, actor.orgId, monthEnd(monthY, monthM));

  // 4.
  const overlapping = periods.find((p) => p.startsOn <= input.endsOn && p.endsOn >= input.startsOn);
  if (overlapping) {
    throw new Error(
      `createMissingClosedPeriod: ${input.startsOn}..${input.endsOn} is not missing — the period ` +
        `${overlapping.startsOn} to ${overlapping.endsOn} covers it`,
    );
  }

  // ⚠️ Matched by OVERLAP with the request, never bare `yearMonth` equality (review finding, LOW):
  // a month split by a period sitting in its middle has TWO holes/pieces sharing that `yearMonth`,
  // and `.find` on the month alone always returns the first — silently validating the request
  // against the WRONG piece when the admin meant the second one.
  const piece = pieces.find(
    (p) => p.yearMonth === month && p.startsOn <= input.endsOn && p.endsOn >= input.startsOn,
  );
  if (!piece) {
    throw new Error(
      `createMissingClosedPeriod: ${input.startsOn}..${input.endsOn} is not inside closed books — the ` +
        'monthly fiscal-period job creates whole months as open',
    );
  }

  // 5. The request must be exactly the whole missing piece — not less. (A request wider than the
  // piece is impossible: it would necessarily overlap an existing period, already refused by 4.)
  if (piece.startsOn !== input.startsOn || piece.endsOn !== input.endsOn) {
    const [ls, le] =
      input.startsOn !== piece.startsOn
        ? [piece.startsOn, subtractOneDay(input.startsOn)]
        : [addOneDay(input.endsOn), piece.endsOn];
    throw new Error(
      `createMissingClosedPeriod: creating ${input.startsOn}..${input.endsOn} would leave ${ls}..${le} of ` +
        `${month} still missing; create the whole missing part`,
    );
  }

  // 6.
  if (piece.class === 'A' || piece.class === 'D') {
    throw new Error(
      `createMissingClosedPeriod: ${input.startsOn}..${input.endsOn} is not inside closed books — the ` +
        'monthly fiscal-period job creates whole months as open',
    );
  }

  // 7-8. R1.5 — the shared gate `closePeriod` itself also calls.
  const blockers = await closeBlockers(tx, actor.orgId, { startsOn: input.startsOn, endsOn: input.endsOn });
  if (blockers.earlierOpen) {
    throw new Error(
      'createMissingClosedPeriod: an earlier period for this organisation is still open. Periods close in order.',
    );
  }
  if (blockers.drafts.length > 0 || blockers.blocking.length > 0) {
    // T-345 §3.5 — a depreciation or amortisation finding gains a pointer at the remedy that
    // actually clears it: booking activity in the current month does NOT satisfy
    // `periodicPostingsMissed` (it asks about a RUN, not an entry), so the plain Q3 sentence below
    // would send an admin to book something that leaves this exact refusal in place next time.
    const lines = [
      ...blockers.drafts.map(draftLabel),
      ...blockers.blocking.map((f) =>
        f.kind === 'depreciationNotBooked' || f.kind === 'amortisationNotBooked'
          ? `${f.detail} Book it under "Scheduled charges missed in closed months"`
          : f.detail,
      ),
    ];
    throw new Error(
      `createMissingClosedPeriod: ${lines.join('; ')}. Book this activity in the current open month as a ` +
        'prior-period adjustment, then try again. Closed books are not reopened.',
    );
  }

  // 9.
  const targetStatus = piece.targetStatus ?? 'closed';
  const inserted = await fiscalPeriodsRepo.insertFilledPeriod(tx, {
    orgId: actor.orgId,
    startsOn: input.startsOn,
    endsOn: input.endsOn,
    status: targetStatus,
    actorId: actor.personId,
    reason,
  });
  if (!inserted) {
    throw new Error(
      `createMissingClosedPeriod: ${input.startsOn}..${input.endsOn} was just created by another request`,
    );
  }

  // 10.
  return { periodId: inserted.id, startsOn: input.startsOn, endsOn: input.endsOn, status: targetStatus };
}
