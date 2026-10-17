/**
 * T-389 S1 - guard G10: every saved-record form keeps what was typed after a refused save (DEF-617).
 * Spec: docs/tasks/389-refused-save-keeps-typing.md, "Guard G10". Same AST approach as G7-G9
 * (`t384-s3-lock-and-save-guard.test.ts`): a real TypeScript AST over `apps/erp/src/**`, an in-memory analyzer that the
 * positive controls (G10f) drive with literal fixtures, and a per-file count RATCHET.
 *
 *  G10a  Every `<EditableRecord` has a `typed=` attribute whose expression is a `typedFor(...)` call, or a prop /
 *        variable passed down from one. Missing, `typed={null}`, `typed={undefined}` and a literal object all fail.
 *  G10b  Every `defineTypedForm({ form: 'x' })` key is unique app-wide, the definition is bound to a const, and that
 *        const is used by at least one `keepTyping(` call in an `actions.ts` and one `typedFor(` call in a `page.tsx`.
 *  G10c  For each `<EditableRecord action={X}>`: X resolves (same file, or through an import) to a function whose body
 *        contains `keepTyping(`. An action it cannot resolve is a finding unless it is in TYPED_EXEMPT.
 *  G10d  Deny list, static: no field rendered `type="password"` is named by any `defineTypedForm`, and no allow-list
 *        entry is on the deny list (the runtime throw in `defineTypedForm` is the other half).
 *  G10e  An `EditableRecord` with a `version` in `hidden` has an action whose `keepTyping(` call passes `stale:`.
 *  G10f  Positive controls on literal fixtures, so none of the above can go blind.
 *
 * RATCHET. `typed-baseline.json` ({ "<file>": <count> }) is seeded by the ORCHESTRATOR from this guard's counts at the
 * end of S1 (run with T389_REPORT=1 to print them) and lowered by the orchestrator only. A file's count of EditableRecord elements with a G10a/c/e finding may
 * never exceed its baseline, and a baseline entry above the real count is stale (fails). A missing baseline file means
 * "empty": every finding then fails, which is the right red until it is seeded. It ends EMPTY at S5.
 * The S1 files are additionally asserted clean outright, whatever the baseline says.
 *
 * Red on HEAD: no form is wired (every EditableRecord has no `typed=`), no `defineTypedForm` exists, and the baseline
 * is not seeded.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { posix, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = resolve(__dirname, '..', 'src');

/** `<file>::<snippet of the element's label attribute>` -> reason. Empty unless a lane finds a real reason; the orchestrator approves each entry. */
const TYPED_EXEMPT: Record<string, string> = {
  'app/staff/[employmentId]/page.tsx::government numbers':
    'T-190: every field is a government ID number, as sensitive as a bank account (bible row 353), so nothing is ever kept after a refused save',
};

/** The deny list, as the spec states it (R4). The runtime copy lives in lib/keep-typing.ts. */
const NEVER_ECHO = /(^|_)(pin|newpin|password|passcode|secret|token|otp|apikey|api_key)$/i;
const SENSITIVE: ReadonlySet<string> = new Set(['bankAccountNumber', 'sssNo', 'philhealthNo', 'pagibigNo']);
const denied = (name: string) => NEVER_ECHO.test(name) || SENSITIVE.has(name);

/** The forms S1 wires. A key is added here by the slice that wires it. */
const S1_FORM_KEYS = ['tender.edit', 'supplier.edit', 'invoice.lines'];
/** Files S1 makes fully clean. The store-link form lives in pos-link/page.tsx beside the tenders. */
const S1_FILES = ['app/settings/pos-link/page.tsx', 'app/ap/suppliers/[id]/page.tsx', 'app/ap/invoices/[id]/page.tsx'];

