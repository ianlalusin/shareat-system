/**
 * T-511 S5b - the words the review screens print instead of stored values. A person never sees a code such as `not_paid` or `waiting_for_other_stores`;
 * every state, platform and kind is turned into a short plain phrase here. Pure; shared by page.tsx and DayDetail.tsx.
 */
import type { ReviewDayDetail, SettlementReviewRow } from '@shareat/domain';
import type { Tone } from '@/components/ui';

export const platformWord = (platform: 'grab' | 'foodpanda'): string => (platform === 'grab' ? 'Grab' : 'Foodpanda');

const STATE: Record<SettlementReviewRow['reviewState'], { label: string; tone: Tone }> = {
  pending: { label: 'Waiting for a decision', tone: 'progress' },
  booked: { label: 'Booked', tone: 'success' },
  rejected: { label: 'Rejected', tone: 'danger' },
};
export const stateWord = (state: SettlementReviewRow['reviewState']) => STATE[state];
/** The list's own short label for the same states: a phone card has room for one word beside the amount (the day detail keeps the full phrase). */
const STATE_SHORT: Record<SettlementReviewRow['reviewState'], string> = { pending: 'Waiting', booked: 'Booked', rejected: 'Rejected' };
export const listStateWord = (state: SettlementReviewRow['reviewState']) => ({ ...STATE[state], label: STATE_SHORT[state] });

export const paidWord = (paid: SettlementReviewRow['paidState']): string => (paid === 'paid' ? 'Paid' : 'Not paid yet');

const LOAN: Record<NonNullable<SettlementReviewRow['loanCheck']>['status'], { label: string; tone: Tone }> = {
  ok: { label: 'Matches', tone: 'success' },
  mismatch: { label: 'Does not match', tone: 'danger' },
  waiting_for_other_stores: { label: "Waiting for other stores' files", tone: 'warning' },
  no_matching_loan: { label: 'No matching loan', tone: 'danger' },
};
export const loanWord = (status: keyof typeof LOAN) => LOAN[status];
/** Shorter labels for the list's narrow Loan check column; the day detail keeps `loanWord`. */
const LOAN_SHORT: Record<keyof typeof LOAN, string> = { ok: 'Matches', mismatch: 'Differs', waiting_for_other_stores: 'Waiting for stores', no_matching_loan: 'No matching loan' };
export const listLoanWord = (status: keyof typeof LOAN) => ({ ...LOAN[status], label: LOAN_SHORT[status] });

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
/** `2026-10-19` -> `19 Oct 2026`. Anything that is not a plain date comes back as it was. */
export function shortDate(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  const month = m ? MONTHS[Number(m[2]) - 1] : undefined;
  return m && month ? `${Number(m[3])} ${month} ${m[1]}` : isoDate;
}

/**
 * The list shows a few words per blocker; the day detail keeps the domain's full sentence. The domain hands the list sentences only (no codes), so a sentence
 * is told apart by what it says, exactly as `dayBlockers` words it. A sentence this table does not know still shows, as "Needs a look", and never disappears.
 */
const BLOCKER_SHORT: readonly (readonly [RegExp, string])[] = [
  [/^Not paid yet/, 'Not paid yet'],
  [/^The charges in the file do not explain/, 'Charges not explained'],
  [/^This store is not matched/, 'Store not matched'],
  [/^Waiting for the sales day to be verified/, 'Sales day not verified'],
  [/no destination account/, 'No bank account set'],
  [/negative deposit/, 'Payout is negative'],
  [/already has a posted settlement/, 'Already posted'],
  [/^An earlier day of this channel/, 'Waiting for earlier days'],
  [/^A newer file has replaced/, 'Replaced by a newer file'],
];
const LOAN_BLOCKER_SHORT: Record<keyof typeof LOAN, string> = {
  ok: 'Loan check',
  mismatch: 'Loan check differs',
  waiting_for_other_stores: "Waiting for other stores' files",
  no_matching_loan: 'No matching loan',
};
export function shortBlocker(sentence: string, loanCheck: SettlementReviewRow['loanCheck']): string {
  if (loanCheck && sentence === loanCheck.sentence) return LOAN_BLOCKER_SHORT[loanCheck.status];
  return BLOCKER_SHORT.find(([pattern]) => pattern.test(sentence))?.[1] ?? 'Needs a look';
}

/** What the list's "What needs attention" cell prints: one short phrase per blocker, then the changed-since-booked warning; empty means nothing. */
export function attentionWords(row: Pick<SettlementReviewRow, 'blockers' | 'loanCheck' | 'changedSinceBooked'>): string[] {
  const words = [...new Set(row.blockers.map((b) => shortBlocker(b, row.loanCheck)))];
  if (row.changedSinceBooked) words.push('Changed since it was booked');
  return words;
}

