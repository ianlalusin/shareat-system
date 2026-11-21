/**
 * T-602 S3 - the per-request memo of the session and the held-capability set.
 *
 *  (1) outside a React server render `requestMemo(fn)` calls `fn` on EVERY call - no sharing across callers exists on that path.
 *  (2) with React's real `cache` replaced by a single-request, Map-backed stand-in, `heldFor` is keyed on the PERSON: two people run the loader twice and
 *      each gets their own set; the same person twice runs it once. MUTANT: key `heldFor` on `orgId` only -> red.
 *  (3) `session.ts` and `page-access.tsx` hold no module-level cache of their own (no `new Map(`, `WeakMap`, or `let` cache).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { codeOnly } from '../../../tests/unit/lib/document-facts';

const loads: string[] = [];
const SETS: Record<string, ReadonlySet<string>> = { A: new Set(['view_reports']), B: new Set(['record_sale']) };

// A stand-in for ONE request's `cache`: one Map per wrapped function, keyed on the argument list (React's cache keys on argument identity; primitives compare by value).
vi.mock('../src/lib/request-memo', () => ({
  requestMemo: <A extends unknown[], R>(fn: (...a: A) => R) => {
    const m = new Map<string, R>();
    return (...a: A): R => {
      const k = JSON.stringify(a);
      if (!m.has(k)) m.set(k, fn(...a));
      return m.get(k)!;
    };
  },
}));
vi.mock('../src/app/expenses/lib', () => ({
  withOrgPrincipal: async (_org: string, fn: (tx: unknown) => unknown) => fn({}),
}));
vi.mock('@shareat/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shareat/auth')>()),
  heldCapabilities: async (_tx: unknown, actor: { personId: string }) => {
    loads.push(actor.personId);
    return SETS[actor.personId]!;
  },
}));
vi.mock('../src/lib/session', () => ({ requireSession: async () => ({ actor: { orgId: 'org', personId: 'A' } }) }));

beforeEach(() => {
  loads.length = 0;
});

describe('T-602 S3 - request memo', () => {
  it('(1) outside a render the real requestMemo calls the function every time', async () => {
    const { requestMemo } = await vi.importActual<typeof import('../src/lib/request-memo')>('../src/lib/request-memo');
    let n = 0;
    const f = requestMemo(async (x: string) => `${x}${++n}`);
    expect(await f('a')).toBe('a1');
    expect(await f('a')).toBe('a2');
    expect(n).toBe(2);
  });

  it('(2) heldFor is keyed on the person: A then B loads twice with each own set; A twice loads once', { timeout: 30_000 }, async () => {
    const { heldFor } = await import('../src/lib/page-access');
    expect([...(await heldFor('org', 'A'))]).toEqual(['view_reports']);
    expect([...(await heldFor('org', 'B'))]).toEqual(['record_sale']);
    expect(loads).toEqual(['A', 'B']);
    await heldFor('org', 'A');
    expect(loads, 'the same person in the same request is read once').toEqual(['A', 'B']);
  });

  it('(3) no module-level cache in session.ts or page-access.tsx', () => {
    for (const f of ['src/lib/session.ts', 'src/lib/page-access.tsx']) {
      const code = codeOnly(readFileSync(join(__dirname, '..', f), 'utf8'));
      expect(code, f).not.toMatch(/new\s+(Weak)?Map\s*\(/);
      expect(code, f).not.toMatch(/^let\s/m);
    }
  });
});
