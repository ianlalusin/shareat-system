import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * T-234 slice 2 — **every route uses the one page container, and no route is a `<main>` any more.**
 *
 * ## ⛔ What this is guarding against
 *
 * Before T-234, page width was ad hoc: 101 routes chose between six `max-w-*` values with no rule.
 * That is not a state a codebase drifts *out* of on its own — it is what it drifts *into*, one page
 * at a time, each author reasonably copying the neighbour. A rule with no guard is a rule that
 * lasts until the next screen.
 *
 * ## ⚠️ The second assertion is the one nobody would think of
 *
 * Slice 1's `AppShell` renders the document's single `<main>`. Every page used to BE a `<main>`, so
 * a page that keeps one ships a nested landmark — invalid, an a11y defect, and invisible to every
 * other test in this repo. **34 of the 101 pages had TWO `<main>` elements** (early-return branches
 * for empty states), so this is not hypothetical tidiness: it is the shape the sweep was most
 * likely to half-finish.
 *
 * ## The allowlist is a written reason, not a config knob
 *
 * Same discipline as `nav-route-reachability.test.ts`'s `UNLINKED_BY_DESIGN`: an entry says a page
 * is deliberately outside the rule, with the reason attached, and a second test refuses a stale one.
 * ⛔ There is deliberately no `api/*` entry — no `page.tsx` exists under `api/`, and an allowlist
 * row matching nothing is the confession that ages into a lie.
 */

const repoRoot = join(import.meta.dirname, '..', '..');
const APP_ROOT = 'apps/erp/src/app';

/**
 * ⛔ `--cached --others --exclude-standard`: tracked AND untracked-but-not-ignored. A page written
 * five minutes ago is exactly the one at risk of shipping with the wrong container, and a guard
 * that only saw committed work would go green on it and red one commit later, for reasons nobody
 * would connect. `--exclude-standard` still honours `.gitignore`, so `.next` stays out.
 */
function pageFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', APP_ROOT], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\0').filter((f) => f.endsWith('/page.tsx'));
}

const SHELL_ROOT = 'apps/erp/src/components/shell';

/** Every tracked or new file under the shell directory. */
function shellFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', SHELL_ROOT], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\0').filter((f) => f.endsWith('.tsx') || f.endsWith('.ts'));
}

/**
 * ⛔ **Comments stripped before anything is counted, and this is not tidiness.**
 * `nav-route-reachability.test.ts` learned it the hard way: `/attendance/lane` appeared exactly
 * once outside its own directory, in a *comment*, and matching raw text declared a live defect
 * fixed. Here the same trap is already loaded — **both `AppShell.tsx` and `Page.tsx` discuss
 * `<main>` in their doc comments**, six mentions between them against one real element, so a raw
 * count would report seven landmarks and this guard would be pure noise.
 *
 * ⚠️ CRLF normalised first: this repo checks out CRLF, JavaScript's `.` does not match `\r`, and a
 * line-oriented scan that silently matches nothing looks exactly like a clean tree (DEF-179).
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

const mainCount = (src: string) => (codeOnly(src).match(/<main[\s>]/g) ?? []).length;

/** `apps/erp/src/app/reports/ap-aging/page.tsx` → `/reports/ap-aging`; the root page → `/`. */
function routeOf(file: string): string {
  const rel = file.slice(`${APP_ROOT}/`.length).replace(/\/?page\.tsx$/, '');
  return rel === '' ? '/' : `/${rel}`;
}

/**
 * Routes that own their own layout and are deliberately outside the density rule.
 *
 * ⚠️ **All three render with NO session**, so slice 1's `AppShell` returns bare children for them
 * and there is no shell to sit inside — they are full-viewport screens that centre a single card,
 * which is a different problem from "how wide should a list be". `narrow` exists for the next
 * screen of that shape *inside* the app; these three are outside it.
 */
const OWNS_ITS_LAYOUT: Record<string, string> = {
  '/sign-in':
    'Pre-session. A centred card on a full-height viewport, with no shell around it — it sets ' +
    'min-h-screen and centres itself, which is not a density question.',
  '/setup':
    'Pre-session, and reachable only while zero organizations exist. Same centred-card layout as ' +
    'sign-in, deliberately identical so the two screens feel like one flow.',
  '/clock':
    'The terminal kiosk. Bible §5.2 forbids it touching the server at all, it renders no shell, ' +
    'and its chrome is owned by the terminal rather than by this app.',
};

