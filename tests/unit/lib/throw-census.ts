/**
 * T-343 S5.0 — the widened id-shaped-throw scanner. `docs/tasks/343-def-417-human-readable-refusals.md`
 * §S5 "Census scanner (S5.0, first)", Amendment R1 item 3 (derived), Amendment R2 fold.
 *
 * Replaces S3's regex (`packages/db/tests/t343-repo-refusal-census.test.ts`'s `findIdShapedThrows`,
 * a single-template match with no `+` and no nested backtick) with a real `ts.createSourceFile`
 * walk — the S3 census note recorded that regex missing 4 of 9 already-classified sites purely
 * because of concatenation or nesting, and finding 3 more live ones (`ap.ts:431,437,443`) it never
 * saw at all. Helper precedent: `tests/unit/lib/document-facts.ts` (pure functions, no `describe`/
 * `it` of its own — importing this file into more than one `.test.ts` must never re-run a suite).
 * AST precedent: `apps/erp/tests/touch-target-geometry.ts` (`ts.createSourceFile`, walk, classify).
 *
 * ⛔ Not a `.test.ts` file — see `document-facts.ts`'s header for why that is load-bearing, not a
 * naming preference: this file has no `describe`/`it`, so importing it from more than one test file
 * never double-registers a suite.
 */
import ts from 'typescript';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `id` — final name matches `ID_NAME_RE` (`id`, `orgId`, `supplierId`, `uid`, …).
 * `key` — final name matches `KEY_NAME_RE` (`itemKind`, `kind`, `disposition`, `role`, `capability`).
 * `derived` — an operand that is a `.join(…)` call, a `.message` access, or `String(<non-literal>)`:
 *   ids collected into a list and joined later, or an id smuggled through `Error#message` (R1.3).
 *   Counts as needing classification, same as `id`/`key` — never silently treated as safe.
 * `plain` — everything else (amounts, names, statuses, dates): the census's "nothing to see here".
 */
export type Classification = 'id' | 'key' | 'derived' | 'plain';

export interface CensusSite {
  /** Repo-relative (or fixture) path, forward-slashed. */
  file: string;
  /** 1-based line of the `throw`/call/property. */
  line: number;
  kind: Classification;
  /** The constructor name for `throw new <X>(…)`, or the function name for a bare call
   *  (`refuse`/`gone`/`internalFault`/`recordGone`), or `'reason'` for an `Outcome` property. */
  callee: string;
  /** The classified argument's source text, whitespace-collapsed and truncated — for reporting. */
  text: string;
}

export interface CensusOptions {
  /** Also scan `reason:` object-literal property initialisers (S5.4's `Outcome` shape, rows
   *  10-11 — a `return`, never a `throw`). Off by default: S5.0-S5.3 need only `throw`/call sites,
   *  and scanning `reason:` unconditionally would flag every ordinary `{ reason: 'why' }` object
   *  literal in the tree, most of which have nothing to do with this task. */
  includeReasonProps?: boolean;
}

// /code-review, S5.0 (2026-09-26): widened to also catch plurals (`orgIds`, `uids`) and the two
// other spellings this codebase's own reference repos and third-party rows use besides `Id`
// (`orgID`, `supplierUuid`) — a bare `id`/`ids`/`uid(s)`/`uuid(s)`, or a camelCase name ending in
// `Id`/`Ids`/`ID`/`IDs`/`Uuid`/`Uuids`/`UUID`/`UID`. Still anchored so `void`/`avoid`/`grid` (which
// end in lower-case `id`, never the capitalised suffix this pattern requires) stay `plain`.
const ID_NAME_RE = /^(id|ids|uid|uids|uuid|uuids|[a-z]\w*(?:Id|Ids|ID|IDs|Uuid|Uuids|UUID|UID))$/;
const KEY_NAME_RE = /^(itemKind|kind|disposition|role|capability)$/;

/** Functions whose call sites are already the SAFE, converted shape — visited (so a later census
 *  can still find them if it wants to) but never classified: there is no raw id left to hide once
 *  a throw has become one of these. */
const CONVERTED_CALLEES = new Set(['gone', 'internalFault', 'recordGone']);

/** `derived` outranks `id` outranks `key` outranks `plain` when a single throw argument mixes
 *  shapes (e.g. a template with both a `${storeId}` span and a `${x.join(', ')}` span) — the
 *  hardest-to-verify classification present anywhere in the argument decides the whole site,
 *  never the first or the last operand found. */
const PRIORITY: Record<Classification, number> = { plain: 0, key: 1, id: 2, derived: 3 };
function combine(a: Classification, b: Classification): Classification {
  return PRIORITY[b] > PRIORITY[a] ? b : a;
}

function nameClassification(name: string): Classification {
  if (ID_NAME_RE.test(name)) return 'id';
  if (KEY_NAME_RE.test(name)) return 'key';
  return 'plain';
}

