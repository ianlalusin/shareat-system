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
 * T-511 S7a: approve calls these same functions INSIDE its transaction, so four more blockers exist: `loan_leg_problem` (the text of `loanLegsForLine().blocker`), `nothing_to_settle`
 * (an order value of 0), `sales_day_not_posted` (verified, but no journal entry, so the file figure cannot replace anything yet) and `period_charge_unbooked` (the carrier day
 * of a Foodpanda invoice while one of its period charges is staged but not booked). The preview is run with the carrier's charges netted, so a negative deposit is judged on
 * what the approve would book.
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
import { carrierChargesFor, invoiceOf, lineToSettlementInput, loanLegsForLine, type CarrierSource } from './settlement-input';
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
  'loan_leg_problem',
  'nothing_to_settle',
  'sales_day_not_posted',
  'period_charge_unbooked',
  'no_open_period',
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
  /** shown beside the day, never a blocker: a closed period */
  postNote: string | null;
}

export interface DayBlockersOptions {
  /** YYYY-MM-DD, the clock for the closed-period note (default: today in Manila) */
  today?: string;
  /** shared by a list of days so the company's loans are read once */
  loanContext?: LoanCheckContext;
  viewer?: LoanCheckViewer;
}

/** A (channel, date) with no sales day at all. */
const NO_SALES_DAY = { recorded: null, verified: false, noSales: false, unposted: false } as const;

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
  /** `unposted`: the sales day is verified but carries no journal entry */
  figure: { recorded: Money | null; verified: boolean; noSales: boolean; unposted: boolean };
  channel: { platform: string | null; platformStoreCode: string | null } | null;
  /** the code the source file was matched by, when it was matched */
  matchedCode: string | null;
  /** Grab only */
  loan: LoanCheckForDay | null;
  /** Grab only: why the loan deduction cannot be placed on loans (the text of `loanLegsForLine`), or null */
  loanLegsBlocker: string | null;
  /** the carrier day of a Foodpanda invoice: how many period charges of the invoice are staged and not booked yet (0 for every other day) */
  unbookedCharges: number;
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

  if (f.figure.unposted) add('sales_day_not_posted', 'Staff recorded no sales for this day, so the file figure cannot replace anything yet.');

  if (loan?.view.blocking) add('loan_check', loan.view.sentence);
  if (f.loanLegsBlocker) add('loan_leg_problem', f.loanLegsBlocker);
  if (isZero(money(line.orderValue))) add('nothing_to_settle', 'The file shows an order value of 0.00 for this day, so there is nothing to settle. Ask the owner to handle it by hand.');

  for (const b of previewBlockers(f.settlementSentences)) add(b.code, b.sentence);

  if (f.unbookedCharges > 0) add('period_charge_unbooked', 'A charge on the same statement has not been booked yet. Book it first, because the platform took it out of this payout.');
  if (f.earlierOpenDays > 0) add('earlier_day_open', 'An earlier day of this channel has not been booked or rejected yet. Decide the earlier days first.');
  if (!line.isCurrent) add('line_not_current', 'A newer file has replaced this day. Open the newer line instead.');

  // a closed period never holds a day: the books post it on the first open date
  const notes: string[] = [];
  let willPostOn: string | null = null;
  if (f.firstOpen === null) {
    notes.push('The books are closed up to today, so this day cannot post until a period is opened.');
    add('no_open_period', 'Every month up to today is closed, so this day cannot be booked yet. Ask an administrator to open a month.');
  } else if (f.firstOpen.date !== line.salesDate) {
    willPostOn = f.firstOpen.date;
    notes.push(`This day's period is closed, so it will post on ${plainDate(f.firstOpen.date)}.`);
  }
  return { blockers, willPostOn, postNote: notes.length > 0 ? notes.join(' ') : null };
}

/**
 * The carrier facts of one staged day (Foodpanda, Ruling 6), read fresh and keyed on the INVOICE (channel + invoice number), never on the upload, so a re-uploaded invoice
 * keeps one carrier and one set of charges. Shared by the blockers and by approve, so the screen and the booking cannot disagree.
 */
