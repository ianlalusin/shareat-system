/**
 * Merge fields and the tiny body markup. T-584 (docs/tasks/584-documents.md s5, s6). PURE: no imports from the database, so a unit test (and a
 * browser) can use it.
 *
 * ⛔ A fixed whitelist. An unknown `{{field}}` is refused when a template is saved, and the bad name is shown. A value that is missing renders as a
 * visible `[missing: employee.ended_on]`; the issuer must edit it out or fill it in before the document can be issued.
 *
 * The body is PLAIN TEXT: blank line = paragraph, `# ` = heading, `**bold**`. `parseBody` returns data, never HTML; the screens render it as React
 * text nodes, so there is no markup an author can inject (no `dangerouslySetInnerHTML` anywhere in the documents screens).
 */
export const MERGE_FIELDS = [
  'employee.full_name',
  'employee.staff_code',
  'employee.position',
  'employee.status',
  'employee.started_on',
  'employee.ended_on',
  'store.name',
  'store.address',
  'store.tin_branch_code',
  'org.legal_name',
  'org.trading_name',
  'org.tin',
  'issuer.full_name',
  'issuer.position',
  'today',
] as const;
export type MergeField = (typeof MERGE_FIELDS)[number];

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
