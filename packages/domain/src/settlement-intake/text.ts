/**
 * T-511 S5b - the two small formatters the review sentences share. Pure. No peso sign: the screens print amounts as plain figures with thousands separators.
 */

/** `2363.12` -> `2,363.12`; a negative keeps its sign. The input is a numeric(14,2) text. */
export function groupedMoney(amount: string): string {
  const negative = amount.startsWith('-');
  const [whole = '0', cents = '00'] = (negative ? amount.slice(1) : amount).split('.');
  let out = '';
  for (let i = 0; i < whole.length; i++) {
    if (i > 0 && (whole.length - i) % 3 === 0) out += ',';
    out += whole[i];
  }
  return `${negative ? '-' : ''}${out}.${cents}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** `2026-11-01` -> `1 Nov 2026`. An input that is not a date is returned as it came. */
export function plainDate(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  const month = m ? MONTHS[Number(m[2]) - 1] : undefined;
  return m && month ? `${Number(m[3])} ${month} ${m[1]}` : isoDate;
}
