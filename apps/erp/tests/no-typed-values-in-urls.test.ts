import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FLASH_HELPER, PENDING, PRE_SESSION, SRC_ROOT, findingsForSource, isExempt, scanTree, type Finding } from './no-typed-values-in-urls';

/**
 * T-380 S1a - the source guard for DEF-476 (G1a, G1b, G2, G-self, G-tree, G3).
 * Spec: docs/tasks/380-no-typed-values-in-urls.md, REV-1 and REV-10.
 *
 * What is red on HEAD, and why: only "lib/flash.ts exists" (S1a creates it). Everything else here is
 * the analyzer proving itself on inline fixtures, plus the real tree with PENDING covering the whole
 * census. That red test prints the census as it stands today (findings by rule, files affected), so
 * the number a builder is working against is in front of them rather than behind a bare failure.
 *
 * The guard's named mutants (what turns each fixture test red):
 *  - G1a: a `?`/`&` template or a non-literal target stops being flagged.
 *  - G1b: drop the `return await` check, the enclosing-function check, the alias check or the
 *    re-export check.
 *  - G2:  treat `await searchParams` as flashed.
 */

const rules = (fs: Finding[]) => fs.map((f) => f.rule);

const ACTION = (body: string, imports = `import { redirectWithFlash } from '@/lib/flash';`) => `${imports}\n${body}`;

describe('G1a - redirect() may not carry a query', () => {
  it('flags the legacy local back() with URLSearchParams (the named mutant: re-add it in a non-PENDING file)', () => {
    const src = `
      import { redirect } from 'next/navigation';
      function back(p: string, q: Record<string, string>): never {
        redirect(\`\${p}?\${new URLSearchParams(q)}\`);
      }
      export async function act() {
        back('/prepaid/1', { error: 'x', reason: 'typed' });
      }
    `;
    const f = findingsForSource(src, 'app/zzz/actions.ts');
    expect(rules(f)).toEqual(['G1a']);
    expect(f[0]!.detail).toContain('query');
  });

  it('flags a template with & in a literal part, a concatenation, an identifier target, and a literal that spells ?error=', () => {
    const cases = [
      "redirect(`/x?a=1&b=${id}`)",
      "redirect('/x?' + qs)",
      'redirect(target)',
      "redirect('/ap?error=Nope')",
      "redirect('/ap?ok=done')",
    ];
    for (const c of cases) {
      const src = `import { redirect } from 'next/navigation';\nexport async function act(id: string, qs: string, target: string) { ${c}; }`;
      expect(rules(findingsForSource(src, 'app/zzz/actions.ts')), c).toEqual(['G1a']);
    }
  });

  it('clean: a literal, a template with no ? or &, a literal with a non-banner query', () => {
    const src = `
      import { redirect } from 'next/navigation';
      export async function act(id: string) {
        redirect('/sign-in');
        redirect(\`/ap/invoices/\${id}\`);
        redirect('/reports?from=2026-01-01');
      }
    `;
    expect(findingsForSource(src, 'app/zzz/actions.ts')).toEqual([]);
  });

  it('finds the call through an import alias and a namespace import, and flags a bare alias', () => {
    const aliased = `import { redirect as go } from 'next/navigation';\nexport async function a(q: string) { go(\`/x?\${q}\`); }`;
    expect(rules(findingsForSource(aliased, 'app/zzz/actions.ts'))).toEqual(['G1a']);
    const ns = `import * as nav from 'next/navigation';\nexport async function a(q: string) { nav.redirect(\`/x?\${q}\`); }`;
    expect(rules(findingsForSource(ns, 'app/zzz/actions.ts'))).toEqual(['G1a']);
    const alias = `import { redirect } from 'next/navigation';\nconst go = redirect;\nexport async function a() { go('/x'); }`;
    expect(rules(findingsForSource(alias, 'app/zzz/actions.ts'))).toEqual(['G1a']);
  });
});