type Rule = 'G10a' | 'G10b' | 'G10c' | 'G10d' | 'G10e';
interface Finding {
  rule: Rule;
  file: string;
  line: number;
  detail: string;
  /** For element findings: the raw `label` attribute text, to match TYPED_EXEMPT. */
  label?: string;
}
interface FormDef {
  name: string | null;
  key: string;
  file: string;
  line: number;
  strings: string[];
  regexes: string[];
}

// ---------------------------------------------------------------------------------------------------------------
// AST helpers
// ---------------------------------------------------------------------------------------------------------------
function parse(source: string, file: string) {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}
function opening(n: ts.Node): ts.JsxOpeningLikeElement | undefined {
  if (ts.isJsxElement(n)) return n.openingElement;
  if (ts.isJsxSelfClosingElement(n)) return n;
  return undefined;
}
const tagName = (n: ts.JsxOpeningLikeElement) => n.tagName.getText();
function attr(n: ts.JsxOpeningLikeElement, name: string): ts.JsxAttribute | undefined {
  return n.attributes.properties.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === name);
}
function attrString(n: ts.JsxOpeningLikeElement, name: string): string | undefined {
  const a = attr(n, name);
  if (!a?.initializer) return undefined;
  if (ts.isStringLiteral(a.initializer)) return a.initializer.text;
  if (ts.isJsxExpression(a.initializer) && a.initializer.expression) {
    const e = a.initializer.expression;
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  }
  return undefined;
}
function attrExpr(a: ts.JsxAttribute | undefined): ts.Expression | undefined {
  if (!a?.initializer) return undefined;
  if (ts.isJsxExpression(a.initializer)) return a.initializer.expression ?? undefined;
  return a.initializer as unknown as ts.Expression;
}
function walk(sf: ts.Node, visit: (n: ts.Node) => void) {
  const v = (n: ts.Node) => {
    visit(n);
    ts.forEachChild(n, v);
  };
  v(sf);
}
const lineOf = (sf: ts.SourceFile, n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
const calleeName = (c: ts.CallExpression) => (ts.isIdentifier(c.expression) ? c.expression.text : ts.isPropertyAccessExpression(c.expression) ? c.expression.name.text : '');

/** Is a `typed=` expression a typedFor(...) call, or something passed down from one? Literal null / undefined / objects are not. */
function typedExprOk(e: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e)) return typedExprOk(e.expression);
  if (ts.isCallExpression(e)) return calleeName(e) === 'typedFor';
  if (ts.isIdentifier(e)) return e.text !== 'undefined';
  if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) return true;
  if (ts.isBinaryExpression(e) && (e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || e.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
    return typedExprOk(e.left);
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------------------
// The analyzer: over an in-memory program { 'app/x/page.tsx': source }. The real tree is loaded into the same shape.
// ---------------------------------------------------------------------------------------------------------------
type Program = Record<string, string>;

function resolveModule(from: string, spec: string, files: Program): string | undefined {
  let base: string;
  if (spec.startsWith('@/')) base = spec.slice(2);
  else if (spec.startsWith('.')) base = posix.normalize(posix.join(posix.dirname(from), spec));
  else return undefined;
  return [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].find((c) => c in files);
}

function findFunction(sf: ts.SourceFile, name: string): ts.Node | undefined {
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name?.text === name) return st;
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) return d.initializer;
      }
    }
  }
  return undefined;
}

/** The function an `action={X}` identifier names: in this file, or through a named import. */
function resolveAction(file: string, sf: ts.SourceFile, ident: string, files: Program): { fn: ts.Node; sf: ts.SourceFile } | undefined {
  const local = findFunction(sf, ident);
  if (local) return { fn: local, sf };
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause?.namedBindings || !ts.isNamedImports(st.importClause.namedBindings)) continue;
    for (const el of st.importClause.namedBindings.elements) {
      if (el.name.text !== ident) continue;
      const original = (el.propertyName ?? el.name).text;
      const target = ts.isStringLiteral(st.moduleSpecifier) ? resolveModule(file, st.moduleSpecifier.text, files) : undefined;
      if (!target) return undefined;
      const tsf = parse(files[target]!, target);
      const fn = findFunction(tsf, original);
      return fn ? { fn, sf: tsf } : undefined;
    }
  }
  return undefined;
}

