import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * T-402 S2, audit ruling A2 / test T3 - no render probe or fallback check may use the LOGGING gate.
 * `authorize()` writes a `security.authorize_denied` event on every refusal, so a page that asks "may I show this link?"
 * by calling `authorize()` and catching `AuthorizationError` would log an attack that never happened. Those sites use
 * `can()` (no write). A real gate (the refusal propagates, or is mapped to an error message) keeps `authorize()`.
 *
 * The guard scans `apps/erp/src` and `packages/domain/src` for a `catch` that tests `instanceof AuthorizationError`
 * and then RETURNS A BOOLEAN or CALLS `authorize(` AGAIN (a try-A-then-fall-back-to-B check), and for the promise
 * forms `authorize(...).then(() => true, ...)` / `.catch(() => false)`. A bare `catch { return false }` after an
 * `authorize(` in its try block counts too. The allow-list must stay EMPTY. *Mutant: one probe restored.*
 *
 * The scanner is exported-by-construction (a plain function in this file) and proved on synthetic sources below, so a
 * green run means the scan can see a probe, not that it looks at nothing.
 */
const ROOT = resolve(__dirname, '..', '..', '..');
const SCAN_DIRS = ['apps/erp/src', 'packages/domain/src'];
/** Must stay empty (ruling A2): a site that needs the logging gate AND swallows the refusal is a design question, not a list entry. */
const ALLOW: readonly string[] = [];

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) files(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(p);
  }
  return out;
}

/** The balanced `{ ... }` block starting at the first `{` at or after `from`. */
function block(text: string, from: number): { body: string; start: number } | null {
  const open = text.indexOf('{', from);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return { body: text.slice(open + 1, i), start: open };
  }
  return null;
}

/** Every probe-shaped site in one source text: `[line, why]`. */
export function probeSites(text: string): Array<[number, string]> {
  const out: Array<[number, string]> = [];
  const lineOf = (idx: number) => text.slice(0, idx).split('\n').length;
  const catches = [...text.matchAll(/\bcatch\s*(?:\([^)]*\))?\s*\{/g)];
  for (const m of catches) {
    const b = block(text, m.index!);
    if (!b) continue;
    const tests = /instanceof\s+AuthorizationError/.test(b.body);
    const returnsBool = /\breturn\s+(?:true|false)\b/.test(b.body) || /=>\s*(?:true|false)\b/.test(b.body);
    const callsAuthorizeAgain = /\bauthorize\s*\(/.test(b.body);
    // the try block before this catch (the nearest preceding `try {`)
    const tryAt = text.lastIndexOf('try', m.index!);
    const tryBlock = tryAt >= 0 ? (block(text, tryAt)?.body ?? '') : '';
    const triedAuthorize = /\bauthorize\s*\(/.test(tryBlock);
    if (tests && (returnsBool || callsAuthorizeAgain)) out.push([lineOf(m.index!), 'catch tests AuthorizationError then returns a boolean / calls authorize() again']);
    else if (!tests && triedAuthorize && returnsBool) out.push([lineOf(m.index!), 'catch after authorize() returns a boolean']);
  }
  for (const m of text.matchAll(/\bauthorize\s*\([^;]*?\)\s*\.(?:then\s*\(\s*\(\s*\)\s*=>\s*true|catch\s*\(\s*(?:\([^)]*\)|\w*)\s*=>\s*(?:false|\{?\s*return\s+false))/g)) {
    out.push([lineOf(m.index!), 'authorize().then/catch used as a yes/no']);
  }
  return out;
}

describe('T-402 S2 A2 - the scanner can see a probe (synthetic sources)', () => {
  it('flags try { authorize } catch { instanceof -> return false }', () => {
    const src = `async function can2(tx){ try { await authorize(tx, a, 'x'); return true; } catch (e) { if (e instanceof AuthorizationError) return false; throw e; } }`;
    expect(probeSites(src)).toHaveLength(1);
  });
  it('flags try-A-then-fall-back-to-B (catch calls authorize again)', () => {
    const src = `async function f(tx){ try { await authorize(tx, a, 'a'); } catch (e) { if (e instanceof AuthorizationError) { await authorize(tx, a, 'b'); } else throw e; } }`;
    expect(probeSites(src)).toHaveLength(1);
  });
  it('flags the promise forms', () => {
    expect(probeSites(`const ok = await authorize(tx, a, 'x').then(() => true, () => false);`)).toHaveLength(1);
    expect(probeSites(`const ok = await authorize(tx, a, 'x').then(() => true).catch(() => false);`).length).toBeGreaterThan(0);
  });
  it('does NOT flag an error mapping or a plain rethrow (a real gate)', () => {
    const src = `async function g(tx){ try { await authorize(tx, a, 'x'); return doIt(); } catch (e) { if (e instanceof AuthorizationError) { return { error: e.userReason }; } throw e; } }`;
    expect(probeSites(src)).toHaveLength(0);
    expect(probeSites(`catch (e) { if (e instanceof AuthorizationError) throw e; return handle(e); }`)).toHaveLength(0);
  });
});

describe('T-402 S2 A2 (T3) - no probe uses the logging gate', () => {
  it('the allow-list stays empty', () => {
    expect(ALLOW).toEqual([]);
  });

  it('apps/erp/src and packages/domain/src hold no catch-and-boolean / catch-and-authorize-again site, and no authorize().then(() => true)', () => {
    const all = SCAN_DIRS.flatMap((d) => files(join(ROOT, d)));
    expect(all.length, 'the scan reads real files').toBeGreaterThan(100);
    const found: string[] = [];
    for (const f of all) {
      const rel = relative(ROOT, f).split('\\').join('/');
      for (const [line, why] of probeSites(readFileSync(f, 'utf8'))) {
        if (!ALLOW.includes(`${rel}:${line}`)) found.push(`${rel}:${line} - ${why}`);
      }
    }
    expect(found, 'switch each of these to can(); a real gate keeps authorize()').toEqual([]);
  });
});
