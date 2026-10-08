/**
 * T-384 S2a (tester) - "every page full width, every form adapts" (Ian, 2026-10-08:
 * "i want all forms to adjust based on screen size and always use full width").
 * Spec: docs/tasks/384-pos-link-tenders-and-width.md section S2, W-R1..W-R4. All static; no DB.
 *
 * G1 no `density="form"` anywhere in apps/erp/src      (RED on HEAD)
 * G2 Page.tsx `table`/`wide` carry no `max-w-`, `narrow` does (RED on HEAD)
 * G3 no fixed-width form control outside a <td>, per-file ratchet baseline (green at baseline)
 * G4 every action <form> with >=3 labelled controls imports FormGrid, ratchet baseline (green at baseline)
 * G5 positive controls: the scanners can see (literal fixtures)
 * G6 FormGrid / Field render the spec'd classes           (RED on HEAD: no component)
 *
 * Baselines (apps/erp/tests/form-width-baseline.json, form-grid-baseline.json) are ORCHESTRATOR-owned.
 * Shapes:  form-width-baseline.json = { "files": { "<path under apps/erp/src>": <count> } }
 *          form-grid-baseline.json  = { "files": [ "<path under apps/erp/src>", ... ] }
 * `T384_BASELINE_DIR` overrides the directory (used only to prove G3/G4 green before the files exist).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, '..', 'src');
const baselineDir = process.env.T384_BASELINE_DIR ? resolve(process.env.T384_BASELINE_DIR) : here;

/** Mirrors tests/unit/page-container.test.ts `codeOnly` (not exported from a .test.ts). */
function codeOnly(src: string): string {
  return src
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.tsx')) out.push(p);
  }
  return out;
}
const relSrc = (p: string) => relative(srcRoot, p).split('\\').join('/');
const allFiles = () => walk(srcRoot).sort();

// ---------------------------------------------------------------- scanners (pure, fixture-testable)

