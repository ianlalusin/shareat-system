/**
 * T-375 S5 (S5-lite), G5 - the daily POS usage pull never calls POS. `docs/tasks/375-pos-v1-day-feed.md` S5 test G5.
 *
 * TESTER, not BUILDER. Pure `fs`. `packages/domain/src/pos/usage-pull.ts` (comments stripped, so prose that names
 * the old design cannot trip it and code that revives it cannot hide in a comment) must contain:
 *  - no `fetch(` call;
 *  - no `@shareat/core/env` import (the only reason the file ever read the environment was the live POS fetch);
 *  - no `fetchPosV1Day` (the import's fetcher; usage reads the stored feed);
 *  - no `POS_API_URL`.
 *
 * ## Why it is red on HEAD
 * HEAD's `usage-pull.ts` defines `fetchPosSoldItemsLive` (a `fetch(` call, `POS_API_URL` read through `env()`), and
 * imports `env` from `@shareat/core/env`.
 *
 * ## Positive controls
 * The scanners are run on fixture strings first: a scanner that flags nothing would pass the real rule vacuously. A
 * comment that only MENTIONS the old design is NOT flagged (so the stripping is deliberate, and proven).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const TARGET = 'packages/domain/src/pos/usage-pull.ts';

/** Drops block comments and whole-line / trailing `//` comments. A `//` inside a string (a URL) is kept: it must be
 *  preceded by whitespace or start of line to count as a comment. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

const callsFetch = (code: string) => /(^|[^\w$.])fetch\s*\(/.test(code) || /\bglobalThis\.fetch\b/.test(code);
const importsEnv = (code: string) => /from\s+['"]@shareat\/core\/env['"]/.test(code);
const namesFeedFetcher = (code: string) => /\bfetchPosV1Day\b/.test(code);
const namesPosUrl = (code: string) => /\bPOS_API_URL\b/.test(code);

describe('G5 scanners (positive controls)', () => {
  it('flag a live fetch call, an env import, the feed fetcher and POS_API_URL in code', () => {
    expect(callsFetch('const res = await fetch(`${url}/x`);')).toBe(true);
    expect(callsFetch('  fetch(url)')).toBe(true);
    expect(importsEnv("import { env } from '@shareat/core/env';")).toBe(true);
    expect(namesFeedFetcher('await fetchPosV1Day({ posStoreId })')).toBe(true);
    expect(namesPosUrl('const { POS_API_URL } = env();')).toBe(true);
  });

  it('do not flag a comment that merely names them, nor a longer identifier', () => {
    const prose = ['// it used to call fetch( and read POS_API_URL', '/* import { env } from "@shareat/core/env"; fetchPosV1Day */', 'const x = 1;'].join('\n');
    const code = stripComments(prose);
    expect(callsFetch(code)).toBe(false);
    expect(importsEnv(code)).toBe(false);
    expect(namesFeedFetcher(code)).toBe(false);
    expect(namesPosUrl(code)).toBe(false);
    expect(callsFetch('const refetch = prefetch(1); obj.fetchSnapshot(x)')).toBe(false);
  });

  it('a URL inside a string is not mistaken for a comment', () => {
    expect(stripComments("const u = 'http://x/fetch(1)';")).toContain('fetch(1)');
  });
});

describe('G5 - usage-pull.ts never calls POS', () => {
  const exists = existsSync(path.join(repoRoot, TARGET));
  const code = exists ? stripComments(readFileSync(path.join(repoRoot, TARGET), 'utf8')) : '';

  it('the file exists (control: the scan is not vacuous)', () => {
    expect(exists).toBe(true);
    expect(code.length).toBeGreaterThan(1000);
    expect(code).toContain('buildPlan');
  });

  it('contains no fetch( call', () => expect(callsFetch(code)).toBe(false));
  it('imports nothing from @shareat/core/env', () => expect(importsEnv(code)).toBe(false));
  it('does not name fetchPosV1Day', () => expect(namesFeedFetcher(code)).toBe(false));
  it('does not name POS_API_URL', () => expect(namesPosUrl(code)).toBe(false));
});
