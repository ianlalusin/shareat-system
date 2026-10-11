/**
 * T-391 S5 - the HR sheet validator behind `validate-hr` (S7, S13, R15, I8). PURE: no database, no network, no file access.
 * It merges the local rates file into the roster rows and validates the four statutory ids. An error names the person and
 * the column, and shows at most the last four digits of an id - never the whole number, never a rate.
 */
type Row = Record<string, string>;

export interface HrError {
  person: string;
  column: string;
  message: string;
}
export interface HrResult {
  rows: Row[];
  errors: HrError[];
  complete: number;
  total: number;
  summary: string;
}

const ID_COLUMNS = [
  { column: 'sss_no', label: 'SSS number', lengths: [10] },
  { column: 'philhealth_no', label: 'PhilHealth number', lengths: [12] },
  { column: 'pagibig_no', label: 'Pag-IBIG number', lengths: [12] },
  { column: 'tin', label: 'TIN', lengths: [9, 12] },
] as const;

const clean = (v: string | undefined): string => (v ?? '').replace(/[\s-]+/g, '');
const last4 = (s: string): string => s.slice(-4);

/** The person's pay basis, its rate and ITS OWN effective date (S14f): never another basis's date. */
const rateOf = (r: Row): { basis: string; rate: string; from: string } => {
  const t = (r.pay_type ?? '').trim().toLowerCase();
  const by: Record<string, string> = { daily: r.daily_rate ?? '', hourly: r.hourly_rate ?? '', monthly: r.monthly_rate ?? '' };
  const pick = (b: string): { basis: string; rate: string; from: string } => ({
    basis: b,
    rate: (by[b] ?? '').trim(),
    from: (r[`${b}_rate_effective_from`] ?? '').trim(),
  });
  if (t in by) return pick(t);
  for (const b of ['hourly', 'daily', 'monthly']) if ((by[b] ?? '').trim() !== '') return pick(b);
  return { basis: '', rate: '', from: '' };
};

export function validateHr(input: { roster: readonly Row[]; rates: readonly Row[] }): HrResult {
  const ratesById = new Map<string, Row>();
  for (const r of input.rates) {
    const id = (r.person_ref ?? '').trim(); // S14c: the roster's own key (group key, else the v1 staff id)
    if (id && !ratesById.has(id)) ratesById.set(id, r);
  }

  const unrated: string[] = [];
  const rows: Row[] = input.roster.map((r) => {
    const out: Row = { ...r };
    const ref = (r.person_ref ?? '').trim();
    const m = ref ? ratesById.get(ref) : undefined;
    if (m) {
      const { basis, rate, from } = rateOf(m);
      out.pay_basis = basis;
      out.rate = rate;
      out.rate_effective_from = from;
    } else {
      unrated.push((r.full_name ?? '').trim());
    }
    return out;
  });

  const errors: HrError[] = [];
  const bad = new Set<number>();
  const blank = new Set<number>();
  const name = (r: Row): string => (r.full_name ?? '').trim();

  for (const { column, label, lengths } of ID_COLUMNS) {
    const byId = new Map<string, number[]>();
    rows.forEach((r, i) => {
      const raw = (r[column] ?? '').trim();
      if (raw === '') {
        blank.add(i);
        return;
      }
      const id = clean(raw);
      if (!/^\d+$/.test(id) || !(lengths as readonly number[]).includes(id.length)) {
        bad.add(i);
        const shape = /^\d+$/.test(id) ? `${id.length} digits` : 'not all digits';
        errors.push({
          person: name(r),
          column,
          message: `${name(r)}: the ${label} (ending ${last4(id)}) is not valid: ${shape}, expected ${lengths.join(' or ')} digits.`,
        });
        return;
      }
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id)!.push(i);
    });
    for (const [id, idx] of byId) {
      if (idx.length < 2) continue;
      const names = idx.map((i) => name(rows[i]!));
      for (const i of idx) {
        bad.add(i);
        errors.push({
          person: name(rows[i]!),
          column,
          message: `${names.join(' and ')} have the same ${label} (ending ${last4(id)}). One person each.`,
        });
      }
    }
  }

  const total = rows.length;
  let complete = 0;
  rows.forEach((_, i) => {
    if (!bad.has(i) && !blank.has(i)) complete++;
  });
  const summary =
    `${complete} of ${total} complete` +
    (errors.length ? `, ${errors.length} problem${errors.length === 1 ? '' : 's'} to fix` : '') +
    (unrated.length ? `. No rate row for: ${unrated.join(', ')}` : '');
  return { rows, errors, complete, total, summary };
}
