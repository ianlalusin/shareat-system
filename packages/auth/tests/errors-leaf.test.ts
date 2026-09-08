/**
 * `@shareat/auth/errors` — the leaf, and the two things that make it worth having.
 *
 * ## ⛔ 1. ONE class object, not two
 *
 * The classes MOVED and their old homes RE-EXPORT them. If either `sessions.ts` or `authorize.ts`
 * ever re-declares one instead, there would be two class objects sharing a name, and every
 * `instanceof` across the app would quietly return `false` — `apps/erp`'s pre-session policies
 * decide what to show a visitor with exactly that check, so both would start masking every error
 * with no test of their own failing. This asserts the identity rather than the name.
 *
 * ## ⭐ 2. The leaf must stay a leaf
 *
 * The point of the file is that an app can reach the error classes without pulling `@shareat/db`.
 * That is a property of its transitive imports, so it is checked as one — a timing assertion would
 * flake, and a comment would rot.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { AuthenticationError as BarrelAuthn, AuthorizationError as BarrelAuthz } from '@shareat/auth';
import { AuthenticationError as LeafAuthn, AuthorizationError as LeafAuthz } from '@shareat/auth/errors';
import { AuthenticationError as SessionsAuthn } from '../src/sessions';
import { AuthorizationError as AuthorizeAuthz } from '../src/authorize';

describe('the error classes are one object each, whichever door you come through', () => {
  it('⛔ barrel, leaf and original module all give the SAME class', () => {
    expect(LeafAuthn).toBe(BarrelAuthn);
    expect(LeafAuthn).toBe(SessionsAuthn);
    expect(LeafAuthz).toBe(BarrelAuthz);
    expect(LeafAuthz).toBe(AuthorizeAuthz);
  });

  it('⛔ and instanceof holds across the doors — the check every caller actually writes', () => {
    // The non-zero control for the assertion above: two distinct classes would pass a `.name`
    // comparison and fail this one, which is the failure that would reach production.
    const authn = new SessionsAuthn('nope');
    expect(authn instanceof LeafAuthn).toBe(true);
    expect(authn instanceof BarrelAuthn).toBe(true);

    const authz = new AuthorizeAuthz('nope', 'manage_users');
    expect(authz instanceof LeafAuthz).toBe(true);
    expect(authz.capability).toBe('manage_users');
    expect(authz instanceof LeafAuthn).toBe(false);
  });
});

describe('the leaf stays a leaf', () => {
  /**
   * ⚠️ Comments are stripped BEFORE anything is matched, and the first version of this test did not
   * — it reported five reachable files and four packages, every one of them a doc comment citing an
   * import the file does not make. `tests/unit/no-direct-transaction-in-erp.test.ts` records the same
   * trap in its own words: *"comments describe the hazard; they do not commit it"*, and a guard that
   * fires on prose is a guard somebody eventually deletes.
   */
  function codeOnly(src: string): string {
    const withoutBlocks = src.replace(/\/\*[\s\S]*?\*\//g, '');
    return withoutBlocks
      .split('\n')
      .map((line) => {
        const idx = line.indexOf('//');
        return idx === -1 ? line : line.slice(0, idx);
      })
      .join('\n');
  }

  function specifiersIn(file: string): string[] {
    const src = codeOnly(readFileSync(file, 'utf8'));
    return [...src.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
  }

  /** Every file reachable from an entry point by a relative import, transitively. */
  function transitiveFiles(entry: string): string[] {
    const seen = new Set<string>();
    const queue = [resolve(entry)];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file) || !existsSync(file)) continue;
      seen.add(file);
      for (const spec of specifiersIn(file)) {
        if (!spec.startsWith('.')) continue; // a package, not a file — counted below
        const base = join(dirname(file), spec);
        queue.push(base.endsWith('.ts') ? base : `${base}.ts`);
      }
    }
    return [...seen];
  }

  /** Every non-relative specifier reachable from an entry point. */
  function packageImports(entry: string): string[] {
    const out = new Set<string>();
    for (const file of transitiveFiles(entry)) {
      for (const spec of specifiersIn(file)) {
        if (!spec.startsWith('.')) out.add(spec);
      }
    }
    return [...out];
  }

  const entry = join(import.meta.dirname, '..', 'src', 'errors.ts');

  it('reaches exactly two files — itself and capabilities.ts, which imports nothing', () => {
    const files = transitiveFiles(entry).map((f) => f.replace(/\\/g, '/'));
    expect(files).toHaveLength(2);
    expect(files.some((f) => f.endsWith('/src/errors.ts'))).toBe(true);
    expect(files.some((f) => f.endsWith('/src/capabilities.ts'))).toBe(true);
  });

  it('⛔ pulls NO package at all — @shareat/db above all', () => {
    expect(packageImports(entry)).toEqual([]);
  });

  it('the control: the barrel DOES pull @shareat/db, so the check above is not vacuous', () => {
    // If this ever went empty, the walker would be broken and the assertion above would be
    // meaningless — a sweep needs a known non-zero hit before its zero means anything.
    expect(packageImports(join(import.meta.dirname, '..', 'src', 'index.ts'))).toContain('@shareat/db');
  });
});