/**
 * The nearest enclosing `const <name> = <initializer>` for `identifier`, walking UP the real
 * lexical scope chain (blocks and the source file are the only scopes that matter here — same
 * restriction, same reason, as `apps/erp/tests/touch-target-geometry.ts`'s `findLocalConst`).
 * `let`/`var` are excluded on purpose: a REASSIGNED binding cannot be resolved to one value, so
 * treating it as if it could would be a false confidence, not a wider net.
 */
function findLocalConstInit(identifier: ts.Identifier): ts.Expression | undefined {
  let current: ts.Node | undefined = identifier.parent;
  while (current) {
    const statements = ts.isSourceFile(current) || ts.isBlock(current) ? current.statements : undefined;
    if (statements) {
      for (const stmt of statements) {
        if (!ts.isVariableStatement(stmt)) continue;
        if (!(stmt.declarationList.flags & ts.NodeFlags.Const)) continue;
        for (const decl of stmt.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.name.text === identifier.text && decl.initializer) {
            return decl.initializer;
          }
        }
      }
    }
    current = current.parent;
  }
  return undefined;
}

/**
 * Classifies one expression by every interpolated/concatenated operand it contains, recursing into
 * nested templates, `+` chains and conditional branches (R1.3, W1 shapes 3-5). A bare string/numeric
 * literal contributes nothing (`plain`) — only the LEAVES that are identifiers, property accesses,
 * or the three named "derived" shapes ever change the verdict.
 *
 * `resolveLocalConst` (/code-review, S5.1, 2026-09-26): a bare identifier that is itself a local
 * `const` bound to a derived/id-shaped expression a few lines earlier — `const raw = \`x:
 * ${err.message}\`; refuse(other, raw)` — carries the SAME risk as writing the expression inline,
 * and `expenses/categories.ts:143-144`'s rewrap does exactly this. Resolved ONE hop only: the
 * recursive call into the initializer passes `false`, so a chain of `const a = b; const c = a;`
 * stops at `b`'s own shape and does not also chase `b` back to whatever defined IT — deliberately
 * bounded, not a general constant-folder.
 */
export function classifyExpression(expr: ts.Expression, resolveLocalConst = true): Classification {
  if (ts.isParenthesizedExpression(expr)) return classifyExpression(expr.expression, resolveLocalConst);

  // /code-review, S5.0 (2026-09-26): `foo!`, `foo as Bar` and `await foo` are transparent wrappers
  // around the SAME operand — `${supplierId!}`, `${(row as Row).supplierId}` and
  // `${await getSupplierId()}` all carry an id through one of these, and none of the branches below
  // would otherwise ever see past the wrapper (a `NonNullExpression`/`AsExpression`/`AwaitExpression`
  // node is none of an Identifier, a PropertyAccessExpression, or a CallExpression).
  if (ts.isNonNullExpression(expr) || ts.isAsExpression(expr) || ts.isAwaitExpression(expr)) {
    return classifyExpression(expr.expression);
  }

  // `row['supplierId']` — bracket notation naming the SAME property a dot-access would, classified
  // by the literal key exactly like `PropertyAccessExpression.name` below. A computed, non-literal
  // index (`row[i]`) carries no name to classify and is left `plain`.
  if (ts.isElementAccessExpression(expr)) {
    const key = expr.argumentExpression;
    return ts.isStringLiteralLike(key) ? nameClassification(key.text) : 'plain';
  }

  if (ts.isCallExpression(expr)) {
    const callee = expr.expression;
    // `<anything>.join(…)` — ids collected into a list and joined later (R1.3, W1 shape 6).
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'join') return 'derived';
    // `String(<non-literal>)` — an id smuggled through a coercion, e.g. `String(row.id)`.
    if (ts.isIdentifier(callee) && callee.text === 'String') {
      const arg = expr.arguments[0];
      if (arg && !ts.isStringLiteralLike(arg) && !ts.isNumericLiteral(arg)) return 'derived';
      return 'plain';
    }
    // An unrecognised call (e.g. `humanDate(d)`, `periodLabel(k)`) is not one of the three named
    // derived shapes — treated as an opaque, already-presentable value, not re-classified.
    return 'plain';
  }

  // `<anything>.message` — an id smuggled through `Error#message` (R1.3, W1 shape 7,
  // `expenses/categories.ts:138`'s rewrap). Checked BEFORE the general name-classification branch
  // below, which would otherwise never fire for `.message` (no name matches ID_NAME_RE/KEY_NAME_RE).
  if (ts.isPropertyAccessExpression(expr)) {
    if (expr.name.text === 'message') return 'derived';
    return nameClassification(expr.name.text);
  }

  if (ts.isIdentifier(expr)) {
    const own = nameClassification(expr.text);
    if (!resolveLocalConst) return own;
    const init = findLocalConstInit(expr);
    return init ? combine(own, classifyExpression(init, false)) : own;
  }

  if (ts.isTemplateExpression(expr)) {
    let worst: Classification = 'plain';
    for (const span of expr.templateSpans) worst = combine(worst, classifyExpression(span.expression));
    return worst;
  }

  // `'…' + storeId + '…'` (W1 shape 3, 4) — a chain of `+` is a LEFT-associative BinaryExpression
  // tree; recursing into both sides walks the whole chain regardless of its length.
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return combine(classifyExpression(expr.left), classifyExpression(expr.right));
  }

  // `a ? `${b.id}` : ''` (W1 shape 5) — only the two BRANCHES matter, never the condition itself.
  if (ts.isConditionalExpression(expr)) {
    return combine(classifyExpression(expr.whenTrue), classifyExpression(expr.whenFalse));
  }

  // String/no-substitution-template/numeric literals, and anything else not named above: plain.
  return 'plain';
}

function firstLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 320);
}

/**
 * One file's sites: every `throw new <X>(arg)`, every bare `refuse(`/`gone(`/`internalFault(`/
 * `recordGone(` call (wherever it appears, not only under a `throw` — a `throw` statement's
 * expression is itself visited as an ordinary `CallExpression` by the walk below, so no separate
 * branch is needed for `throw recordGone(…)`), and — opt-in — every `reason:` property initialiser.
 *
 * `refuse`'s SECOND argument (the sentence, never the raw diagnostic) is what gets classified: the
 * design's own invariant is that this always classifies `plain` (rule 1, "no quoted raw key"). The
 * three `CONVERTED_CALLEES` are visited (so a later census can still find them) but never
 * classified `id`/`key`/`derived` — there is no more raw id to hide once a throw already reads
 * `recordGone(...)`/`gone(...)`/`internalFault(...)`.
 */
export function censusSource(fileLabel: string, sourceText: string, options: CensusOptions = {}): CensusSite[] {
  const sourceFile = ts.createSourceFile(fileLabel, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const sites: CensusSite[] = [];
  const lineOf = (node: ts.Node): number => sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;

  const visit = (node: ts.Node): void => {
    if (ts.isThrowStatement(node) && node.expression && ts.isNewExpression(node.expression)) {
      const newExpr = node.expression;
      const callee = newExpr.expression.getText(sourceFile);
      const arg = newExpr.arguments?.[0];
      if (arg) {
        sites.push({ file: fileLabel, line: lineOf(newExpr), kind: classifyExpression(arg), callee, text: firstLine(arg.getText(sourceFile)) });
      }
    }

    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      if (name === 'refuse') {
        const sentence = node.arguments[1];
        if (sentence) {
          sites.push({ file: fileLabel, line: lineOf(node), kind: classifyExpression(sentence), callee: 'refuse', text: firstLine(sentence.getText(sourceFile)) });
        }
      } else if (CONVERTED_CALLEES.has(name)) {
        sites.push({ file: fileLabel, line: lineOf(node), kind: 'plain', callee: name, text: firstLine(node.getText(sourceFile)) });
      }
    }

    if (
      options.includeReasonProps &&
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'reason'
    ) {
      sites.push({ file: fileLabel, line: lineOf(node), kind: classifyExpression(node.initializer), callee: 'reason', text: firstLine(node.initializer.getText(sourceFile)) });
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return sites;
}

/** A synthetic fixture, not a real file — `file` reads `'<fixture>'` in every returned site. */
export function censusFixture(sourceText: string, options: CensusOptions = {}): CensusSite[] {
  return censusSource('<fixture>', sourceText, options);
}

function collectTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'tests' || entry.name === '.next') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTsFiles(full, out);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Every site under a real directory, recursively (excluding `node_modules`, any `tests/`
 *  subdirectory, and `.test.ts` files — the same exclusion the S1 ratchet test uses). */
export function censusTree(rootDir: string, options: CensusOptions = {}): CensusSite[] {
  const sites: CensusSite[] = [];
  for (const file of collectTsFiles(rootDir)) {
    sites.push(...censusSource(file.replace(/\\/g, '/'), readFileSync(file, 'utf8'), options));
  }
  return sites;
}

/**
 * DEF-179's lesson applied to this census: a scanner that quietly matches nothing must FAIL, not
 * pass by accident. `scanner(fixture)` is expected to return exactly `expectedCount` hits; a
 * scanner that always returns `[]` (e.g. `() => []`) throws here instead of silently agreeing with
 * a "0 found" assertion nobody wrote on purpose.
 */
export function assertFinds<T>(scanner: (src: string) => T[], fixture: string, expectedCount: number): T[] {
  const hits = scanner(fixture);
  if (hits.length !== expectedCount) {
    throw new Error(`assertFinds: expected ${expectedCount} hit(s), found ${hits.length}`);
  }
  return hits;
}