/** G1: every `density="form"` (also `density={'form'}`) in comment-stripped source. */
function countFormDensity(src: string): number {
  return (codeOnly(src).match(/density=(?:"form"|\{\s*['"`]form['"`]\s*\})/g) ?? []).length;
}

/** C3 tokens: w-16..w-96, w-[..], max-w-xs..max-w-2xl, max-w-[..], with any variant prefix. */
const FIXED_WIDTH =
  /(?<![\w-])(?:[a-z0-9]+:)*(?:w-(?:16|20|24|28|32|36|40|44|48|52|56|60|64|72|80|96)|w-\[[^\]\s]+\]|max-w-(?:xs|sm|md|lg|xl|2xl)|max-w-\[[^\]\s]+\])(?![\w-])/;
const CONTROL = /<(input|select|textarea|Input)\b[^>]*?className=\{?[`"]([^`"]*)/g;

interface Hit {
  readonly tag: string;
  readonly cls: string;
  readonly snippet: string;
}

/** G3: fixed-width controls NOT inside a table cell (last `<td` before it is after the last `</td>`). */
function fixedWidthControls(src: string): Hit[] {
  const clean = codeOnly(src);
  const hits: Hit[] = [];
  const re = new RegExp(CONTROL.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    if (!FIXED_WIDTH.test(m[2]!)) continue;
    const before = clean.slice(0, m.index);
    if (before.lastIndexOf('<td') > before.lastIndexOf('</td>')) continue; // a cell is the measure
    hits.push({ tag: m[1]!, cls: m[2]!, snippet: m[0].slice(0, 80) });
  }
  return hits;
}

/** G4: an action `<form>` (has `action=`) holding >=3 `<label`, and the file does not import FormGrid. */
function needsFormGrid(src: string): boolean {
  const clean = codeOnly(src);
  const forms = clean.match(/<form\b[^>]*\baction=[\s\S]*?<\/form>/g) ?? [];
  const big = forms.some((f) => (f.match(/<label\b/g) ?? []).length >= 3);
  const imports = (clean.match(/import[\s\S]*?from\s+['"][^'"]*['"]/g) ?? []).join('\n');
  return big && !/\bFormGrid\b/.test(imports);
}

/** EXEMPT: file + snippet + reason. A stale entry (file gone, or snippet no longer in the file) fails. */
interface Exempt {
  readonly file: string;
  readonly snippet: string;
  readonly reason: string;
}
const EXEMPT: readonly Exempt[] = [];
function staleExempts(list: readonly Exempt[], read: (f: string) => string | null): string[] {
  return list
    .filter((e) => {
      const src = read(e.file);
      return src === null || !src.includes(e.snippet) || e.reason.trim().length < 15;
    })
    .map((e) => e.file);
}
const readSrc = (f: string): string | null => {
  const p = join(srcRoot, f);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
};

function loadBaseline<T>(name: string): T {
  const p = join(baselineDir, name);
  if (!existsSync(p)) {
    throw new Error(`${name} is missing (orchestrator-owned; create it from the S2a tester report). Looked in ${p}`);
  }
  return (JSON.parse(readFileSync(p, 'utf8')) as { files: T }).files;
}

// ---------------------------------------------------------------- G1
describe('T-384 S2a G1 - no density="form" anywhere', () => {
  it('apps/erp/src has none (16 wrappers in 13 files on HEAD, census C1)', () => {
    const offenders = allFiles()
      .map((f) => ({ f: relSrc(f), n: countFormDensity(readFileSync(f, 'utf8')) }))
      .filter((x) => x.n > 0);
    const total = offenders.reduce((s, x) => s + x.n, 0);
    expect(
      offenders.map((x) => `${x.f} x${x.n}`),
      `${total} density="form" wrapper(s) in ${offenders.length} file(s). Ian: every page uses the full width. Use density="table".`,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------- G2
describe('T-384 S2a G2 - Page.tsx width table', () => {
  const page = codeOnly(readFileSync(join(srcRoot, 'components', 'shell', 'Page.tsx'), 'utf8'));
  const width = (k: string): string | undefined => new RegExp(`^\\s*${k}:\\s*'([^']*)'`, 'm').exec(page)?.[1];

  it('`table` and `wide` carry no max-w- (no cap at any screen)', () => {
    expect(width('table'), '`table` still caps the page width').not.toMatch(/max-w-/);
    expect(width('wide'), '`wide` still caps the page width').not.toMatch(/max-w-/);
  });
  it('`narrow` keeps its cap (A4: sign-in/setup/clock stay narrow cards)', () => {
    expect(width('narrow')).toMatch(/max-w-/);
  });
  it('`form` is gone from PageDensity', () => {
    expect(page).not.toMatch(/PageDensity\s*=[^;]*'form'/);
    expect(width('form')).toBeUndefined();
  });
});

// ---------------------------------------------------------------- G3
describe('T-384 S2a G3 - no fixed-width form control outside a <td> (per-file ratchet)', () => {
  const exemptSnips = (file: string) => EXEMPT.filter((e) => e.file === file).map((e) => e.snippet);

  it('no file exceeds its baseline count, and a count that is now too low must be lowered', () => {
    const base = loadBaseline<Record<string, number>>('form-width-baseline.json');
    const over: string[] = [];
    const lower: string[] = [];
    const counts = new Map<string, number>();
    for (const f of allFiles()) {
      const rel = relSrc(f);
      const hits = fixedWidthControls(readFileSync(f, 'utf8')).filter(
        (h) => !exemptSnips(rel).some((s) => h.snippet.includes(s) || h.cls.includes(s)),
      );
      counts.set(rel, hits.length);
      const allowed = base[rel] ?? 0;
      if (hits.length > allowed) {
        over.push(`${rel}: ${hits.length} > baseline ${allowed} (${hits.map((h) => h.cls.match(FIXED_WIDTH)?.[0]).join(', ')})`);
      }
    }
    for (const [k, allowed] of Object.entries(base)) {
      const now = counts.get(k) ?? 0;
      if (now < allowed) lower.push(`${k}: ${now} < baseline ${allowed} - lower the baseline`);
    }
    expect(over, 'fixed-width controls added (use w-full, or sm:min-w-48 sm:flex-1 in a flex row)').toEqual([]);
    expect(lower).toEqual([]);
  });
  it('EXEMPT has no stale entry', () => {
    expect(staleExempts(EXEMPT, readSrc)).toEqual([]);
  });
});

// ---------------------------------------------------------------- G4
describe('T-384 S2a G4 - action forms with >=3 labelled controls use FormGrid (per-file ratchet)', () => {
  it('every such file imports FormGrid, is in the baseline, or is EXEMPT; a baseline entry that now passes must be removed', () => {
    const base = new Set(loadBaseline<string[]>('form-grid-baseline.json'));
    const exemptFiles = new Set(EXEMPT.map((e) => e.file));
    const need = allFiles()
      .map(relSrc)
      .filter((rel) => needsFormGrid(readSrc(rel)!));
    const missing = need.filter((r) => !base.has(r) && !exemptFiles.has(r));
    const stale = [...base].filter((r) => !need.includes(r));
    expect(missing, 'new multi-field form without FormGrid: wrap its fields in FormGrid + Field').toEqual([]);
    expect(stale, 'baseline entry no longer needs cover (now uses FormGrid or has <3 labels): remove it').toEqual([]);
  });
});

// ---------------------------------------------------------------- G5
describe('T-384 S2a G5 - positive controls (literal fixtures)', () => {
  it('G1 sees density="form" and ignores a comment decoy', () => {
    expect(countFormDensity('<Page density="form">')).toBe(1);
    expect(countFormDensity('// <Page density="form">\n<Page density="table">')).toBe(0);
  });
  it('G3: w-40 on an input is flagged; w-28 in a <td> is not; sm:min-w-48 is not; w-full is not', () => {
    expect(fixedWidthControls('<input className="w-40 rounded" />')).toHaveLength(1);
    expect(fixedWidthControls('<select className={`rounded max-w-sm`}>')).toHaveLength(1);
    expect(fixedWidthControls('<input className="w-[12rem]" />')).toHaveLength(1);
    expect(fixedWidthControls('<td><input className="w-28" /></td>')).toHaveLength(0);
    expect(fixedWidthControls('<td>x</td><input className="w-28" />')).toHaveLength(1);
    expect(fixedWidthControls('<input className="w-full sm:w-auto sm:min-w-48 sm:flex-1" />')).toHaveLength(0);
  });
  it('G4: a 3-label action form without FormGrid is flagged; with FormGrid or <3 labels or a GET form it is not', () => {
    const form = (n: number) => `<form action={a}>${'<label>x</label>'.repeat(n)}</form>`;
    expect(needsFormGrid(form(3))).toBe(true);
    expect(needsFormGrid(form(2))).toBe(false);
    expect(needsFormGrid(`import { FormGrid } from '@/components/ui';\n${form(3)}`)).toBe(false);
    expect(needsFormGrid('<form method="get">' + '<label>x</label>'.repeat(4) + '</form>')).toBe(false);
  });
  it('a stale EXEMPT entry is flagged', () => {
    const fake: Exempt[] = [{ file: 'no/such/file.tsx', snippet: 'w-28', reason: 'a real reason here, long enough' }];
    expect(staleExempts(fake, () => null)).toEqual(['no/such/file.tsx']);
    expect(staleExempts(fake, () => '<input className="w-28" />')).toEqual([]);
    expect(staleExempts(fake, () => '<input className="w-full" />')).toEqual(['no/such/file.tsx']);
  });
});

// ---------------------------------------------------------------- G6
describe('T-384 S2a G6 - FormGrid and Field', () => {
  const load = async () => await import('../src/components/ui/FormGrid');
  it('FormGrid renders the container-adaptive auto-fit template with min(100%,14rem)', async () => {
    const { FormGrid } = await load();
    const html = renderToStaticMarkup(createElement(FormGrid as never, null, 'x'));
    expect(html).toContain('grid');
    expect(html).toContain('gap-4');
    expect(html).toContain('repeat(auto-fit,minmax(min(100%,14rem),1fr))');
  });
  it('Field: label with min-w-0, text and hint; span=full -> col-span-full; span=wide -> sm:col-span-2', async () => {
    const { Field } = await load();
    const F = Field as never;
    const base = renderToStaticMarkup(createElement(F, { label: 'Name', hint: 'As printed' }, createElement('input')));
    expect(base).toContain('<label');
    expect(base).toContain('min-w-0');
    expect(base).toContain('Name');
    expect(base).toContain('As printed');
    expect(base).not.toContain('col-span');
    expect(renderToStaticMarkup(createElement(F, { label: 'R', span: 'full' }, createElement('textarea')))).toContain('col-span-full');
    expect(renderToStaticMarkup(createElement(F, { label: 'R', span: 'wide' }, createElement('input')))).toContain('sm:col-span-2');
  });
  it('components/ui/index.ts exports FormGrid and Field', () => {
    const idx = readFileSync(join(srcRoot, 'components', 'ui', 'index.ts'), 'utf8');
    expect(idx).toMatch(/\bFormGrid\b/);
    expect(idx).toMatch(/\bField\b/);
  });
});