export async function carrierOfLine(tx: Tx, orgId: string, line: SettlementDayLineRow): Promise<ReturnType<typeof carrierChargesFor>> {
  const inv = invoiceOf(line);
  const facts = inv ? (await settlementIntakeRepo.invoiceCarrierFactsMany(tx, orgId, [inv])).get(settlementIntakeRepo.invoiceKey(inv.channelId, inv.invoiceNumber)) : undefined;
  return carrierChargesFor(line, facts);
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
  const figure = (await settlementIntakeRepo.salesDayFiguresMany(tx, orgId, [line])).get(`${line.channelId}|${line.salesDate}`) ?? NO_SALES_DAY;
  let loan: LoanCheckForDay | null = null;
  if (line.platform === 'grab') {
    const viewer = opts.viewer ?? (await loanCheckViewerOf(tx, actor.orgId, actor.personId));
    loan = await loanCheckForDay(tx, actor, line.salesDate, { context: opts.loanContext, viewer });
  }
  // T-511 S6a: a payout that docks several loans is one settlement with a leg per loan; the preview reads the legs the loan check resolved (a day it cannot resolve
  // is already held by the loan_check blocker, and its preview then carries no loan, as before).
  const legs = loanLegsForLine(line, loan?.result ?? null);
  const carrier = await carrierOfLine(tx, orgId, line);
  const preview = await previewChannelSettlement(tx, actor, lineToSettlementInput(line, legs.legs, { charges: carrier.charges }));
  return blockersFromFacts({
    line,
    figure,
    channel,
    matchedCode: source?.matchedCode ?? null,
    loan,
    loanLegsBlocker: legs.blocker,
    unbookedCharges: carrier.unbooked,
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
  const invoices = new Map(lines.flatMap((l) => { const i = invoiceOf(l); return i ? [[settlementIntakeRepo.invoiceKey(i.channelId, i.invoiceNumber), i] as const] : []; }));
  const carrierSources: Map<string, CarrierSource> = await settlementIntakeRepo.invoiceCarrierFactsMany(tx, orgId, [...invoices.values()]);
  const channels = await settlementIntakeRepo.channelFactsMany(tx, orgId, channelIds);
  const sources = await settlementIntakeRepo.findUploadsByIds(tx, orgId, [...new Set(lines.map((l) => l.sourceUploadId))]);
  const posted = await settlementIntakeRepo.postedSettlementKeys(tx, orgId, channelIds, dates);
  const earlier = await settlementIntakeRepo.earlierOpenInputs(tx, orgId, channelIds);
  const spans = await fiscalPeriodsRepo.periodSpans(tx, orgId);

  for (const line of lines) {
    const channel = channels.get(line.channelId) ?? null;
    const inv = invoiceOf(line);
    const carrier = carrierChargesFor(line, inv ? carrierSources.get(settlementIntakeRepo.invoiceKey(inv.channelId, inv.invoiceNumber)) : undefined);
    const loan = line.platform === 'grab' ? await loanCheckForDay(tx, actor, line.salesDate, { context, viewer }) : null;
    // the settlement preview's refusals that matter here, from the same functions it uses (a channel that is gone shows the store_not_matched blocker alone)
    const settlementSentences = channel
      ? [
          ...settlementConfigBlockers(channel, { storeId: line.storeId, businessDate: line.salesDate }, posted.has(`${line.channelId}|${line.salesDate}`)),
          ...(compare(money(lineToSettlementInput(line, [], { charges: carrier.charges }).netDeposited), ZERO) < 0 ? [NEGATIVE_DEPOSIT_BLOCKER] : []),
        ]
      : [];
    out.set(
      line.id,
      blockersFromFacts({
        line,
        figure: figures.get(`${line.channelId}|${line.salesDate}`) ?? NO_SALES_DAY,
        channel,
        matchedCode: sources.get(line.sourceUploadId)?.matchedCode ?? null,
        loan,
        loanLegsBlocker: loanLegsForLine(line, loan?.result ?? null).blocker,
        unbookedCharges: carrier.unbooked,
        settlementSentences,
        earlierOpenDays: settlementIntakeRepo.countEarlierOpen(earlier.get(line.channelId)!, line.salesDate),
        firstOpen: fiscalPeriodsRepo.firstOpenFromSpans(spans, line.salesDate, today),
      }),
    );
  }
  return out;
}
