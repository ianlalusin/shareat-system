/**
 * T-502 section 12 / 14 - the PARTS of an itemised invoice, and the rule an expense is judged by.
 *
 * An expense is one CATEGORY slice of an invoice that lists what was on it. The parts are derived, never stored (no link table):
 *  - one part per category the invoice's lines carry (their items' `expense_category_id`),
 *  - "Uncategorised" - lines whose item has no category,
 *  - "Fees and other charges" - the invoice total minus the lines total (delivery fee etc.); never negative.
 * Uncategorised + fees form the OPEN ROOM (section 14 Q4/Q5). Room for category C = lines(C) - live expenses(C); an expense may spill
 * past its own lines only into the open room, and `open room = (uncategorised + fees) - sum over C of max(0, live(C) - lines(C))`.
 * Voiding or deleting an expense frees its room automatically because nothing is stored.
 *
 * Pure: `buildInvoiceParts` takes the repo's raw facts. Everything is `Money`, never a float.
 */
import { add, compare, money, subtract, ZERO, type Money } from '@shareat/core/money';
import type { expensesRepo } from '@shareat/db';

export type InvoicePartsFactsInput = NonNullable<Awaited<ReturnType<typeof expensesRepo.invoicePartsFacts>>>;

export const NOT_ITEMISED_SENTENCE = 'List what was on this bill first (invoice page), then record the expense.';
export const ALREADY_RECORDED_SENTENCE = 'Everything on this bill is already recorded.';
export const PICK_CATEGORY_SENTENCE = "Pick a category for the items that don't have one yet.";
export const LINES_OVER_TOTAL_SENTENCE = "This bill's items add up to more than its total. Fix the bill before recording expenses.";

export const nothingUnderSentence = (category: string) => `This bill has nothing under ${category}. Pick one of the parts listed.`;
export const overRoomSentence = (category: string, left: Money) => `Only ₱${left} of ${category} on this bill is left to record.`;

export type PartKind = 'category' | 'uncategorised' | 'fees';

export interface InvoicePart {
  /** The category id, or `'uncategorised'` / `'fees'`. Stable and unique within one invoice. */
  key: string;
  kind: PartKind;
  /** Null for the two open-room parts. */
  categoryId: string | null;
  itemNames: string[];
  /** What the part holds in total (lines total, or the fees difference). */
  total: Money;
  /** What is still free to record under it. */
  left: Money;
}

export interface InvoiceParts {
  itemised: boolean;
  invoiceTotal: Money;
  linesTotal: Money;
  /** Lines add up to more than the invoice total (cannot be verified; a batch is refused). */
  linesExceedTotal: boolean;
  parts: InvoicePart[];
  /** Uncategorised + fees, before anything is recorded. */
  openBase: Money;
  /** What is left of the open room after live expenses that spilled into it. */
  openRoom: Money;
  /** lines(C) / live(C) per category id. */
  linesBy: ReadonlyMap<string, Money>;
  recordedBy: ReadonlyMap<string, Money>;
}

const max0 = (m: Money): Money => (compare(m, ZERO) < 0 ? ZERO : m);
const minOf = (a: Money, b: Money): Money => (compare(a, b) <= 0 ? a : b);

export function buildInvoiceParts(facts: InvoicePartsFactsInput): InvoiceParts {
  const invoiceTotal = money(facts.invoiceTotal);
  const linesBy = new Map<string, Money>();
  let uncategorised = ZERO;
  const names = new Map<string, string[]>();
  let uncategorisedNames: string[] = [];
  for (const g of facts.lineGroups) {
    if (g.categoryId === null) {
      uncategorised = add(uncategorised, money(g.total));
      uncategorisedNames = uncategorisedNames.concat(g.itemNames);
    } else {
      linesBy.set(g.categoryId, add(linesBy.get(g.categoryId) ?? ZERO, money(g.total)));
      names.set(g.categoryId, (names.get(g.categoryId) ?? []).concat(g.itemNames));
    }
  }
  const linesTotal = add(uncategorised, ...linesBy.values());
  const linesExceedTotal = compare(linesTotal, invoiceTotal) > 0;
  const fees = linesExceedTotal ? ZERO : subtract(invoiceTotal, linesTotal);
  const openBase = add(uncategorised, fees);

  const recordedBy = new Map<string, Money>();
  for (const r of facts.recorded) recordedBy.set(r.categoryId, add(recordedBy.get(r.categoryId) ?? ZERO, money(r.total)));

  // The open room: what live expenses have spilled past their own lines into it.
  const categoryIds = new Set<string>([...linesBy.keys(), ...recordedBy.keys()]);
  const spill = add(...[...categoryIds].map((c) => max0(subtract(recordedBy.get(c) ?? ZERO, linesBy.get(c) ?? ZERO))));
  const openRoom = max0(subtract(openBase, spill));

  const parts: InvoicePart[] = [];
  for (const [categoryId, total] of linesBy) {
    parts.push({
      key: categoryId,
      kind: 'category',
      categoryId,
      itemNames: names.get(categoryId) ?? [],
      total,
      left: max0(subtract(total, recordedBy.get(categoryId) ?? ZERO)),
    });
  }
  // The open room is shown on uncategorised first, then fees.
  const uncategorisedLeft = minOf(uncategorised, openRoom);
  const feesLeft = subtract(openRoom, uncategorisedLeft);
  if (compare(uncategorised, ZERO) > 0) {
    parts.push({ key: 'uncategorised', kind: 'uncategorised', categoryId: null, itemNames: uncategorisedNames, total: uncategorised, left: uncategorisedLeft });
  }
  if (compare(fees, ZERO) > 0) {
    parts.push({ key: 'fees', kind: 'fees', categoryId: null, itemNames: [], total: fees, left: feesLeft });
  }

  return {
    itemised: facts.lineCount > 0,
    invoiceTotal,
    linesTotal,
    linesExceedTotal,
    parts,
    openBase,
    openRoom,
    linesBy,
    recordedBy,
  };
}

/** The most an expense under `categoryId` may add right now (its own free lines plus whatever open room is left for it). */
export function headroomFor(p: InvoiceParts, categoryId: string): Money {
  const lines = p.linesBy.get(categoryId) ?? ZERO;
  const live = p.recordedBy.get(categoryId) ?? ZERO;
  let otherSpill = ZERO;
  for (const c of new Set<string>([...p.linesBy.keys(), ...p.recordedBy.keys()])) {
    if (c === categoryId) continue;
    otherSpill = add(otherSpill, max0(subtract(p.recordedBy.get(c) ?? ZERO, p.linesBy.get(c) ?? ZERO)));
  }
  const room = max0(subtract(p.openBase, otherSpill));
  return max0(subtract(add(lines, room), live));
}

/**
 * The sentence an expense of `amount` under `categoryId` is refused with, or null when it fits. `categoryName` reads in the sentence.
 * `parts.itemised` false is the caller's own refusal (it depends on `requireItemised`), not decided here.
 */
export function partsRefusal(p: InvoiceParts, categoryId: string, categoryName: string, amount: Money): string | null {
  const own = p.linesBy.has(categoryId);
  if (!own && compare(p.openBase, ZERO) <= 0) return nothingUnderSentence(categoryName);
  const left = headroomFor(p, categoryId);
  if (compare(amount, left) > 0) return overRoomSentence(categoryName, left);
  return null;
}
