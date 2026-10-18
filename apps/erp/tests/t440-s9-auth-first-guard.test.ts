/**
 * T-440 S9a - guard G6: authorization BEFORE field checks. Spec: docs/tasks/440-live-field-checks.md, S9 ("Guard G6").
 *
 * WHY. A caller with no right to an action must be told "you may not", never "your amount is wrong": the field sentence
 * would otherwise confirm the shape of a screen they cannot use, and the refusal is not logged as a denial. So every
 * `assertFieldRules(` call must come AFTER the authorization that governs the same action.
 *
 * SCOPE. `apps/erp/src/app/** /actions.ts`, `apps/erp/src/lib/**`, `packages/domain/src/**` minus `field-rules/` and
 * `shared/field-rules-assert.ts`. Real TypeScript AST (comments and strings never count).
 *
 * RULE. For every `assertFieldRules(` CALL, walk up to the top-level function (callbacks such as `withOrgPrincipal((tx) => ...)`
 * belong to it). A GATE call must END before the assert STARTS. GATE = `authorize`, `authorizeOrgLevel`, `loadAndAuthorize`,
 * `loadDestructiveTarget`, or a one-hop function (in scope) whose body contains one of them. `can(` counts only when the assert
 * is inside the then-branch of an `if` whose condition contains it. A PRIVATE (non-exported) helper that asserts with no gate
 * of its own passes only if EVERY call site of it in its file passes.
 *
 * KEYS. A violator is `file#function`; `file` is relative to `apps/erp/src/app/` for actions, `lib/...` for apps/erp/src/lib
 * and `domain/...` for packages/domain/src.
 *
 * RATCHET. `auth-first-baseline.json` lists today's violators. An unlisted violator is red; a listed entry that now passes is red
 * ("lower it"); a listed or EXEMPT entry whose function no longer holds an assert is red. The ORCHESTRATOR lowers the file after
 * each merge - workers never edit it. S9 closes with it empty and deleted (a missing file means "empty": every violator is red).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { buildIndex, callees, lineOf, parse, read, walk, type Index, type Sources } from './helpers/ts-index';

const ERP_SRC = resolve(__dirname, '..', 'src');
const APP_ROOT = join(ERP_SRC, 'app');
const LIB_ROOT = join(ERP_SRC, 'lib');
const REPO = resolve(__dirname, '..', '..', '..');
const DOMAIN_SRC = join(REPO, 'packages', 'domain', 'src');
const BASELINE_FILE = join(__dirname, 'auth-first-baseline.json');

const GATES = new Set(['authorize', 'authorizeOrgLevel', 'loadAndAuthorize', 'loadDestructiveTarget']);

/** Entries that are deliberately not gated, each with the reason. A stale entry fails (C7). */
const EXEMPT: Record<string, string> = {
  'setup/actions.ts#createFirstRunAction':
    'no actor exists yet; the gate is the setup window plus the signed setup identity above it (spec S9, EXEMPT 1)',
};

// ---------------------------------------------------------------------------------------------------------------------
// The checker (pure: sources in, sites out - so the controls can feed it literal fixtures)
// ---------------------------------------------------------------------------------------------------------------------
interface Site {
  file: string;
  fn: string; // top-level function holding the assert
  key: string; // file#fn
  line: number;
  ok: boolean;
  why: string; // for a failure: what was missing / which call site was early
}

const calleeName = (c: ts.CallExpression): string | null => {
  const e = c.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
};
const hasExport = (n: ts.Node) => !!(ts.canHaveModifiers(n) && ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));

