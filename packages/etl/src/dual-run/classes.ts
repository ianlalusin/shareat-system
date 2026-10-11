/**
 * T-392 S2 - the closed class catalogue (R11). Every difference the comparator names carries one of these codes; a class
 * is never derived by matching prose. Adding a code is a deliberate edit here, with a family, a meaning and an authority.
 */
export type ClassFamily = 'tie' | 'policy' | 'timing' | 'encoder' | 'defect' | 'scope' | 'open';

export interface ClassEntry {
  family: ClassFamily;
  meaning: string;
  authority: string;
}

export const CLASS_CATALOGUE = {
  TIES: { family: 'tie', meaning: 'Delta is zero to the centavo', authority: 'row 303' },
  INVENTORY_BASIS: {
    family: 'policy',
    meaning: 'v1 expenses stock on purchase; v2 debits 1310/GRNI and recognises COGS at usage (FIFO)',
    authority: 'row 303, ADR-011, section 16.11',
  },
  PAYROLL_ON_V1: { family: 'scope', meaning: 'Payroll legs exist in v1 only until cutover', authority: 'row 302' },
  NOT_IN_DUAL_RUN_SCOPE: {
    family: 'scope',
    meaning: 'A v1 sourceType outside the double-entry scope set by Q1',
    authority: 'row 303, Q1',
  },
  V2_ONLY_EVENT: {
    family: 'policy',
    meaning: 'A v2 posting with no v1 equivalent (supplier return/credit, channel-settlement fees, service-charge float)',
    authority: 'row 166, T-150',
  },
  V1_CASH_RESIDUAL: {
    family: 'policy',
    meaning: 'v1 floors the sale cash leg at 0; a negative unfloored residual equals the day delta on the cash tender line',
    authority: 'GLOSSARY cashPayments',
  },
  AP_AT_INVOICE: {
    family: 'timing',
    meaning: 'v1 incurs AP when the credit expense posts; v2 incurs it at the verified supplier invoice (paired by receipt)',
    authority: 'POSTING-PATTERNS expense.credit.ap; T-130 GRNI',
  },
  SUPPLIER_ADVANCE_1240: {
    family: 'policy',
    meaning: 'Supplier advance (1240) sub-line, excluded from the 2110 tie',
    authority: 'POSTING-PATTERNS ap_payment.overpayment, supplier.credit-applied',
  },
  V2_CORRECTION_DATED_LATER: {
    family: 'timing',
    meaning: 'A v2 correction stays on its own date, paired with its source on the other side of the week boundary',
    authority: 'R5a, POSTING-PATTERNS sale.pos-correction',
  },
  CHANNEL_AR_FLOW: {
    family: 'timing',
    meaning: 'v1 posts channel sales through a separate channel_sales flow; v2 posts them in the sales day to 1220',
    authority: 'v1 sales-day.actions.ts:270-297',
  },
  PENDING_V2: { family: 'timing', meaning: 'The v2 document exists but is not posted yet', authority: 'R9, R12' },
  PENDING_V1: { family: 'timing', meaning: 'The v1 document exists but is not posted yet', authority: 'R9, R12' },
  DATE_SHIFT: { family: 'timing', meaning: 'Same document, different business date', authority: 'R9 matching' },
  NOT_DOUBLE_ENTERED: { family: 'encoder', meaning: 'In scope, v1 only, no candidate in v2', authority: 'row 303' },
  KEYING_DIFFERENCE: { family: 'encoder', meaning: 'Candidate found, centavos differ', authority: 'R9 matching' },
  MISCLASSIFIED: { family: 'encoder', meaning: 'Same centavos under another category, supplier or money account', authority: 'R9 matching' },
  UNMAPPED_KEY: { family: 'encoder', meaning: 'A v1 key with no keys-sheet row or master link', authority: 'R7 keys sheet' },
  V1_DEFECT: { family: 'defect', meaning: 'v1 is wrong; on-screen disposition with a DEF ref', authority: 'R10, R14' },
  V2_DEFECT: { family: 'defect', meaning: 'v2 is wrong; on-screen disposition with a DEF ref', authority: 'R10, R14' },
  UNEXPLAINED: { family: 'open', meaning: 'Default; blocks sign-off', authority: 'R12' },
  V1_REMITTED_FIELD_ZERO: {
    family: 'open',
    meaning: 'v1 sales day has dineInSales 0 while posted sale legs are not; no residual can be computed',
    authority: 'S1 flag',
  },
  V1_UNKNOWN_EXPENSE_GROUP: {
    family: 'open',
    meaning: 'A v1 expense category carries a group the key sheet does not know',
    authority: 'S1 flag',
  },
  V1_EXPENSE_ENTRY_GROUP_CONFLICT: {
    family: 'open',
    meaning: 'A v1 expense entry carries conflicting groups',
    authority: 'S1 flag',
  },
} as const satisfies Record<string, ClassEntry>;

export type ClassCode = keyof typeof CLASS_CATALOGUE;

/** The only classes a person may assign (R10), always with a DEF-nnn ref. */
export const DISPOSITION_CLASSES = ['V1_DEFECT', 'V2_DEFECT'] as const;
export type DispositionClass = (typeof DISPOSITION_CLASSES)[number];
