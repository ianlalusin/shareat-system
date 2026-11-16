/**
 * T-511 S8b - the earlier-invoice deductions of a Foodpanda payout. docs/tasks/511-settlement-upload-s8-spec.md "S8b" item 5 and the money audit of 15 Nov. PURE: facts in, a verdict
 * out; nothing is read or written.
 *
 * A weekly statement ends with "Appendix C, Outstanding Amount From Previous Periods": the earlier charge documents Foodpanda netted out of THIS payout, each printed with its
 * official document number, a signed amount (-100.00 is a deduction from the payout, +100.00 a credit) and what REMAINS of it. The charges themselves arrive on other, earlier
 * invoices and are booked on their own (`postPlatformCharge`, official document kept on the staged line). Here each printed item is matched to what the books hold for that document:
 *
 *   - a booked charge that no live settlement has netted: it will be netted by this payout (the expected deposit falls by its total, signed);
 *   - a booked charge a live settlement already netted: shown, never netted twice, never part of the checks;
 *   - a charge staged but not booked: a blocker, "book it first" (or "this kind cannot be booked from a file", e.g. cash on delivery);
 *   - nothing on file for the document: a blocker, "upload that invoice first" (or, when the channel holds charges staged before document numbers were kept, "upload its file again");
 *   - an item Foodpanda only PARTLY settled (the remaining amount is not the amount, or is not printed): a blocker, never netted as if it were whole.
 *   Rejecting the day is the way out of each (Ian, 15 Nov).
 *
 * Cross-check, once every printed item is matched, PER DOCUMENT: minus the printed amount must equal the sum of that document's matched charges' totals (net + VAT, signed), else
 * `prior_items_mismatch` naming the document. One total over all items would let an over-deduction on one document hide behind a credit on another. A document printed more than once
 * is blocked in its own words, even when the rows add up: Foodpanda's repeat and the books' single charge cannot be told apart from a double deduction.
 */
import { fromCentavos, money, toCentavos } from '@shareat/core/money';
import { groupedMoney } from './text';

export const PRIOR_PROBLEM_CODES = ['prior_item_not_uploaded', 'prior_item_not_booked', 'prior_item_cannot_book', 'prior_item_partly_settled', 'prior_items_mismatch'] as const;
export type PriorProblemCode = (typeof PRIOR_PROBLEM_CODES)[number];

/** A booked charge whose staged line carries the document number. `nettedBySettlementId` is set only through a settlement that is not voided. */
export interface EarlierCharge {
  chargeId: string;
  /** net + VAT, signed (a cost is positive) */
  totalAmount: string;
  /** the invoice the charge came from, when its upload says */
  invoiceNumber: string | null;
  chargeDate: string | null;
  nettedBySettlementId: string | null;
}

/** What the books hold for one printed Appendix C item (one entry per printed row). */
export interface EarlierItemFact {
  document: string;
  /** the signed amount as printed */
  amount: string;
  /** what remains of it, as printed; null when the file did not print it */
  remaining: string | null;
  /** every booked charge with this document number in the channel */
  charges: readonly EarlierCharge[];
  /** staged current lines with this document that no charge was booked from, of the kind `postPlatformCharge` books (a period charge) */
  stagedBookable: number;
  /** the same, of any other kind (PandaGO cash on delivery, an advertisement with no day): never booked from a file */
  stagedOther: number;
  /** how many charge lines of the channel were staged before document numbers were kept (their number is empty), so a missing document may simply be one of them */
  legacyUndocumented: number;
}

export interface PriorProblem {
  code: PriorProblemCode;
  /** plain words: a document number and amounts, no id, no store name */
  sentence: string;
}

/** One earlier charge as the screen lists it. */
export interface EarlierChargeView {
  document: string;
  invoiceNumber: string | null;
  chargeDate: string | null;
  total: string;
  /** a live settlement already netted it: informational, this payout does not net it again */
  netted: boolean;
}

export interface PriorVerdict {
  /** the booked, not yet netted charges this payout nets (each id once) */
  charges: EarlierCharge[];
  /** every booked charge that matched an item, netted or not, for the screen */
  views: EarlierChargeView[];
  problems: PriorProblem[];
}

