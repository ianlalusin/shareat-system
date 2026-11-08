// @vitest-environment happy-dom
/**
 * T-552 — Ian, on the deployed supplier page: "find every instance of this card which collapse but only has a
 * minimal content like just this one it just have 1 button. the button in here can be taken out of the card, the
 * details card may use full wdth of the page."
 *
 * Two claims, both checked here:
 *   1. No page wraps an `<EditableRecord>` in a disclosure. Since T-448 the record's LOCKED state is a single
 *      pencil button (the form lives in the dialog), so such a card opens to reveal one button and nothing else —
 *      exactly the "Edit this supplier" card Ian photographed. The scanner is proven to bite on a fabricated
 *      positive (bible §3.2: a guard that has only ever seen a clean tree is indistinguishable from one that
 *      checks nothing).
 *   2. On a sectioned detail page at ≥1440px, a table-less card shares the row ONLY with another card beside it;
 *      alone, it spans both columns instead of leaving the right half empty. The selectors are exercised against
 *      a real DOM, not only grepped out of the stylesheet.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = join(import.meta.dirname, '..', '..', '..');
const erpSrc = join(repoRoot, 'apps', 'erp', 'src');

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsxFiles(full));
    else if (entry.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/** Every \`<details>\` block in a source, with the index it starts at. Nested blocks end early on purpose. */
export function disclosureBlocks(source: string): Array<{ at: number; text: string }> {
  const out: Array<{ at: number; text: string }> = [];
  const re = /<details\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const end = source.indexOf('</details>', m.index);
    if (end < 0) continue;
    out.push({ at: m.index, text: source.slice(m.index, end + '</details>'.length) });
  }
  return out;
}

/** The disclosures that hold nothing but an edit trigger — the defect T-552 removes. */
export function loneEditDisclosures(source: string): number[] {
  return disclosureBlocks(source)
    .filter((b) => b.text.includes('<EditableRecord'))
    .map((b) => source.slice(0, b.at).split('\n').length);
}

const rel = (file: string) => relative(erpSrc, file).split(sep).join('/');

describe('a card that opens to reveal one button', () => {
  it('⭐ the scanner bites on a fabricated positive and stays quiet on a real form (the control)', () => {
    const bad = ['<details>', '  <summary>Edit</summary>', '  <EditableRecord x />', '</details>'].join('\n');
    const good = ['<details>', '  <summary>Add</summary>', '  <form><input name="a" /></form>', '</details>'].join('\n');
    expect(loneEditDisclosures(bad)).toEqual([1]);
    expect(loneEditDisclosures(good)).toEqual([]);
  });

  it('no page or component wraps <EditableRecord> in a disclosure', () => {
    const offenders: string[] = [];
    for (const file of tsxFiles(erpSrc)) {
      const src = readFileSync(file, 'utf8');
      for (const line of loneEditDisclosures(src)) offenders.push(`${rel(file)}:${line}`);
    }
    expect(
      offenders,
      'an EditableRecord is the only thing inside a <details>: its locked state is one pencil button, so the card ' +
        'opens to reveal nothing but the button. Render the record beside the facts it edits instead.',
    ).toEqual([]);
  });
});

describe('the supplier page', () => {
  const page = readFileSync(join(erpSrc, 'app', 'ap', 'suppliers', '[id]', 'page.tsx'), 'utf8');

  it('has no disclosure card left', () => {
    expect(page).not.toMatch(/<details\b/);
    expect(page).not.toMatch(/<summary[^>]*>\s*Edit this supplier/);
  });

  it('puts the pencil in the details card header, before the facts it edits', () => {
    const heading = page.indexOf('<h2 className="font-medium">Supplier details</h2>');
    const record = page.indexOf('<EditableRecord', heading);
    const facts = page.indexOf('<dl', heading);
    expect(heading, 'the details card needs the visible heading it now carries').toBeGreaterThan(-1);
    expect(record, 'the edit trigger belongs beside that heading').toBeGreaterThan(heading);
    expect(facts, 'the facts follow the heading row').toBeGreaterThan(record);
  });

  it('still posts the same form — every edited field is present', () => {
    for (const name of ['name', 'vatStatus', 'classification', 'status', 'bankAccountNumber', 'notes']) {
      expect(page, name).toContain(`name="${name}"`);
    }
    // Days to pay takes its name from the rule itself (nativeAttrs), so it is never a literal in the source.
    expect(page).toContain('nativeAttrs(SUPPLIER_ADD_RULES.creditTermsDays)');
  });
});

describe('the details card uses the full width when it has no neighbour to share the row with', () => {
  const css = readFileSync(join(erpSrc, 'app', 'globals.css'), 'utf8');
  const FIRST_OF_PAIR = '.erp-page[data-view="detail"][data-sectioned] > section:not(:has(table)):has(+ section:not(:has(table)))';
  const SECOND_OF_PAIR = '.erp-page[data-view="detail"][data-sectioned] > section:not(:has(table)) + section:not(:has(table))';

  it('both halves of the pair rule are in the stylesheet', () => {
    expect(css).toContain(FIRST_OF_PAIR);
    expect(css).toContain(SECOND_OF_PAIR);
    // The old blanket rule — every table-less section squeezed into one column, even when it was alone — is gone.
    expect(css).not.toMatch(/\[data-sectioned\] > section:not\(:has\(table\)\) \{ grid-column: auto; \}/);
  });

  it('a lone card matches neither half (so it spans both columns)', () => {
    const page = document.createElement('div');
    page.className = 'erp-page';
    page.dataset.view = 'detail';
    page.dataset.sectioned = '';
    const lone = document.createElement('section');
    const tableCard = document.createElement('section');
    tableCard.append(document.createElement('table'));
    page.append(lone, tableCard);
    document.body.append(page);
    expect(lone.matches(FIRST_OF_PAIR)).toBe(false);
    expect(lone.matches(SECOND_OF_PAIR)).toBe(false);
  });

  it('the second card of a pair still shares the row (evaluated against a real DOM)', () => {
    const page = document.createElement('div');
    page.className = 'erp-page';
    page.dataset.view = 'detail';
    page.dataset.sectioned = '';
    const first = document.createElement('section');
    const second = document.createElement('section');
    const tableCard = document.createElement('section');
    tableCard.append(document.createElement('table'));
    page.append(first, second, tableCard);
    document.body.append(page);
    expect(second.matches(SECOND_OF_PAIR)).toBe(true);
    // A table-less card that follows a TABLE card is not half of a pair.
    expect(tableCard.matches(SECOND_OF_PAIR)).toBe(false);
  });

  it('the first card of a pair is pinned in the stylesheet (happy-dom cannot evaluate a :has() inside a :has())', () => {
    expect(css).toContain(FIRST_OF_PAIR);
    // ⚠️ Stated rather than hidden: happy-dom 21 matches ':has(+ section)' but returns false for
    // ':has(+ section:not(:has(table)))' whatever the DOM. Chrome 105+, Safari 15.4+ and Firefox 121+ evaluate the
    // full selector; the second half above is the behaviour test, this one keeps the first half from being deleted.
  });
});