function keepTypingCalls(fn: ts.Node): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  walk(fn, (n) => {
    if (ts.isCallExpression(n) && calleeName(n) === 'keepTyping') out.push(n);
  });
  return out;
}
function passesStale(call: ts.CallExpression): boolean {
  const opts = call.arguments[3];
  return !!opts && ts.isObjectLiteralExpression(opts) && opts.properties.some((p) => p.name !== undefined && p.name.getText() === 'stale');
}
function hiddenHasVersion(el: ts.JsxOpeningLikeElement): boolean {
  const e = attrExpr(attr(el, 'hidden'));
  if (!e || !ts.isObjectLiteralExpression(e)) return false;
  return e.properties.some((p) => p.name !== undefined && p.name.getText() === 'version');
}

/** G10a + G10c + G10e over one program. TYPED_EXEMPT is applied by the caller. */
function elementFindings(files: Program): Finding[] {
  const out: Finding[] = [];
  for (const [file, source] of Object.entries(files)) {
    if (!file.endsWith('.tsx') || !source.includes('EditableRecord')) continue;
    const sf = parse(source, file);
    walk(sf, (n) => {
      const el = opening(n);
      if (!el || tagName(el) !== 'EditableRecord') return;
      const label = attr(el, 'label')?.initializer?.getText() ?? '';
      const at = (rule: Rule, detail: string): Finding => ({ rule, file, line: lineOf(sf, el), detail, label });

      // G10a
      const typed = attr(el, 'typed');
      if (!typed) {
        const spread = el.attributes.properties.some((p) => ts.isJsxSpreadAttribute(p));
        out.push(at('G10a', spread ? 'no explicit typed= (a spread cannot be checked)' : 'no typed= attribute'));
      } else {
        const e = attrExpr(typed);
        if (!e || !typedExprOk(e)) out.push(at('G10a', `typed= is not a typedFor(...) call or a prop passed down (${e ? e.getText().slice(0, 40) : 'empty'})`));
      }

      // G10c / G10e
      const actionExpr = attrExpr(attr(el, 'action'));
      if (!actionExpr || !ts.isIdentifier(actionExpr)) {
        out.push(at('G10c', 'action is not a plain identifier, so it cannot be resolved to a function'));
        return;
      }
      const resolved = resolveAction(file, sf, actionExpr.text, files);
      if (!resolved) {
        out.push(at('G10c', `action ${actionExpr.text} does not resolve to a function (a param, or an import this guard cannot follow)`));
        return;
      }
      const calls = keepTypingCalls(resolved.fn);
      if (calls.length === 0) out.push(at('G10c', `action ${actionExpr.text} never calls keepTyping(`));
      else if (hiddenHasVersion(el) && !calls.some(passesStale)) out.push(at('G10e', `versioned record, but ${actionExpr.text} never passes stale: to keepTyping(`));
    });
  }
  return out;
}

