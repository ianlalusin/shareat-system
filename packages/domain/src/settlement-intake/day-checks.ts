/**
 * T-511 S5b - `dayBlockers`: the ordered list of reasons a store-day cannot be approved yet. docs/designs/channel-settlement-upload.md Component F "Blockers".
 * S5 only SHOWS them; slice 7 enforces them at approval. Everything is read fresh (the staff figure, the sales day's state, whether the line is still the
 * current version): a line's own snapshot is never trusted.
 *
 * The three blockers that exist in T-150 (no destination account, a negative deposit, a posted settlement already) are taken from
 * `previewChannelSettlement`, called with the FILE's order value as the gross, so there is one copy of those rules. Its other refusals (a variance, a gain,
 * "nothing outstanding") are NOT blockers here: a gap between the file and what staff recorded is the sales correction's business (slice 6), not a reason to
 * hold the day. A closed period is not a blocker either (ruling 9): the day shows the date it will post on instead.
 *
 * Two ways in, one set of rules: `dayBlockers` reads the facts of ONE day and `dayBlockersForLines` reads those of a whole list in a fixed number of
 * queries; both hand the facts to `blockersFromFacts`. The list's three preview blockers are built by the same pure functions the preview uses
 * (`settlementConfigBlockers`, `NEGATIVE_DEPOSIT_BLOCKER`), not copies of their words.
 *
 * Nothing is posted or written here.
 */
import { authorize, type Actor } from '@shareat/auth';
import { toBusinessDate } from '@shareat/core/datetime';
import { isZero, money, ZERO, compare, type Money } from '@shareat/core/money';
import { fiscalPeriodsRepo, settlementIntakeRepo, type SettlementDayLineRow, type Tx } from '@shareat/db';
import { NEGATIVE_DEPOSIT_BLOCKER, previewChannelSettlement, settlementConfigBlockers } from '../channel-settlements';
import { loadLoanCheckContext, loanCheckForDay, loanCheckViewerOf, primeLoanCheckCoverage, type LoanCheckContext, type LoanCheckForDay, type LoanCheckViewer } from './loan-check';
import { intakeRefusal } from './refusal';
import { lineToSettlementInput } from './settlement-input';
import { plainDate } from './text';

export const DAY_BLOCKER_CODES = [
  'no_file',
  'not_paid',
  'charges_unexplained',
  'store_not_matched',
  'sales_day_not_verified',
  'loan_check',
  'no_destination_account',
  'negative_net_deposit',
  'posted_settlement_exists',
  'earlier_day_open',
  'line_not_current',
] as const;
export type DayBlockerCode = (typeof DAY_BLOCKER_CODES)[number];

export interface DayBlocker {
  code: DayBlockerCode;
  /** plain words, no id, no store name other than the actor's */
  sentence: string;
}

export interface DayBlockersResult {
  blockers: DayBlocker[];
  /** the first open date on or after the sales day, only when the sales day's period is closed */
  willPostOn: string | null;
  /** shown beside the day, never a blocker: a closed period, a payout split across two loans */
  postNote: string | null;
}

export interface DayBlockersOptions {
  /** YYYY-MM-DD, the clock for the closed-period note (default: today in Manila) */
  today?: string;
  /** shared by a list of days so the company's loans are read once */
  loanContext?: LoanCheckContext;
  viewer?: LoanCheckViewer;
}

const SPLIT_NOTE = 'This payout covers two loans. It cannot be approved yet.';

const norm = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase();

/** The preview's own sentences, told apart by what they say (it returns plain strings), in the order of the documented list. */
function previewBlockers(sentences: readonly string[]): DayBlocker[] {
  const find = (fragment: string): string | undefined => sentences.find((s) => s.includes(fragment));
  const out: DayBlocker[] = [];
  const destination = find('no destination account');
  if (destination) out.push({ code: 'no_destination_account', sentence: destination });
  const negative = find('negative deposit');
  if (negative) out.push({ code: 'negative_net_deposit', sentence: negative });
  const posted = find('already has a posted settlement');
  if (posted) out.push({ code: 'posted_settlement_exists', sentence: posted });
  return out;
}

/** Everything the blockers of one staged day are worked out from. */
interface DayFacts {
  line: SettlementDayLineRow;
  figure: { recorded: Money | null; verified: boolean; noSales: boolean };
  channel: { platform: string | null; platformStoreCode: string | null } | null;
  /** the code the source file was matched by, when it was matched */
  matchedCode: string | null;
  /** Grab only */
  loan: LoanCheckForDay | null;
  /** the refusals of the settlement preview that matter here (see `previewBlockers`) */
  settlementSentences: readonly string[];
  earlierOpenDays: number;
  /** null: every period up to today is closed */
  firstOpen: { date: string } | null;
}