/** The statement directly under the source file that contains `n`, and the name the checker reports for it. */
function topLevel(n: ts.Node): { stmt: ts.Statement; name: string; exported: boolean } {
  let cur: ts.Node = n;
  while (cur.parent && !ts.isSourceFile(cur.parent)) cur = cur.parent;
  const stmt = cur as ts.Statement;
  if (ts.isFunctionDeclaration(stmt)) return { stmt, name: stmt.name?.text ?? 'default', exported: hasExport(stmt) };
  if (ts.isVariableStatement(stmt)) {
    const d = stmt.declarationList.declarations[0];
    return { stmt, name: d && ts.isIdentifier(d.name) ? d.name.text : '<anonymous>', exported: hasExport(stmt) };
  }
  if (ts.isClassDeclaration(stmt)) {
    let m: ts.Node | undefined = n;
    while (m && !ts.isMethodDeclaration(m) && m !== stmt) m = m.parent;
    const method = m && ts.isMethodDeclaration(m) ? m.name.getText() : '<class>';
    return { stmt, name: `${stmt.name?.text ?? 'default'}.${method}`, exported: hasExport(stmt) };
  }
  return { stmt, name: '<module>', exported: hasExport(stmt) };
}

function callsIn(root: ts.Node): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  const v = (n: ts.Node) => {
    if (ts.isCallExpression(n)) out.push(n);
    ts.forEachChild(n, v);
  };
  v(root);
  return out;
}

/** Function names (in scope) whose body holds a GATE call: the "one-hop" gates. */
function oneHopGates(index: Index): Set<string> {
  const out = new Set<string>();
  for (const [name, defs] of index.defs) for (const d of defs) if ([...callees(d.node)].some((c) => GATES.has(c))) out.add(name);
  return out;
}

/**
 * A gate that sits in a conditional branch (an `if` block, a `case`, a ternary arm, the right of `&&`) does not cover an assert
 * outside that branch. Function bodies and callbacks are NOT branches (they belong to the top-level function, spec G6).
 */
function dominates(gate: ts.Node, at: ts.Node): boolean {
  const isFn = (n: ts.Node | undefined) => !!n && (ts.isFunctionLike(n) || ts.isClassLike(n));
  for (let n: ts.Node = gate; n.parent && !ts.isSourceFile(n.parent); n = n.parent) {
    const par = n.parent;
    const branch =
      (ts.isBlock(n) && !isFn(par) && !(ts.isTryStatement(par) && par.tryBlock === n)) ||
      ts.isCaseClause(n) ||
      ts.isDefaultClause(n) ||
      (ts.isIfStatement(par) && n !== par.expression) ||
      (ts.isConditionalExpression(par) && n !== par.condition) ||
      (ts.isBinaryExpression(par) && n === par.right && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(par.operatorToken.kind));
    if (branch) return n.pos <= at.pos && at.end <= n.end;
  }
  return true;
}

/** Does a gate (or an `if (await can(..))` around `at`) govern the position `at` inside top-level statement `stmt`? */
function gated(at: ts.Node, stmt: ts.Node, gateNames: Set<string>): boolean {
  const start = at.getStart();
  for (const c of callsIn(stmt)) {
    const name = calleeName(c);
    if (name && gateNames.has(name) && c.getEnd() <= start && dominates(c, at)) return true;
  }
  for (let p: ts.Node | undefined = at; p && p !== stmt.parent; p = p.parent) {
    const par: ts.Node | undefined = p.parent;
    if (par && ts.isIfStatement(par) && par.thenStatement === p && callsIn(par.expression).some((c) => calleeName(c) === 'can')) return true;
  }
  return false;
}

function analyse(sources: Sources): Site[] {
  const index = buildIndex(sources);
  const gateNames = new Set([...GATES, ...oneHopGates(index)]);
  const sites: Site[] = [];
  for (const [file, src] of Object.entries(sources)) {
    if (!src.includes('assertFieldRules')) continue;
    const sf = parse(src, file);
    // Every call in this file, for the private-helper rule.
    const calls = callsIn(sf);
    /** Judge the position `at`; a private ungated helper is judged by every call site of it (depth-limited). */
    const judge = (at: ts.Node, depth: number, seen: Set<string>): { ok: boolean; why: string } => {
      const top = topLevel(at);
      if (gated(at, top.stmt, gateNames)) return { ok: true, why: '' };
      if (top.exported || depth >= 6 || seen.has(top.name) || top.name.startsWith('<')) {
        return { ok: false, why: `no authorize()/can() before the assert in ${top.name}` };
      }
      const next = new Set(seen).add(top.name);
      const callSites = calls.filter((c) => calleeName(c) === top.name && topLevel(c).stmt !== top.stmt);
      for (const c of callSites) {
        const r = judge(c, depth + 1, next);
        if (!r.ok) return { ok: false, why: `private helper ${top.name} is called before any gate at line ${lineOf(sf, c)} (${topLevel(c).name})` };
      }
      return { ok: true, why: '' };
    };
    for (const c of calls) {
      if (calleeName(c) !== 'assertFieldRules') continue;
      const top = topLevel(c);
      const r = judge(c, 0, new Set());
      sites.push({ file, fn: top.name, key: `${file}#${top.name}`, line: lineOf(sf, c), ok: r.ok, why: r.why });
    }
  }
  return sites;
}

