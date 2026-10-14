/**
 * T-394 S2 - the rehearsal report. Pure: text in, text out.
 * docs/tasks/394-purge-and-opening-rehearsal.md s4 R9/R10, s6 I12/I13.
 *
 * The SANITISED report (committed) is built from an allow-list of fields: database name, step codes + durations + person ids, check
 * names + PASS/FAIL, counts per class, account CODES with totals, the migration list. It never receives a check's free-text detail,
 * a person's name, or any connection string - they are simply not read. The FULL report keeps the detail and the names.
 */
import { toBusinessDate } from '../../../packages/core/src/datetime';

export interface ReportInput {
  database: string;
  generatedAt: string;
  steps: { code: string; startedAt: string; endedAt?: string; by?: string; result?: string }[];
  checks: { name: string; ok: boolean; detail: string }[];
  classCounts: { class: string; tables: number; rows: number }[];
  accountTotals: { orgId: string; code: string; debit: string; credit: string }[];
  migrations: string[];
  people: { id: string; displayName: string }[];
}

/** 'cutover-rehearsal-YYYY-MM-DD.md', the business (Manila) date of `generatedAt`. */
export function reportFileName(generatedAt: string): string {
  return `cutover-rehearsal-${toBusinessDate(new Date(generatedAt))}.md`;
}

/** Whole seconds from the marks, or NOT TIMED when the end mark is missing (never zero). */
function timing(s: { startedAt: string; endedAt?: string }): string {
  if (!s.endedAt) return 'NOT TIMED';
  const ms = Date.parse(s.endedAt) - Date.parse(s.startedAt);
  if (!(ms >= 0)) return 'NOT TIMED (end before start)';
  return `${Math.round(ms / 1000)} s`;
}

function render(input: ReportInput, full: boolean): string {
  const nameOf = (id: string): string => input.people.find((p) => p.id === id)?.displayName ?? id;
  const out: string[] = [];
  out.push(`# Cutover rehearsal report${full ? ' (FULL, not for commit)' : ''}`, '');
  out.push(`- Database: ${input.database}`);
  out.push(`- Generated: ${input.generatedAt}`, '');

  out.push('## Steps', '');
  for (const s of input.steps) {
    const by = s.by ? ` - by ${full ? `${nameOf(s.by)} (${s.by})` : s.by}` : '';
    const result = s.result ? ` - ${s.result}` : '';
    out.push(`- ${s.code}: ${timing(s)}${result}${by}`);
  }
  out.push('');

  out.push('## Checks', '');
  for (const c of input.checks) {
    out.push(`- ${c.name}: ${c.ok ? 'PASS' : 'FAIL'}`);
    if (full && c.detail) out.push(`  - ${c.detail}`);
  }
  out.push('');

  out.push('## Rows by cutover class', '');
  for (const c of input.classCounts) out.push(`- ${c.class}: ${c.tables} tables, ${c.rows} rows`);
  out.push('');

  out.push('## Account totals (posted, by account code)', '');
  for (const a of input.accountTotals) out.push(`- ${a.orgId} ${a.code}: debit ${a.debit}, credit ${a.credit}`);
  out.push('');

  out.push('## Migrations', '');
  for (const m of input.migrations) out.push(`- ${m}`);
  out.push('');
  return out.join('\n');
}

export function buildReports(input: ReportInput): { sanitised: string; full: string } {
  return { sanitised: render(input, false), full: render(input, true) };
}