/** The blockers, in the documented order, from the facts. Pure: no read, no write. */
function blockersFromFacts(f: DayFacts): DayBlockersResult {
  const { line, loan } = f;
  const grab = line.platform === 'grab';
  const blockers: DayBlocker[] = [];
  const add = (code: DayBlockerCode, sentence: string): void => void blockers.push({ code, sentence });

  // Foodpanda is never held for paid state: its invoice is the payout statement (BOSS ruling 1, 5 Nov).
  if (grab && line.paidState === 'not_paid') add('not_paid', 'Not paid yet: Grab still shows this payout as processing.');
  if (!isZero(money(line.unexplained))) add('charges_unexplained', `The charges in the file do not explain the whole payout: ${line.unexplained} is left over.`);

  if (!f.channel || f.channel.platform !== line.platform || (f.matchedCode != null && norm(f.channel.platformStoreCode) !== norm(f.matchedCode))) {
    add('store_not_matched', 'This store is not matched to the platform code in the file any more. Check the platform code on the channel.');
  }

  if (f.figure.recorded === null && !(f.figure.verified && f.figure.noSales)) add('sales_day_not_verified', 'Waiting for the sales day to be verified');

  if (loan?.view.blocking) add('loan_check', loan.view.sentence);

  for (const b of previewBlockers(f.settlementSentences)) add(b.code, b.sentence);

  if (f.earlierOpenDays > 0) add('earlier_day_open', 'An earlier day of this channel has not been booked or rejected yet. Decide the earlier days first.');
  if (!line.isCurrent) add('line_not_current', 'A newer file has replaced this day. Open the newer line instead.');

  // a closed period never holds a day: the books post it on the first open date
  const notes: string[] = [];
  let willPostOn: string | null = null;
  if (f.firstOpen === null) {
    notes.push('The books are closed up to today, so this day cannot post until a period is opened.');
  } else if (f.firstOpen.date !== line.salesDate) {
    willPostOn = f.firstOpen.date;
    notes.push(`This day's period is closed, so it will post on ${plainDate(f.firstOpen.date)}.`);
  }
  if (loan && new Set(loan.result.allocations.filter((a) => loan.result.rowStoreIds[a.rowKey] === line.storeId).map((a) => a.loanId)).size > 1) {
    notes.push(SPLIT_NOTE);
  }
  return { blockers, willPostOn, postNote: notes.length > 0 ? notes.join(' ') : null };
}

/** The ordered blockers of one store-day (a staged line, or `{ channelId, salesDate }` for a day with no line). Reads only. */
export async function dayBlockers(
  tx: Tx,
  actor: Actor,
  target: SettlementDayLineRow | { channelId: string; salesDate: string },
  opts: DayBlockersOptions = {},
): Promise<DayBlockersResult> {
  const orgId = actor.orgId;
  if (!('id' in target)) {
    const facts = await settlementIntakeRepo.channelFacts(tx, orgId, target.channelId);
    if (!facts) throw intakeRefusal('CHANNEL_NOT_SET_UP', 'This channel was not found. Reload the page.');
    await authorize(tx, actor, 'record_ar_collection', { storeId: facts.storeId });
    const current = await settlementIntakeRepo.currentLine(tx, orgId, target.channelId, target.salesDate);
    if (current) return dayBlockers(tx, actor, current, opts);
    const figure = await settlementIntakeRepo.salesDayFigure(tx, orgId, target.channelId, target.salesDate);
    const recorded = figure.recorded !== null && compare(figure.recorded, ZERO) > 0;
    return {
      blockers: recorded ? [{ code: 'no_file', sentence: 'There is no file for this day yet, but staff recorded sales for it.' }] : [],
      willPostOn: null,
      postNote: null,
    };
  }

  // fresh, never the object passed in: it may be older than the table
  const line = await settlementIntakeRepo.dayLineById(tx, orgId, target.id);
  if (!line) throw intakeRefusal('LINE_NOT_FOUND', 'This day was not found. Reload the page.');
  const today = opts.today ?? toBusinessDate();

  const channel = await settlementIntakeRepo.channelFacts(tx, orgId, line.channelId);
  const source = await settlementIntakeRepo.findUploadById(tx, orgId, line.sourceUploadId);
  const figure = await settlementIntakeRepo.salesDayFigure(tx, orgId, line.channelId, line.salesDate);
  let loan: LoanCheckForDay | null = null;
  if (line.platform === 'grab') {
    const viewer = opts.viewer ?? (await loanCheckViewerOf(tx, actor.orgId, actor.personId));
    loan = await loanCheckForDay(tx, actor, line.salesDate, { context: opts.loanContext, viewer });
  }
  const preview = await previewChannelSettlement(tx, actor, lineToSettlementInput(line));
  return blockersFromFacts({
    line,
    figure,
    channel,
    matchedCode: source?.matchedCode ?? null,
    loan,
    settlementSentences: preview.blockers,
    earlierOpenDays: await settlementIntakeRepo.countEarlierOpenDays(tx, orgId, line.channelId, line.salesDate),
    firstOpen: await fiscalPeriodsRepo.firstOpenDateOnOrAfter(tx, orgId, line.salesDate, today),
  });
}

