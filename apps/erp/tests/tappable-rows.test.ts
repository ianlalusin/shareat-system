/**
 * T-258 / DEF-244 — `/customers/[customerId]`'s Charges and Collections rows are whole-row tap
 * targets via the stretched-link technique (a real `<Link>` with `after:absolute after:inset-0`,
 * positioned against a `relative` ancestor `<tr>` — not a `<div onClick>`, and not `<tr>` wrapped in
 * `<a>`, which is invalid HTML: `<tr>` only accepts `<td>/<th>` children).
 *
 * ⚠️ Rendered geometry (actual row height, boundary probes between consecutive rows) is not
 * unit-testable here — same limitation T-249 §9 documented, no harness renders real Tailwind CSS.
 * A static Tailwind-CLI repro measured this before building (44.4–70.4px rows, 0px gaps, full-width
 * hit area, independently-clickable void button) — the orchestrator's live browser pass on the real
 * app at 390/1280 is what turns that into a fact about production. This guard checks the one thing
 * that IS mechanical: the structural pieces the technique depends on are actually present in source,
 * and a future edit can't silently drop one half of the pattern.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const pagePath = resolve(here, '..', 'src', 'app', 'customers', '[customerId]', 'page.tsx');
const content = readFileSync(pagePath, 'utf8');

describe('whole-row tap target — T-258 / DEF-244', () => {
  it('never wraps a <tr> in <a> (invalid HTML — <tr> only accepts <td>/<th>)', () => {
    expect(content).not.toMatch(/<Link[^>]*>\s*<tr/);
    expect(content).not.toMatch(/<a[^>]*>\s*<tr/);
  });

  it('never uses a bare <tr onClick> as the tap-target mechanism', () => {
    expect(content).not.toMatch(/<tr[^>]*onClick/);
  });

  it('both entry-link rows are `relative` (the containing block the stretched link needs)', () => {
    const rowBlocks = content.split('<tr').slice(1).filter((b) => b.includes('journalEntryId &&'));
    expect(rowBlocks.length).toBe(2); // Charges row, Collections row
    for (const block of rowBlocks) {
      expect(block.slice(0, 400)).toMatch(/\brelative\b/);
    }
  });

  it('both "entry" links use the stretched-link classes, not ACTION_LINK', () => {
    const matches = [...content.matchAll(/>\s*entry\s*<\/Link>/g)];
    expect(matches.length).toBe(2);
    expect(content).not.toMatch(/entry[\s\S]{0,5}<\/Link>[\s\S]{0,5}ACTION_LINK/);
    const entryLinkAttrs = [...content.matchAll(/<Link[^>]*after:absolute after:inset-0[^>]*>/g)];
    expect(entryLinkAttrs.length).toBe(2);
  });

  it('every "entry" link has a distinguishing aria-label, not a page of identical names', () => {
    const labels = [...content.matchAll(/aria-label=\{`View journal entry[^`]*`\}/g)];
    expect(labels.length).toBe(2);
    // Distinct template literals (Charges vs. Collections) — not the same string copy-pasted twice.
    expect(new Set(labels.map((m) => m[0])).size).toBe(2);
  });

  it('the void form escapes the stretched link as a real sibling with its own stacking context', () => {
    const formMatch = content.match(/<form\s+action=\{voidCollectionAction\}[^>]*>/);
    expect(formMatch).not.toBeNull();
    expect(formMatch![0]).toMatch(/\brelative\b/);
    expect(formMatch![0]).toMatch(/\bz-10\b/);
  });

  it('the void button uses ACTION_LINK — found-in-passing DEF-239-shape fix, not left at bare underline', () => {
    expect(content).toMatch(/<button type="submit" className=\{ACTION_LINK\}>\s*void\s*<\/button>/);
    expect(content).not.toMatch(/<button type="submit" className="underline underline-offset-2">/);
  });
});
