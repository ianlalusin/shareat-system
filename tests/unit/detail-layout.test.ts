import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * T-240 — **the two-column detail page: the rail is a component, and its one invisible trap is
 * guarded as far as a unit test can guard it.**
 *
 * ## ⛔ What this is actually protecting
 *
 * Tailwind breakpoints are **viewport** queries, not container queries, and this app has no
 * container-query plugin. A `sm:grid-cols-5` strip moved into a 320 px rail therefore stays
 * five-across at a 1440 px viewport — 58 px per tile. **Nothing overflows. Every DOM measurement
 * passes. The build is green. The screen is unreadable.** That is the same failure the tablet rail
 * shipped with, and it is why every grid inside a `summary` carries `min-[1440px]:grid-cols-1`.
 *
 * ⚠️ **This file cannot prove that class is on the right element** — see the honest note on the
 * fourth assertion. The real proof is a screenshot at 1440, and T-240 §5.3 makes twelve of them a
 * done-condition. What this file does is refuse the two failures that ARE mechanical: the class
 * missing from a caller entirely, and a seventh page quietly adopting the layout without anyone
 * looking at it on a wide screen.
 */

const repoRoot = join(import.meta.dirname, '..', '..');
const APP_ROOT = 'apps/erp/src/app';
const LAYOUT = 'apps/erp/src/components/shell/DetailLayout.tsx';

/**
 * The six callers, and the reason there are six rather than twenty-five: these are the only detail
 * pages carrying a **summary block with no interactive element in it** — a row of `<Figure>` tiles
 * that a rail can hold without moving a single form field, button or link.
 *
 * ⛔ **This list is deliberately EXACT, not a floor.** A seventh page joining is not a bug, but it
 * is a page nobody has looked at on a 1440 screen, and the failure mode here is invisible to every
 * other gate in this repo. Adding a name to this array is the moment you take on the screenshot.
 */
const CALLERS = [
  'cash-requests/[id]',
  'fixed-assets/[id]',
  'liabilities/[id]',
  'loans/[id]',
  'owners/[id]',
  'prepaid/[id]',
].map((r) => `${APP_ROOT}/${r}/page.tsx`);

/** The two-column track definition. It lives in the component; no page hand-rolls it. */
const GRID = 'grid-cols-[minmax(0,1fr)_20rem]';
/** The class that stops a moved grid staying N-across inside the rail. */
const RAIL_STACK = 'min-[1440px]:grid-cols-1';

function pageFiles(): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', APP_ROOT],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return out.split('\0').filter((f) => f.endsWith('/page.tsx'));
}

/**
 * ⛔ **Comments stripped before ANY match, and here it is not a precaution — it is the whole
 * reason the fourth assertion means anything.**
 *
 * Every one of the six callers explains `min-[1440px]:grid-cols-1` in a comment directly above the
 * class it applies. A raw `.includes()` would be satisfied by the explanation alone, so a page that
 * lost the class but kept the comment would pass — the guard would be checking that someone wrote
 * a note about the bug it is supposed to catch. `nav-route-reachability.test.ts` has the same
 * stripper for the same reason, and `page-container.test.ts` inherited it.
 *
 * ⚠️ CRLF normalised first. This tree checks out CRLF, JavaScript's `.` never matches `\r`, and a
 * line-oriented scan that silently matches nothing looks exactly like a clean codebase (DEF-179).
 */
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

const read = (f: string) => readFileSync(join(repoRoot, f), 'utf8');
const code = (f: string) => codeOnly(read(f));