/**
 * The blockers of many staged lines at once, for the day table: the same answers as `dayBlockers` on each, from a FIXED number of reads however many days
 * (the table used to cost about fifteen reads a day). `lines` are taken as just read by the caller; each distinct store is checked against the gate of
 * recording a channel settlement, as `dayBlockers` does. Keyed by line id.
 */
export async function dayBlockersForLines(
  tx: Tx,
  actor: Actor,
  lines: readonly SettlementDayLineRow[],
  opts: DayBlockersOptions = {},
): Promise<Map<string, DayBlockersResult>> {
  const orgId = actor.orgId;
  const out = new Map<string, DayBlockersResult>();
  if (lines.length === 0) return out;
  for (const storeId of new Set(lines.map((l) => l.storeId))) await authorize(tx, actor, 'record_ar_collection', { storeId });
  const today = opts.today ?? toBusinessDate();

  const channelIds = [...new Set(lines.map((l) => l.channelId))];
  const dates = [...new Set(lines.map((l) => l.salesDate))];
  const grabDates = [...new Set(lines.filter((l) => l.platform === 'grab').map((l) => l.salesDate))].sort();
  let context = opts.loanContext;
  let viewer = opts.viewer;
  if (grabDates.length > 0) {
    const last = grabDates[grabDates.length - 1]!;
    context = context && context.throughDate.localeCompare(last) >= 0 ? context : await loadLoanCheckContext(tx, orgId, last);
    viewer ??= await loanCheckViewerOf(tx, orgId, actor.personId);
    await primeLoanCheckCoverage(tx, context, grabDates);
  }

  const figures = await settlementIntakeRepo.salesDayFiguresMany(tx, orgId, lines);
  const channels = await settlementIntakeRepo.channelFactsMany(tx, orgId, channelIds);
  const sources = await settlementIntakeRepo.findUploadsByIds(tx, orgId, [...new Set(lines.map((l) => l.sourceUploadId))]);
  const posted = await settlementIntakeRepo.postedSettlementKeys(tx, orgId, channelIds, dates);
  const earlier = await settlementIntakeRepo.earlierOpenInputs(tx, orgId, channelIds);
  const spans = await fiscalPeriodsRepo.periodSpans(tx, orgId);

  for (const line of lines) {
    const channel = channels.get(line.channelId) ?? null;
    // the settlement preview's refusals that matter here, from the same functions it uses (a channel that is gone shows the store_not_matched blocker alone)
    const settlementSentences = channel
      ? [
          ...settlementConfigBlockers(channel, { storeId: line.storeId, businessDate: line.salesDate }, posted.has(`${line.channelId}|${line.salesDate}`)),
          ...(compare(money(line.netPayout), ZERO) < 0 ? [NEGATIVE_DEPOSIT_BLOCKER] : []),
        ]
      : [];
    out.set(
      line.id,
      blockersFromFacts({
        line,
        figure: figures.get(`${line.channelId}|${line.salesDate}`) ?? { recorded: null, verified: false, noSales: false },
        channel,
        matchedCode: sources.get(line.sourceUploadId)?.matchedCode ?? null,
        loan: line.platform === 'grab' ? await loanCheckForDay(tx, actor, line.salesDate, { context, viewer }) : null,
        settlementSentences,
        earlierOpenDays: settlementIntakeRepo.countEarlierOpen(earlier.get(line.channelId)!, line.salesDate),
        firstOpen: fiscalPeriodsRepo.firstOpenFromSpans(spans, line.salesDate, today),
      }),
    );
  }
  return out;
}