describe('G1b - return await redirectWithFlash(...) from a top-level exported action (REV-1, REV-10)', () => {
  it('clean: the converted forms (function declaration, exported arrow, a guard clause, inside try/catch)', () => {
    const src = ACTION(`
      export async function writeOffAction(fd: FormData) {
        if (!fd) return await redirectWithFlash('/prepaid/1', {}, { error: 'e' });
        try {
          await doThing();
        } catch (err) {
          return await redirectWithFlash('/prepaid/1', {}, { error: String(err), keep: { reason: 'r' } });
        }
        return await redirectWithFlash('/prepaid/1', {}, { ok: 'done' });
      }
      export const other = async () => {
        return await redirectWithFlash('/x', {});
      };
    `);
    expect(findingsForSource(src, 'app/zzz/actions.ts')).toEqual([]);
  });

  it('flags an unawaited call (the named mutant: remove `await` from one call)', () => {
    const src = ACTION(`export async function a() { return redirectWithFlash('/x', {}, { ok: 'y' }); }`);
    const f = findingsForSource(src, 'app/zzz/actions.ts');
    expect(rules(f)).toEqual(['G1b']);
    expect(f[0]!.detail).toContain('return await');
  });

  it('flags a bare `await redirectWithFlash(...);` statement and a void call (REV-1: the type does not narrow)', () => {
    for (const body of [`await redirectWithFlash('/x', {});`, `void redirectWithFlash('/x', {});`, `redirectWithFlash('/x', {});`, `const r = await redirectWithFlash('/x', {}); return r;`]) {
      const src = ACTION(`export async function a() { ${body} }`);
      expect(rules(findingsForSource(src, 'app/zzz/actions.ts')), body).toEqual(['G1b']);
    }
  });

  it('REV-10: finds the call through an import alias', () => {
    const src = `import { redirectWithFlash as fail } from '@/lib/flash';\nexport async function a() { fail('/x', {}); }`;
    expect(rules(findingsForSource(src, 'app/zzz/actions.ts'))).toEqual(['G1b']);
    const ok = `import { redirectWithFlash as fail } from '@/lib/flash';\nexport async function a() { return await fail('/x', {}); }`;
    expect(findingsForSource(ok, 'app/zzz/actions.ts')).toEqual([]);
  });

  it('REV-10: a namespace import is followed too', () => {
    const src = `import * as f from '@/lib/flash';\nexport async function a() { f.redirectWithFlash('/x', {}); }`;
    expect(rules(findingsForSource(src, 'app/zzz/actions.ts'))).toEqual(['G1b']);
  });

  it('REV-10: a call inside a local function, a local arrow, or a nested callback is flagged even when it is return-await', () => {
    const local = ACTION(`async function fail(m: string) { return await redirectWithFlash('/x', {}, { error: m }); }\nexport async function a() { return await fail('x'); }`);
    expect(rules(findingsForSource(local, 'app/zzz/actions.ts'))).toEqual(['G1b']);
    const arrow = ACTION(`const fail = async (m: string) => { return await redirectWithFlash('/x', {}, { error: m }); };\nexport async function a() { return await fail('x'); }`);
    expect(rules(findingsForSource(arrow, 'app/zzz/actions.ts'))).toEqual(['G1b']);
    const nested = ACTION(`export async function a(xs: string[]) { return xs.map(async () => { return await redirectWithFlash('/x', {}); }); }`);
    expect(rules(findingsForSource(nested, 'app/zzz/actions.ts'))).toEqual(['G1b']);
    const top = `import { redirectWithFlash } from '@/lib/flash';\nawait redirectWithFlash('/x', {});`;
    expect(rules(findingsForSource(top, 'app/zzz/actions.ts')).length).toBeGreaterThan(0);
  });

  it('REV-10: no file but lib/flash.ts may re-export it (named, renamed, local, and star)', () => {
    for (const src of [
      `export { redirectWithFlash } from '@/lib/flash';`,
      `export { redirectWithFlash as fail } from '@/lib/flash';`,
      `export * from '@/lib/flash';`,
      `import { redirectWithFlash } from '@/lib/flash';\nexport { redirectWithFlash };`,
    ]) {
      expect(rules(findingsForSource(src, 'app/zzz/actions.ts')), src).toContain('G1b');
    }
  });

  it('REV-10: an alias assignment is flagged (it would hide later calls from the guard)', () => {
    const src = ACTION(`const fail = redirectWithFlash;\nexport async function a() { return await fail('/x', {}); }`);
    expect(rules(findingsForSource(src, 'app/zzz/actions.ts'))).toContain('G1b');
  });

  it('lib/flash.ts itself is the one exempt file (it is where redirect lives)', () => {
    const src = `import { redirect } from 'next/navigation';\nexport async function redirectWithFlash(p: string, n: object) { redirect(\`\${p}?\${new URLSearchParams(n as never)}\`); }`;
    expect(findingsForSource(src, FLASH_HELPER)).toEqual([]);
    expect(rules(findingsForSource(src, 'app/zzz/actions.ts'))).toEqual(['G1a']);
  });
});

