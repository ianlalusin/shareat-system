import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * T-640 (security audit): `callAi` enforces switches, caps and limits but does NOT authorize the feature that calls it ("who may ask Ask ERP" is the feature's own `authorize()`).
 * So every caller of `callAi` outside packages/domain/src/ai must authorize in the same function, BEFORE the call. Today there is no caller, so the census over the real tree is
 * empty; the fixtures below prove it would catch one, and it starts guarding the day T-641 adds the first.
 */
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');
const GATES = new Set(['authorize', 'authorizeHub', 'authorizeOrgLevel', 'loadAndAuthorize', 'requirePageAccess']);

function callersWithoutGate(source: string, file: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const bad: string[] = [];
  const name = (c: ts.CallExpression): string | null => (ts.isIdentifier(c.expression) ? c.expression.text : ts.isPropertyAccessExpression(c.expression) ? c.expression.name.text : null);
  const topLevel = (n: ts.Node): ts.Node => {
    let cur = n;
    while (cur.parent && !ts.isSourceFile(cur.parent)) cur = cur.parent;
    return cur;
  };
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && name(n) === 'callAi') {
      const fn = topLevel(n);
      let gated = false;
      const scan = (m: ts.Node): void => {
        if (ts.isCallExpression(m) && GATES.has(name(m) ?? '') && m.getEnd() <= n.getStart(sf)) gated = true;
        ts.forEachChild(m, scan);
      };
      scan(fn);
      if (!gated) bad.push(`${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return bad;
}

describe('T-640 every caller of callAi authorizes first', () => {
  it('the real tree: no caller outside packages/domain/src/ai is ungated (empty until T-641 adds the first) [kills: an AI feature that asks the model before checking who may]', () => {
    const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' })
      .split('\0')
      .filter((f) => /^(apps\/[^/]+\/src|packages\/domain\/src|scripts)\/.*\.tsx?$/.test(f) && !f.startsWith('packages/domain/src/ai/') && !f.includes('/tests/'));
    const bad = files.flatMap((f) => {
      const text = readFileSync(join(ROOT, f), 'utf8');
      return text.includes('callAi(') ? callersWithoutGate(text, f) : [];
    });
    expect(bad).toEqual([]);
  });

  it('control: a caller that authorizes first passes [kills: a checker that flags everything]', () => {
    const ok = `export async function askErp(tx: Tx, actor: Actor, q: string) { await authorize(tx, actor, 'view_financial_reports', {}); return callAi(run, actor, { feature: 'ask_erp', messages: [], maxOutputTokens: 5 }); }`;
    expect(callersWithoutGate(ok, 'x.ts')).toEqual([]);
  });

  it('control: no authorize at all is caught [kills: a checker that is blind]', () => {
    const bad = `export async function askErp(tx: Tx, actor: Actor, q: string) { return callAi(run, actor, { feature: 'ask_erp', messages: [], maxOutputTokens: 5 }); }`;
    expect(callersWithoutGate(bad, 'x.ts')).toEqual(['x.ts:1']);
  });

  it('control: authorizing AFTER the call, or in another function, does not count [kills: a gate in the wrong place]', () => {
    const after = `export async function a(tx: Tx, actor: Actor) { const r = await callAi(run, actor, {}); await authorize(tx, actor, 'x', {}); return r; }`;
    expect(callersWithoutGate(after, 'y.ts')).toEqual(['y.ts:1']);
    const other = `async function gate(tx: Tx, actor: Actor) { await authorize(tx, actor, 'x', {}); }\nexport async function b(tx: Tx, actor: Actor) { return callAi(run, actor, {}); }`;
    expect(callersWithoutGate(other, 'z.ts')).toEqual(['z.ts:2']);
  });
});
