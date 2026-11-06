/** T-519 R7: plain-words labels for staff deduction agreements. A leaf: no database, safe in a server component and a unit test. */

const SOURCE_WORDS: Record<string, string> = {
  tillcountshortage: 'Till shortage',
  remittance_variance: 'Remittance shortage',
  trade_discrepancy: 'Commissary charge',
  order_wastage: 'Wastage charge',
  owner_pay_recovery: 'Owner drawing',
  cash_request_shortage: 'Cash request shortage',
};

export const chargeSourceLabel = (sourceType: string): string => SOURCE_WORDS[sourceType] ?? sourceType;

/** The payslip line for one recovery. `signedOn` is the agreement's signing date (blank only for a figure with no agreement row). */
export const chargeRepaymentLabel = (signedOn: string): string => (signedOn ? `Charge repayment, agreement of ${signedOn}` : 'Charge repayment');