/** Violating functions: any one failing site fails the function. key -> first failing site. */
function violators(sites: Site[]): Map<string, Site> {
  const out = new Map<string, Site>();
  for (const s of sites) if (!s.ok && !out.has(s.key)) out.set(s.key, s);
  return out;
}

/** The ratchet comparator (C7 proves it bites). `baseline` = listed violators; `exempt` = deliberate exceptions. */
function judgeAll(sites: Site[], baseline: string[], exempt: Record<string, string>): string[] {
  const problems: string[] = [];
  const exist = new Set(sites.map((s) => s.key));
  const bad = violators(sites);
  const listed = new Set(baseline);
  for (const [key, s] of bad) {
    if (!listed.has(key) && !(key in exempt)) problems.push(`NEW VIOLATOR ${key} (line ${s.line}): ${s.why}. Authorize first, then assertFieldRules.`);
  }
  for (const key of listed) {
    if (!exist.has(key)) problems.push(`STALE baseline entry ${key}: that function no longer holds an assertFieldRules call (delete the entry)`);
    else if (!bad.has(key)) problems.push(`LOWER IT: ${key} now authorizes first - remove it from auth-first-baseline.json`);
  }
  for (const key of Object.keys(exempt)) {
    if (!exist.has(key)) problems.push(`STALE EXEMPT entry ${key}: that function no longer holds an assertFieldRules call`);
    else if (!bad.has(key)) problems.push(`EXEMPT entry ${key} now passes on its own - remove it from EXEMPT`);
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------------
// The real tree
// ---------------------------------------------------------------------------------------------------------------------
const isSrc = (f: string) => /\.tsx?$/.test(f) && !f.endsWith('.d.ts') && !/\.test\.tsx?$/.test(f);
const norm = (f: string) => f.replace(/\\/g, '/');
function realSources(): Sources {
  const out: Sources = {};
  for (const f of walk(APP_ROOT, (x) => norm(x).endsWith('/actions.ts'))) out[norm(relative(APP_ROOT, f))] = read(f);
  for (const f of walk(LIB_ROOT, isSrc)) out['lib/' + norm(relative(LIB_ROOT, f))] = read(f);
  for (const f of walk(DOMAIN_SRC, isSrc)) {
    const rel = norm(relative(DOMAIN_SRC, f));
    if (rel.startsWith('field-rules/') || rel === 'shared/field-rules-assert.ts') continue;
    out['domain/' + rel] = read(f);
  }
  return out;
}
let cache: Site[] | null = null;
const realSites = () => (cache ??= analyse(realSources()));
function loadBaseline(): string[] {
  if (!existsSync(BASELINE_FILE)) return [];
  const j = JSON.parse(readFileSync(BASELINE_FILE, 'utf8')) as { violators: string[] };
  return j.violators;
}

/** The 25 class-(i) sites of spec S9 section A: already after authorization today, so green. file#function. */
const CLASS_I: string[] = [
  // actions (5)
  'admin/users/actions.ts#setCapabilityGrantAction',
  'commissary/discrepancies/actions.ts#resolveDiscrepancyAction',
  'commissary/discrepancies/actions.ts#deferDiscrepancyAction',
  'inventory/low-stock/actions.ts#setThresholdAction',
  'menu/requests/actions.ts#submitItemRequestAction',
  // domain (20 sites in 17 functions)
  'domain/ap/index.ts#judgeCreditTerms',
  'domain/attendance/adjustments.ts#recordAdjustment',
  'domain/attendance/config.ts#supersedeConfig',
  'domain/channel-settlements/index.ts#recordChannelSettlement',
  'domain/dual-run/dispositions.ts#recordDualRunDisposition',
  'domain/expenses/categories.ts#cleanCategoryName',
  'domain/loans/index.ts#createLoan',
  'domain/organizations/index.ts#setOrganizationIdentity',
  'domain/payroll/rates.ts#setGovernmentIds',
  'domain/pos/store-link.ts#linkStoreToPos',
  'domain/pos/tenders.ts#createTender',
  'domain/pos/tenders.ts#updateTender',
  'domain/prepaid/index.ts#runCreate',
  'domain/prepaid/index.ts#confirmPrepaidTerm',
  'domain/sales-channels/index.ts#cleanName',
  'domain/stock/usage-tolerance.ts#setOrgUsageTolerance',
  'domain/stock/usage-tolerance.ts#setItemUsageTolerance',
];

describe('T-440 S9 G6 - authorization before field checks (real tree)', () => {
  it('every assertFieldRules call comes after its gate, or is in the ratchet baseline', { timeout: 60_000 }, () => {
    const problems = judgeAll(realSites(), loadBaseline(), EXEMPT);
    expect(problems, problems.join('\n')).toEqual([]);
  });
  it('the baseline is sorted and has no duplicates (so a diff shows only real changes)', () => {
    const b = loadBaseline();
    expect(b).toEqual([...new Set(b)].sort());
  });
  it('C8 non-vacuous: >= 170 assert sites over >= 60 files, and every class-(i) site is green', { timeout: 60_000 }, () => {
    const sites = realSites();
    expect(sites.length).toBeGreaterThanOrEqual(170);
    expect(new Set(sites.map((s) => s.file)).size).toBeGreaterThanOrEqual(60);
    const byKey = new Map<string, Site[]>();
    for (const s of sites) byKey.set(s.key, [...(byKey.get(s.key) ?? []), s]);
    const missing = CLASS_I.filter((k) => !byKey.has(k));
    expect(missing, `class-(i) entries not found: ${missing.join(', ')}`).toEqual([]);
    const red = CLASS_I.filter((k) => byKey.get(k)!.some((s) => !s.ok));
    expect(red, `class-(i) sites the checker calls red: ${red.join(', ')}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Controls (C1-C7): literal fixtures through the SAME checker
// ---------------------------------------------------------------------------------------------------------------------
const AT = `import { authorize } from '@shareat/auth';\nimport { assertFieldRules } from '@shareat/domain';\n`;
const run = (src: string, file = 'x/actions.ts') => analyse({ [file]: AT + src });
const fails = (src: string, file?: string) => [...violators(run(src, file)).keys()];

describe('G6 controls (the guard bites, and does not cry wolf)', () => {
  it('C1 RED: assert, then authorize', () => {
    expect(fails(`export async function a(tx, actor, fd) { assertFieldRules(R, fd); await authorize(tx, actor, 'cap', {}); }`)).toEqual(['x/actions.ts#a']);
  });
  it('C2 RED: the gate lives only in a sibling function', () => {
    expect(
      fails(`async function other(tx, actor) { await authorize(tx, actor, 'cap', {}); }
export async function a(tx, actor, fd) { assertFieldRules(R, fd); }`),
    ).toEqual(['x/actions.ts#a']);
  });
  it('C3 RED: the gate appears only in a comment or a string', () => {
    expect(
      fails(`export async function a(tx, actor, fd) {
  // await authorize(tx, actor, 'cap', {});
  const s = "await authorize(tx, actor, 'cap', {})";
  assertFieldRules(R, fd);
}`),
    ).toEqual(['x/actions.ts#a']);
  });
  it('C4 RED: `await can(...)` with its result ignored, assert after', () => {
    expect(fails(`export async function a(tx, actor, fd) { await can(tx, actor, 'cap', {}); assertFieldRules(R, fd); }`)).toEqual(['x/actions.ts#a']);
  });
  it('C5 RED: a private helper asserted from one call site before authorize and one after (names the early site)', () => {
    const src = `function helper(fd) { assertFieldRules(R, fd); }
export async function late(tx, actor, fd) { await authorize(tx, actor, 'cap', {}); helper(fd); }
export async function early(tx, actor, fd) { helper(fd); await authorize(tx, actor, 'cap', {}); }`;
    const v = violators(run(src));
    expect([...v.keys()]).toEqual(['x/actions.ts#helper']);
    expect(v.get('x/actions.ts#helper')!.why).toMatch(/\(early\)/);
  });
  it('C6 GREEN: authorize->assert, if(can)->assert, loadDestructiveTarget->assert, one-hop lib helper->assert, helper only called after authorize', () => {
    const src = `
export async function g1(tx, actor, fd) { await authorize(tx, actor, 'cap', {}); assertFieldRules(R, fd); }
export async function g2(tx, actor, fd) { if (await can(tx, actor, 'cap', {})) assertFieldRules(R, fd); }
export async function g3(actor, fd) { await loadDestructiveTarget(actor, 'k', 'id', ['cap']); assertFieldRules(R, fd); }
export async function g4(tx, actor, fd) { await requireRight(tx, actor); assertFieldRules(R, fd); }
export async function g5(tx, actor, fd) { await withOrgPrincipal('o', async (t) => { await authorizeOrgLevel(t, actor, 'cap'); assertFieldRules(R, fd); }); }
function h(fd) { assertFieldRules(R, fd); }
export async function g6(tx, actor, fd) { await authorize(tx, actor, 'cap', {}); h(fd); }`;
    const sites = analyse({ 'x/actions.ts': AT + src, 'lib/rights.ts': `export async function requireRight(tx, actor) { await authorize(tx, actor, 'cap', {}); }` });
    expect(sites.filter((s) => !s.ok)).toEqual([]);
    expect(sites.map((s) => s.fn).sort()).toEqual(['g1', 'g2', 'g3', 'g4', 'g5', 'h']);
  });
  it('C6b RED: `can` guarding the wrong branch (assert in the else, or outside the if)', () => {
    expect(fails(`export async function a(tx, actor, fd) { if (await can(tx, actor, 'cap', {})) { x(); } assertFieldRules(R, fd); }`)).toEqual(['x/actions.ts#a']);
    expect(fails(`export async function b(tx, actor, fd) { if (await can(tx, actor, 'cap', {})) { x(); } else { assertFieldRules(R, fd); } }`)).toEqual(['x/actions.ts#b']);
  });
  it('C7 RED: an EXEMPT or baseline entry whose function no longer exists; a listed entry that now passes', () => {
    const sites = run(`export async function a(tx, actor, fd) { await authorize(tx, actor, 'cap', {}); assertFieldRules(R, fd); }
export async function b(tx, actor, fd) { assertFieldRules(R, fd); }`);
    expect(judgeAll(sites, ['x/actions.ts#b'], {})).toEqual([]);
    expect(judgeAll(sites, ['x/actions.ts#b', 'x/actions.ts#gone'], {}).join('\n')).toMatch(/STALE baseline entry x\/actions\.ts#gone/);
    expect(judgeAll(sites, ['x/actions.ts#a', 'x/actions.ts#b'], {}).join('\n')).toMatch(/LOWER IT: x\/actions\.ts#a/);
    expect(judgeAll(sites, ['x/actions.ts#b'], { 'x/actions.ts#gone': 'r' }).join('\n')).toMatch(/STALE EXEMPT entry x\/actions\.ts#gone/);
    expect(judgeAll(sites, [], {}).join('\n')).toMatch(/NEW VIOLATOR x\/actions\.ts#b/);
  });
  it('C7b the real EXEMPT entry exists in the real tree (the exemption is not dead weight)', { timeout: 60_000 }, () => {
    expect(realSites().some((s) => s.key === 'setup/actions.ts#createFirstRunAction')).toBe(true);
  });
});
