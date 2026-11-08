/**
 * T-545 (DEF-815) — the dialog's Close "×" must be big enough for a finger.
 *
 * The Close button was `h-8 w-8` (32 × 32 px) at every pointer size. The project's rule is 44 px on
 * a touch screen (48 px preferred) and compact with a mouse, and the repo already carries that rule
 * as plain CSS keyed on `@media (pointer: coarse)` (Tailwind 3.4 has no pointer variant — see the
 * `.shell-nav-row` block in `globals.css`).
 *
 * This guard reads the two files rather than a rendered DOM, because jsdom/happy-dom has no pointer
 * media query: it pins that the button opts into the new class, that the class is 32 px by default
 * and 44 px under a coarse pointer, and that the button is still labelled "Close".
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const erpRoot = resolve(here, '..');
const dialogPath = resolve(erpRoot, 'src', 'components', 'ui', 'Dialog.tsx');
const cssPath = resolve(erpRoot, 'src', 'app', 'globals.css');

const dialog = readFileSync(dialogPath, 'utf8');
const css = readFileSync(cssPath, 'utf8');

/** The one `<button>` in the dialog header that closes it — the one carrying aria-label="Close". */
function closeButton(): string {
  const m = /<button\b[\s\S]*?aria-label="Close"[\s\S]*?<\/button>/.exec(dialog);
  return m ? m[0] : '';
}

/** Every `@media (pointer: coarse) { … }` block, braces balanced one level deep. */
function coarseBlocks(source: string): string[] {
  const blocks: string[] = [];
  const marker = '@media (pointer: coarse)';
  let from = source.indexOf(marker);
  while (from !== -1) {
    const open = source.indexOf('{', from);
    if (open === -1) break;
    let depth = 0;
    let i = open;
    for (; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    blocks.push(source.slice(open, i + 1));
    from = source.indexOf(marker, i + 1);
  }
  return blocks;
}

describe('T-545 — the dialog Close button is finger-sized on touch', () => {
  it('is still the labelled Close button, compact for a mouse and opted into the sized class', () => {
    const button = closeButton();
    expect(button, 'no aria-label="Close" button found in Dialog.tsx').not.toBe('');
    expect(button).toContain('aria-label="Close"');
    expect(button).toContain('erp-dialog-close');
    // 32px with a mouse — `h-8 w-8` stays so the mouse size and the touch-target census agree.
    expect(button).toContain('h-8 w-8');
  });

  it('grows to at least 44px under a coarse pointer, with a selector that beats the utilities', () => {
    const sized = coarseBlocks(css).filter((block) => block.includes('.erp-dialog-close'));
    expect(sized, 'no @media (pointer: coarse) rule sizes .erp-dialog-close').toHaveLength(1);

    // Two classes beat a single `h-8` utility whatever order Tailwind emits it in.
    expect(sized[0]).toContain('.erp-dialog .erp-dialog-close');

    const height = Number(/height:\s*(\d+)px/.exec(sized[0] ?? '')?.[1] ?? 0);
    const width = Number(/width:\s*(\d+)px/.exec(sized[0] ?? '')?.[1] ?? 0);
    expect(height).toBeGreaterThanOrEqual(44);
    expect(width).toBeGreaterThanOrEqual(44);
  });

  it('keeps the icon at 18px and the dialog unchanged otherwise', () => {
    const header = /<button\b[\s\S]*?<\/button>/.exec(closeButton())?.[0] ?? '';
    expect(header).toMatch(/width=\{18\}/);
    expect(header).toMatch(/height=\{18\}/);
    // The close behaviour is untouched: the button still calls close() on the dialog ref.
    expect(header).toContain('ref.current?.close()');
  });
});
