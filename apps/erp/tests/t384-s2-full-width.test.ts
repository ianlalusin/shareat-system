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
const CONTROL_OPEN = /<(input|select|textarea|Input)(?=[\s/>])/g;

interface Hit {
  readonly tag: string;
  readonly cls: string;
  readonly snippet: string;
}

/**
 * The full text of the tag opened at `start`, brace-aware: `>` ends the tag only at brace depth 0 and
 * outside quotes, so `onChange={(e) => ...}` (a `=>` before className) does not cut the tag short.
 */
function tagText(clean: string, start: number): string {
  let depth = 0;
  let quote = '';
  for (let i = start; i < clean.length; i++) {
    const c = clean[i]!;
    if (quote) {
      if (c === quote) quote = '';
      continue;
    }
    if (depth === 0 && (c === '"' || c === "'")) quote = c;
    else if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) return clean.slice(start, i + 1);
  }
  return clean.slice(start);
}

/** G3: fixed-width controls NOT inside a table cell (last `<td` before it is after the last `</td>`). */
function fixedWidthControls(src: string): Hit[] {
  const clean = codeOnly(src);
  const hits: Hit[] = [];
  const re = new RegExp(CONTROL_OPEN.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    const tag = tagText(clean, m.index);
    const cm = /className=\{?[`"]([^`"]*)/.exec(tag);
    if (!cm || !FIXED_WIDTH.test(cm[1]!)) continue;
    const before = clean.slice(0, m.index);
    if (before.lastIndexOf('<td') > before.lastIndexOf('</td>')) continue; // a cell is the measure
    hits.push({ tag: m[1]!, cls: cm[1]!, snippet: tag.slice(0, 80) });
  }
  return hits;
}

/**
 * FormGrid sets `container-type: inline-size`, which makes its width independent of its content. In a
 * flex row without flex-1/w-full, inline, w-fit or a table cell it therefore collapses to 0.
 * Walks the JSX tag stack (brace-aware) and checks the direct parent of each `<FormGrid`.
 */
function formGridPlacementProblems(src: string): string[] {
  const clean = codeOnly(src);
  const out: string[] = [];
  const stack: { name: string; cls: string }[] = [];
  const re = /<(\/?)([A-Za-z][\w.]*)(?=[\s/>])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    const name = m[2]!;
    if (m[1]) {
      for (let i = stack.length - 1; i >= 0; i--) if (stack[i]!.name === name) { stack.length = i; break; }
      continue;
    }
    const tag = tagText(clean, m.index);
    const cls = /className=\{?[`"]([^`"]*)/.exec(tag)?.[1] ?? '';
    if (name === 'FormGrid') {
      const parent = stack[stack.length - 1];
      if (parent) {
        const p = ` ${parent.cls} `;
        if (parent.name === 'td' || parent.name === 'th') out.push(`FormGrid inside <${parent.name}>`);
        else if (/\s(?:inline|inline-block|inline-flex|w-fit|table-cell)\s/.test(p)) out.push('FormGrid inside an inline/w-fit parent');
        else if (/\s(?:inline-)?flex\s/.test(p) && !/\sflex-col\s/.test(p) && !/(?:^|\s)(?:flex-1|w-full|basis-full|grow)(?:\s|$)/.test(cls)) out.push('FormGrid a flex-row child without flex-1/w-full');
      }
    }
    if (!/\/\s*>$/.test(tag) && !/^<(input|br|img|hr)$/.test(`<${name}`)) stack.push({ name, cls });
  }
  return out;
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
  it('G3 is brace-aware: a `=>` inside {...} before className does not hide the control', () => {
    expect(fixedWidthControls('<input onChange={(e) => set(e.target.value)} className="w-40" />')).toHaveLength(1);
    expect(fixedWidthControls('<Input onBlur={() => { go(a > b); }} name="x" className={`w-64 rounded`} />')).toHaveLength(1);
    expect(fixedWidthControls('<input onChange={(e) => set(1)} className="w-full" />')).toHaveLength(0);
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
  it('Field: label with min-w-0, text and hint; span=full -> col-span-full', async () => {
    const { Field } = await load();
    const F = Field as never;
    const base = renderToStaticMarkup(createElement(F, { label: 'Name', hint: 'As printed' }, createElement('input')));
    expect(base).toContain('<label');
    expect(base).toContain('min-w-0');
    expect(base).toContain('Name');
    expect(base).toContain('As printed');
    expect(base).not.toContain('col-span');
    expect(renderToStaticMarkup(createElement(F, { label: 'R', span: 'full' }, createElement('textarea')))).toContain('col-span-full');
  });
  it('Field span=wide is EXACTLY a 29rem container-query span; FormGrid is the container', async () => {
    const { FormGrid, Field } = await load();
    const wide = renderToStaticMarkup(createElement(Field as never, { label: 'R', span: 'wide' }, createElement('input')));
    const grid = renderToStaticMarkup(createElement(FormGrid as never, null, 'x'));
    expect(wide, 'wide must not use a viewport breakpoint span').not.toMatch(/(?:sm|md|lg|xl|2xl):[^\s"]*col-span/);
    expect(wide, 'wide must be a conditional container span, never unconditional').toContain('[@container_(min-width:29rem)]:col-span-2');
    expect(wide, 'wide must not carry an unconditional or other-width span').not.toMatch(/(?:^|[\s"])col-span-2/);
    expect(wide).not.toMatch(/min-width:(?!29rem)/);
    expect(grid, 'FormGrid must be the size container').toContain('[container-type:inline-size]');
  });
  it('FormGrid is never where inline-size containment collapses it (flex row without flex-1/w-full, inline, w-fit, table cell)', () => {
    const offenders: string[] = [];
    for (const f of allFiles()) {
      for (const why of formGridPlacementProblems(readFileSync(f, 'utf8'))) offenders.push(`${relSrc(f)}: ${why}`);
    }
    expect(offenders).toEqual([]);
  });
  it('placement guard positive controls (literal fixtures)', () => {
    const bad = (src: string) => formGridPlacementProblems(src).length;
    expect(bad('<div className="flex gap-2"><FormGrid>x</FormGrid></div>')).toBe(1);
    expect(bad('<div className="flex gap-2"><FormGrid className="flex-1">x</FormGrid></div>')).toBe(0);
    expect(bad('<div className="flex"><FormGrid className="w-full">x</FormGrid></div>')).toBe(0);
    expect(bad('<div className="flex flex-col"><FormGrid>x</FormGrid></div>')).toBe(0);
    expect(bad('<span className="inline-block"><FormGrid>x</FormGrid></span>')).toBe(1);
    expect(bad('<div className="w-fit"><FormGrid>x</FormGrid></div>')).toBe(1);
    expect(bad('<td><FormGrid>x</FormGrid></td>')).toBe(1);
    expect(bad('<div className="space-y-4"><form action={a} onSubmit={(e) => go(e)}><FormGrid>x</FormGrid></form></div>')).toBe(0);
  });
  it('components/ui/index.ts exports FormGrid and Field', () => {
    const idx = readFileSync(join(srcRoot, 'components', 'ui', 'index.ts'), 'utf8');
    expect(idx).toMatch(/\bFormGrid\b/);
    expect(idx).toMatch(/\bField\b/);
  });
});
