/**
 * T-500: the pure half of the contribution-row screen - which fields belong to which agency, a rate as a percent, and the words a list
 * row shows. No React, so the unit tests read it directly. No rate maths lives here: this only decides what is SHOWN.
 */
export type RateAgency = 'sss' | 'philhealth' | 'pagibig';

/**
 * Which optional blocks an agency uses. Read from the maths (domain `statutory.ts`): the step rounds SSS pay to a bracket (PhilHealth
 * and Pag-IBIG are not bracketed); the low band is Pag-IBIG's lower rate for low pay; employees' compensation (EC) is paid to SSS only.
 */
export function agencyFields(agency: RateAgency): { step: boolean; lowBand: boolean; ec: boolean } {
  return { step: agency === 'sss', lowBand: agency === 'pagibig', ec: agency === 'sss' };
}

/** The input names of the blocks an agency does NOT use (cleared and left out when the agency changes). */
export function hiddenFieldNames(agency: RateAgency): string[] {
  const f = agencyFields(agency);
  return [...(f.step ? [] : ['step']), ...(f.lowBand ? [] : ['lowThreshold', 'lowEeRate']), ...(f.ec ? [] : ['ecThreshold', 'ecLow', 'ecHigh'])];
}

/** "0.05" -> "5%", "0.0275" -> "2.75%". Decimal-point shift on the text, never a float. null when it is not a plain number. */
export function percentText(raw: string): string | null {
  const v = raw.trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(v);
  if (!m) return null;
  const frac = (m[2] ?? '').padEnd(2, '0');
  const whole = `${m[1]}${frac.slice(0, 2)}`.replace(/^0+(?=\d)/, '');
  const rest = frac.slice(2).replace(/0+$/, '');
  return `${whole}${rest ? `.${rest}` : ''}%`;
}

/** True when the typed text is a plain number above 1 (a rate typed as 5 instead of 0.05). String work only, no float compare. */
export function rateExceedsOne(raw: string): boolean {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(raw.trim());
  if (!m) return false;
  const whole = (m[1] ?? '0').replace(/^0+(?=\d)/, '');
  return whole !== '0' && (whole !== '1' || /[1-9]/.test(m[2] ?? ''));
}

/** What the usual employer-number format looks like at each agency, for the hint under the box. */
export const EMPLOYER_NO_HINT: Record<'sss' | 'philhealth' | 'pagibig', string> = {
  sss: 'Usually like 03-1234567-8. Dashes and spaces are fine.',
  philhealth: 'Usually 12 digits, like 02-000000001-2. Dashes and spaces are fine.',
  pagibig: 'Usually 12 digits, like 1210-0000-0001. Dashes and spaces are fine.',
};

export interface RateRowView {
  agency: RateAgency;
  eeRate: string;
  erRate: string;
  baseKind: 'gross' | 'basic';
  floor: string | null;
  ceiling: string | null;
  step: string | null;
  lowThreshold: string | null;
  lowEeRate: string | null;
  ecThreshold: string | null;
  ecLow: string | null;
  ecHigh: string | null;
}

/** "5000.00" -> "5000", "0.0500" -> "0.05". */
const n = (v: string): string => (v.includes('.') ? v.replace(/0+$/, '').replace(/\.$/, '') : v);
const pct = (v: string): string => `${n(v)} (${percentText(v) ?? '?'})`;

/** One short line per thing the approver is approving. Every stored value shows; an empty one says what its absence means. */
export function rateSummary(r: RateRowView): string[] {
  const out = [
    `employee ${pct(r.eeRate)} · employer ${pct(r.erRate)} · on ${r.baseKind} pay`,
    `${r.floor === null ? 'no floor' : `floor ${n(r.floor)}`} · ${r.ceiling === null ? 'no ceiling' : `ceiling ${n(r.ceiling)}`}`,
  ];
  if (r.step !== null) out.push(`pay rounded to ${n(r.step)}`);
  if (r.lowThreshold !== null && r.lowEeRate !== null) out.push(`low band: pay up to ${n(r.lowThreshold)} pays employee ${pct(r.lowEeRate)}`);
  if (r.ecThreshold !== null && r.ecLow !== null && r.ecHigh !== null) {
    out.push(`EC: ${n(r.ecLow)} below ${n(r.ecThreshold)}, ${n(r.ecHigh)} at or above`);
  }
  return out;
}
