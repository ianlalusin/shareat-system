/**
 * T-440 S2 - the live-check census + ratchet (guards G1-G5). Spec: docs/tasks/440-live-field-checks.md, S2, Audit A12,
 * orchestrator ruling O3.
 *
 * Real TypeScript AST over `apps/erp/src/app/**` and `apps/erp/src/components/**` .tsx (like t384-s3). A "form" is a JSX
 * `form` (non-GET), `<CheckedForm>` or `<EditableRecord>`; a control belongs to its NEAREST enclosing form. The kit's
 * `<Input>` / `<Select>` / `<Textarea>` read as the native control (so converting to the kit never blinds a guard).
 *
 *  CENSUS  A control is RULED (spec 4, R1) when it carries a literal `required` / `maxLength` / `minLength` / `pattern` / `min`
 *          / `max` / numeric-or-decimal `inputMode`, or `type="number|date|email"`. R2/R3 (server-only rules) are not visible
 *          to a static scan of JSX; they come from `docs/tasks/440-census.md` and are judged by G4. Hidden / file /
 *          checkbox / radio inputs are never a ruled control (A12).
 *          CHECKED = the control spreads `nativeAttrs(X.y)` (it is converted). UNCONVERTED = ruled and not checked.
 *  G1      An UNCONVERTED ruled control in a non-GET form is a finding. A control whose `name` is not a string literal
 *          (MoneyLines `${name}Amount_${i}`, `name={expr}`) or that a shared control component renders (ConfirmDestructive)
 *          goes in EXEMPT with a count and a reason, never silently skipped; a stale EXEMPT entry fails (A12, O2).
 *  G2      A control spread from `nativeAttrs(X.y)` sits inside `<Field rule={X.y}>` AND inside a `<CheckedForm rules={X}>`
 *          or `<EditableRecord rules={X}>` naming the same set.
 *  G3      (a) Every rule set exported from `packages/domain/src/field-rules/` reaches `assertFieldRules(` somewhere in
 *          `packages/domain/src` or `apps/erp/src/**.ts` (no client-only rules, row 7). (b) O3: for every form that passes
 *          `rules={X}`, the action it names reaches `assertFieldRules` on X through ITS OWN call chain (directly, or via an
 *          alias const such as `{ creditTermsDays: X.creditTermsDays }`), and every field of X is covered on that path (the
 *          whole set asserted, or `X.field` referenced). Not "somewhere on the server": THAT form's action.
 *  G4      Every row of `docs/tasks/440-census.md` marked R2/R3 names a field that is in a rule set of that file's forms;
 *          the ones that are not are the "server rule lacks a live check" count, ratcheted per file under `serverOnly`.
 *          A row naming a file that is gone is stale. No census doc yet = nothing to judge.
 *  G5      Positive and negative controls on literal fixtures, so the census, G1-G4 and the ratchet cannot go blind.
 *
 * RATCHET. `live-check-baseline.json` ({ unconverted: { "<file>": n }, serverOnly: { "<file>": n } }) is seeded by the
 * ORCHESTRATOR from this guard's HEAD counts and lowered by the orchestrator only (A13). A file's count may never exceed its
 * baseline, a baseline entry above the real count is stale (fails), and a new file with findings fails. Sweeps S3-S7 convert
 * fields, the counts fall, the orchestrator lowers the file's entry (deletes it at 0). S7 ends with the baseline AND EXEMPT
 * empty (S8 then deals with the repeated line fields). A missing baseline file means "empty": every finding fails.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ERP_SRC = resolve(__dirname, '..', 'src');
const APP_ROOT = join(ERP_SRC, 'app');
const COMPONENTS_ROOT = join(ERP_SRC, 'components');
const REPO = resolve(__dirname, '..', '..', '..');
const DOMAIN_SRC = join(REPO, 'packages', 'domain', 'src');
const RULES_DIR = join(DOMAIN_SRC, 'field-rules');
const CENSUS_DOC = join(REPO, 'docs', 'tasks', '440-census.md');
const BASELINE_FILE = join(__dirname, 'live-check-baseline.json');

// ---------------------------------------------------------------------------------------------------------------------
// AST helpers (the t384-s3 parsers, extended for CheckedForm / EditableRecord and the nativeAttrs spread)
// ---------------------------------------------------------------------------------------------------------------------
function parse(source: string, file: string) {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}
type Open = ts.JsxOpeningElement | ts.JsxSelfClosingElement;
function opening(n: ts.Node): Open | undefined {
  if (ts.isJsxElement(n)) return n.openingElement;
  if (ts.isJsxSelfClosingElement(n)) return n;
  return undefined;
}
const tagName = (n: Open) => n.tagName.getText();
function attr(n: Open, name: string): ts.JsxAttribute | undefined {
  return n.attributes.properties.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === name);
}
/** A literal string value of an attribute: `a="x"`, `a={'x'}`, `a={`x`}`; undefined when absent or computed. */
function attrString(n: Open, name: string): string | undefined {
  const a = attr(n, name);
  if (!a) return undefined;
  if (!a.initializer) return '';
  if (ts.isStringLiteral(a.initializer)) return a.initializer.text;
  if (ts.isJsxExpression(a.initializer) && a.initializer.expression) {
    const e = a.initializer.expression;
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  }
  return undefined;
}
/** The whitespace-free source text of an attribute's `{expression}`, for comparing two rule references. */
function attrExpr(n: Open, name: string): string | undefined {
  const a = attr(n, name);
  if (!a?.initializer || !ts.isJsxExpression(a.initializer)) return undefined;
  return a.initializer.expression?.getText().replace(/\s+/g, '');
}
const KIT_NATIVE: Record<string, string> = { Input: 'input', Select: 'select', Textarea: 'textarea' };
const nativeTag = (n: Open) => KIT_NATIVE[tagName(n)] ?? tagName(n);
const CONTROL_TAGS = new Set(['input', 'select', 'textarea']);
const FORM_TAGS = new Set(['form', 'CheckedForm', 'EditableRecord']);
/** A12: these input types are never a text rule (a file, a tick, a hidden carrier). */
const SKIP_TYPES = new Set(['hidden', 'file', 'checkbox', 'radio']);
const lineOf = (sf: ts.SourceFile, n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
function allJsx(sf: ts.SourceFile): Open[] {
  const out: Open[] = [];
  const v = (n: ts.Node) => {
    const o = opening(n);
    if (o) out.push(o);
    ts.forEachChild(n, v);
  };
  v(sf);
  return out;
}
/** The JSX elements enclosing `o`, nearest first (an element's opening node's parent is the element). */
function jsxAncestors(o: Open): Open[] {
  const out: Open[] = [];
  for (let p: ts.Node | undefined = ts.isJsxSelfClosingElement(o) ? o.parent : o.parent?.parent; p; p = p.parent) {
    const x = opening(p);
    if (x) out.push(x);
  }
  return out;
}
const isGetMethod = (o: Open) => (attrString(o, 'method') ?? 'post').toLowerCase() === 'get';
const isNonGetForm = (o: Open) => FORM_TAGS.has(tagName(o)) && !isGetMethod(o);

// ---------------------------------------------------------------------------------------------------------------------
// Census + G1 + G2 over one source
// ---------------------------------------------------------------------------------------------------------------------
interface Control {
  file: string;
  line: number;
  name: string | null; // null = not a string literal
  ruledBy: string[]; // the R1 attributes found
  checkedBy: string | null; // the `X.y` text inside nativeAttrs(X.y), '' when spread but not an X.y, null when not spread
  inForm: boolean;
}
interface FormInfo {
  file: string;
  line: number;
  tag: string;
  rulesExpr: string | null;
  actionExpr: string | null;
}
interface Finding {
  file: string;
  line: number;
  detail: string;
}
interface Scan {
  g1: Finding[];
  g2: Finding[];
  controls: Control[];
  forms: FormInfo[];
}

function r1Attrs(o: Open): string[] {
  const out: string[] = [];
  for (const a of ['required', 'maxLength', 'minLength', 'pattern', 'min', 'max']) if (attr(o, a)) out.push(a);
  if (attr(o, 'inputMode')) {
    const v = attrString(o, 'inputMode');
    if (v === undefined || v === 'numeric' || v === 'decimal') out.push('inputMode');
  }
  const t = attrString(o, 'type');
  if (t === 'number' || t === 'date' || t === 'email') out.push(`type=${t}`);
  return out;
}
function nativeAttrsSpread(o: Open): string | null {
  for (const p of o.attributes.properties) {
    if (!ts.isJsxSpreadAttribute(p)) continue;
    const e = p.expression;
    if (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'nativeAttrs') {
      const arg = e.arguments[0]?.getText().replace(/\s+/g, '') ?? '';
      return /^[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*$/.test(arg) ? arg : '';
    }
  }
  return null;
}

function scan(source: string, file: string): Scan {
  const sf = parse(source, file);
  const jsx = allJsx(sf);
  const forms: FormInfo[] = jsx
    .filter(isNonGetForm)
    .map((o) => ({ file, line: lineOf(sf, o), tag: tagName(o), rulesExpr: attrExpr(o, 'rules') ?? null, actionExpr: attrExpr(o, 'action') ?? null }));
  const controls: Control[] = [];
  const g1: Finding[] = [];
  const g2: Finding[] = [];
  for (const o of jsx) {
    if (!CONTROL_TAGS.has(nativeTag(o))) continue;
    const type = attrString(o, 'type');
    if (type !== undefined && SKIP_TYPES.has(type)) continue;
    const anc = jsxAncestors(o);
    const form = anc.find((a) => FORM_TAGS.has(tagName(a)));
    if (form && isGetMethod(form)) continue; // a GET filter form is not a write form
    const spread = nativeAttrsSpread(o);
    const ruledBy = r1Attrs(o);
    const nameLit = attrString(o, 'name');
    const line = lineOf(sf, o);
    if (spread !== null) {
      const setName = spread.includes('.') ? spread.slice(0, spread.lastIndexOf('.')) : '';
      if (spread === '') g2.push({ file, line, detail: 'nativeAttrs() argument is not a plain X.y rule reference' });
      else {
        if (!anc.some((a) => tagName(a) === 'Field' && attrExpr(a, 'rule') === spread))
          g2.push({ file, line, detail: `nativeAttrs(${spread}) is not inside <Field rule={${spread}}>` });
        if (!anc.some((a) => (tagName(a) === 'CheckedForm' || tagName(a) === 'EditableRecord') && attrExpr(a, 'rules') === setName))
          g2.push({ file, line, detail: `nativeAttrs(${spread}) is not inside a <CheckedForm|EditableRecord rules={${setName}}>` });
      }
    } else if (ruledBy.length > 0) {
      // No enclosing form = a control a shared component renders into a form by composition; still a ruled field.
      g1.push({ file, line, detail: `${nameLit ?? '(non-literal name)'}${form ? '' : ' (no lexical form)'}: ${ruledBy.join(',')} not from nativeAttrs()` });
    }
    controls.push({ file, line, name: nameLit ?? null, ruledBy, checkedBy: spread, inForm: !!form });
  }
  return { g1, g2, controls, forms };
}

// ---------------------------------------------------------------------------------------------------------------------
// The ratchet comparator (G5 proves it bites)
// ---------------------------------------------------------------------------------------------------------------------
function ratchet(actual: Record<string, number>, baseline: Record<string, number>): string[] {
  const problems: string[] = [];
  for (const [f, n] of Object.entries(actual)) {
    const b = baseline[f];
    if (b === undefined) problems.push(`${f}: ${n} finding(s), no baseline entry (a new file may not start with findings)`);
    else if (n > b) problems.push(`${f}: ${n} finding(s) exceeds its baseline ${b} (the count may only fall)`);
  }
  for (const [f, b] of Object.entries(baseline)) {
    const n = actual[f] ?? 0;
    if (b <= 0) problems.push(`${f}: a baseline entry of ${b} is dead weight (delete the entry at 0)`);
    else if (n < b) problems.push(`${f}: baseline ${b} is stale, the real count is ${n} (lower it)`);
  }
  return problems;
}
function countByFile(items: { file: string }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of items) out[i.file] = (out[i.file] ?? 0) + 1;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// G3: rule sets, the function index and the call chain from a form's action (O3)
// ---------------------------------------------------------------------------------------------------------------------
type Sources = Record<string, string>;
interface RuleSetInfo {
  name: string;
  file: string;
  fields: string[];
}
/** Every `export const X = defineFieldRules('form', { a: {...}, b: {...} })` in the given rule files. */
function ruleSets(files: Sources): RuleSetInfo[] {
  const out: RuleSetInfo[] = [];
  for (const [file, src] of Object.entries(files)) {
    const sf = parse(src, file);
    for (const st of sf.statements) {
      if (!ts.isVariableStatement(st) || !st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
      for (const d of st.declarationList.declarations) {
        const init = d.initializer;
        if (!init || !ts.isCallExpression(init) || init.expression.getText() !== 'defineFieldRules' || !ts.isIdentifier(d.name)) continue;
        const obj = init.arguments[1];
        const fields = obj && ts.isObjectLiteralExpression(obj) ? obj.properties.map((p) => (p.name ? p.name.getText().replace(/['"]/g, '') : '')).filter(Boolean) : [];
        out.push({ name: d.name.text, file, fields });
      }
    }
  }
  return out;
}

interface FnDef {
  file: string;
  node: ts.Node;
}
interface Index {
  defs: Map<string, FnDef[]>;
  consts: Map<string, Map<string, string>>; // file -> const name -> initializer text (all depths, collisions joined)
}
function buildIndex(sources: Sources): Index {
  const defs = new Map<string, FnDef[]>();
  const consts = new Map<string, Map<string, string>>();
  const add = (name: string, d: FnDef) => defs.set(name, [...(defs.get(name) ?? []), d]);
  for (const [file, src] of Object.entries(sources)) {
    const sf = parse(src, file);
    const fc = new Map<string, string>();
    consts.set(file, fc);
    const v = (n: ts.Node) => {
      if (ts.isFunctionDeclaration(n) && n.name && n.body) add(n.name.text, { file, node: n.body });
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
        if (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer)) add(n.name.text, { file, node: n.initializer.body });
        fc.set(n.name.text, [fc.get(n.name.text), n.initializer.getText()].filter(Boolean).join(' '));
      }
      ts.forEachChild(n, v);
    };
    v(sf);
  }
  return { defs, consts };
}
function callees(n: ts.Node): Set<string> {
  const out = new Set<string>();
  const v = (x: ts.Node) => {
    if (ts.isCallExpression(x)) {
      const e = x.expression;
      if (ts.isIdentifier(e)) out.add(e.text);
      else if (ts.isPropertyAccessExpression(e)) out.add(e.name.text);
    }
    ts.forEachChild(x, v);
  };
  v(n);
  return out;
}
const noSpace = (s: string) => s.replace(/\s+/g, '');
const wordRe = (w: string, tail = '') => new RegExp(`(?<![\\w$])${w.replace(/\$/g, '\\$')}${tail}(?![\\w$])`, 'g');

/** The function bodies reachable from `start` by name (union over same-named functions), depth-limited. */
function reachable(index: Index, start: string, maxDepth = 8): FnDef[] {
  const seen = new Set<string>();
  const out: FnDef[] = [];
  let frontier = [start];
  for (let d = 0; d <= maxDepth && frontier.length; d++) {
    const next: string[] = [];
    for (const name of frontier) {
      if (seen.has(name)) continue;
      seen.add(name);
      for (const def of index.defs.get(name) ?? []) {
        out.push(def);
        for (const c of callees(def.node)) if (!seen.has(c) && index.defs.has(c)) next.push(c);
      }
    }
    frontier = next;
  }
  return out;
}
/**
 * O3: does the call chain of `actionName` assert rule set `setName`, and which of its fields does it cover? `asserted` is
 * false when no reachable `assertFieldRules(` names the set (directly or through an alias const); `missing` lists fields of
 * the set that the chain neither asserts (whole set / `X.field` in the assert's argument or alias) nor references.
 */
function assertEvidence(index: Index, actionName: string, set: RuleSetInfo): { found: boolean; asserted: boolean; missing: string[] } {
  const defs = reachable(index, actionName);
  if (defs.length === 0) return { found: false, asserted: false, missing: set.fields };
  let asserted = false;
  let whole = false;
  const covered = new Set<string>();
  for (const def of defs) {
    const v = (n: ts.Node) => {
      if (ts.isCallExpression(n) && n.expression.getText() === 'assertFieldRules' && n.arguments[0]) {
        const arg = n.arguments[0];
        const texts = [arg.getText()];
        if (ts.isIdentifier(arg)) {
          const alias = index.consts.get(def.file)?.get(arg.text);
          if (alias) texts.push(alias);
        }
        const joined = texts.join(' ');
        if (wordRe(set.name).test(joined)) {
          asserted = true;
          if (texts.some((t) => noSpace(t) === set.name || noSpace(t) === `{...${set.name}}`) || wordRe('\\.\\.\\.\\s*' + set.name).test(joined)) whole = true;
          for (const m of joined.matchAll(wordRe(set.name, '\\.(\\w+)'))) covered.add(m[1]);
        }
      }
      ts.forEachChild(n, v);
    };
    v(def.node);
    for (const m of def.node.getText().matchAll(wordRe(set.name, '\\.(\\w+)'))) covered.add(m[1]);
  }
  return { found: true, asserted, missing: asserted && !whole ? set.fields.filter((f) => !covered.has(f)) : asserted ? [] : set.fields };
}
/** G3a over a source universe: each set reaches an assertFieldRules call (by name, direct or via an alias const). */
function unassertedSets(sets: RuleSetInfo[], universe: Sources): string[] {
  const index = buildIndex(universe);
  const bad: string[] = [];
  for (const s of sets) {
    let hit = false;
    for (const [file, src] of Object.entries(universe)) {
      const sf = parse(src, file);
      const v = (n: ts.Node) => {
        if (ts.isCallExpression(n) && n.expression.getText() === 'assertFieldRules' && n.arguments[0]) {
          const arg = n.arguments[0];
          const texts = [arg.getText()];
          if (ts.isIdentifier(arg)) {
            const a = index.consts.get(file)?.get(arg.text);
            if (a) texts.push(a);
          }
          if (wordRe(s.name).test(texts.join(' '))) hit = true;
        }
        ts.forEachChild(n, v);
      };
      v(sf);
      if (hit) break;
    }
    if (!hit) bad.push(s.name);
  }
  return bad;
}
/** G3b over forms: every `rules={X}` form's action asserts X, covering every field. */
function formActionProblems(forms: FormInfo[], sets: RuleSetInfo[], index: Index): string[] {
  const problems: string[] = [];
  for (const f of forms) {
    if (!f.rulesExpr) continue;
    const loc = `${f.file}:${f.line}`;
    const set = sets.find((s) => s.name === f.rulesExpr);
    if (!set) {
      problems.push(`${loc}: <${f.tag} rules={${f.rulesExpr}}> names no exported rule set`);
      continue;
    }
    const actionName = f.actionExpr?.match(/^[A-Za-z_$][\w$]*/)?.[0];
    if (!actionName) {
      problems.push(`${loc}: <${f.tag} rules={${set.name}}> has no resolvable action={...}`);
      continue;
    }
    const ev = assertEvidence(index, actionName, set);
    if (!ev.found) problems.push(`${loc}: action ${actionName} was not found in the server sources`);
    else if (!ev.asserted) problems.push(`${loc}: action ${actionName} never reaches assertFieldRules on ${set.name}`);
    else if (ev.missing.length) problems.push(`${loc}: action ${actionName} asserts ${set.name} but not its field(s) ${ev.missing.join(', ')}`);
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------------
// G4: the census table
// ---------------------------------------------------------------------------------------------------------------------
interface CensusRow {
  file: string;
  field: string;
  kinds: string;
}
function parseCensus(md: string): CensusRow[] {
  const rows: CensusRow[] = [];
  let cols: { file: number; field: number; kind: number } | null = null;
  for (const line of md.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    const lower = cells.map((c) => c.toLowerCase());
    if (lower.some((c) => c === 'file') && lower.some((c) => c === 'field')) {
      cols = { file: lower.indexOf('file'), field: lower.indexOf('field'), kind: lower.findIndex((c) => /^r1/.test(c) || c.includes('r1/r2')) };
      continue;
    }
    if (!cols || cols.kind < 0 || /^[-:\s|]+$/.test(line) || cells.every((c) => /^[-: ]*$/.test(c))) continue;
    rows.push({ file: cells[cols.file].replace(/`/g, ''), field: cells[cols.field].replace(/`/g, ''), kinds: cells[cols.kind] });
  }
  return rows;
}
/** R2/R3 rows whose field is in NO rule set of any `rules=` form in that file -> per-file count; plus rows naming a vanished file. */
function serverOnly(rows: CensusRow[], knownFiles: Set<string>, formsByFile: Record<string, FormInfo[]>, sets: RuleSetInfo[]): { counts: Record<string, number>; stale: string[] } {
  const counts: Record<string, number> = {};
  const stale: string[] = [];
  for (const r of rows) {
    if (!/R[23]/.test(r.kinds)) continue;
    if (!knownFiles.has(r.file)) {
      stale.push(`${r.file} (${r.field})`);
      continue;
    }
    const names = (formsByFile[r.file] ?? []).map((f) => f.rulesExpr).filter((x): x is string => !!x);
    const covered = names.some((n) => sets.find((s) => s.name === n)?.fields.includes(r.field));
    if (!covered) counts[r.file] = (counts[r.file] ?? 0) + 1;
  }
  return { counts, stale };
}

// ---------------------------------------------------------------------------------------------------------------------
// The real tree
// ---------------------------------------------------------------------------------------------------------------------
function walk(dir: string, accept: (f: string) => boolean, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '.next') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, accept, out);
    else if (accept(p)) out.push(p);
  }
  return out;
}
const key = (f: string) => (f.startsWith(COMPONENTS_ROOT) ? 'components/' + relative(COMPONENTS_ROOT, f) : relative(APP_ROOT, f)).replace(/\\/g, '/');
const read = (f: string) => readFileSync(f, 'utf8');
const toSources = (files: string[], k: (f: string) => string): Sources => Object.fromEntries(files.map((f) => [k(f), read(f)]));

const tsxFiles = [...walk(APP_ROOT, (f) => f.endsWith('.tsx')), ...walk(COMPONENTS_ROOT, (f) => f.endsWith('.tsx'))];
const ruleFiles = walk(RULES_DIR, (f) => f.endsWith('.ts') && !f.endsWith('index.ts') && !f.endsWith('check.ts'));
const serverFiles = [
  ...walk(DOMAIN_SRC, (f) => f.endsWith('.ts') && !f.startsWith(RULES_DIR)),
  ...walk(ERP_SRC, (f) => f.endsWith('.ts') && !f.endsWith('.d.ts')),
];

/**
 * A12 / O2: ruled controls the guard cannot convert one by one. Keyed by file; `count` is the exact number of unconverted
 * ruled controls it absorbs from that file's findings; `reason` says why. A stale entry (count above reality) fails.
 * Filled from the first run of this guard; S7 empties it, S8 owns the repeated line fields.
 */
const REPEATED = 'repeated line family: the name is built per row (S8 owns the family rule, orchestrator ruling O2)';
const EXEMPT: Record<string, { count: number; reason: string }> = {
  'components/money/MoneyLines.tsx': { count: 1, reason: `shared MoneyLines (9 consumer files): ${REPEATED}` },
  'components/two-way-picker.tsx': { count: 2, reason: 'shared picker: the control names arrive as props (fromName / toName), one component for every caller' },
  'components/ui/ConfirmDestructive.tsx': { count: 1, reason: 'shared control: the controlled administrator-PIN input of ConfirmDestructive (A12)' },
  'ap/invoices/[id]/page.tsx': { count: 3, reason: `invoice line inputs line\${i}_quantity / _conversionFactor: ${REPEATED}` },
  'ap/suppliers/[id]/AutoAllocatePaymentForm.tsx': { count: 1, reason: `per-invoice allocation amount: controlled input with no literal name (${REPEATED})` },
  'ap/suppliers/[id]/page.tsx': { count: 1, reason: 'local field helper: name / required arrive as props, one component for many callers' },
  'attendance/terminals/ProvisionForm.tsx': { count: 1, reason: 'controlled client-state input with no literal name (the label state, not a posted field)' },
  'channel-settlements/SettlementForm.tsx': { count: 1, reason: `deduction rows name={d.name} from data: ${REPEATED}` },
  'customers/[customerId]/AutoAllocateCollectionForm.tsx': { count: 1, reason: `per-invoice allocation amount: controlled input with no literal name (${REPEATED})` },
  'remittance/page.tsx': { count: 2, reason: `lineAmount_\${i} / lineOverage_\${i}: ${REPEATED}` },
  'sales-days/[id]/page.tsx': { count: 1, reason: `channel_\${c.id} per-channel amounts: ${REPEATED}` },
  'settings/attendance/page.tsx': { count: 2, reason: 'local number-field helpers: name arrives as a prop, one component for many callers' },
  'till/page.tsx': { count: 1, reason: `count:\${a.id} per-denomination counts: ${REPEATED}` },
};

let cached: Scan | undefined;
const realScan = (): Scan => {
  if (cached) return cached;
  const all: Scan = { g1: [], g2: [], controls: [], forms: [] };
  for (const f of tsxFiles) {
    const r = scan(read(f), key(f));
    all.g1.push(...r.g1);
    all.g2.push(...r.g2);
    all.controls.push(...r.controls);
    all.forms.push(...r.forms);
  }
  cached = all;
  return all;
};
function loadBaseline(): { unconverted: Record<string, number>; serverOnly: Record<string, number> } {
  if (!existsSync(BASELINE_FILE)) return { unconverted: {}, serverOnly: {} };
  const j = JSON.parse(read(BASELINE_FILE)) as { unconverted?: Record<string, number>; serverOnly?: Record<string, number> };
  return { unconverted: j.unconverted ?? {}, serverOnly: j.serverOnly ?? {} };
}
function exemptApplied(g1: Finding[], exempt: Record<string, { count: number; reason: string }> = EXEMPT): { counts: Record<string, number>; stale: string[] } {
  const raw = countByFile(g1);
  const counts: Record<string, number> = { ...raw };
  const stale: string[] = [];
  for (const [f, e] of Object.entries(exempt)) {
    if (!e.reason.trim()) stale.push(`${f}: EXEMPT entry has no reason`);
    if ((raw[f] ?? 0) < e.count) {
      stale.push(`${f}: EXEMPT absorbs ${e.count} but the file has only ${raw[f] ?? 0} finding(s) (stale)`);
      continue;
    }
    counts[f] = raw[f] - e.count;
    if (counts[f] === 0) delete counts[f];
  }
  return { counts, stale };
}

if (process.env.T440_DUMP) {
  describe('dump', () => {
    it('prints', () => {
      const all = realScan();
      console.log(
        JSON.stringify(
          {
            forms: all.forms.length,
            formsWithRules: all.forms.filter((f) => f.rulesExpr).length,
            controls: all.controls.length,
            ruled: all.controls.filter((c) => c.ruledBy.length || c.checkedBy !== null).length,
            converted: all.controls.filter((c) => c.checkedBy !== null).length,
            unconverted: all.g1.length,
            nonLiteralByFile: countByFile(all.g1.filter((g) => g.detail.startsWith('(non-literal'))),
            noForm: countByFile(all.g1.filter((g) => g.detail.includes('no lexical form'))),
            g2: all.g2,
            byFile: countByFile(all.g1),
            BASELINE: exemptApplied(all.g1).counts,
          },
          null,
          1,
        ),
      );
    });
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------------------------------------------------
describe('T-440 S2 census + ratchet over the real tree', () => {
  it('the scan sees the tree (it did not go blind)', () => {
    const all = realScan();
    expect(tsxFiles.length).toBeGreaterThan(200);
    expect(all.forms.length).toBeGreaterThan(80);
    expect(all.controls.length).toBeGreaterThan(400);
    // the two S1 pilots are converted, so the converted branch is exercised by real code
    expect(all.controls.filter((c) => c.checkedBy !== null).length).toBeGreaterThanOrEqual(6);
  });

  it('G1: unconverted ruled controls per file never exceed the baseline, and the baseline is never stale', () => {
    const { counts, stale } = exemptApplied(realScan().g1);
    expect(stale).toEqual([]);
    expect(ratchet(counts, loadBaseline().unconverted)).toEqual([]);
  });

  it('G1: every EXEMPT entry carries a reason and a positive count', () => {
    for (const [f, e] of Object.entries(EXEMPT)) {
      expect(e.reason.length, f).toBeGreaterThan(10);
      expect(e.count, f).toBeGreaterThan(0);
    }
  });

  it('G2: every converted control sits in its own <Field rule> and <CheckedForm|EditableRecord rules>', () => {
    expect(realScan().g2).toEqual([]);
  });

  describe('G3 (server half)', () => {
    const sets = ruleSets(toSources(ruleFiles, key));
    const universe = toSources(serverFiles, (f) => relative(REPO, f).replace(/\\/g, '/'));
    it('the rule files define rule sets (we are not looking at nothing)', () => {
      expect(sets.length).toBeGreaterThanOrEqual(2);
    });
    it('G3a: every exported rule set reaches assertFieldRules on the server (no client-only rules)', () => {
      expect(unassertedSets(sets, universe)).toEqual([]);
    });
    it('G3b (O3): every <CheckedForm|EditableRecord rules={X}> has an action whose own call chain asserts X, every field', () => {
      expect(formActionProblems(realScan().forms, sets, buildIndex(universe))).toEqual([]);
    });
  });

  it('G4: R2/R3 census rows with no live check are ratcheted per file; no row names a vanished file', () => {
    const base = loadBaseline().serverOnly;
    if (!existsSync(CENSUS_DOC)) {
      // Nothing to judge until the census doc exists; the baseline must not claim otherwise.
      expect(base).toEqual({});
      return;
    }
    const all = realScan();
    const formsByFile: Record<string, FormInfo[]> = {};
    for (const f of all.forms) (formsByFile[f.file] ??= []).push(f);
    const sets = ruleSets(toSources(ruleFiles, key));
    const r = serverOnly(parseCensus(read(CENSUS_DOC)), new Set(tsxFiles.map(key)), formsByFile, sets);
    expect(r.stale).toEqual([]);
    expect(ratchet(r.counts, base)).toEqual([]);
  });

  it('prints the census (informational)', () => {
    const all = realScan();
    const ruled = all.controls.filter((c) => c.ruledBy.length || c.checkedBy !== null).length;
    const converted = all.controls.filter((c) => c.checkedBy !== null).length;
    // eslint-disable-next-line no-console
    console.log(`T-440 census: ${all.forms.length} write forms; ${ruled} ruled fields; ${converted} converted; ${all.g1.length} unconverted`);
    expect(ruled).toBe(converted + all.g1.length);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// G5: positive and negative controls on literal fixtures
// ---------------------------------------------------------------------------------------------------------------------
const wrap = (jsx: string) => `export default function P() { return (${jsx}); }`;
const g1Of = (jsx: string) => scan(wrap(jsx), 'x.tsx').g1;
const g2Of = (jsx: string) => scan(wrap(jsx), 'x.tsx').g2;

describe('G5 controls: G1 bites and does not over-fire (census scope, A12)', () => {
  it('an R1 control in a write form is a finding', () => {
    expect(g1Of('<form action={a}><input name="x" required /></form>')).toHaveLength(1);
    expect(g1Of('<form action={a}><input name="x" maxLength={20} /></form>')).toHaveLength(1);
    expect(g1Of('<form action={a}><input name="x" minLength={2} /></form>')).toHaveLength(1);
    expect(g1Of('<form action={a}><input name="x" pattern="[0-9]+" /></form>')).toHaveLength(1);
    expect(g1Of('<form action={a}><input name="x" min="0" /></form>')).toHaveLength(1);
    expect(g1Of('<form action={a}><input name="x" max={9} /></form>')).toHaveLength(1);
    expect(g1Of('<form action={a}><input name="x" inputMode="numeric" /></form>')).toHaveLength(1);
    expect(g1Of('<form action={a}><input name="x" inputMode="decimal" /></form>')).toHaveLength(1);
  });
  it('type=email / number / date count as R1 (A12, spec 4)', () => {
    for (const t of ['email', 'number', 'date']) expect(g1Of(`<form action={a}><input name="x" type="${t}" /></form>`), t).toHaveLength(1);
  });
  it('the kit Input / Select / Textarea read as the native control', () => {
    expect(g1Of('<form action={a}><Input name="x" required /></form>')).toHaveLength(1);
    expect(g1Of('<form action={a}><Select name="x" required /></form>')).toHaveLength(1);
    expect(g1Of('<form action={a}><Textarea name="x" maxLength={50} /></form>')).toHaveLength(1);
  });
  it('CheckedForm and EditableRecord are forms (the converted tags do not blind the census)', () => {
    expect(g1Of('<CheckedForm action={a}><Input name="x" required /></CheckedForm>')).toHaveLength(1);
    expect(g1Of('<EditableRecord action={a}><Input name="x" required /></EditableRecord>')).toHaveLength(1);
    expect(scan(wrap('<CheckedForm rules={R} action={a}><Input name="x" /></CheckedForm>'), 'x.tsx').forms).toHaveLength(1);
  });
  it('hidden / file / checkbox / radio carry no rule (A12)', () => {
    for (const t of ['hidden', 'file', 'checkbox', 'radio'])
      expect(g1Of(`<form action={a}><input name="x" type="${t}" required /></form>`), t).toHaveLength(0);
  });
  it('a GET form and a control with no rule attribute are not findings; inputMode="text" is not numeric', () => {
    expect(g1Of('<form method="get"><input name="q" required /></form>')).toHaveLength(0);
    expect(g1Of('<form method="GET"><input name="q" maxLength={4} /></form>')).toHaveLength(0);
    expect(g1Of('<form action={a}><input name="x" placeholder="p" /></form>')).toHaveLength(0);
    expect(g1Of('<form action={a}><input name="x" inputMode="text" /></form>')).toHaveLength(0);
  });
  it('a ruled control with no lexical form (a shared component renders it into a form) is still a finding, labelled', () => {
    const f = g1Of('<div><input name="x" required /></div>');
    expect(f).toHaveLength(1);
    expect(f[0].detail).toContain('no lexical form');
    expect(g1Of('<div><input name="x" /></div>')).toHaveLength(0);
  });
  it('the NEAREST form decides: a control in a GET form nested in a write form is out; one in a write form inside a GET shell is in', () => {
    expect(g1Of('<form action={a}><form method="get"><input name="q" required /></form></form>')).toHaveLength(0);
    expect(g1Of('<form method="get"><form action={a}><input name="q" required /></form></form>')).toHaveLength(1);
  });
  it('a control inside the extra={...} of an EditableRecord counts for the form it sits in', () => {
    expect(g1Of('<EditableRecord action={a} extra={<form action={b}><input name="x" required /></form>}><Input name="y" /></EditableRecord>')).toHaveLength(1);
  });
  it('a non-literal (or missing) name is a finding labelled as such (it must be listed in EXEMPT, not skipped)', () => {
    const f = g1Of('<form action={a}><input name={`${n}Amount_${i}`} required /></form>');
    expect(f).toHaveLength(1);
    expect(f[0].detail).toContain('(non-literal name)');
    expect(g1Of('<form action={a}><input name={fieldName} required /></form>')[0].detail).toContain('(non-literal name)');
    expect(g1Of('<form action={a}><input required /></form>')[0].detail).toContain('(non-literal name)');
  });
  it('a converted control (spread nativeAttrs) is NOT a G1 finding even with the attrs it spreads', () => {
    const ok = '<CheckedForm rules={R} action={a}><Field label="n" rule={R.n}><Input {...nativeAttrs(R.n)} maxLength={5} /></Field></CheckedForm>';
    expect(g1Of(ok)).toHaveLength(0);
  });
  it('counts one finding per control, with a line number', () => {
    const r = scan(wrap('<form action={a}><input name="a" required /><input name="b" required /><input name="c" /></form>'), 'x.tsx');
    expect(r.g1).toHaveLength(2);
    expect(r.g1.every((f) => f.line >= 1)).toBe(true);
    expect(r.controls).toHaveLength(3);
  });
});

describe('G5 controls: G2 bites', () => {
  const good = (s: string) => `<CheckedForm rules={R} action={a}><Field label="n" rule={R.n}>${s}</Field></CheckedForm>`;
  it('the full converted shape passes (CheckedForm and EditableRecord)', () => {
    expect(g2Of(good('<Input {...nativeAttrs(R.n)} />'))).toEqual([]);
    expect(g2Of('<EditableRecord rules={R} action={a}><Field label="n" rule={R.n}><Input {...nativeAttrs(R.n)} /></Field></EditableRecord>')).toEqual([]);
  });
  it('a plain form that spreads nativeAttrs is a finding (no CheckedForm holds the state)', () => {
    expect(g2Of('<form action={a}><Field label="n" rule={R.n}><Input {...nativeAttrs(R.n)} /></Field></form>')).toHaveLength(1);
  });
  it('a missing <Field rule> is a finding', () => {
    expect(g2Of('<CheckedForm rules={R} action={a}><label>n<Input {...nativeAttrs(R.n)} /></label></CheckedForm>')).toHaveLength(1);
  });
  it('a Field naming another field is a finding', () => {
    expect(g2Of('<CheckedForm rules={R} action={a}><Field label="n" rule={R.m}><Input {...nativeAttrs(R.n)} /></Field></CheckedForm>')).toHaveLength(1);
  });
  it('a form holding a DIFFERENT set is a finding (same set on both, spec G2)', () => {
    expect(g2Of('<CheckedForm rules={Q} action={a}><Field label="n" rule={R.n}><Input {...nativeAttrs(R.n)} /></Field></CheckedForm>')).toHaveLength(1);
  });
  it('a spread control outside any form is a finding; an odd argument is a finding', () => {
    expect(g2Of('<Field label="n" rule={R.n}><Input {...nativeAttrs(R.n)} /></Field>')).toHaveLength(1);
    expect(g2Of(good('<Input {...nativeAttrs(pick())} />'))).toHaveLength(1);
  });
  it('a form with no rules= attribute does not satisfy G2', () => {
    expect(g2Of('<CheckedForm action={a}><Field label="n" rule={R.n}><Input {...nativeAttrs(R.n)} /></Field></CheckedForm>')).toHaveLength(1);
  });
});

describe('G5 controls: census counts', () => {
  it('ruled = converted + unconverted; hidden/file/checkbox/radio and GET-form controls are not counted as ruled findings', () => {
    const r = scan(
      wrap(
        '<div><CheckedForm rules={R} action={a}><Field label="n" rule={R.n}><Input {...nativeAttrs(R.n)} /></Field><input name="u" required /></CheckedForm>' +
          '<form method="get"><input name="q" required /></form><form action={a}><input type="checkbox" name="c" required /></form></div>',
      ),
      'x.tsx',
    );
    expect(r.forms).toHaveLength(2);
    expect(r.controls.filter((c) => c.checkedBy !== null)).toHaveLength(1);
    expect(r.g1).toHaveLength(1);
  });
});

describe('G5 controls: the ratchet bites', () => {
  it('a rise, a new file, a stale entry and a missing baseline all fail; equal and an untouched file pass', () => {
    expect(ratchet({ 'a.tsx': 3 }, { 'a.tsx': 3 })).toEqual([]);
    expect(ratchet({}, {})).toEqual([]);
    expect(ratchet({ 'a.tsx': 4 }, { 'a.tsx': 3 })).toHaveLength(1); // rose
    expect(ratchet({ 'b.tsx': 1 }, { 'a.tsx': 0 })).toHaveLength(2); // new file with findings + a stale zero entry
    expect(ratchet({ 'a.tsx': 2 }, { 'a.tsx': 3 })).toHaveLength(1); // fell but baseline not lowered: stale
    expect(ratchet({ 'a.tsx': 1 }, {})).toHaveLength(1); // no baseline file = every finding fails
  });
  it('EXEMPT: absorbs only its count, and a stale count is reported', () => {
    const f = (file: string, n: number): Finding[] => Array.from({ length: n }, (_, i) => ({ file, line: i + 1, detail: 'd' }));
    const ex = { 'a.tsx': { count: 2, reason: 'a real reason' } };
    expect(exemptApplied(f('a.tsx', 3), ex)).toEqual({ counts: { 'a.tsx': 1 }, stale: [] }); // absorbs exactly its count
    expect(exemptApplied(f('a.tsx', 2), ex)).toEqual({ counts: {}, stale: [] });
    expect(exemptApplied(f('a.tsx', 1), ex).stale).toHaveLength(1); // stale: absorbs more than exists
    expect(exemptApplied([], ex).stale).toHaveLength(1);
    expect(exemptApplied(f('a.tsx', 2), { 'a.tsx': { count: 2, reason: ' ' } }).stale).toHaveLength(1); // no reason
    expect(exemptApplied(f('b.tsx', 1), ex).counts).toEqual({ 'b.tsx': 1 }); // another file is not absorbed
  });
});

describe('G5 controls: G3 bites (O3: THAT form\'s own action)', () => {
  const set = (fields: string[], name = 'R'): RuleSetInfo => ({ name, file: 'rules.ts', fields });
  const R = set(['name', 'days']);
  const idx = (src: Sources) => buildIndex(src);
  const form = (rules: string, action: string): FormInfo => ({ file: 'p.tsx', line: 1, tag: 'CheckedForm', rulesExpr: rules, actionExpr: action });

  it('passes: action -> domain fn -> assertFieldRules(R, ...) whole set', () => {
    const i = idx({
      'a.ts': 'export async function saveAction(fd){ await save(fd); }',
      'd.ts': 'export function save(fd){ return assertFieldRules(R, fd); }',
    });
    expect(formActionProblems([form('R', 'saveAction')], [R], i)).toEqual([]);
  });
  it('passes: asserted through an alias const that picks fields, the rest referenced as R.field', () => {
    const i = idx({
      'a.ts': 'export async function saveAction(fd){ await save(fd); }',
      'd.ts': 'const SUB = { form: R.form, days: R.days };\nexport function save(fd){ const n = R.name; judge(fd); }\nfunction judge(fd){ assertFieldRules(SUB, fd); }',
    });
    expect(formActionProblems([form('R', 'saveAction')], [R], i)).toEqual([]);
  });
  it('MUTANT delete the server call -> red', () => {
    const i = idx({ 'a.ts': 'export async function saveAction(fd){ await save(fd); }', 'd.ts': 'export function save(fd){ return fd; }' });
    expect(formActionProblems([form('R', 'saveAction')], [R], i)).toHaveLength(1);
  });
  it('O3: asserted in a function the form\'s action never reaches -> red (the set reaches the server, but not THIS path)', () => {
    const universe = {
      'a.ts': 'export async function saveAction(fd){ await save(fd); }',
      'd.ts': 'export function save(fd){ return fd; }\nexport function otherPath(fd){ return assertFieldRules(R, fd); }',
    };
    expect(unassertedSets([R], universe)).toEqual([]); // G3a alone is satisfied...
    expect(formActionProblems([form('R', 'saveAction')], [R], idx(universe))).toHaveLength(1); // ...G3b is not
  });
  it('asserting a DIFFERENT set is red; a set missing a field is red; an unknown action / set is red', () => {
    const i = idx({ 'a.ts': 'export async function saveAction(fd){ return assertFieldRules(Q, fd); }' });
    expect(formActionProblems([form('R', 'saveAction')], [R, set(['x'], 'Q')], i)).toHaveLength(1);
    const partial = idx({ 'a.ts': 'export async function saveAction(fd){ return assertFieldRules({ form: R.form, name: R.name }, fd); }' });
    const p = formActionProblems([form('R', 'saveAction')], [R], partial);
    expect(p).toHaveLength(1);
    expect(p[0]).toContain('days');
    expect(formActionProblems([form('R', 'nopeAction')], [R], i)).toHaveLength(1);
    expect(formActionProblems([form('Z', 'saveAction')], [R], i)).toHaveLength(1);
    expect(formActionProblems([{ ...form('R', 'x'), actionExpr: null }], [R], i)).toHaveLength(1);
  });
  it('a form with no rules= is not judged by G3b', () => {
    expect(formActionProblems([{ ...form('R', 'x'), rulesExpr: null }], [R], idx({}))).toEqual([]);
  });
  it('G3a: a client-only set (never asserted) is red; one asserted anywhere passes', () => {
    expect(unassertedSets([R], { 'd.ts': 'export function f(){ return 1; }' })).toEqual(['R']);
    expect(unassertedSets([R], { 'd.ts': 'export function f(fd){ return assertFieldRules(R, fd); }' })).toEqual([]);
    expect(unassertedSets([R], { 'd.ts': 'const S = { a: R.name };\nexport function f(fd){ return assertFieldRules(S, fd); }' })).toEqual([]);
    expect(unassertedSets([R], { 'd.ts': 'export function f(fd){ return checkField(R.name, fd); }' })).toEqual(['R']); // checkField is not the server assert
    expect(unassertedSets([R], { 'd.ts': 'export const RR = 1;\nexport function f(fd){ return assertFieldRules(RR, fd); }' })).toEqual(['R']); // word match, not substring
  });
  it('ruleSets() reads exported defineFieldRules sets and their fields, and ignores a non-exported or other call', () => {
    const r = ruleSets({
      'x.ts':
        "export const A = defineFieldRules('a.b', { one: { label: 'x' }, two: { label: 'y' } });\nconst B = defineFieldRules('b', { z: {} });\nexport const C = other('c', { y: {} });",
    });
    expect(r).toEqual([{ name: 'A', file: 'x.ts', fields: ['one', 'two'] }]);
  });
});

describe('G5 controls: G4 bites', () => {
  const md = [
    '| file | form | field | R1/R2/R3 | server function | slice |',
    '|---|---|---|---|---|---|',
    '| ap/page.tsx | supplier add | name | R1,R2 | createSupplier | S4 |',
    '| ap/page.tsx | supplier add | tin | R2 | createSupplier | S4 |',
    '| gone/page.tsx | x | y | R3 | f | S6 |',
    '| ap/page.tsx | supplier add | notes | R1 | - | S4 |',
  ].join('\n');
  it('parses the table and judges only R2/R3 rows', () => {
    const rows = parseCensus(md);
    expect(rows).toHaveLength(4);
    const forms = { 'ap/page.tsx': [{ file: 'ap/page.tsx', line: 1, tag: 'CheckedForm', rulesExpr: 'R', actionExpr: 'a' }] };
    const r = serverOnly(rows, new Set(['ap/page.tsx']), forms, [{ name: 'R', file: 'r.ts', fields: ['name'] }]);
    expect(r.counts).toEqual({ 'ap/page.tsx': 1 }); // tin: server rule with no live check; name is covered; notes is R1 only
    expect(r.stale).toEqual(['gone/page.tsx (y)']);
  });
  it('a file with no converted form counts every R2/R3 row', () => {
    const r = serverOnly(parseCensus(md), new Set(['ap/page.tsx', 'gone/page.tsx']), {}, []);
    expect(r.counts).toEqual({ 'ap/page.tsx': 2, 'gone/page.tsx': 1 });
  });
  it('a header-less or kind-less table yields no rows', () => {
    expect(parseCensus('| a | b |\n|---|---|\n| 1 | 2 |')).toEqual([]);
  });
});
