/**
 * T-406 — account WORDS for ordinary screens (bible row 229: what a person sees names things in
 * words, never an id, a code or a key). Pure: no React, no database.
 *
 * Words follow the meaning of each account in packages/db/seed/chart-of-accounts.ts.
 * Reports and accountant pages may use accountCodeAndName ("code · name") instead.
 */

import { CHART_OF_ACCOUNTS } from '../../../../packages/db/seed/chart-of-accounts';

export const UNKNOWN_ACCOUNT = 'Other account';

/** The cash and e-wallet accounts a money movement can land in (read-only list for pickers). */
export const MONEY_ACCOUNT_CODES = ['1110', '1120', '1130', '1140'] as const;

/** Plain words for every account code that an ordinary screen names. Keys are chart codes. */
export const ACCOUNT_WORDS: Record<string, string> = {
  '1110': 'Cash at the cashier',
  '1120': 'Cash held by staff',
  '1130': 'Cash in the office',
  '1140': 'E-wallet and online balances',
  '1210': 'Owed by customers',
  '1220': 'Due from delivery platforms',
  '1230': 'Advances to employees',
  '1240': 'Advances to suppliers',
  '1250': 'Due from related store',
  '1310': 'Raw materials stock',
  '1320': 'Supplies and packaging stock',
  '1330': 'Prepared goods stock',
  '1340': 'Stock in transit between branches',
  '2110': 'Owed to suppliers',
  '2120': 'Goods received, bill not yet in',
  '2140': 'Customer store credit',
  '2150': 'Due to related store',
  '3200': "Owner's drawings",
  '5100': 'Cost of food sold',
  '5300': 'Wastage and spoilage',
  '5400': 'Stock count differences',
  '6400': 'Platform and channel fees',
  '6420': 'Channel settlement variance',
  '6500': 'Supplies',
  '6860': 'Bad debt expense',
  '6870': 'Bank charges',
  '7100': 'Platform settlement gain',
};

function wordsFor(code: string | null | undefined): string | undefined {
  if (!code) return undefined;
  if (Object.prototype.hasOwnProperty.call(ACCOUNT_WORDS, code)) return ACCOUNT_WORDS[code];
  // Not in the curated list: fall back to the chart's own account name (never the code).
  return CHART_OF_ACCOUNTS.find((a) => a.code === code)?.name;
}

/** The account's plain words. Never the code: a miss or an empty value gives UNKNOWN_ACCOUNT. */
export function accountLabel(code: string | null | undefined): string {
  return wordsFor(code) ?? UNKNOWN_ACCOUNT;
}

/** "code · name" — for reports and accountant pages only. */
export function accountCodeAndName(code: string | null | undefined): string {
  const words = wordsFor(code);
  return words === undefined ? UNKNOWN_ACCOUNT : `${code} · ${words}`;
}
