/**
 * T-187 slice 2 — WIRING GUARDS for the service-charge distribution screen's server action.
 *
 * ⭐ Why this file exists at all: `domain-actions-have-callers` and `production-caller-ratchet`
 * (tests/unit/domain-actions-have-callers.test.ts) exist because five tasks shipped "done" with a
 * domain function nothing under `apps/` ever called — DEF-129/135/136/137/147. A domain-layer
 * integration test proves `distributeServiceCharge` is CORRECT; it cannot prove anything about the
 * screen that is supposed to call it. This file is that other half, in the same idiom
 * `apps/erp/tests/remittance-overage-wiring.test.ts` established: `page.tsx`/`actions.ts` are
 * server components / server actions, awkward to exercise directly, so this reads the real source
 * and asserts STRUCTURAL properties of it rather than rendering anything.
 *
 * ⚠️ Until the screen exists (`apps/erp/src/app/service-charge/{page,actions,lib}` — not this
 * lane's to create), the `readFileSync` below throws and every test in this file reports that same
 * root cause. That is an import/read failure, not an assertion failure — the same distinction
 * `service-charge-distribution.test.ts`'s A-D groups draw against `packages/domain/src/service-
 * charge/` not existing yet, and it resolves the same way: once the file exists, these assertions
 * run against its real text.
 *
 * WHAT THIS PROVES, one describe block per ask:
 *   (a) the action exists and REACHES `distributeServiceCharge` — a real call, not merely an
 *       unused import, using the AMENDMENT 1 signature `(tx, actor, input)`.
 *   (b) ⭐ THE HIGHEST-VALUE CASE — the action does not re-implement the cap or the store check.
 *       `liabilities/actions.ts`'s own header states the rule this whole file exists to enforce
 *       here: "the gates live in the services, not here." A second copy of invariant 1 (the cap:
 *       sum 2160 credits minus debits, scoped to journal_lines.store_id) or invariant 4 (the money
 *       account belongs to the paying store: money_accounts) would be a second source of truth
 *       that can drift from the domain's (RULES §6.3) — so this checks for the ABSENCE of the
 *       literals a re-implementation would need, not the presence of a particular refusal.
 *   (c) a refusal reaches the operator carrying whatever the domain threw (the store and the
 *       shortfall, per `service-charge-distribution.test.ts`'s invariant-2 case), rather than being
 *       swallowed into a generic message — the same `errorMessage(err)` convention every other
 *       action in this app already uses (181 occurrences across 50 files, checked before relying
 *       on it, including `catch (err)` being the ONLY spelling anywhere under apps/erp/src/app).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const actionsPath = resolve(here, '..', 'src', 'app', 'service-charge', 'actions.ts');
const actionsSource = readFileSync(actionsPath, 'utf8');

/**
 * From just after an opening bracket at `openIdx`, scans to its match, skipping characters inside
 * line comments, block comments, and `'...'`/`"..."`/`` `...` `` literals — same discipline as
 * `remittance-overage-wiring.test.ts`'s identically-purposed helpers, duplicated rather than
 * imported (this file has no sibling module to share one with, and every wiring-guard file in this
 * suite is self-contained by the same precedent). Parametrized over the bracket pair so one
 * function covers both `(...)` and `{...}` rather than two near-duplicates.
 */
function scanToMatching(source: string, openIdx: number, openCh: string, closeCh: string): number {
  let depth = 1;
  let i = openIdx + 1;
  for (; i < source.length && depth > 0; i++) {
    const c = source[i];
    if (c === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i);
      i = end === -1 ? source.length : end;
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 1;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (c === openCh) depth++;
    else if (c === closeCh) depth--;
  }
  return i;
}
const scanToMatchingParen = (source: string, openIdx: number) => scanToMatching(source, openIdx, '(', ')');
const scanToMatchingBrace = (source: string, openIdx: number) => scanToMatching(source, openIdx, '{', '}');

/**
 * Finds the body of the exported server action whose body contains `needle`. Every action in this
 * app (207 occurrences checked across apps/erp/src/app) is `export async function
 * NameAction(formData: FormData): Promise<void> { ... }` — never an arrow function — so that is
 * the one shape this looks for, rather than guessing the new screen's action name.
 */