describe('T-240 — the two-column detail page', () => {
  it('⭐ finds the component and all six callers — a scan matching nothing passes silently (DEF-179)', () => {
    // Not ceremony. If APP_ROOT is wrong or `git ls-files` fails, every assertion below is
    // vacuously true and the suite reports a codebase in perfect order.
    expect(pageFiles().length).toBeGreaterThan(90);
    expect(read(LAYOUT).length).toBeGreaterThan(500);
    for (const f of CALLERS) {
      expect(read(f).length, `${f} could not be read — the caller list is stale`).toBeGreaterThan(500);
    }
  });

  it('⛔ exactly these six pages use the layout — a seventh means a screenshot nobody took', () => {
    const users = pageFiles().filter((f) => /<DetailLayout[\s>]/.test(code(f)));

    expect(
      users.sort(),
      'The set of DetailLayout callers changed.\n\n' +
        'Adding a page is fine — the layout is meant to be reused. But its one failure mode\n' +
        '(a grid staying N-across inside a 320px rail) is invisible to typecheck, to this suite,\n' +
        'to the build and to every overflow measurement. It is only visible in a screenshot at\n' +
        '1440px. Add the route to CALLERS in this file, and take the screenshot — T-240 §5.3.',
    ).toEqual([...CALLERS].sort());
  });

  it('⛔ every caller imports the component rather than re-implementing it', () => {
    for (const f of CALLERS) {
      expect(code(f), `${f} renders <DetailLayout without importing it`).toContain(
        "from '@/components/shell/DetailLayout'",
      );
    }
  });

  it('⛔ no page hand-rolls the two-column track — the component owns the split', () => {
    // The same argument `page-container.test.ts` makes for `mx-auto + max-w-`: a rule that lives in
    // one component survives; a rule that pages may re-type drifts back one page at a time.
    const offenders = pageFiles().filter((f) => code(f).includes(GRID));

    expect(
      offenders,
      offenders.length === 0
        ? ''
        : `Pages defining the two-column grid themselves:\n  ${offenders.join('\n  ')}\n\n` +
            'The track, the gap, the placement and the stickiness belong to DetailLayout.\n' +
            'If the split is wrong for a page, that is a QUESTION about the layout, not a\n' +
            'second copy of it with different numbers.',
    ).toEqual([]);
    expect(code(LAYOUT), 'the component no longer defines the grid it owns').toContain(GRID);
  });

  /**
   * ⚠️ **The weak one, labelled rather than dressed up.**
   *
   * It proves the class is present in the file's *code*. It cannot prove it is on the element that
   * needs it, and it says nothing about a grid added to a `summary` tomorrow. It is here because it
   * is free and it catches the one omission with a name: a caller that moved a strip into the rail
   * and forgot the class entirely. **T-240 §5.3's screenshots are the real assertion**; treating a
   * green run here as proof of §3.5 is exactly the mistake this comment exists to prevent.
   */
  it('⚠️ every caller carries the rail-stacking class in CODE, not merely in a comment', () => {
    const missing = CALLERS.filter((f) => !code(f).includes(RAIL_STACK));

    expect(
      missing,
      missing.length === 0
        ? ''
        : `Callers missing \`${RAIL_STACK}\`:\n  ${missing.join('\n  ')}\n\n` +
            'Tailwind breakpoints are VIEWPORT queries. A `sm:grid-cols-4` strip stays four-across\n' +
            'inside the 320px rail at a 1440px viewport — 74px per tile, nothing overflowing, every\n' +
            'other gate green. Add the class to each grid moved into `summary`.',
    ).toEqual([]);
  });

  it('⛔ the component renders neither <main> nor <aside>', () => {
    const src = code(LAYOUT);

    // <main>: AppShell owns the document's only landmark, and page-container.test.ts asserts the
    // shell directory's total is exactly one. This file lives in that directory, so a <main> here
    // turns THAT suite red — a failure whose message points at the shell, not at this task.
    expect(/<main[\s>]/.test(src), 'DetailLayout renders a <main>; AppShell owns the only one').toBe(
      false,
    );
    // <aside>: announces *complementary* content. A loan's outstanding balance is the most
    // important thing on the page, not an aside to it. Decided in T-240 §3.1, guarded so the next
    // reader who thinks "surely this should be an <aside>" finds the reason instead of the tag.
    expect(/<aside[\s>]/.test(src), 'the rail is not complementary content — see T-240 §3.1').toBe(
      false,
    );
  });

  it('⭐ and the rail is placed by grid lines, not by source order — the control for the DOM order', () => {
    // The summary is FIRST in the DOM and SECOND on screen. Below 1440 there is no grid, so it is
    // simply where it has always been, and no phone changes. `order-first` instead would reverse
    // what a screen reader reads on every phone in the business to save one class on a laptop.
    const src = code(LAYOUT);
    expect(src).toContain('min-[1440px]:col-start-2');
    expect(src).toContain('min-[1440px]:col-start-1');
    expect(/\border-first\b|\border-last\b/.test(src), 'placement regressed to source order').toBe(
      false,
    );
  });
});