describe('G2 - a page that reads a banner or refill key gets its params from withFlash', () => {
  const page = (body: string, imports = '') => `${imports}\nexport default async function Page({ searchParams }: { searchParams: Promise<Record<string, string>> }) {\n${body}\n}`;

  it('flags sp.error read from the bare searchParams (the named mutant: treat bare as flashed)', () => {
    const f = findingsForSource(page(`const sp = await searchParams; return sp.error;`), 'app/zzz/page.tsx');
    expect(rules(f)).toEqual(['G2']);
  });

  it('flags a refill key, an element access, a destructure and a direct (await searchParams).x', () => {
    for (const body of [
      `const sp = await searchParams; return sp.refundAmount;`,
      `const sp = await searchParams; return sp['reason'];`,
      `const { error } = await searchParams; return error;`,
      `return (await searchParams).ok;`,
    ]) {
      expect(rules(findingsForSource(page(body), 'app/zzz/page.tsx')), body).toEqual(['G2']);
    }
  });

  it('clean: sp from withFlash(searchParams); and a page that reads only nav keys from bare searchParams', () => {
    const imp = `import { withFlash } from '@/lib/flash';`;
    expect(findingsForSource(page(`const sp = await withFlash(searchParams); return sp.error ?? sp.reason;`, imp), 'app/zzz/page.tsx')).toEqual([]);
    expect(findingsForSource(page(`const sp = await searchParams; return sp.store ?? sp.date;`), 'app/zzz/page.tsx')).toEqual([]);
  });

  it('only page.tsx files are subject to G2', () => {
    expect(findingsForSource(page(`const sp = await searchParams; return sp.error;`), 'app/zzz/helper.tsx')).toEqual([]);
  });
});

describe('G-tree - the real tree', () => {
  const scan = scanTree();

  it('control: the scan sees a real number of files and the census is not empty (the scan is not vacuous)', () => {
    expect(scan.filesScanned).toBeGreaterThan(300);
    expect(scan.all.length).toBeGreaterThan(0);
  });

  it('every PENDING entry (not a prefix) is a real file', () => {
    expect(scan.missingPending, `PENDING lists files that do not exist: ${scan.missingPending.join(', ')}`).toEqual([]);
  });

  it('no G1/G2 finding outside PRE_SESSION, PENDING and lib/flash.ts', () => {
    const lines = scan.violations.map((v) => `${v.rule} ${v.file}:${v.line} ${v.detail}`);
    expect(lines, `spec gap or new violation:\n${lines.join('\n')}`).toEqual([]);
  });

  it('S1a deliverable: apps/erp/src/lib/flash.ts exists (RED until the builder lands it). Census today is in the message', () => {
    const by = (r: Rule2) => scan.all.filter((f) => f.rule === r).length;
    const census = `census at this HEAD: ${scan.all.length} findings (G1a ${by('G1a')}, G1b ${by('G1b')}, G2 ${by('G2')}) in ${scan.pendingWithFindings.length} PENDING files; ${PENDING.length} PENDING entries, ${PRE_SESSION.length} PRE_SESSION`;
    // eslint-disable-next-line no-console
    console.log(`[T-380 guard] ${census}`);
    expect(existsSync(join(SRC_ROOT, 'lib', 'flash.ts')), `lib/flash.ts is missing. ${census}`).toBe(true);
  });
});

type Rule2 = 'G1a' | 'G1b' | 'G2';

describe('G3 - stale-entry check (switched on at S6)', () => {
  // S6 sets this to true and cuts PENDING down to `app/items/**`.
  const G3_ACTIVE = true;
  it.skipIf(!G3_ACTIVE)('a PENDING action or page with zero findings is red: remove its entry', () => {
    expect(scanTree().stalePending).toEqual([]);
  });

  it('exemption helper: PENDING prefix entries cover their subtree, exact entries only their file, nothing else', () => {
    const pending = ['app/zz/**', 'app/yy/page.tsx'];
    const covered = (rel: string): boolean => pending.some((p) => (p.endsWith('/**') ? rel.startsWith(p.slice(0, -2)) : p === rel));
    expect(covered('app/zz/actions.ts')).toBe(true);
    expect(covered('app/zz/[id]/page.tsx')).toBe(true);
    expect(covered('app/zzX/actions.ts')).toBe(false);
    expect(covered('app/yy/page.tsx')).toBe(true);
    expect(covered('app/yy/actions.ts')).toBe(false);
    // The real list is empty at S6: items converted, so nothing is exempt but PRE_SESSION and the helper.
    expect(PENDING).toEqual([]);
    expect(isExempt('app/items/actions.ts')).toBe(false);
    expect(isExempt('app/items/[id]/page.tsx')).toBe(false);
    expect(isExempt('app/zzz/actions.ts')).toBe(false);
    expect(isExempt('app/sign-in/actions.ts')).toBe(true);
  });
});