/** The defineTypedForm definitions in a program. */
function formDefs(files: Program): { defs: FormDef[]; unnamed: Finding[] } {
  const defs: FormDef[] = [];
  const unnamed: Finding[] = [];
  for (const [file, source] of Object.entries(files)) {
    if (!source.includes('defineTypedForm')) continue;
    const sf = parse(source, file);
    walk(sf, (n) => {
      if (!ts.isCallExpression(n) || calleeName(n) !== 'defineTypedForm') return;
      if (ts.isImportSpecifier(n.parent)) return;
      const arg = n.arguments[0];
      if (!arg || !ts.isObjectLiteralExpression(arg)) return;
      const prop = (name: string) => arg.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText() === name);
      const keyNode = prop('form')?.initializer;
      const key = keyNode && (ts.isStringLiteral(keyNode) || ts.isNoSubstitutionTemplateLiteral(keyNode)) ? keyNode.text : '';
      const fieldsNode = prop('fields')?.initializer;
      const strings: string[] = [];
      const regexes: string[] = [];
      if (fieldsNode && ts.isArrayLiteralExpression(fieldsNode)) {
        for (const el of fieldsNode.elements) {
          if (ts.isStringLiteral(el) || ts.isNoSubstitutionTemplateLiteral(el)) strings.push(el.text);
          else if (ts.isRegularExpressionLiteral(el)) regexes.push(el.text);
        }
      }
      const parent = n.parent;
      const name = ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) ? parent.name.text : null;
      if (name === null) unnamed.push({ rule: 'G10b', file, line: lineOf(sf, n), detail: 'defineTypedForm(...) is not bound to a const, so nothing can be checked against it' });
      defs.push({ name, key, file, line: lineOf(sf, n), strings, regexes });
    });
  }
  return { defs, unnamed };
}

/** G10b over one program. */
function formFindings(files: Program): Finding[] {
  const { defs, unnamed } = formDefs(files);
  const out: Finding[] = [...unnamed];
  const keepUsed = new Set<string>();
  const forUsed = new Set<string>();
  for (const [file, source] of Object.entries(files)) {
    if (!source.includes('keepTyping') && !source.includes('typedFor')) continue;
    const sf = parse(source, file);
    walk(sf, (n) => {
      if (!ts.isCallExpression(n)) return;
      const second = n.arguments[1];
      const nm = second && ts.isIdentifier(second) ? second.text : null;
      if (!nm) return;
      if (calleeName(n) === 'keepTyping' && /actions\.ts$/.test(file)) keepUsed.add(nm);
      if (calleeName(n) === 'typedFor' && /page\.tsx$/.test(file)) forUsed.add(nm);
    });
  }
  const byKey = new Map<string, FormDef[]>();
  for (const d of defs) byKey.set(d.key, [...(byKey.get(d.key) ?? []), d]);
  for (const d of defs) {
    if (!d.key) out.push({ rule: 'G10b', file: d.file, line: d.line, detail: 'defineTypedForm has no literal form key' });
    else if ((byKey.get(d.key)?.length ?? 0) > 1) out.push({ rule: 'G10b', file: d.file, line: d.line, detail: `form key ${d.key} is defined more than once` });
    if (d.name && !keepUsed.has(d.name)) out.push({ rule: 'G10b', file: d.file, line: d.line, detail: `${d.name} (${d.key}) is never passed to keepTyping( in an actions.ts` });
    if (d.name && !forUsed.has(d.name)) out.push({ rule: 'G10b', file: d.file, line: d.line, detail: `${d.name} (${d.key}) is never passed to typedFor( in a page.tsx` });
  }
  return out;
}

/** G10d over one program. */
function denyFindings(files: Program): Finding[] {
  const passwordNames = new Set<string>();
  for (const [file, source] of Object.entries(files)) {
    if (!file.endsWith('.tsx') || !source.includes('password')) continue;
    walk(parse(source, file), (n) => {
      const el = opening(n);
      if (el && tagName(el) === 'input' && attrString(el, 'type') === 'password') {
        const nm = attrString(el, 'name');
        if (nm) passwordNames.add(nm);
      }
    });
  }
  const out: Finding[] = [];
  for (const d of formDefs(files).defs) {
    for (const s of d.strings) {
      if (denied(s)) out.push({ rule: 'G10d', file: d.file, line: d.line, detail: `${d.key}: allow-list names a denied field "${s}"` });
      if (passwordNames.has(s)) out.push({ rule: 'G10d', file: d.file, line: d.line, detail: `${d.key}: allow-list names a password input "${s}"` });
    }
    for (const r of d.regexes) {
      const m = /^\/(.*)\/([a-z]*)$/s.exec(r);
      const re = m ? new RegExp(m[1]!, m[2]) : null;
      for (const pw of passwordNames) if (re?.test(pw)) out.push({ rule: 'G10d', file: d.file, line: d.line, detail: `${d.key}: regex ${r} matches the password input "${pw}"` });
    }
  }
  return out;
}

