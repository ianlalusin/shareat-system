/**
 * Merge fields and the tiny body markup. T-584 (docs/tasks/584-documents.md s5, s6); the field list carries a label and a sample since T-637. PURE: no imports from the
 * database, so a unit test (and a browser) can use it. The tiny markup is now only the OLD body format (read by `legacyBodyToDoc`); templates are JSON documents (doc.ts).
 *
 * ⛔ A fixed whitelist. An unknown `{{field}}` is refused when a template is saved, and the bad name is shown. A value that is missing renders as a
 * visible `[missing: employee.ended_on]`; the issuer must edit it out or fill it in before the document can be issued.
 *
 * The body is PLAIN TEXT: blank line = paragraph, `# ` = heading, `**bold**`. `parseBody` returns data, never HTML; the screens render it as React
 * text nodes, so there is no markup an author can inject (no `dangerouslySetInnerHTML` anywhere in the documents screens).
 */
export interface FieldDef {
  readonly name: string;
  /** The plain words the chip and the picker show ("Employee full name"). */
  readonly label: string;
  /** What the picker and the preview show before a real value exists. Invented, never real data. */
  readonly sample: string;
}

/** T-637: every field a template may use, with its label and sample. A field is here only if its value is really stored (see the as-built note in the T-637 spec). */
const DEFS = [
  { name: 'employee.full_name', label: 'Employee full name', sample: 'Maria S. Santos' },
  { name: 'employee.first_name', label: 'Employee first name', sample: 'Maria' },
  { name: 'employee.last_name', label: 'Employee last name', sample: 'Santos' },
  { name: 'employee.staff_code', label: 'Employee staff code', sample: 'SE-014' },
  { name: 'employee.position', label: 'Employee position', sample: 'Server' },
  { name: 'employee.status', label: 'Employment status', sample: 'Regular' },
  { name: 'employee.started_on', label: 'Date started', sample: '6 January 2025' },
  { name: 'employee.ended_on', label: 'Date left', sample: '30 June 2026' },
  { name: 'employee.length_of_service', label: 'Length of service', sample: '1 year, 5 months' },
  { name: 'employee.email', label: 'Employee email', sample: 'maria.santos@example.com' },
  { name: 'employee.phone', label: 'Employee contact number', sample: '0917 000 0000' },
  { name: 'store.name', label: 'Store name', sample: 'Shareat Sample Branch' },
  { name: 'store.address', label: 'Store address', sample: '1 Sample Street, Sample City' },
  { name: 'store.phone', label: 'Store contact number', sample: '(043) 000 0000' },
  { name: 'store.tin_branch_code', label: 'Store branch code', sample: '00001' },
  { name: 'org.legal_name', label: 'Company registered name', sample: 'Sample Foods Incorporated' },
  { name: 'org.trading_name', label: 'Company trading name', sample: 'Shareat' },
  { name: 'org.tin', label: 'Company TIN', sample: '000-000-000' },
  { name: 'issuer.full_name', label: 'Issuer full name', sample: 'Juan D. Cruz' },
  { name: 'issuer.position', label: 'Issuer position', sample: 'Manager' },
  { name: 'today', label: "Today's date", sample: '25 November 2026' },
] as const satisfies readonly FieldDef[];
export type MergeField = (typeof DEFS)[number]['name'];
export const FIELD_DEFS: readonly FieldDef[] = DEFS;
export const MERGE_FIELDS: readonly MergeField[] = DEFS.map((d) => d.name);

/** The fields to offer after `{{`: those whose name or label starts with, or has a word starting with, what was typed (case-insensitive). Empty query lists all. */
export function suggestFields(query: string, defs: readonly FieldDef[] = FIELD_DEFS): FieldDef[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...defs];
  const starts = (text: string): boolean => text.toLowerCase().split(/[\s._]+/).some((w) => w.startsWith(q)) || text.toLowerCase().startsWith(q);
  return defs.filter((d) => starts(d.name) || starts(d.label));
}

const KNOWN: ReadonlySet<string> = new Set(MERGE_FIELDS);
const FIELD_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;
const MISSING_RE = /\[missing: ([a-z_.]+)\]/g;