/** The house money format: a word for the direction, never a bare signed number. A printed amount below zero is a deduction. */
const direction = (cents: bigint, deduction: 'deducted' | 'credited' = 'deducted'): string => {
  const g = groupedMoney(String(fromCentavos(cents < 0n ? -cents : cents)));
  if (cents === 0n) return g;
  const other = deduction === 'deducted' ? 'credited' : 'deducted';
  return `${g} ${cents > 0n ? deduction : other}`;
};
/** A printed item: -100.00 is a deduction (money Foodpanda takes), +100.00 a credit. */
const printedWords = (amount: string): string => {
  const cents = -toCentavos(money(amount));
  const g = groupedMoney(String(fromCentavos(cents < 0n ? -cents : cents)));
  return cents === 0n ? g : `${cents > 0n ? 'deducted' : 'credited'} ${g}`;
};
/** A charge total on the books: +100.00 is a cost, so it is deducted. */
const booksWords = (cents: bigint): string => direction(cents);

export function evaluatePriorItems(items: readonly EarlierItemFact[]): PriorVerdict {
  const problems: PriorProblem[] = [];
  const toNet = new Map<string, EarlierCharge>();
  const views: EarlierChargeView[] = [];
  const seenViews = new Set<string>();
  const matched = new Map<string, { printed: bigint; books: bigint }>(); // per document: minus the printed amounts, and its open charges
  const rows = new Map<string, number>();
  for (const item of items) rows.set(item.document, (rows.get(item.document) ?? 0) + 1);
  const reported = new Set<string>();
  for (const item of items) {
    const printedCents = toCentavos(money(item.amount));
    const open = item.charges.filter((c) => c.nettedBySettlementId === null);
    for (const c of item.charges) {
      if (seenViews.has(c.chargeId)) continue;
      seenViews.add(c.chargeId);
      views.push({ document: item.document, invoiceNumber: c.invoiceNumber, chargeDate: c.chargeDate, total: c.totalAmount, netted: c.nettedBySettlementId !== null });
    }
    const what = `document ${item.document}, ${printedWords(item.amount)}`;
    if ((rows.get(item.document) ?? 0) > 1) {
      if (!reported.has(item.document)) {
        reported.add(item.document);
        problems.push({
          code: 'prior_items_mismatch',
          sentence: `Foodpanda printed document ${item.document} more than once on this statement, so it cannot be matched automatically. Reject the day or ask for help.`,
        });
      }
    } else if (item.stagedBookable > 0) {
      problems.push({
        code: 'prior_item_not_booked',
        sentence: `Foodpanda settles an earlier charge in this payout (${what}). That charge is on file but not booked yet. Book it first, because the platform took it out of this payout, or reject this day.`,
      });
    } else if (item.stagedOther > 0) {
      problems.push({
        code: 'prior_item_cannot_book',
        sentence: `Foodpanda settles an earlier item in this payout (${what}), but that item is of a kind this system does not book from a file (for example PandaGO cash on delivery), so it cannot be matched. Ask the owner, or reject this day.`,
      });
    } else if (item.charges.length === 0) {
      problems.push({
        code: 'prior_item_not_uploaded',
        sentence:
          item.legacyUndocumented > 0
            ? `Foodpanda settles an earlier item in this payout (${what}), but no charge with that document number is on file. That earlier invoice was uploaded before document numbers were kept. Upload its file again. Or reject this day.`
            : `Foodpanda settles an earlier item in this payout (${what}), but no charge with that document number is on file. Upload that invoice first, or reject this day.`,
      });
    } else if (open.length > 0) {
      let whole = false;
      try {
        whole = item.remaining !== null && toCentavos(money(item.remaining)) === printedCents;
      } catch {
        whole = false;
      }
      if (!whole) {
        problems.push({
          code: 'prior_item_partly_settled',
          sentence: `Foodpanda only partly settled an earlier item (document ${item.document}); this cannot be booked automatically. Reject the day or ask for help.`,
        });
      } else {
        const m = matched.get(item.document) ?? { printed: 0n, books: 0n };
        m.printed -= printedCents;
        m.books = open.reduce((t, c) => t + toCentavos(money(c.totalAmount)), 0n);
        matched.set(item.document, m);
        for (const c of open) toNet.set(c.chargeId, c);
      }
    }
    // all of its charges already netted: informational only (listed in `views`, nothing netted, nothing checked)
  }
  if (problems.length === 0) {
    for (const [document, m] of matched) {
      if (m.printed !== m.books) {
        problems.push({
          code: 'prior_items_mismatch',
          sentence: `Foodpanda says this payout settles earlier items worth ${booksWords(m.printed)}, but the charges on file add up to ${booksWords(m.books)} (document ${document}). Check that the right invoices were uploaded, or reject this day.`,
        });
      }
    }
  }
  return { charges: [...toNet.values()], views, problems };
}