/** TYPED_EXEMPT: split findings into live ones, and report stale / reasonless exempt entries. */
function applyExempt(findings: Finding[], exempt: Record<string, string>) {
  const used = new Set<string>();
  const live = findings.filter((f) => {
    for (const k of Object.keys(exempt)) {
      const [file, snippet] = k.split('::');
      if (file === f.file && (f.label ?? '').includes(snippet ?? '')) {
        used.add(k);
        return false;
      }
    }
    return true;
  });
  return {
    live,
    stale: Object.keys(exempt).filter((k) => !used.has(k)),
    reasonless: Object.entries(exempt).filter(([, why]) => !why.trim()).map(([k]) => k),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The real tree, and the ratchet.
// ---------------------------------------------------------------------------------------------------------------
function walkDir(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walkDir(full, out);
    else if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full);
  }
  return out;
}
let treeCache: Program | undefined;
function tree(): Program {
  if (!treeCache) {
    treeCache = {};
    for (const f of walkDir(SRC_ROOT)) treeCache[relative(SRC_ROOT, f).replace(/\\/g, '/')] = readFileSync(f, 'utf8');
  }
  return treeCache;
}
/** Per file, the number of ELEMENTS with at least one finding (an element lacking both typed= and keepTyping( counts once). */
function counts(fs: Finding[]): Record<string, number> {
  const m: Record<string, number> = {};
  const seenAt = new Set<string>();
  for (const f of fs) {
    const at = f.file + ':' + f.line;
    if (seenAt.has(at)) continue;
    seenAt.add(at);
    m[f.file] = (m[f.file] ?? 0) + 1;
  }
  return m;
}
function baseline(): Record<string, number> {
  const p = resolve(__dirname, 'typed-baseline.json');
  if (!existsSync(p)) return {};
  const j = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(j).filter(([k]) => !k.startsWith('_'))) as Record<string, number>;
}
function ratchet(actual: Record<string, number>, base: Record<string, number>): string[] {
  const errs: string[] = [];
  for (const [f, n] of Object.entries(actual)) if (n > (base[f] ?? 0)) errs.push(`${f}: ${n} finding(s), baseline ${base[f] ?? 0}`);
  for (const [f, n] of Object.entries(base)) if (n > (actual[f] ?? 0)) errs.push(`${f}: baseline ${n} is stale, actual ${actual[f] ?? 0} (lower it)`);
  return errs;
}

