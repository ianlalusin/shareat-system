/**
 * T-348 S2 (DEF-474) — the sweep: 102 title descriptions in 92 files, `<p className="[mt-1
 * ][max-w-2xl |max-w-3xl ]text-sm text-neutral-600 dark:text-neutral-400">` -> `<PageDescription>`.
 * SW1/SW2 are ratchets over the whole `app/` tree — once every site is swept they must find
 * nothing, ever again, on this shape. SW3-SW5 pin the concrete migration; SW6 pins what must NOT
 * move (task doc §S2 item 5 / Appendix A/B).
 *
 * Census re-run at S2 start (Appendix B method, own copy below — the planner's `scratchpad/
 * census.py` was session scratch, never committed): 139 pairs, 102 class A in 92 files, 47 capped
 * — identical to Appendix A/B's 2026-09-28 figures. Diffed the 92-file SET against Appendix A:
 * zero added, zero removed. Several individual `:line` numbers in Appendix A have drifted (e.g.
 * `ap/invoices/[id]/page.tsx` 72->86, `channel-settlements/page.tsx` 61->142) from unrelated
 * commits landing lines above the pair since 2026-09-28 (T-350/T-358 etc.) — SW1/SW2/SW4 below
 * scan by shape, not by the stale line number, so that drift does not need chasing site by site.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..', 'src', 'app');

// The 6 class-E files (own layout / pre-session / error) — allowlisted out of the sweep entirely,
// task doc Census table row E.
const CLASS_E = new Set([
  'sign-in/page.tsx',
  'setup/page.tsx',
  'clock/page.tsx',
  'error.tsx',
  'global-error.tsx',
  'not-found.tsx',
]);

interface Pair {
  file: string;
  pLine: number;
  className: string;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const p = resolve(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (entry.endsWith('.tsx')) out.push(p);
  }
  return out;
}

function classNameOf(raw: string): string {
  let m = /className\s*=\s*"([^"]*)"/.exec(raw);
  if (m) return m[1]!;
  m = /className\s*=\s*\{`([\s\S]*?)`\}/.exec(raw);
  if (m) return m[1]!;
  return '';
}

// Appendix B's method, verbatim: for every `<h1`, scan the next 7 lines; the first whose trimmed
// text starts with `<p` (stopping at another `<h1`) forms the pair.
function findPairs(): Pair[] {
  const pairs: Pair[] = [];
  for (const file of walk(appRoot)) {
    const rel = file.slice(appRoot.length + 1).replace(/\\/g, '/');
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const h1Line = lines[i];
      if (h1Line === undefined || !h1Line.includes('<h1')) continue;
      for (let j = i + 1; j <= i + 7 && j < lines.length; j++) {
        const pLine = lines[j];
        if (pLine === undefined) break;
        if (pLine.includes('<h1')) break;
        if (pLine.trim().startsWith('<p')) {
          let raw = pLine;
          let k = j;
          while (!raw.includes('>') && k < j + 5 && k + 1 < lines.length) {
            k++;
            const next = lines[k];
            if (next === undefined) break;
            raw += `\n${next}`;
          }
          pairs.push({ file: rel, pLine: j + 1, className: classNameOf(raw) });
          break;
        }
      }
    }
  }
  return pairs;
}

const pairs = findPairs();
const nonE = pairs.filter((p) => !CLASS_E.has(p.file));

// Same h1-then-next-7-lines scan as findPairs(), but reports which TAG paired with the <h1> —
// `<p` or `<PageDescription` — instead of only recognising `<p`. SW3 needs the PAIR itself (the
// element immediately after THIS file's <h1> is a <PageDescription>), not "a <PageDescription>
// appears somewhere later in the file", which a stray, unrelated usage could satisfy.
function tagPairedWithH1(filePath: string): string | undefined {
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const h1Line = lines[i];
    if (h1Line === undefined || !h1Line.includes('<h1')) continue;
    for (let j = i + 1; j <= i + 7 && j < lines.length; j++) {
      const line = lines[j];
      if (line === undefined) break;
      if (line.includes('<h1')) break;
      const trimmed = line.trim();
      if (trimmed.startsWith('<PageDescription')) return 'PageDescription';
      if (trimmed.startsWith('<p')) return 'p';
    }
  }
  return undefined;
}

// Class A (title description) predicate, Appendix B's own definition — needed because several
// class-B/C/D files ALSO carry their own class-A site under a second, earlier `<h1>` (an early
// return for "no store selected", e.g. `inventory/deliveries/page.tsx:42/57`): SW6 must compare
// only the B/C/D shape, or the still-unswept class-A sibling contaminates the multiset today.
function isClassA(p: Pair): boolean {
  if ((p.file === 'admin/stores/page.tsx' && p.pLine === 37) || (p.file === 'admin/users/page.tsx' && p.pLine === 28)) {
    return true;
  }
  const cls = p.className.replace(/\s+/g, ' ').trim();
  if (!cls.includes('text-neutral-600')) return false;
  if (cls.startsWith('mt-4 ') || cls.startsWith('mt-2 ')) return false;
  return true;
}

describe('T-348 S2 — the sweep ratchet (SW1/SW2)', () => {
  it('SW1: no <p> within 7 lines of an <h1> still carries the pre-sweep text-sm text-neutral-600 shape', () => {
    const violations = nonE.filter((p) => {
      const cls = p.className.replace(/\s+/g, ' ').trim();
      return cls.includes('text-sm text-neutral-600') && !cls.startsWith('mt-4 ') && !cls.startsWith('mt-2 ');
    });
    expect(violations.map((p) => `${p.file}:${p.pLine}`)).toEqual([]);
  });

  it('SW2: no <p> within 7 lines of an <h1> caps at max-w-2xl or max-w-3xl', () => {
    const violations = nonE.filter((p) => /max-w-2xl|max-w-3xl/.test(p.className));
    expect(violations.map((p) => `${p.file}:${p.pLine}`)).toEqual([]);
  });
});

describe('T-348 S2 — the two neutral-500 prose sites move too (SW3)', () => {
  it('SW3: the element PAIRED with admin/stores\' and admin/users\' <h1> is a <PageDescription>, not just present somewhere in the file', () => {
    for (const rel of ['admin/stores/page.tsx', 'admin/users/page.tsx']) {
      const tag = tagPairedWithH1(resolve(appRoot, rel));
      expect(tag, `${rel}: expected an <h1>-then-<PageDescription> pair`).toBe('PageDescription');
    }
  });
});

describe('T-348 S2 — the population lands exactly, nothing dropped or doubled (SW4)', () => {
  it('SW4: exactly 125 <PageDescription> call sites exist under app/', () => {
    let count = 0;
    for (const file of walk(appRoot)) {
      const content = readFileSync(file, 'utf8');
      count += (content.match(/<PageDescription[\s>]/g) ?? []).length;
    }
    // 105 -> 106, T-375 S1: the new /settings/pos-link page carries its <PageDescription> (SW1/SW2 stay green). T-401 S4: +4 (menu screens). 110 -> 111, T-401 S5 / combined release: +1. 111 -> 112, T-408: /ap/vat carries its <PageDescription>. 112 -> 116, release 2026-10-16: +4 new pages each carrying one (recipes list/new/[id] from T-413, /settings/usage-tolerance from T-401 S6); measured by walking app/.
    // 116 -> 117, T-431: /liabilities/unpaid carries its <PageDescription>; measured by walking app/.
    // 117 -> 118, T-436: the new /attendance/leave page carries its <PageDescription>.
    // 118 -> 119, T-190: /payroll/rates carries its <PageDescription>; measured by walking app/.
    // 119 -> 120, T-464: /settings/pos-tablet carries its <PageDescription>.
    // 120 -> 122, T-398 S5e: the two inbound shipment pages (S5d) each carry a <PageDescription> (verified in both files).
    // 122 -> 125, T-193 S5: the three statutory-payments pages each carry a <PageDescription>.
    expect(count).toBe(125);
  });
});

describe('T-348 S2 — the 9 linked descriptions keep their link target (SW5)', () => {
  // Recorded pre-sweep (task doc Census table: "9 — budgets, customers, expenses/new,
  // money-accounts, money-transfers, payroll/separations, settings/attendance,
  // settings/organization, settings/sales-channels"). Two of these files carry a second,
  // unlinked, early-return "No store is set up yet." site (Appendix A's two-line entries) — the
  // href below is the OTHER site, the one with real content.
  const LINKED_SITES: Record<string, string> = {
    'budgets/page.tsx': '/expenses/new',
    'customers/page.tsx': '/customers/price-lists',
    'expenses/new/page.tsx': '/ap',
    'money-accounts/page.tsx': '/money-transfers',
    'money-transfers/page.tsx': '/money-accounts',
    'payroll/separations/page.tsx': '/payroll',
    'settings/attendance/page.tsx': '/payroll',
    'settings/organization/page.tsx': '/admin/stores',
    'settings/sales-channels/page.tsx': '/admin/stores',
  };

  it('SW5: each of the 9 pre-sweep hrefs is still present, now inside a <PageDescription> block', () => {
    const report: string[] = [];
    for (const [rel, href] of Object.entries(LINKED_SITES)) {
      const content = readFileSync(resolve(appRoot, rel), 'utf8');
      const blocks = content.match(/<PageDescription[\s\S]*?<\/PageDescription>/g) ?? [];
      const hit = blocks.some((b) => b.includes(`"${href}"`));
      if (!hit) report.push(`${rel}: no <PageDescription> block contains href="${href}"`);
    }
    expect(report).toEqual([]);
  });
});

describe('T-348 S2 — SW6: class B/C/D sites keep their exact class strings (must not move)', () => {
  // Captured at S2 start, this same census re-run — the 24 empty-state (class B), 4
  // record-metadata (class C) and 3 not-a-description (class D) sites the task doc's Census table
  // names, none of them in scope for this sweep. Keyed by file (multiset per file — two files
  // each carry two of these sites) rather than by line, for the same reason SW1/SW2/SW4 scan by
  // shape: an unrelated commit inserting a line above one of these sites must not make this
  // guard drift-blind.
  const BASELINE_BY_FILE: Record<string, string[]> = {
    'admin/access-defaults/page.tsx': ['mt-4 text-sm text-neutral-600 dark:text-neutral-400'],
    'attendance/lane/page.tsx': ['mt-2 text-sm text-neutral-600 dark:text-neutral-400'],
    'attendance/terminals/page.tsx': ['mt-4 text-sm text-neutral-600 dark:text-neutral-400'],
    'commissary/catalogue/page.tsx': ['mt-4 text-sm text-neutral-600'],
    'commissary/discrepancies/page.tsx': ['mt-4 text-sm text-neutral-600'],
    'commissary/orders/page.tsx': ['mt-4 text-sm text-neutral-600'],
    // T-390 S5 added a second class B empty state here (a store with no stock room).
    'cutover/count/page.tsx': ['mt-2 text-sm text-neutral-600 dark:text-neutral-400', 'mt-2 text-sm text-neutral-600 dark:text-neutral-400'],
    'inventory/counts/page.tsx': ['mt-4 text-sm text-neutral-600'],
    'inventory/deliveries/page.tsx': ['mt-4 text-sm text-neutral-600'],
    'inventory/locations/page.tsx': ['mt-4 text-sm text-neutral-600', 'mt-4 text-sm text-neutral-600'],
    'inventory/low-stock/page.tsx': ['mt-4 text-sm text-neutral-600'],
    'inventory/page.tsx': ['mt-4 text-sm text-neutral-600'],
    'inventory/pos-map/page.tsx': ['mt-4 text-sm text-neutral-600'],
    'inventory/pos-usage/page.tsx': ['mt-4 text-sm text-neutral-600'],
    'inventory/production/page.tsx': ['mt-4 text-sm text-neutral-600'],
    'inventory/returns/page.tsx': ['mt-4 text-sm text-neutral-600'],
    'inventory/transfers/page.tsx': ['mt-4 text-sm text-neutral-600'],
    'inventory/usage/page.tsx': ['mt-4 text-sm text-neutral-600'],
    'staff/hire/page.tsx': ['mt-4 text-sm text-neutral-600'],
    'staff/page.tsx': ['mt-4 text-sm text-neutral-600'],
    'trade/orders/page.tsx': ['mt-4 text-sm text-neutral-600'],
    'trade/returns/page.tsx': ['mt-4 text-sm text-neutral-600'],
    'wastage/page.tsx': ['mt-4 text-sm text-neutral-600'],
    // class C — record-metadata subtitle, neutral-500; class D's amber callout also lives on
    // admin/stores/[id]/page.tsx, a second site in the same file.
    'admin/stores/[id]/page.tsx': [
      'text-sm text-neutral-500 dark:text-neutral-400',
      'rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300',
    ],
    'admin/users/[personId]/page.tsx': ['text-sm text-neutral-500 dark:text-neutral-400'],
    'items/[id]/page.tsx': ['text-sm text-neutral-500 dark:text-neutral-400'],
    'staff/[employmentId]/page.tsx': ['text-sm text-neutral-500 dark:text-neutral-400'],
    // class D — not a description at all
    'ap/suppliers/[id]/page.tsx': ['text-xs text-neutral-500 dark:text-neutral-400'],
    "customers/[customerId]/page.tsx": ["text-xs ${TREATMENT_TONE[customer.treatment] ?? ''}"],
  };

  it('every listed class B/C/D site (24 + 4 + 3 = 31) still carries byte-identical classes', () => {
    const report: string[] = [];
    for (const [file, expectedClasses] of Object.entries(BASELINE_BY_FILE)) {
      const actual = pairs
        .filter((p) => p.file === file && !isClassA(p))
        .map((p) => p.className.replace(/\s+/g, ' ').trim());
      const remaining = [...expectedClasses];
      for (const cls of actual) {
        const idx = remaining.indexOf(cls);
        if (idx === -1) report.push(`NEW/CHANGED class at ${file}: "${cls}"`);
        else remaining.splice(idx, 1);
      }
      for (const cls of remaining) report.push(`MISSING expected class at ${file}: "${cls}"`);
    }
    expect(report.sort()).toEqual([]);
  });
});