/** The sentence above a day's orders: what to look for depends on which side is higher (`difference` is file minus staff). */
export function ordersHint(platform: 'grab' | 'foodpanda', difference: string | null): string {
  const look = difference?.startsWith('-')
    ? 'Staff recorded more than the file, so look for an order staff recorded that the file does not carry, such as a cancelled or refunded order.'
    : 'Look for one staff did not record, such as a late order.';
  return `These are the orders in the file for this day. ${look}${platform === 'grab' ? '' : ' The Foodpanda file gives a date only, so there is no time.'}`;
}

/**
 * The lines under one loan line of a day. A deduction names its loan and says who matched it, or says it is not matched (and nothing more); a payout to the
 * store is not matched to a loan at all, so it says nothing about matching.
 */
export function loanLineDetails(l: ReviewDayDetail['loan']['lines'][number]): string[] {
  if (l.kind === 'disbursal') return [];
  if (!l.loanName) return ['Not matched to a loan yet'];
  const name = l.ownerStoreName ? `${l.loanName} (owned by ${l.ownerStoreName})` : l.loanName;
  return [name, l.allocationSource === 'admin' ? 'Set by an administrator' : 'Set by the system'];
}

/** The list shows at most this many days a page; the data load is unchanged, only the rows printed are cut. */
export const REVIEW_PAGE_SIZE = 50;

/** `?page=` as a whole number from 1; anything else is page 1. */
export function pageNumber(raw: string | undefined): number {
  return raw !== undefined && /^[1-9]\d{0,5}$/.test(raw) ? Number(raw) : 1;
}

/** One page of a list; a page past the end gives the last page. `from`/`to` are 1-based positions for "Showing 51 to 100 of 120". */
export function pageSlice<T>(items: readonly T[], requested: number, size: number = REVIEW_PAGE_SIZE) {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const page = Math.min(Math.max(1, requested), pages);
  const start = (page - 1) * size;
  const shown = items.slice(start, start + size);
  return { items: shown, page, pages, total: items.length, from: shown.length === 0 ? 0 : start + 1, to: start + shown.length };
}

const OTHER_KIND: Record<string, string> = {
  adjustment: 'Adjustment',
  compensation: 'Compensation',
  chargeback: 'Chargeback',
  withholding_tax: 'Withholding tax',
  advertisement: 'Advertising',
  cancelled_order: 'Cancelled order',
  period_charge: 'Charge for the whole period',
  platform_fee_weekly: 'Weekly platform fee',
  pandago: 'PandaGO',
};
export const otherKindWord = (kind: string): string => OTHER_KIND[kind] ?? kind.replace(/_/g, ' ');

const BOOKED_AS: Record<string, string> = { platformFee: 'Platform fee and taxes', marketing: 'Advertising', none: 'Not booked' };
export const bookedAsWord = (bookedAs: ReviewDayDetail['otherLines'][number]['bookedAs']): string => BOOKED_AS[bookedAs] ?? bookedAs;

/** Which side is higher, in words, so a difference is never told by colour or a sign alone. `difference` is file minus staff. */
export function differenceWords(difference: string | null): string {
  if (difference === null) return 'Not known yet';
  if (/^-?0+(\.0+)?$/.test(difference)) return 'Same';
  return difference.startsWith('-') ? 'Staff recorded more' : 'File is higher';
}

/** The list's two-word version of `differenceWords`, so a phone card's amount column stays narrow. */
export const differenceShort = (difference: string | null): string => (difference?.startsWith('-') ? 'Staff higher' : 'File higher');

export const isNonZero = (figure: string | null): boolean => figure !== null && !/^-?0+(\.0+)?$/.test(figure);

/** The filters of the review page, as the page reads them and as every form posts them back (see `FilterFields` in DayDetail.tsx). */
export interface ReviewFilterValues {
  store?: string | undefined;
  platform?: string | undefined;
  period?: string | undefined;
  needs?: boolean | undefined;
  /** the list page (links only: a form posts the filters back, never the page) */
  page?: number | undefined;
}

/**
 * Grab's free-text Description, made safe for one table cell (screen only; the stored text is untouched): control and text-direction characters become spaces,
 * whitespace collapses to one line, and anything past 120 characters is cut with an ellipsis.
 */
export function noteText(description: string | null): string {
  const flat = (description ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat;
}

/** The review page's own address, keeping the filters; `day` opens one day. */
export function reviewHref(filters: ReviewFilterValues, day?: string): string {
  const q = new URLSearchParams();
  if (filters.store) q.set('store', filters.store);
  if (filters.platform) q.set('platform', filters.platform);
  if (filters.period) q.set('period', filters.period);
  if (filters.needs) q.set('needs', '1');
  if (filters.page && filters.page > 1) q.set('page', String(filters.page));
  if (day) q.set('day', day);
  const s = q.toString();
  return s ? `/channel-settlements/review?${s}` : '/channel-settlements/review';
}
