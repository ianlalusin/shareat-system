/** T-502 section 12 - the plain-JSON shape of an invoice's parts, passed from a server page to the client pickers. Money stays a string. */
export type PartKind = 'category' | 'uncategorised' | 'fees';

export interface PartView {
  /** The category id, or 'uncategorised' / 'fees'. */
  key: string;
  kind: PartKind;
  categoryId: string | null;
  /** What a person reads: the category name, "Uncategorised", "Fees and other charges on this bill". */
  label: string;
  itemNames: string[];
  total: string;
  /** What is still free to record under it. */
  left: string;
}

export interface InvoicePartsView {
  invoiceId: string;
  itemised: boolean;
  linesExceedTotal: boolean;
  parts: PartView[];
}

export interface CategoryChoice {
  id: string;
  group: 'OPEX' | 'COGS' | 'CAPEX' | 'PERSONAL';
  category: string;
  accountCode: string | null;
  isActive: boolean;
}

import { compare, money, ZERO } from '@shareat/core/money';

/** True when a part still has something left to record (exact comparison on Money, never a float). */
export const hasLeft = (left: string): boolean => compare(money(left), ZERO) > 0;

/** The pre-filled particulars of a part: its item names, joined (fees say what they are). Mirrors the domain's `defaultParticulars`. */
export function particularsOf(part: Pick<PartView, 'kind' | 'itemNames'>): string {
  if (part.kind === 'fees') return 'Fees and other charges';
  const unique = [...new Set(part.itemNames)];
  return unique.length > 0 ? unique.join(', ') : 'Items on this bill';
}