/** Every `{{name}}` in the text, in order of first appearance, without duplicates. */
export function fieldsIn(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(FIELD_RE)) if (!out.includes(m[1]!)) out.push(m[1]!);
  return out;
}

/** The names a template may not use (not on the whitelist). */
export function unknownFields(body: string): string[] {
  return fieldsIn(body).filter((f) => !KNOWN.has(f));
}

export type MergeValues = Partial<Record<MergeField, string | null | undefined>>;

/** Fills known fields. A null, undefined or blank value becomes `[missing: name]`. An unknown name is left exactly as typed (a saved template has none). */
export function fillBody(body: string, values: MergeValues): string {
  return body.replace(FIELD_RE, (whole, name: string) => {
    if (!KNOWN.has(name)) return whole;
    const v = values[name as MergeField];
    return v === null || v === undefined || v.trim() === '' ? `[missing: ${name}]` : v;
  });
}

/** The `[missing: …]` markers still in a text, in order, without duplicates. Issue is blocked while any remain. */
export function missingIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(MISSING_RE)) if (!out.includes(m[1]!)) out.push(m[1]!);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;

/** `2026-11-15` -> `15 November 2026`. A calendar date has no time zone, so this is the same words in Manila or anywhere. Null for anything else. */
export function longDate(isoDate: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate ?? '');
  if (!m) return null;
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${Number(m[3])} ${month} ${m[1]}` : null;
}

/**
 * "2 years, 3 months": whole calendar months from `startedOn` to `endedOn` (or `asOf` while still employed), the part that is zero left out, "less than a month" under one.
 * A day earlier in the month than the start does not complete the month. Null when either date is not `YYYY-MM-DD` or the end is before the start.
 */
export function lengthOfService(startedOn: string | null | undefined, endedOn: string | null | undefined, asOf: string): string | null {
  const parse = (v: string | null | undefined): [number, number, number] | null => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v ?? '');
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const a = parse(startedOn);
  const b = parse(endedOn ?? asOf);
  if (!a || !b) return null;
  const months = (b[0] - a[0]) * 12 + (b[1] - a[1]) - (b[2] < a[2] ? 1 : 0);
  if (months < 0) return null;
  if (months === 0) return 'less than a month';
  const y = Math.floor(months / 12);
  const mo = months % 12;
  const parts = [y > 0 ? `${y} ${y === 1 ? 'year' : 'years'}` : '', mo > 0 ? `${mo} ${mo === 1 ? 'month' : 'months'}` : ''].filter(Boolean);
  return parts.join(', ');
}

// ---------------------------------------------------------------------------------------------------------------------
// The markup
// ---------------------------------------------------------------------------------------------------------------------
export interface Run {
  text: string;
  bold: boolean;
}
export type Block = { type: 'heading'; text: string } | { type: 'paragraph'; runs: Run[] };

function runsOf(line: string): Run[] {
  const runs: Run[] = [];
  const parts = line.split('**');
  // An odd number of `**` leaves the last mark unmatched: it stays as literal text rather than bolding the rest.
  const closed = parts.length % 2 === 1 ? parts.length : parts.length - 1;
  parts.forEach((p, i) => {
    if (i >= closed) {
      const prev = runs[runs.length - 1];
      if (prev) prev.text += `**${p}`;
      else runs.push({ text: `**${p}`, bold: false });
      return;
    }
    if (p !== '') runs.push({ text: p, bold: i % 2 === 1 });
  });
  return runs;
}

/** Blank line = paragraph; a line starting `# ` = heading; `**bold**` inline; a single newline stays a line break inside its paragraph. */
export function parseBody(body: string): Block[] {
  const blocks: Block[] = [];
  const normalised = body.replace(/\r\n?/g, '\n').trim();
  if (normalised === '') return blocks;
  for (const chunk of normalised.split(/\n[ \t]*\n+/)) {
    const lines = chunk.split('\n');
    let para: string[] = [];
    const flush = () => {
      if (para.length > 0) blocks.push({ type: 'paragraph', runs: runsOf(para.join('\n')) });
      para = [];
    };
    for (const line of lines) {
      if (line.startsWith('# ')) {
        flush();
        blocks.push({ type: 'heading', text: line.slice(2).trim() });
      } else para.push(line);
    }
    flush();
  }
  return blocks;
}