describe('T-234 — every route uses the Page container', () => {
  it('⭐ finds pages at all — a scan matching nothing passes silently (DEF-179)', () => {
    // ⚠️ Not ceremony. The floor collapses to zero if `git ls-files` fails or APP_ROOT is wrong,
    // and a guard that scans nothing looks exactly like a codebase in perfect order.
    expect(pageFiles().length).toBeGreaterThan(90);
  });

  it('every allowlisted route is a real page — a stale entry cannot grant cover', () => {
    const routes = new Set(pageFiles().map(routeOf));
    for (const [route, reason] of Object.entries(OWNS_ITS_LAYOUT)) {
      expect(routes.has(route), `allowlisted "${route}" matches no page.tsx`).toBe(true);
      expect(reason.trim().length, `the reason for "${route}" is too thin to be a reason`).toBeGreaterThan(40);
    }
  });

  it('⛔ every page renders <Page', () => {
    const offenders = pageFiles()
      .filter((f) => OWNS_ITS_LAYOUT[routeOf(f)] === undefined)
      // ⛔ `<Page[\s>]` on comment-stripped source, not `.includes('<Page')`. The loose form is
      // satisfied by `<PageHeader`, and by a doc comment that merely mentions `<Page` — so a file
      // that imported PageHeader and wrapped nothing would pass. One rule for the whole file, the
      // same argument the landmark assertion makes for itself.
      .filter((f) => !/<Page[\s>]/.test(codeOnly(readFileSync(join(repoRoot, f), 'utf8'))))
      .map((f) => `${routeOf(f)} (${f})`);

    expect(
      offenders,
      offenders.length === 0
        ? ''
        : `Routes not using the page container:\n  ${offenders.join('\n  ')}\n\n` +
            'T-234 §3.3: one density rule, four widths — `narrow` | `form` | `table` | `wide`.\n' +
            'Import it from `components/shell/Page` and wrap the page in <Page density="…">.\n' +
            'If the page genuinely owns its own layout, add it to OWNS_ITS_LAYOUT with the reason.',
    ).toEqual([]);
  });

  it('⛔ no page renders its own <main> — AppShell owns the only landmark', () => {
    const offenders = pageFiles()
      .filter((f) => OWNS_ITS_LAYOUT[routeOf(f)] === undefined)
      // ⚠️ `mainCount`, so a page that merely MENTIONS `<main>` in a comment is not accused of
      // rendering one — the same comment-stripping `nav-route-reachability` needs and for the same
      // reason. No page does today; the shell files both do, which is how close this was.
      .map((f) => ({ f, count: mainCount(readFileSync(join(repoRoot, f), 'utf8')) }))
      .filter((x) => x.count > 0)
      .map((x) => `${routeOf(x.f)} — ${x.count} <main> element(s)`);

    expect(
      offenders,
      offenders.length === 0
        ? ''
        : `Routes rendering their own <main>:\n  ${offenders.join('\n  ')}\n\n` +
            'AppShell (T-234 slice 1) renders the document\'s single <main>. A page that keeps one\n' +
            'nests a landmark inside a landmark: invalid HTML, and a screen reader announces two\n' +
            'mains with no way to tell which is the content.\n' +
            '⚠️ Check EVERY return in the file — 34 pages had a second <main> on an early-return\n' +
            'branch for an empty state, and those are the ones a sweep misses.',
    ).toEqual([]);
  });

  /**
   * ⚠️ **The CONTAINER idiom, not every `max-w-`.** The first cut of this test forbade any
   * `max-w-*` anywhere in a page and went red on 30 routes — every one of them a `<p>` carrying a
   * **prose measure**, which is ordinary typography: a description paragraph capped at `max-w-2xl`
   * so a 1280 px line does not run to 200 characters. Fifty `<p>`s and one `<span>` do this, and
   * they were right to — until T-348.
   *
   * ⛔ **T-348 / DEF-474 (2026-09-29): no longer true for the page-TITLE description.** 47 of those
   * capped paragraphs sat under a page's `<h1>` and are swept into the shared `<PageDescription>`
   * component, which drops the cap on purpose — DEF-474 wants the full content width, clamped at 3
   * lines with an ellipsis and an expand control, not a narrower prose measure. Prose elsewhere on
   * the page (the section blurbs this test still leaves alone, out of scope for that sweep) is
   * unaffected: capping THEIR width is still ordinary typography, not the centring container below.
   *
   * ⛔ What must not come back is the CENTRING CONTAINER — `mx-auto` together with a `max-w-*`,
   * a page deciding its own width. That is the pattern this task replaced on 98 routes, and it is
   * the one that drifts back one page at a time.
   */
  it('⛔ no page centres its own width container — that is what the density is for', () => {
    const CONTAINER = /className="(?=[^"]*\bmx-auto\b)(?=[^"]*\bmax-w-)[^"]*"/;
    const offenders = pageFiles()
      .filter((f) => OWNS_ITS_LAYOUT[routeOf(f)] === undefined)
      // ⚠️ Comment-stripped, like every other scan in this file: `Page.tsx`'s own docstring quotes
      // the `mx-auto max-w-…` idiom it replaced, and a page that documented the same history would
      // be accused of committing it.
      .filter((f) => CONTAINER.test(codeOnly(readFileSync(join(repoRoot, f), 'utf8'))))
      .map((f) => routeOf(f));

    expect(
      offenders,
      offenders.length === 0
        ? ''
        : `Routes centring their own width container (mx-auto + max-w-*):\n  ${offenders.join('\n  ')}\n\n` +
            'Width is the container\'s decision. If one of the four densities is wrong for a page,\n' +
            'that is a QUESTION about the density rule, not a fifth width on one page.',
    ).toEqual([]);
  });

  /**
   * ⭐ **The other half of the landmark invariant, and the reason this test exists at all.**
   *
   * The assertion above says no PAGE renders a `<main>`. On its own that is one-directional: it
   * stays green on a document with **no** `<main>` anywhere, which is precisely the state this repo
   * was one commit away from — slice 2 removed 98 page wrappers and slice 1 supplies the single
   * replacement, so committing either alone leaves the app with no landmark and every test green.
   * A guard that fails loudly on legitimate code gets fixed the same morning; one that passes
   * quietly on broken code gets credited. This is the second half.
   */
  it('⛔ the shell renders EXACTLY ONE <main>, and it is AppShell', () => {
    const files = shellFiles();
    // Non-zero control: a `git ls-files` that returns nothing must fail, not pass. Without this the
    // whole assertion is satisfied by an empty directory.
    expect(files.length, 'no files found under the shell directory — the enumeration is broken').toBeGreaterThan(3);

    const withMain = files.filter((f) => mainCount(readFileSync(join(repoRoot, f), 'utf8')) > 0);
    const total = files.reduce((n, f) => n + mainCount(readFileSync(join(repoRoot, f), 'utf8')), 0);

    const explain =
      `\n\nTHE INVARIANT: exactly one <main> exists in the document, and it lives in the shell.\n` +
      `  · ${SHELL_ROOT}/AppShell.tsx renders it.\n` +
      `  · ${SHELL_ROOT}/Page.tsx renders a <div> inside it, deliberately.\n` +
      `  · Every route's page.tsx renders neither (see the assertion above).\n\n` +
      `⚠️ IF THE SHELL MOVED, this line is what needs UPDATING — not deleting. Point SHELL_ROOT at\n` +
      `the new location. Deleting the assertion leaves the app's only landmark unguarded, which is\n` +
      `the state it was in before T-234 and the reason this test was written.`;

    expect(total, `expected exactly one <main> in the shell, found ${total}.${explain}`).toBe(1);
    expect(withMain.map((f) => f.split('/').pop()), `the <main> is in the wrong file.${explain}`).toEqual([
      'AppShell.tsx',
    ]);
  });

  it('⭐ and a prose measure on a paragraph is still allowed — the control for the rule above', () => {
    // Without this, the next person to read the assertion above tightens it to "no max-w at all",
    // the suite goes red, and the natural repair is to delete every legitimate line-length cap.
    // Naming what is PERMITTED is what stops that.
    //
    // ⛔ T-348 / DEF-474 (2026-09-29): >10 -> 5. The 47 title descriptions that used to supply most
    // of this population are swept into `<PageDescription>` (page-container.test.ts's OTHER
    // docstring above), which drops the cap on purpose — they no longer count here, and that is
    // the fix working, not a regression. What is left: the 4 section-blurb files the sweep left
    // alone (`findings/page.tsx`, `payroll/page.tsx`, `remittance/page.tsx`, `till/page.tsx`) plus
    // one unrelated pre-existing site (`attendance/lane/page.tsx:417`, a `sm:max-w-[12rem]` label,
    // nothing to do with a title or a section blurb). Pinned exact, like the rest of this file's
    // guards, so the NEXT change to this number states itself instead of quietly drifting: this
    // control still does its one job — proving `<p className="...max-w-...">` is not vacuously
    // forbidden — with 5 of them, same as with 50.
    const withProseMeasure = pageFiles().filter((f) =>
      /<p className="[^"]*\bmax-w-/.test(readFileSync(join(repoRoot, f), 'utf8')),
    );
    expect(withProseMeasure.length).toBe(5);
  });
});
