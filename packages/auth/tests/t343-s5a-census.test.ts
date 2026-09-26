/**
 * T-343 S5a — K1: census of `packages/auth/src`, via the REAL S5.0 scanner
 * (`tests/unit/lib/throw-census.ts`) rather than a hand-rolled regex — same discipline the scanner
 * itself was built to replace S3's regex with. `docs/tasks/343-def-417-human-readable-refusals.md`
 * §S5a.
 *
 * ⛔ TESTER, not BUILDER — measured BEFORE this file existed by running the scanner over
 * `packages/auth/src`: 7 raw `throw new Error(`, 11 two-arg `new AuthorizationError(`, and exactly
 * 5 id/key/derived first arguments (`roles.ts:367,393,447,586`, `credentials-admin.ts:45`) — the
 * doc's own "five, not four" note, confirmed by measurement, not assumed.
 *
 * The allowlist below is keyed by each site's exact classified TEXT (never file:line — S5a edits
 * lines around every one of these), captured verbatim from that measurement, including the ONE
 * entry (`roles.ts:447`) the scanner's own 320-character `firstLine` truncation cuts off mid-word —
 * that truncated form is exactly what `censusTree` will produce again here, so the allowlist must
 * match it exactly, not the full source sentence.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { censusTree } from '../../../tests/unit/lib/throw-census';

const AUTH_SRC = join(import.meta.dirname, '..', 'src');

/** K4/Invariant 1 pin these five raw messages byte-identical — exempt from the first-argument rule
 *  only (R2 ruling 1, folded into K1 by R4.2). The 3-arg rule still applies to every one of them. */
const ALLOWLIST: ReadonlySet<string> = new Set([
  "`assignRoleAsActor: person ${input.personId} does not exist in org ${actor.orgId}`",
  "`assignRoleAsActor: assigning '${input.role}' requires super_admin — the role itself, or an ` + `admin holding every capability super_admin has and admin does not (bible row 116 — only ` + `a super-admin appoints an admin); actor holds '${actorRole?.role ?? 'no role'}'`",
  "`assignRoleAsActor: refusing to change this person's role — they hold ` + `'${targetRole.role}', which outranks you. This change needs somebody who is at least a ` + `'${targetRole.role}' themselves (the role, or an admin holding every capability ` + `super_admin has and admin does not). If nobody in this organisation ",
  "`grantCapabilityAsActor: person ${input.personId} does not exist in org ${actor.orgId}`",
  "`person ${personId} does not exist in org ${actor.orgId}`",
]);

/** Mirrors `throw-census.ts`'s own private `collectTsFiles` — not exported, so copied rather than
 *  reached into (same posture `t343-authorize-census.test.ts` takes toward its own `codeOnly`). */
function collectTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'tests' || entry.name === '.next') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectTsFiles(full, out);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

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

/**
 * Every `new AuthorizationError(...)` call's real argument count, via the TypeScript AST — never a
 * hand-rolled character scanner. ⚠️ A text-based comma-counter was tried first and is WRONG twice
 * over: it cannot tell a comma inside a string literal ("...role — ask another admin, so a mistake
 * ...") from a real argument separator, and Prettier's trailing comma after the last argument of a
 * multi-line call (confirmed in `authorize.ts`: `otherOrg(capability),\n      )`) over-counts by
 * one. The AST already knows exactly where each argument boundary is.
 */
function authorizationErrorArgCounts(fileLabel: string, sourceText: string): { line: number; argCount: number }[] {
  const sourceFile = ts.createSourceFile(fileLabel, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const hits: { line: number; argCount: number }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'AuthorizationError') {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      hits.push({ line, argCount: node.arguments?.length ?? 0 });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return hits;
}

describe('K1 — census: packages/auth/src, via the real S5.0 scanner', () => {
  const sites = censusTree(AUTH_SRC);

  it('zero raw `throw new Error(` sites', () => {
    const rawErrors = sites.filter((s) => s.callee === 'Error').map((s) => `${s.file.split('/').slice(-1)[0]}:${s.line}`);
    expect(rawErrors).toEqual([]);
  });

  it('every `new AuthorizationError(` call has exactly 3 arguments', () => {
    const files = collectTsFiles(AUTH_SRC);
    const offenders: string[] = [];
    for (const file of files) {
      const hits = authorizationErrorArgCounts(file, readFileSync(file, 'utf8'));
      for (const hit of hits) {
        if (hit.argCount !== 3) offenders.push(`${file.split(/[\\/]/).slice(-1)[0]}:${hit.line}: ${hit.argCount} arg(s)`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no id/key/derived first argument on any `throw new <X>(`, except the 5-entry allowlist', () => {
    // Scoped to S5a's own BUILDER files (roles.ts, credentials-admin.ts) — NOT the whole tree.
    // `authorize.ts`'s raw diagnostics are PERMANENTLY id-shaped by design (S2's own choice: the raw
    // stays exact for logs, only the third `userMessage` argument is sanitised) and already has its
    // own dedicated invariant, `t343-authorize-census.test.ts`'s T5 ("every 3rd arg is a refusal-text
    // call"). Re-flagging it here would contradict a working, already-tested design, and the doc's
    // own predicted allowlist ("five, not four") counts only roles.ts/credentials-admin.ts sites —
    // confirming this is the intended scope, not an oversight.
    const s5aFiles = new Set(['roles.ts', 'credentials-admin.ts']);
    const offenders = sites
      .filter((s) => s5aFiles.has(s.file.split('/').slice(-1)[0]!))
      .filter((s) => (s.kind === 'id' || s.kind === 'key' || s.kind === 'derived') && !ALLOWLIST.has(s.text))
      .map((s) => `${s.file.split('/').slice(-1)[0]}:${s.line} [${s.kind}] ${s.text}`);
    expect(offenders).toEqual([]);
  });

  it('no `new RefusalError(` in packages/auth/src (R1.5 — production code calls refuse/gone)', () => {
    const files = collectTsFiles(AUTH_SRC);
    const offenders: string[] = [];
    for (const file of files) {
      if (codeOnly(readFileSync(file, 'utf8')).includes('new RefusalError(')) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('sanity: the allowlist itself is exactly the 5 sites measured (not a subset that hides a 6th)', () => {
    const allowlisted = sites.filter((s) => (s.kind === 'id' || s.kind === 'key' || s.kind === 'derived') && ALLOWLIST.has(s.text));
    expect(allowlisted).toHaveLength(5);
  });
});