describe('G10 on the real tree', () => {
  const found = () => applyExempt(elementFindings(tree()), TYPED_EXEMPT);

  it('G10a/c/e: no EditableRecord beyond the baseline lacks typed=, a keepTyping( action, or stale: (ends empty)', () => {
    expect(ratchet(counts(found().live), baseline())).toEqual([]);
  });

  it('the S1 files are clean outright, whatever the baseline says (tender, store link, supplier, invoice lines)', () => {
    const live = found().live.filter((f) => S1_FILES.includes(f.file));
    expect(live.map((f) => `${f.rule} ${f.file}:${f.line} ${f.detail}`)).toEqual([]);
    const present = Object.keys(tree());
    for (const f of S1_FILES) expect(present, f).toContain(f);
  });

  it('G10b: every form key is unique, bound to a const, kept in an actions.ts and read in a page.tsx; the S1 forms exist', () => {
    expect(formFindings(tree()).map((f) => `${f.file}:${f.line} ${f.detail}`)).toEqual([]);
    const keys = formDefs(tree()).defs.map((d) => d.key);
    for (const k of S1_FORM_KEYS) expect(keys, `form ${k} is defined`).toContain(k);
    expect(keys.length, 'S1 wires four forms: tender, store link, supplier, invoice lines').toBeGreaterThanOrEqual(4);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('G10d: no allow-list names a password input or a denied field', () => {
    expect(denyFindings(tree()).map((f) => `${f.file}:${f.line} ${f.detail}`)).toEqual([]);
  });

  it('TYPED_EXEMPT has no stale entry and every entry has a reason', () => {
    const r = found();
    expect(r.stale).toEqual([]);
    expect(r.reasonless).toEqual([]);
  });
});

describe('G10f: positive controls on literal fixtures', () => {
  const WIRED: Program = {
    'app/x/page.tsx': `
      import { saveAction } from './actions';
      import { X_EDIT } from './typed-forms';
      export default async function P({ sp }: any) {
        return (
          <EditableRecord action={saveAction} label="the x" hidden={{ id: '1', version: '2' }} typed={typedFor(sp, X_EDIT, '1')}>
            <input name="name" />
          </EditableRecord>
        );
      }`,
    'app/x/actions.ts': `
      'use server';
      export async function saveAction(fd: FormData) {
        try { await go(); } catch (err) {
          return await redirectWithFlash('/x', {}, { error: 'e', typed: keepTyping(fd, X_EDIT, '1', { stale: isStale(err) }) });
        }
      }`,
    'app/x/typed-forms.ts': `export const X_EDIT = defineTypedForm({ form: 'x.edit', fields: ['name'] });`,
  };
  const with_ = (over: Program): Program => ({ ...WIRED, ...over });
  const all = (p: Program) => [...elementFindings(p), ...formFindings(p), ...denyFindings(p)];

  it('control: a fully wired fixture has no finding', () => {
    expect(all(WIRED)).toEqual([]);
  });

  it('G10a: a bare <EditableRecord action={a}> with no typed is flagged', () => {
    const p = with_({ 'app/x/page.tsx': WIRED['app/x/page.tsx']!.replace(' typed={typedFor(sp, X_EDIT, \'1\')}', '') });
    expect(elementFindings(p).map((f) => f.rule)).toContain('G10a');
  });

  it('G10a: typed={null}, typed={undefined} and a literal view are flagged; a prop passed down is not', () => {
    for (const lit of ['null', 'undefined', "{ kind: 'dropped' }"]) {
      const p = with_({ 'app/x/page.tsx': WIRED['app/x/page.tsx']!.replace("typedFor(sp, X_EDIT, '1')", lit) });
      expect(elementFindings(p).map((f) => f.rule), lit).toContain('G10a');
    }
    const down = with_({ 'app/x/page.tsx': WIRED['app/x/page.tsx']!.replace("typedFor(sp, X_EDIT, '1')", 'typed') });
    expect(elementFindings(down).filter((f) => f.rule === 'G10a')).toEqual([]);
    const viaProp = with_({ 'app/x/page.tsx': WIRED['app/x/page.tsx']!.replace("typedFor(sp, X_EDIT, '1')", 'props.typed') });
    expect(elementFindings(viaProp).filter((f) => f.rule === 'G10a')).toEqual([]);
  });

  it('G10c: an action with no keepTyping( is flagged', () => {
    const p = with_({ 'app/x/actions.ts': WIRED['app/x/actions.ts']!.replace(/typed: keepTyping\([^)]*\{[^}]*\}\)/, "typed: undefined") });
    expect(elementFindings(p).map((f) => f.rule)).toContain('G10c');
  });

  it('G10c: an action it cannot resolve (a param) is flagged, unless it is exempt with a reason', () => {
    const p = with_({
      'app/y/page.tsx': `export function Y({ action }: any) { return <EditableRecord action={action} label="by hand" hidden={{ id: '1' }} typed={typedFor(sp, X_EDIT, '1')}><input name="n" /></EditableRecord>; }`,
    });
    const fs = elementFindings(p).filter((f) => f.file === 'app/y/page.tsx');
    expect(fs.map((f) => f.rule)).toEqual(['G10c']);
    const ex = applyExempt(fs, { 'app/y/page.tsx::by hand': 'resolved by hand: app/z/page.tsx:12' });
    expect(ex.live).toEqual([]);
    expect(ex.stale).toEqual([]);
  });

  it('G10c: an action imported from another file is followed (the real shape: page.tsx imports ../actions)', () => {
    const p: Program = {
      'app/ap/suppliers/[id]/page.tsx': `import { editAction } from '../../actions'; export default function P() { return <EditableRecord action={editAction} label="s" hidden={{ supplierId: '1' }} typed={typedFor(sp, S_EDIT, '1')}><input name="n" /></EditableRecord>; }`,
      'app/ap/actions.ts': `export async function editAction(fd: FormData) { return await redirectWithFlash('/x', {}, { typed: keepTyping(fd, S_EDIT, '1') }); }`,
    };
    expect(elementFindings(p)).toEqual([]);
    const noKeep = { ...p, 'app/ap/actions.ts': `export async function editAction(fd: FormData) { return await redirectWithFlash('/x', {}, { error: 'e' }); }` };
    expect(elementFindings(noKeep).map((f) => f.rule)).toEqual(['G10c']);
  });

  it('G10e: a versioned form whose keepTyping( call has no stale: is flagged; with stale: it passes; unversioned needs none', () => {
    const noStale = with_({ 'app/x/actions.ts': WIRED['app/x/actions.ts']!.replace(', { stale: isStale(err) }', '') });
    expect(elementFindings(noStale).map((f) => f.rule)).toEqual(['G10e']);
    expect(elementFindings(WIRED)).toEqual([]);
    const unversioned = with_({
      'app/x/page.tsx': WIRED['app/x/page.tsx']!.replace(", version: '2'", ''),
      'app/x/actions.ts': WIRED['app/x/actions.ts']!.replace(', { stale: isStale(err) }', ''),
    });
    expect(elementFindings(unversioned)).toEqual([]);
  });

  it('G10b: a duplicate key, an unbound definition, and a form nobody keeps or reads are flagged', () => {
    const dup = with_({ 'app/y/typed-forms.ts': `export const Y_EDIT = defineTypedForm({ form: 'x.edit', fields: ['a'] });` });
    expect(formFindings(dup).map((f) => f.detail)).toEqual(expect.arrayContaining([expect.stringContaining('defined more than once')]));
    const unbound = with_({ 'app/y/typed-forms.ts': `defineTypedForm({ form: 'y.edit', fields: ['a'] });` });
    expect(formFindings(unbound).map((f) => f.detail)).toEqual(expect.arrayContaining([expect.stringContaining('not bound to a const')]));
    const unused = with_({ 'app/y/typed-forms.ts': `export const Y_EDIT = defineTypedForm({ form: 'y.edit', fields: ['a'] });` });
    const msgs = formFindings(unused).map((f) => f.detail);
    expect(msgs).toEqual(expect.arrayContaining([expect.stringContaining('never passed to keepTyping('), expect.stringContaining('never passed to typedFor(')]));
  });

  it('G10b: keepTyping in a page, or typedFor in an action, does not count as use', () => {
    const swapped: Program = {
      'app/x/page.tsx': `export default function P() { return <div>{keepTyping(fd, X_EDIT, '1')}</div>; }`,
      'app/x/actions.ts': `export async function a() { return typedFor(sp, X_EDIT, '1'); }`,
      'app/x/typed-forms.ts': WIRED['app/x/typed-forms.ts']!,
    };
    expect(formFindings(swapped)).toHaveLength(2);
  });

  it('G10d: an allow-list naming pin / newPin / password / bankAccountNumber, or a rendered password input, is flagged', () => {
    for (const bad of ['pin', 'newPin', 'password', 'bankAccountNumber']) {
      const p = with_({ 'app/x/typed-forms.ts': `export const X_EDIT = defineTypedForm({ form: 'x.edit', fields: ['name', '${bad}'] });` });
      expect(denyFindings(p).map((f) => f.rule), bad).toEqual(['G10d']);
    }
    const pw = with_({
      'app/x/typed-forms.ts': `export const X_EDIT = defineTypedForm({ form: 'x.edit', fields: ['name', 'secretWord'] });`,
      'app/x/login.tsx': `export const L = () => <input type="password" name="secretWord" />;`,
    });
    expect(denyFindings(pw).map((f) => f.detail).join('|')).toContain('password input');
    const re = with_({
      'app/x/typed-forms.ts': `export const X_EDIT = defineTypedForm({ form: 'x.edit', fields: [/^sec/] });`,
      'app/x/login.tsx': `export const L = () => <input type="password" name="secretWord" />;`,
    });
    expect(denyFindings(re).map((f) => f.rule)).toEqual(['G10d']);
  });

  it('G10d (runtime half): defineTypedForm itself throws for a denied name', async () => {
    const specifier = '@/lib/keep-typing';
    const mod = (await import(/* @vite-ignore */ specifier).catch((err: unknown) => {
      throw new Error(`apps/erp/src/lib/keep-typing.ts cannot be loaded (T-389 S1 builder file): ${String(err)}`);
    })) as { defineTypedForm(d: { form: string; fields: ReadonlyArray<string | RegExp> }): unknown };
    expect(() => mod.defineTypedForm({ form: 'x.edit', fields: ['pin'] })).toThrow();
    expect(() => mod.defineTypedForm({ form: 'x.edit', fields: ['name'] })).not.toThrow();
  });

  it('TYPED_EXEMPT: a stale entry (matches no element) and a reasonless entry are both reported', () => {
    const fs = elementFindings(with_({ 'app/y/page.tsx': `export const Y = () => <EditableRecord action={a} label="odd one" hidden={{}} />;` })).filter((f) => f.file === 'app/y/page.tsx');
    expect(fs.length).toBeGreaterThan(0);
    const r = applyExempt(fs, { 'app/y/page.tsx::odd one': '', 'app/gone/page.tsx::nothing': 'was needed once' });
    expect(r.live).toEqual([]);
    expect(r.stale).toEqual(['app/gone/page.tsx::nothing']);
    expect(r.reasonless).toEqual(['app/y/page.tsx::odd one']);
    const unexempt = applyExempt(fs, {});
    expect(unexempt.live).toHaveLength(fs.length);
  });

  it('the ratchet: a count above the baseline fails, a baseline above the count is stale, a missing baseline means empty', () => {
    expect(ratchet({ 'a.tsx': 2 }, { 'a.tsx': 1 })).toHaveLength(1);
    expect(ratchet({ 'a.tsx': 1 }, { 'a.tsx': 2 })).toHaveLength(1);
    expect(ratchet({ 'a.tsx': 1 }, {})).toHaveLength(1);
    expect(ratchet({ 'a.tsx': 1 }, { 'a.tsx': 1 })).toEqual([]);
  });

  it('the resolver follows relative and @/ specifiers and not packages', () => {
    const files: Program = { 'app/ap/actions.ts': '', 'lib/flash.ts': '' };
    expect(resolveModule('app/ap/suppliers/[id]/page.tsx', '../../actions', files)).toBe('app/ap/actions.ts');
    expect(resolveModule('app/ap/page.tsx', '@/lib/flash', files)).toBe('lib/flash.ts');
    expect(resolveModule('app/ap/page.tsx', 'react', files)).toBeUndefined();
  });
});

/** Report helper for the orchestrator: T389_REPORT=1 prints the per-file counts that seed typed-baseline.json. */
describe.skipIf(!process.env['T389_REPORT'])('report', () => {
  it('prints counts', () => {
    const live = applyExempt(elementFindings(tree()), TYPED_EXEMPT).live;
    console.log('G10 total', live.length, 'files', Object.keys(counts(live)).length, JSON.stringify(counts(live), null, 1));
  });
});
