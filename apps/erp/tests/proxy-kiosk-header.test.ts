/**
 * DEF-233 / T-246 — `proxy.ts`'s matcher stays scoped to exactly the kiosk route.
 *
 * ⚠️ Reads `proxy.ts` as TEXT rather than importing it: the file imports `next/server`, which this
 * project's plain Vitest unit project has no established contract for (no existing test imports
 * it — checked). Importing it to guard one string literal risks an edge-runtime shim mismatch for
 * zero benefit, when the thing actually worth guarding — the matcher didn't silently drift to cover
 * fewer or more routes — is fully checkable from the source text (same reasoning as T-243's
 * `readiness-remedy-routes.test.ts`).
 *
 * Without this guard, a proxy that quietly widens to match every route pays a per-request cost on
 * all 101 routes to fix one, or a narrowed matcher stops protecting `/clock` at all — either way
 * silent, because nothing renders differently until someone happens to look.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const proxySourcePath = resolve(here, '..', 'src', 'proxy.ts');
const proxySource = readFileSync(proxySourcePath, 'utf8');

function extractMatcher(source: string): string[] {
  const block = source.match(/matcher:\s*\[([\s\S]*?)\]/);
  if (!block) {
    throw new Error('config.matcher not found in proxy.ts — did it move or get renamed?');
  }
  return [...block[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

describe('proxy.ts — the matcher stays scoped to the kiosk route', () => {
  const matcher = extractMatcher(proxySource);

  it('known hit printed first: the source names /clock at all', () => {
    expect(proxySource).toContain('/clock');
  });

  it('matches exactly ["/clock", "/clock/:path*"] — no more, no fewer', () => {
    expect(matcher).toEqual(['/clock', '/clock/:path*']);
  });

  it('⛔ the control: does NOT match every route', () => {
    expect(matcher).not.toContain('/');
    expect(matcher).not.toContain('/:path*');
    expect(matcher).not.toContain('/((?!api|_next).*)');
  });
});
