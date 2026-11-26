/**
 * T-496 - no app build may download fonts from Google (T-588: apps/pos is gone; the apps with a src tree are erp and customer). `next/font/google` fetches
 * at build time and CI failed three times when that fetch flaked. Fonts must load through
 * `next/font/local` from files committed in the repo, with the same families and CSS variables.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|jsx|mjs|css)$/.test(name)) out.push(p);
  }
  return out;
}

// Every app with a src tree is scanned, so a new app cannot slip a Google font in unnoticed.
const apps = readdirSync(join(root, 'apps')).filter((a) => existsSync(join(root, 'apps', a, 'src')));
// Apps that load fonts themselves, with the families and CSS variables they must keep. An app not listed here (customer) uses system fonts and loads none.
const expected = {
  erp: [
    { variable: '--font-display', family: 'baloo' },
    { variable: '--font-body', family: 'jakarta' },
  ],
} as const;
const fontApps = Object.keys(expected) as Array<keyof typeof expected>;
const GOOGLE_FONT = /from\s+['"]next\/font\/google['"]|require\(\s*['"]next\/font\/google['"]|fonts\.googleapis\.com|fonts\.gstatic\.com/;

const layoutOf = (app: string) => join(root, 'apps', app, 'src', 'app', 'layout.tsx');

/** Each `localFont({...})` / `local({...})` call body, from the opening paren to the next call. */
function localFontBlocks(source: string): string[] {
  const parts = source.split(/(?:localFont|local)\s*\(\s*\{/).slice(1);
  return parts.map((p) => p.split(/\n\}\s*\)/)[0] ?? p);
}

describe('T-496 - no Google font fetch at build time', () => {
  it('non-vacuity: erp and customer are both scanned, each with its layout and real source files; the pattern fires on a Google font', () => {
    expect(apps).toEqual(expect.arrayContaining(['erp', 'customer']));
    expect(apps).not.toContain('pos');
    for (const app of apps) {
      const files = walk(join(root, 'apps', app, 'src')).map((f) => f.split(sep).join('/'));
      expect(files.length, `${app}: the scan found no files`).toBeGreaterThan(10);
      expect(files.some((f) => f.endsWith(`apps/${app}/src/app/layout.tsx`)), `${app}: no layout`).toBe(true);
    }
    expect(GOOGLE_FONT.test("import { Inter } from 'next/font/google';")).toBe(true);
    expect(GOOGLE_FONT.test('@import url(https://fonts.googleapis.com/css2?family=Inter);')).toBe(true);
    expect(GOOGLE_FONT.test("import localFont from 'next/font/local';")).toBe(false);
  }, 30000);

  it('(1) no file under apps/*/src imports next/font/google or links fonts.googleapis.com / fonts.gstatic.com', () => {
    const offenders: string[] = [];
    for (const app of apps) {
      for (const f of walk(join(root, 'apps', app, 'src'))) {
        if (GOOGLE_FONT.test(readFileSync(f, 'utf8'))) offenders.push(f.slice(root.length + 1).split(sep).join('/'));
      }
    }
    expect(offenders).toEqual([]);
  }, 30000);

  for (const app of fontApps) {
    describe(`${app} layout`, () => {
      const source = existsSync(layoutOf(app)) ? readFileSync(layoutOf(app), 'utf8') : '';

      it('(2) loads fonts via next/font/local from files that exist', () => {
        expect(source).toMatch(/from\s+['"]next\/font\/local['"]/);
        const blocks = localFontBlocks(source);
        expect(source.length, `${app}: layout missing`).toBeGreaterThan(0);
        expect(blocks.length).toBeGreaterThanOrEqual(expected[app].length);
        const srcs = [...source.matchAll(/(?:src|path)\s*:\s*['"]([^'"]+\.(?:woff2?|ttf|otf))['"]/g)].map((m) => m[1]!);
        expect(srcs.length).toBeGreaterThan(0);
        for (const s of srcs) {
          // next/font/local resolves `src` relative to the file that calls it.
          expect(existsSync(resolve(dirname(layoutOf(app)), s)), `missing font file ${s}`).toBe(true);
        }
      });

      it('(3) keeps the same families and CSS variables', () => {
        const blocks = localFontBlocks(source);
        for (const { variable, family } of expected[app]) {
          const block = blocks.find((b) => b.includes(`'${variable}'`) || b.includes(`"${variable}"`));
          expect(block, `no local font declares ${variable}`).toBeDefined();
          const files = [...(block ?? '').matchAll(/['"]([^'"]+\.(?:woff2?|ttf|otf))['"]/g)].map((m) => m[1]!.toLowerCase());
          expect(files.length).toBeGreaterThan(0);
          for (const f of files) expect(f, `${variable} must use ${family} files`).toContain(family);
        }
      });
    });
  }
});
