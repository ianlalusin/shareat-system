/**
 * T-411 S1 — the census. Static: reads `.tsx` source under `apps/erp/src`, no DB, no render.
 * Spec: docs/tasks/411-row-link-sweep.md (§S1 rules 1-4, §Invariants I4-I6, §NO_ROW_TARGET).
 *
 * Every `<table>` / `<Table>` file is classified: either it must use the shared whole-row link
 * (`ROW_LINK`, the 30 sweep files) or it has no row destination (`NO_ROW_TARGET`, 46 files, not
 * touched). A new table lands in neither list and fails rule 1. Starts RED on purpose: the 30
 * `ROW_LINK` files are not yet swept, so rule 2 and rule 4 list them.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, '..', 'src');
const TABLE_RULE_FILE = 'components/ui/Table.tsx';

/** Files whose rows open a record. Paths relative to `apps/erp/src`. */
const ROW_LINK: readonly string[] = [
  'app/admin/stores/page.tsx',
  'app/admin/users/page.tsx',
  'app/ap/invoices/[id]/page.tsx',
  'app/ap/page.tsx',
  'app/liabilities/unpaid/page.tsx', // T-431
  'app/ap/vat/page.tsx', // T-408, swept at the 2026-10-16 combined release
  'app/ap/suppliers/[id]/page.tsx',
  'app/ap/suppliers/page.tsx',
  'app/attendance/page.tsx',
  'app/cash-requests/page.tsx',
  'app/channel-settlements/page.tsx',
  'app/commissary/catalogue/page.tsx',
  'app/commissary/orders/page.tsx',
  'app/customers/[customerId]/page.tsx',
  'app/customers/page.tsx',
  'app/expenses/page.tsx',
  'app/fixed-assets/page.tsx',
  'app/inventory/counts/page.tsx',
  'app/inventory/deliveries/[id]/page.tsx',
  'app/inventory/deliveries/page.tsx',
  'app/inventory/deliveries/inbound/page.tsx', // T-398 S5: each shipment row opens its receipt page (LinkRow/RowLink)
  'app/inventory/production/page.tsx',
  'app/inventory/production/recipes/page.tsx', // T-413, swept at the 2026-10-16 combined release
  'app/inventory/usage/[id]/page.tsx',
  'app/inventory/usage/page.tsx',
  'app/items/page.tsx',
  'app/liabilities/page.tsx',
  'app/loans/page.tsx',
  'app/owners/page.tsx',
  'app/prepaid/page.tsx',
  'app/sales-days/page.tsx',
  'app/trade/orders/[id]/page.tsx',
  'app/trade/orders/page.tsx',
  'app/wastage/page.tsx',
];

/** Tables with no row destination: reports, editing grids, read-only detail lines. Untouched by T-411. */
const NO_ROW_TARGET: readonly string[] = [
  // Reports (9)
  'components/reports/ApAgingTable.tsx',
  'components/reports/ArAgingTable.tsx',
  'components/reports/BalanceSheetTable.tsx',
  'components/reports/CashFlowTable.tsx',
  'components/reports/IncomeStatementTable.tsx',
  'components/reports/JournalLinesTable.tsx',
  'components/reports/SalesRollupTable.tsx',
  'components/reports/StoreComparisonTable.tsx',
  'components/reports/TrialBalanceTable.tsx',
  // Editing grids / rows are forms (21)
  'app/trade/orders/[id]/print/page.tsx', // T-433 S2: the printable delivery receipt, a print page with no row destination
  'app/page.tsx', // T-401 S6: the usage check scorecard on the dashboard, one row per store, no row destination
  'app/admin/access-defaults/grid.tsx',
  'app/attendance/lane/page.tsx',
  'app/attendance/terminals/page.tsx',
  'app/inventory/counts/[id]/page.tsx',
  'app/inventory/deliveries/inbound/[shipmentId]/page.tsx', // T-398 S5: shipment line items, no per-row record page
  'app/inventory/locations/page.tsx',
  'app/inventory/low-stock/page.tsx',
  'app/inventory/pos-usage/page.tsx',
  'app/inventory/returns/page.tsx',
  'app/inventory/transfers/page.tsx',
  'app/liabilities/[id]/page.tsx',
  'app/loans/[id]/page.tsx',
  'app/menu/usage-source/page.tsx',
  'app/money-accounts/page.tsx',
  'app/money-transfers/page.tsx',
  'app/payroll/page.tsx',
  'app/prepaid/[id]/page.tsx',
  'app/remittance/page.tsx',
  'app/sales-days/SalesDayForm.tsx',
  'app/settings/expense-categories/page.tsx',
  'app/statutory-discounts/page.tsx',
  'app/trade/returns/page.tsx',
  // Read-only detail lines with nowhere to go (16)
  'app/admin/prerequisite-refusals/page.tsx',
  'app/customers/price-lists/[id]/page.tsx',
  'app/cutover/count/sheet/page.tsx',
  'app/expenses/[id]/page.tsx',
  'app/findings/scorecard/page.tsx',
  'app/fixed-assets/[id]/page.tsx',
  'app/inventory/page.tsx',
  'app/inventory/pos-map/page.tsx',
  'app/inventory/production/[id]/page.tsx',
  'app/inventory/production/recipes/[id]/page.tsx', // T-413: read-only ingredient lines, no row destination
  'app/items/[id]/page.tsx',
  'app/menu/items/[id]/page.tsx',
  'app/owners/[id]/page.tsx',
  'app/payroll/thirteenth-month/page.tsx',
  'app/sales-days/[id]/page.tsx',
  'app/settings/pos-link/page.tsx',
  'app/till/page.tsx',
];

