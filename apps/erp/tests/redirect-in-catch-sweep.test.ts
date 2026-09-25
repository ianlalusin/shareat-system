import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findUnsafeRedirectInCatch, findUnsafeRedirectInCatchForFile } from './redirect-in-catch-sweep';

/** Every `actions.ts` under `dir`, recursively — no external glob dependency, same idiom
 *  `touch-target-geometry.ts`'s own `walk()` uses. */
function findActionsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      findActionsFiles(full, out);
    } else if (entry === 'actions.ts') {
      out.push(full);
    }
  }
  return out;
}

/**
 * T-344 / DEF-422 — the NEXT_REDIRECT-leaks-as-an-error shape, found on screen in
 * `createMissingClosedPeriodAction` (§9.4, 2026-09-25): the write succeeded, but the page showed
 * the literal string "NEXT_REDIRECT" instead of a success sentence, because the success path's
 * `back()` (which calls Next's `redirect()`) ran INSIDE a `try` whose `catch` treated the
 * redirect's own throw as a real error. `docs/SMOKETEST.md` reports what a human sees; this is the
 * static guard so the SAME shape does not have to be found on screen a second time, in a different
 * action.
 */

const appRoot = resolve(__dirname, '..', 'src', 'app');
const actionFiles = findActionsFiles(appRoot);

describe('redirect-in-catch sweep — a try that calls redirect()/back() must not be caught silently', () => {
  it('finds a real number of actions.ts files under apps/erp/src/app (non-zero control)', () => {
    expect(actionFiles.length).toBeGreaterThan(40);
  });

  it('the analyzer itself flags the exact shape on a minimal fixture (proves the scan is not vacuous)', () => {
    const fixture = `
      import { redirect } from 'next/navigation';
      function back(params: Record<string, string>): never {
        redirect('/x?' + new URLSearchParams(params).toString());
      }
      export async function doThing(): Promise<void> {
        try {
          back({ ok: 'done' });
        } catch (err) {
          back({ error: String(err) });
        }
      }
    `;
    const findings = findUnsafeRedirectInCatch(fixture);
    expect(findings).toEqual([{ functionName: 'doThing', line: 7, via: 'back' }]);
  });

  it('NEGATIVE: the analyzer does NOT flag the safe shape — redirect after the try, isRedirectError, or an explicit rethrow', () => {
    const safe = `
      import { redirect } from 'next/navigation';
      import { isRedirectError } from 'next/dist/client/components/redirect';
      function back(params: Record<string, string>): never {
        redirect('/x?' + new URLSearchParams(params).toString());
      }
      export async function afterTryCatch(): Promise<void> {
        try {
          await Promise.resolve();
        } catch (err) {
          back({ error: String(err) });
        }
        back({ ok: 'done' });
      }
      export async function rethrows(): Promise<void> {
        try {
          back({ ok: 'done' });
        } catch (err) {
          if (isRedirectError(err)) throw err;
          back({ error: String(err) });
        }
      }
      export async function bareRethrow(): Promise<void> {
        try {
          back({ ok: 'done' });
        } catch (err) {
          throw err;
        }
      }
    `;
    expect(findUnsafeRedirectInCatch(safe)).toEqual([]);
  });

  it('NEGATIVE: a file that never imports redirect from next/navigation is never scanned (no false positive on an unrelated "redirect" name)', () => {
    const unrelated = `
      function redirect(x: string) { console.log(x); }
      export function f() {
        try {
          redirect('/somewhere');
        } catch (err) {
          console.log(err);
        }
      }
    `;
    expect(findUnsafeRedirectInCatch(unrelated)).toEqual([]);
  });

  it('would have caught the EXACT pre-fix shape — a fixture copy, never by reverting real source', () => {
    // Copied verbatim from `findings/actions.ts` as it stood on screen 2026-09-25 (before the
    // builder's fix), including its real `back()` wrapper — not a generic analog like the fixture
    // above. `back({ ok: ... })` sits inside the `try`; the `catch` has neither `isRedirectError`
    // nor a rethrow, so it swallows `redirect()`'s own throw and reports it as `errorMessage(err)` —
    // which is exactly the "NEXT_REDIRECT" banner the §9.4 smoketest saw.
    const preFixShape = `
      import { redirect } from 'next/navigation';
      import { createMissingClosedPeriod } from '@shareat/domain';
      import { withOrgPrincipal } from './lib';
      import { requireActor } from '../../lib/session';
      import { errorMessage } from '@/lib/constraint-messages';

      function str(fd: FormData, key: string): string {
        const v = fd.get(key);
        return typeof v === 'string' ? v.trim() : '';
      }

      function back(params: Record<string, string>): never {
        redirect('/findings?' + new URLSearchParams(params).toString());
      }

      export async function createMissingClosedPeriodAction(formData: FormData): Promise<void> {
        const actor = await requireActor();
        const period = str(formData, 'period');
        const startsOn = str(formData, 'startsOn');
        const endsOn = str(formData, 'endsOn');
        const reason = str(formData, 'reason');

        try {
          const result = await withOrgPrincipal(actor.orgId, (tx) =>
            createMissingClosedPeriod(tx, actor, { startsOn, endsOn, reason }),
          );
          back({ ok: \`\${result.startsOn} to \${result.endsOn} is created as \${result.status}.\`, period });
        } catch (err) {
          back({ error: errorMessage(err), period });
        }
      }
    `;
    expect(findUnsafeRedirectInCatch(preFixShape)).toEqual([
      { functionName: 'createMissingClosedPeriodAction', line: 24, via: 'back' },
    ]);
  });

  it('findings/actions.ts — createMissingClosedPeriodAction (T-344/DEF-422, confirmed on screen 2026-09-25) — green: the builder moved the success back() outside the try', () => {
    const findings = findUnsafeRedirectInCatchForFile(resolve(appRoot, 'findings', 'actions.ts'));
    expect(
      findings,
      'regression: the success back({ok...}) is back inside the try, or the catch no longer ' +
        'rethrows/checks isRedirectError — see docs/SMOKETEST.md §9.4, 2026-09-25',
    ).toEqual([]);
  });

  it('every OTHER actions.ts file — reported, never fixed here (findings/actions.ts is excluded above)', () => {
    const report: string[] = [];
    for (const file of actionFiles) {
      if (file.replace(/\\/g, '/').endsWith('/findings/actions.ts')) continue;
      const findings = findUnsafeRedirectInCatchForFile(file);
      for (const f of findings) {
        report.push(`${file.slice(appRoot.length + 1).replace(/\\/g, '/')}:${f.line} ${f.functionName}() via ${f.via}()`);
      }
    }
    expect(report, report.length ? `unexpected finding(s) — report these, do not fix them here:\n  ${report.join('\n  ')}` : '').toEqual([]);
  });
});
