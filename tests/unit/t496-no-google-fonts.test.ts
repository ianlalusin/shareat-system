/**
 * T-496 - the ERP and POS builds must not download fonts from Google. `next/font/google` fetches
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
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

const apps = ['erp', 'pos'] as const;
const expected = {
  erp: [
    { variable: '--font-display', family: 'baloo' },
    { variable: '--font-body', family: 'jakarta' },
  ],
  pos: [
    { variable: '--font-sans', family: 'poppins' },
    { variable: '--font-serif', family: 'baloo' },
  ],
} as const;

const layoutOf = (app: string) => join(root, 'apps', app, 'src', 'app', 'layout.tsx');

/** Each `localFont({...})` / `local({...})` call body, from the opening paren to the next call. */
function localFontBlocks(source: string): string[] {
  const parts = source.split(/(?:localFont|local)\s*\(\s*\{/).slice(1);
  return parts.map((p) => p.split(/\n\}\s*\)/)[0] ?? p);
}

describe('T-496 - no Google font fetch at build time', () => {
  it('non-vacuity: the scan sees both app layouts', () => {
    const files = walk(join(root, 'apps')).map((f) => f.split(sep).join('/'));
    for (const app of apps) {
      expect(files.some((f) => f.endsWith(`apps/${app}/src/app/layout.tsx`))).toBe(true);
    }
  }, 30000);

  it('(1) no file under apps/*/src imports next/font/google', () => {
    const offenders: string[] = [];
    for (const app of apps) {
      for (const f of walk(join(root, 'apps', app, 'src'))) {
        if (/from\s+['"]next\/font\/google['"]|require\(\s*['"]next\/font\/google['"]/.test(readFileSync(f, 'utf8'))) {
          offenders.push(f.slice(root.length + 1).split(sep).join('/'));
        }
      }
    }
    expect(offenders).toEqual([]);
  }, 30000);

  for (const app of apps) {
    describe(`${app} layout`, () => {
      const source = existsSync(layoutOf(app)) ? readFileSync(layoutOf(app), 'utf8') : '';

      it('(2) loads fonts via next/font/local from files that exist', () => {
        expect(source).toMatch(/from\s+['"]next\/font\/local['"]/);
        const blocks = localFontBlocks(source);
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