/**
 * A data row whose body contains one of these `href=` values is allowed to be a plain row:
 * the admin/users empty-state row links to `/staff`, which is not a record.
 */
const ALLOWED_PLAIN_LINK_ROWS: Readonly<Record<string, readonly string[]>> = {
  'app/admin/users/page.tsx': ['"/staff"'],
};

/** Matches a file that renders a table (rule 1). `<Table>` with no trailing space is real; the spec's literal `<Table ` misses two files. */
const TABLE_RE = /<table\b|<Table\b/;

/** Things that must sit inside a RowAction when they appear in a linked row (rule 2). */
const CONTROL_RE = /href=|<form\b|<Button\b|<button\b|<input\b|<Input\b/g;

// ---------- helpers ----------

function walkTsx(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walkTsx(full, out);
    } else if (name.endsWith('.tsx')) {
      out.push(full);
    }
  }
}

const toRel = (abs: string) => relative(srcRoot, abs).split(sep).join('/');

const allTsx: readonly string[] = (() => {
  const out: string[] = [];
  walkTsx(srcRoot, out);
  return out.map(toRel).sort();
})();

const read = (rel: string) => readFileSync(join(srcRoot, ...rel.split('/')), 'utf8');

const lineOf = (src: string, index: number) => src.slice(0, index).split('\n').length;

interface RowSpan {
  readonly tag: 'tr' | 'LinkRow';
  readonly start: number;
  readonly end: number;
  readonly body: string;
}

interface RowScan {
  readonly rows: RowSpan[];
  /** Open tags with no matching close of the same name. Each one is a census failure. */
  readonly unmatched: string[];
}

/**
 * Every `<tr>` / `<LinkRow>` in the source, with its matching close. Depth-counted on the same
 * tag name. A data row is one whose body has a `<td>` / `<Td>` / `<NumTd>`; header-only rows are
 * not data rows. An open tag that never closes (e.g. `<LinkRow>` closed by `</tr>`) goes to
 * `unmatched` instead of being silently dropped from `rows`.
 */
/** Same-length copy of `src` with JS/JSX comments blanked (newlines kept), so a `<tr>` in a comment is not a tag. */
function maskComments(src: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|\s)\/\/[^\n]*/g, (whole) => whole.slice(0, whole.indexOf('//')) + blank(whole.slice(whole.indexOf('//'))));
}