function findActionContaining(source: string, needle: string): { name: string; body: string } | null {
  const fnRe = /export async function (\w+)\(/g;
  let m: RegExpExecArray | null;
  while ((m = fnRe.exec(source)) !== null) {
    const name = m[1]!;
    const openParenIdx = fnRe.lastIndex - 1;
    const afterParen = scanToMatchingParen(source, openParenIdx);
    const openBraceIdx = source.indexOf('{', afterParen);
    if (openBraceIdx === -1) continue;
    const bodyEnd = scanToMatchingBrace(source, openBraceIdx);
    const body = source.slice(openBraceIdx + 1, bodyEnd - 1);
    if (body.includes(needle)) return { name, body };
  }
  return null;
}

/** The first `catch (...) { ... }` block's contents within `body`. */
function extractCatchBlock(body: string): string | null {
  const catchMatch = body.match(/catch\s*\([^)]*\)\s*\{/);
  if (!catchMatch || catchMatch.index === undefined) return null;
  const openBraceIdx = catchMatch.index + catchMatch[0].length - 1;
  const end = scanToMatchingBrace(body, openBraceIdx);
  return body.slice(openBraceIdx + 1, end - 1);
}

describe('T-187 slice 2 — WIRING GUARD (a): the action reaches the real domain function', () => {
  it('actions.ts: imports distributeServiceCharge from the domain layer, not a local reimplementation', () => {
    // ⚠️ Either the bare barrel OR a subpath (e.g. '@shareat/domain/service-charge') — both are
    // established in this codebase (vitest.config.mts aliases '@shareat/domain/money-lines' and
    // '@shareat/domain/money-input' the same way) and a subpath import is in fact the RIGHT choice
    // here: the barrel is the orchestrator's alone to wire (§8), so an action reaching the domain
    // function without editing it is respecting that boundary, not a defect in the wiring.
    expect(actionsSource).toMatch(
      /import\s*\{[^}]*\bdistributeServiceCharge\b[^}]*\}\s*from\s*['"]@shareat\/domain(\/[\w-]+)?['"]/,
    );
  });

  it('actions.ts: an exported action CALLS distributeServiceCharge(tx, actor, — the AMENDMENT 1 signature', () => {
    const found = findActionContaining(actionsSource, 'distributeServiceCharge(');
    expect(found, 'no exported action function calls distributeServiceCharge(...)').not.toBeNull();
    // The call itself, not merely the import: proves the action REACHES the domain function, with
    // the (tx, actor, input) signature AMENDMENT 1 ruled — a bare orgId here would be the same
    // defect the amendment corrected, one layer up.
    expect(found!.body).toMatch(/distributeServiceCharge\(\s*tx\s*,\s*actor\s*,/);
  });
});

describe('T-187 slice 2 — WIRING GUARD (b): the action does not re-implement the cap or the store check (RULES §6.3)', () => {
  it('⭐ THE HIGHEST-VALUE CASE — actions.ts never touches 2160, journal_lines, or money_accounts, so a refusal can only come from the domain', () => {
    // Invariant 1's cap is "sum credits minus debits on 2160, restricted to journal_lines.store_id
    // = storeId, over non-draft entries" (§7). A re-implementation needs at least the account code
    // and the raw ledger table; absence of both is a structural guarantee no independent cap
    // arithmetic exists here.
    expect(actionsSource).not.toMatch(/2160/);
    expect(actionsSource).not.toMatch(/journal_lines/i);
    // Invariant 4 — "the money account must belong to the paying store" — same reasoning: no
    // independent store-ownership comparison against the money_accounts table. (`payLiability`'s
    // own action, apps/erp/src/app/liabilities/actions.ts, does zero independent validation of
    // fromMoneyAccountId either — it is passed straight through as a string.)
    expect(actionsSource).not.toMatch(/money_accounts/i);
  });
});

describe('T-187 slice 2 — WIRING GUARD (c): a refusal reaches the operator, not swallowed into a generic message', () => {
  it('actions.ts: the catch around distributeServiceCharge forwards the real error via errorMessage(err)', () => {
    const found = findActionContaining(actionsSource, 'distributeServiceCharge(');
    expect(found, 'no exported action function calls distributeServiceCharge(...)').not.toBeNull();
    const catchBody = extractCatchBlock(found!.body);
    expect(catchBody, `no catch block found in ${found?.name ?? '(action not found)'}`).not.toBeNull();
    // ⭐ The same convention as every other action in this app: errorMessage(err) forwards
    // whatever the DOMAIN threw — which is where invariant 2 already puts the store's name and
    // the shortfall (service-charge-distribution.test.ts). A catch block that does NOT call this
    // is the shape of a swallowed refusal: a hardcoded "could not process the payout" string the
    // operator cannot act on, even though the domain threw something specific.
    expect(catchBody).toMatch(/errorMessage\(\s*err\s*\)/);
  });
});