/** Where the opening tag starting at `from` ends, and whether it is self-closing (`<tr ... />`). */
function openingTagEnd(src: string, from: number): { end: number; selfClosing: boolean } {
  let braces = 0;
  let quote: string | null = null;
  for (let i = from; i < src.length; i++) {
    const ch = src[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (braces === 0 && (ch === '"' || ch === "'")) quote = ch;
    else if (ch === '{') braces++;
    else if (ch === '}') braces--;
    else if (ch === '>' && braces === 0) return { end: i + 1, selfClosing: src[i - 1] === '/' };
  }
  return { end: src.length, selfClosing: false };
}

/**
 * Every `<tr>` / `<LinkRow>` in the source, with its matching close. Depth-counted on the same
 * tag name. A data row is one whose body has a `<td>` / `<Td>` / `<NumTd>`; header-only rows are
 * not data rows. Comments and self-closing tags (`<tr ... />`) are not rows. An open tag that never
 * closes (e.g. `<LinkRow>` closed by `</tr>`) goes to `unmatched` instead of being silently dropped.
 */
function scanRows(raw: string): RowScan {
  const src = maskComments(raw);
  const rows: RowSpan[] = [];
  const unmatched: string[] = [];
  const open = /<(tr|LinkRow)(?=[\s>/])/g;
  let m: RegExpExecArray | null;
  while ((m = open.exec(src)) !== null) {
    const tag = m[1] as 'tr' | 'LinkRow';
    if (openingTagEnd(src, m.index).selfClosing) continue;
    const tokenRe = new RegExp(`<${tag}(?=[\\s>/])|</${tag}\\s*>`, 'g');
    tokenRe.lastIndex = m.index + m[0].length;
    let depth = 1;
    let closed = false;
    let t: RegExpExecArray | null;
    while ((t = tokenRe.exec(src)) !== null) {
      if (t[0].startsWith('</')) {
        depth -= 1;
      } else {
        if (openingTagEnd(src, t.index).selfClosing) continue;
        depth += 1;
      }
      if (depth === 0) {
        const end = t.index + t[0].length;
        rows.push({ tag, start: m.index, end, body: src.slice(m.index, end) });
        closed = true;
        break;
      }
    }
    if (!closed) unmatched.push(`line ${lineOf(src, m.index)}: <${tag}> has no matching </${tag}>`);
  }
  return { rows, unmatched };
}

function rowsIn(src: string): RowSpan[] {
  return scanRows(src).rows;
}

const isDataRow = (body: string) => /<(td|Td|NumTd)[\s>]/.test(body);

/** Half-open [start, end) spans of every `<RowAction ...> … </RowAction>` in a row body. */
function rowActionSpans(body: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const open = /<RowAction(?=[\s>/])/g;
  let m: RegExpExecArray | null;
  while ((m = open.exec(body)) !== null) {
    const close = body.indexOf('</RowAction>', m.index);
    if (close === -1) continue;
    spans.push([m.index, close + '</RowAction>'.length]);
  }
  return spans;
}

/** The span of the one `<RowLink ...>` opening tag in a row body, or null. */
function rowLinkOpenTag(body: string): [number, number] | null {
  const i = body.indexOf('<RowLink');
  if (i === -1) return null;
  const gt = body.indexOf('>', i);
  return [i, gt === -1 ? body.length : gt + 1];
}

/** Rule 2 violations for one ROW_LINK file; empty array = swept. */
function rowLinkViolations(rel: string): string[] {
  const src = read(rel);
  const problems: string[] = [];
  if (!/import\s*\{[^}]*\bRowLink\b[^}]*\}\s*from\s*['"][^'"]+['"]/.test(src)) {
    problems.push('does not import RowLink');
  }
  const allowed = ALLOWED_PLAIN_LINK_ROWS[rel] ?? [];
  for (const row of rowsIn(src)) {
    if (!isDataRow(row.body) || !row.body.includes('href=')) continue;
    if (allowed.some((a) => row.body.includes(`href=${a}`))) continue;
    const where = `line ${lineOf(src, row.start)}`;
    if (row.tag !== 'LinkRow') {
      problems.push(`${where}: linked <tr> is not <LinkRow>`);
      continue;
    }
    const linkCount = row.body.split('<RowLink').length - 1;
    if (linkCount !== 1) {
      problems.push(`${where}: linked row has ${linkCount} <RowLink> (need exactly 1)`);
    }
    const actions = rowActionSpans(row.body);
    const link = rowLinkOpenTag(row.body);
    for (const c of row.body.matchAll(CONTROL_RE)) {
      const at = c.index ?? 0;
      const inAction = actions.some(([s, e]) => at >= s && at < e);
      const isMainHref = link !== null && at >= link[0] && at < link[1];
      if (!inAction && !isMainHref) {
        problems.push(`${where}: ${c[0]} outside <RowAction>`);
      }
    }
  }
  return problems;
}

/** Table files (rule 1 scope): every `.tsx` under src that renders a table, minus Table.tsx itself. */
const tableFiles = allTsx.filter((rel) => rel !== TABLE_RULE_FILE && TABLE_RE.test(read(rel)));

// ---------- census ----------

describe('T-411 census — every table file is classified', () => {
  it('rule 1: table files == ROW_LINK ∪ NO_ROW_TARGET; the lists are disjoint and every path exists', () => {
    const classified = new Set([...ROW_LINK, ...NO_ROW_TARGET]);
    const unclassified = tableFiles.filter((f) => !classified.has(f));
    const stale = [...classified].filter((f) => !tableFiles.includes(f)).sort();
    const overlap = ROW_LINK.filter((f) => NO_ROW_TARGET.includes(f));
    const missing = [...classified].filter((f) => !existsSync(join(srcRoot, ...f.split('/')))).sort();

    expect(unclassified, 'table files in src not listed in ROW_LINK or NO_ROW_TARGET').toEqual([]);
    expect(stale, 'listed paths that no longer render a table').toEqual([]);
    expect(overlap, 'paths listed in both ROW_LINK and NO_ROW_TARGET').toEqual([]);
    expect(missing, 'listed paths that do not exist').toEqual([]);
    expect(tableFiles.length).toBe(ROW_LINK.length + NO_ROW_TARGET.length);
  });

  it('rule 2: every ROW_LINK file imports RowLink; every linked data row is <LinkRow> with one <RowLink> and controls in <RowAction>', () => {
    const unswept = ROW_LINK.flatMap((rel) => {
      const problems = rowLinkViolations(rel);
      return problems.length === 0 ? [] : [`${rel} :: ${problems.join(' | ')}`];
    });
    expect(unswept, `ROW_LINK files not yet swept (${unswept.length} of ${ROW_LINK.length})`).toEqual([]);
  });

  it('rule 3: no NO_ROW_TARGET file has a data row containing href= (a new link forces reclassification)', () => {
    const linked = NO_ROW_TARGET.flatMap((rel) => {
      const src = read(rel);
      return rowsIn(src)
        .filter((r) => isDataRow(r.body) && r.body.includes('href='))
        .map((r) => `${rel} :: line ${lineOf(src, r.start)}`);
    });
    expect(linked, 'NO_ROW_TARGET files with a linked data row').toEqual([]);
  });

  it('rule 4: the hand-rolled stretch string after:inset-0 appears only in components/ui/Table.tsx', () => {
    const hits = allTsx.filter((rel) => rel !== TABLE_RULE_FILE && read(rel).includes('after:inset-0'));
    expect(hits, 'files still hand-rolling the stretch (use RowLink)').toEqual([]);
  });

  it('rule 5: every <tr> / <LinkRow> open tag has a matching close (an unmatched open is a failure, not a skipped row)', () => {
    const unmatched = allTsx.flatMap((rel) => scanRows(read(rel)).unmatched.map((u) => `${rel} :: ${u}`));
    expect(unmatched, 'row open tags with no matching close').toEqual([]);
  });
});

describe('T-411 census — self-check for the row scanner (rule 5)', () => {
  it('a mismatched </tr> closing a <LinkRow> is reported as unmatched, not silently skipped', () => {
    const bad = '<table><LinkRow className="x"><td>a</td></tr></table>';
    const scan = scanRows(bad);
    expect(scan.rows).toEqual([]);
    expect(scan.unmatched).toEqual(['line 1: <LinkRow> has no matching </LinkRow>']);
  });

  it('a self-closing <tr ... /> and a <tr> inside a comment are neither rows nor unmatched', () => {
    const src = '<table>{/* a <tr> in prose */}<tr className={x} {...rest} /></table>';
    const scan = scanRows(src);
    expect(scan.rows).toEqual([]);
    expect(scan.unmatched).toEqual([]);
  });

  it('a well-formed <LinkRow> is one data row and reports nothing unmatched (control)', () => {
    const good = '<table><LinkRow className="x"><td>a</td></LinkRow></table>';
    const scan = scanRows(good);
    expect(scan.unmatched).toEqual([]);
    expect(scan.rows.map((r) => r.tag)).toEqual(['LinkRow']);
    expect(isDataRow(scan.rows[0]!.body)).toBe(true);
  });
});
