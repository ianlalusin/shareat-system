/**
 * T-384 S3a - guards G7 (lock), G8 (submit label), G9 (positive controls). Spec:
 * docs/tasks/384-pos-link-tenders-and-width.md, S3a. Amendment A0 (L1, L4, L5), A4 (Q2 = a).
 *
 * Real TypeScript AST over `apps/erp/src/app/**` .tsx. Scope: non-GET `<form>` elements.
 *
 *  G7  A form with a hidden `id` / `*Id` input AND a control whose `defaultValue` / `defaultChecked`
 *      reads a record (`ident.x` or `ident?.x`) must be rendered through `<EditableRecord` (an ancestor
 *      JSX element), or its file must be in EXEMPT with a reason. A raw form is the edit-in-place
 *      shape A0 outlaws.
 *  G8  Every submit label (`<button type="submit">`, a `<button>` with no type, `<input type=submit>`)
 *      and the LAST button of every non-GET form must be exactly "Save" / "Save draft", a COMMANDS
 *      verb (L5, each with a reason) or a TOGGLES pair. "Add ...", "Create ...", "Update" and
 *      "Save <noun>" fail.
 *  G9  Positive controls on literal fixtures, so neither guard can go blind.
 *
 * RATCHET. `editable-record-baseline.json` ({ "<file>": <count> }) and `submit-label-baseline.json`
 * are seeded by the ORCHESTRATOR from this guard's HEAD counts and lowered by the orchestrator only.
 * A file's count may never exceed its baseline, and a baseline entry above the real count is stale
 * (fails), so the ratchet only ever tightens. A missing baseline file means "empty": every finding
 * then fails, which is the right red until the orchestrator seeds it. Both end empty (S3b).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const APP_ROOT = resolve(__dirname, '..', 'src', 'app');
const rel = (f: string) => relative(APP_ROOT, f).replace(/\\/g, '/');

/** Files whose raw record-bound form is deliberate. Each needs a reason. Empty at the end of S3b. */
const EXEMPT: Record<string, string> = {};

/**
 * L5 / Q2 = a (Ian; orchestrator ruling 2026-10-08). A COMMAND posts money, moves stock, changes a record's
 * status, or grants / revokes access, and keeps its own verb. A key ending in " *" matches that verb followed
 * by anything ("Void *" matches "Void payment"); any other key matches the whole label. Plain data entry
 * (Save X, Set X, Add / Create / Record X on master data, Rename, Hire) is NOT here: it must say Save.
 */
const COMMANDS: Record<string, string> = {
  'Record payment': 'books money out for good (Q2)',
  'Record transfer': 'moves money between accounts',
  'Record the draw': 'books an owner draw',
  'Record contribution': 'books an owner contribution',
  'Record drawing': 'books an owner drawing',
  'Record loan': 'books a loan',
  'Record obligation': 'books a liability',
  'Record prepaid item': 'books a prepayment',
  'Record handover': 'books a cash handover',
  Record: 'books a payout (cash-requests)',
  'Post *': 'posts to the ledger',
  'Pay *': 'books a payment',
  'Charge *': 'books a charge',
  'Reverse *': 'reverses a posting',
  'Refund *': 'books a refund',
  'Distribute *': 'distributes money',
  'Write *': 'writes an amount off',
  'Recognise *': 'books income',
  'Book it': 'books a posting',
  'Transfer *': 'moves stock',
  'Receive *': 'receives stock',
  'Dispatch *': 'dispatches stock',
  'Return *': 'returns stock or goods',
  'Dispose *': 'disposes of an asset',
  'Approve *': 'moves a status',
  'Accept *': 'moves a status',
  'Reject *': 'moves a status',
  'Decline *': 'moves a status',
  'Refuse *': 'moves a status',
  'Decide *': 'moves a status',
  'Defer *': 'moves a status',
  'Verify *': 'moves a status',
  'Void *': 'voids a document',
  void: 'voids a document',
  'Cancel count': 'moves a status',
  'Commit *': 'commits a count',
  'Close *': 'moves a status',
  'Confirm *': 'confirms a status change',
  'I confirm this is done': 'confirms a cutover step',
  'Finalize *': 'moves a status',
  'Finish *': 'moves a status',
  'Mark *': 'moves a status',
  Propose: 'moves a status',
  'Submit *': 'moves a status',
  Resolve: 'moves a status',
  'Dispute *': 'moves a status',
  Override: 'overrides a verified day',
  '\u2192 Move to reviewing': 'moves a status',
  'Flag as unmappable': 'moves a status',
  'Open branch': 'opening a store is a status change',
  'Create the missing month': 'creates a period',
  'Make default': 'changes which record is default',
  'Delete *': 'deletes a record',
  'Discard *': 'discards a record',
  'Remove *': 'removes a link or cap',
  'Release *': 'releases money held',
  'Withdraw *': 'withdraws a request',
  Link: 'links records',
  Pair: 'pairs a device',
  'Revoke *': 'revokes access',
  'Grant *': 'grants access',
  'Hold in their own right': 'grants access',
  'Enrol *': 'grants a credential',
  'End employment': 'moves a status',
  'Import from POS': 'imports sales',
  'Re-import from POS': 'imports sales',
  Run: 'runs a depreciation',
  'Record closing count': 'books a till count',
  'Record expense': 'books an expense',
  'Open count': 'opens a count',
  'Open shift': 'opens a shift',
  Settle: 'settles a balance',
  Unlink: 'removes a link',
  'Link store': 'links a store to POS',
  'Assign role': 'grants access',
  'Cancel order': 'moves a status',
  'Issue PIN': 'issues a credential',
  'Provision terminal': 'issues a device credential',
  Reinstate: 'moves a status',
  'Retire this channel': 'moves a status',
};
/** Forms that only navigate, filter, preview or retry. Not data entry, so G8 does not judge them (ruling 2). */
const NAVIGATION = new Set(['Show', 'Search', 'Filter', 'Go', 'Refresh', 'Preview', 'Check POS again', 'Retry']);
/** Q1 (A4): sign-in, setup and the clock kiosk are out of the lock-and-edit sweep. */
const OUT_OF_SCOPE = ['sign-in/', 'setup/', 'clock/'];
/** Toggle pairs (state flips; either label is the verb of the next state). */
const TOGGLES: ReadonlyArray<readonly string[]> = [
  ['On', 'Off'],
  ['Retire', 'Restore'],
  ['Deactivate', 'Reactivate'],
  ['Pause', 'Resume'],
];
const TOGGLE_WORDS = new Set(TOGGLES.flat());
const SAVE_OK = new Set(['Save', 'Save draft']);

interface Finding {
  file: string;
  line: number;
  detail: string;
}

function parse(source: string, file: string) {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
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
  if (!a) return undefined;
  if (!a.initializer) return '';
  if (ts.isStringLiteral(a.initializer)) return a.initializer.text;
  if (ts.isJsxExpression(a.initializer) && a.initializer.expression) {
    const e = a.initializer.expression;
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  }
  return undefined;
}
function allJsx(sf: ts.SourceFile): ts.Node[] {
  const out: ts.Node[] = [];
  const visit = (n: ts.Node) => {
    if (opening(n)) out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
const lineOf = (sf: ts.SourceFile, n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
function inside(n: ts.Node, tag: string): boolean {
  for (let p = n.parent; p; p = p.parent) {
    const o = opening(p);
    if (o && tagName(o) === tag) return true;
  }
  return false;
}
function isNonGetForm(n: ts.Node): boolean {
  const o = opening(n);
  if (!o || tagName(o) !== 'form') return false;
  return (attrString(o, 'method') ?? 'post').toLowerCase() !== 'get';
}
function descendants(n: ts.Node, pred: (x: ts.Node) => boolean): ts.Node[] {
  const out: ts.Node[] = [];
  const v = (x: ts.Node) => {
    if (pred(x)) out.push(x);
    ts.forEachChild(x, v);
  };
  ts.forEachChild(n, v);
  return out;
}
function rootIsIdent(x: ts.Expression): boolean {
  let c: ts.Expression = x;
  while (ts.isPropertyAccessExpression(c) || ts.isElementAccessExpression(c) || ts.isNonNullExpression(c)) c = c.expression;
  return ts.isIdentifier(c);
}
/** Does an expression read a property off an identifier: `row.name`, `link?.name`, `a.b.c`? */
function readsRecord(e: ts.Node): boolean {
  let hit = false;
  const v = (x: ts.Node) => {
    if (ts.isPropertyAccessExpression(x) && rootIsIdent(x)) hit = true;
    ts.forEachChild(x, v);
  };
  v(e);
  return hit;
}

/** G7 over one source. EXEMPT is applied by the caller, not here. */
function lockFindings(source: string, file: string): Finding[] {
  const sf = parse(source, file);
  const out: Finding[] = [];
  for (const form of allJsx(sf).filter(isNonGetForm)) {
    if (inside(form, 'EditableRecord')) continue;
    const kids = descendants(form, (x) => !!opening(x));
    const hasHiddenId = kids.some((k) => {
      const o = opening(k)!;
      if (tagName(o) !== 'input' || attrString(o, 'type') !== 'hidden') return false;
      const nm = attrString(o, 'name');
      return nm !== undefined && (nm === 'id' || /Id$/.test(nm));
    });
    if (!hasHiddenId) continue;
    const bound = kids.some((k) => {
      const o = opening(k)!;
      if (!['input', 'select', 'textarea'].includes(tagName(o))) return false;
      return ['defaultValue', 'defaultChecked'].some((a) => {
        const at = attr(o, a);
        return !!at?.initializer && ts.isJsxExpression(at.initializer) && !!at.initializer.expression && readsRecord(at.initializer.expression);
      });
    });
    if (bound) out.push({ file, line: lineOf(sf, form), detail: 'raw record-bound form (not inside <EditableRecord>)' });
  }
  return out;
}

const lit = (x: ts.Expression): string | undefined =>
  ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)
    ? x.text
    : ts.isConditionalExpression(x)
      ? [lit(x.whenFalse), lit(x.whenTrue)].find((t) => t !== undefined && !t.endsWith('\u2026'))
      : undefined;

/** The text a button shows. A `a ? 'X' : 'Y'` child contributes its first literal branch (the idle label). */
function buttonLabel(el: ts.Node): string | undefined {
  if (ts.isJsxSelfClosingElement(el)) return attrString(el, 'value');
  if (!ts.isJsxElement(el)) return undefined;
  let s = '';
  for (const c of el.children) {
    if (ts.isJsxText(c)) s += c.text;
    else if (ts.isJsxExpression(c) && c.expression) s += lit(c.expression) ?? '';
  }
  return s.replace(/\s+/g, ' ').trim();
}
function isCommand(label: string, commands: Record<string, string>): boolean {
  return Object.keys(commands).some((k) => {
    if (!k.endsWith(' *')) return label === k;
    const verb = k.slice(0, -2);
    return label === verb || (label.startsWith(verb) && /^[\s\-\u2014&]/.test(label.slice(verb.length)));
  });
}
function labelAllowed(label: string, commands: Record<string, string>): boolean {
  return SAVE_OK.has(label) || NAVIGATION.has(label) || TOGGLE_WORDS.has(label) || isCommand(label, commands);
}
/** G8 over one source. */
function labelFindings(source: string, file: string, commands: Record<string, string> = COMMANDS): Finding[] {
  const sf = parse(source, file);
  const out: Finding[] = [];
  if (OUT_OF_SCOPE.some((d) => file.startsWith(d))) return out;
  for (const form of allJsx(sf).filter(isNonGetForm)) {
    const btns = descendants(form, (x) => {
      const o = opening(x);
      if (!o) return false;
      if (tagName(o) === 'button') return true;
      return tagName(o) === 'input' && attrString(o, 'type') === 'submit';
    });
    const picked = new Set<ts.Node>();
    for (const b of btns) {
      const o = opening(b)!;
      const type = attrString(o, 'type') ?? (tagName(o) === 'button' ? 'submit' : undefined);
      if (type === 'submit') picked.add(b);
    }
    if (btns.length) picked.add(btns[btns.length - 1]);
    for (const b of picked) {
      const label = buttonLabel(b);
      if (!label) continue; // icon-only or fully dynamic: nothing to judge
      if (!labelAllowed(label, commands)) out.push({ file, line: lineOf(sf, b), detail: `submit label "${label}"` });
    }
  }
  return out;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.tsx')) out.push(full);
  }
  return out;
}
function scan(fn: (src: string, file: string) => Finding[]): Finding[] {
  return walk(APP_ROOT).flatMap((f) => fn(readFileSync(f, 'utf8'), rel(f)));
}
function counts(fs: Finding[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const f of fs) m[f.file] = (m[f.file] ?? 0) + 1;
  return m;
}
function baseline(name: string): Record<string, number> {
  const p = resolve(__dirname, name);
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

describe('G7: record-bound forms are rendered through <EditableRecord>', () => {
  it('no raw record-bound form beyond the baseline (ends empty)', () => {
    const found = scan(lockFindings).filter((f) => !(f.file in EXEMPT));
    expect(ratchet(counts(found), baseline('editable-record-baseline.json'))).toEqual([]);
  });
  it('EXEMPT has no stale entry (each exempt file still has a raw form) and every entry has a reason', () => {
    const live = new Set(scan(lockFindings).map((f) => f.file));
    expect(Object.keys(EXEMPT).filter((f) => !live.has(f))).toEqual([]);
    expect(Object.entries(EXEMPT).filter(([, why]) => !why.trim())).toEqual([]);
  });
});

describe('G8: submit labels are Save / Save draft / a COMMANDS verb / a toggle', () => {
  it('no other label beyond the baseline (ends empty)', () => {
    expect(ratchet(counts(scan((s, f) => labelFindings(s, f))), baseline('submit-label-baseline.json'))).toEqual([]);
  });
  it('COMMANDS: every entry has a reason and still appears as a button label in app/ (no stale verb)', () => {
    expect(Object.entries(COMMANDS).filter(([, why]) => !why.trim())).toEqual([]);
    const seen = new Set<string>();
    for (const f of walk(APP_ROOT)) {
      const sf = parse(readFileSync(f, 'utf8'), rel(f));
      for (const n of allJsx(sf)) {
        const o = opening(n)!;
        if (tagName(o) === 'button') {
          const l = buttonLabel(n);
          if (l) seen.add(l);
        }
      }
    }
    const unseen = Object.keys(COMMANDS).filter((k) => ![...seen].some((l) => isCommand(l, { [k]: '' })));
    expect(unseen).toEqual([]);
  });
});

describe('G9: positive controls on literal fixtures', () => {
  const rawForm = `export default function P({ row }: any) { return (
    <form action={act}>
      <input type="hidden" name="id" value={row.id} />
      <input name="name" defaultValue={row.name} />
      <button type="submit">Save</button>
    </form>); }`;
  const wrapped = `export default function P({ row }: any) { return (
    <EditableRecord action={act} label="x" hidden={{ id: row.id }}>
      <form action={act}>
        <input type="hidden" name="id" value={row.id} />
        <input name="name" defaultValue={row.name} />
      </form>
    </EditableRecord>); }`;
  const addForm = (label: string) =>
    `export default function P() { return (<form action={act}><input name="name" /><button type="submit">${label}</button></form>); }`;
  const F = 'app/x/page.tsx';

  it('a bare record-bound form is flagged by G7', () => {
    expect(lockFindings(rawForm, F)).toHaveLength(1);
  });
  it('the same form inside <EditableRecord passes G7', () => {
    expect(lockFindings(wrapped, F)).toEqual([]);
  });
  it('a GET form and an unbound add form are not G7 findings', () => {
    expect(lockFindings(rawForm.replace('<form action={act}>', '<form method="get">'), F)).toEqual([]);
    expect(lockFindings(addForm('Save'), F)).toEqual([]);
  });
  it('a submit reading "Add tender" is flagged by G8; so are "Create", "Update", "Save tender"', () => {
    for (const l of ['Add tender', 'Create', 'Update', 'Save tender']) {
      expect(labelFindings(addForm(l), F).map((f) => f.detail)).toEqual([`submit label "${l}"`]);
    }
  });
  it('"Save" and "Save draft" pass G8', () => {
    expect(labelFindings(addForm('Save'), F)).toEqual([]);
    expect(labelFindings(addForm('Save draft'), F)).toEqual([]);
  });
  it('"Record payment" passes G8 only while it is in COMMANDS', () => {
    expect(labelFindings(addForm('Record payment'), F)).toEqual([]);
    const without = { ...COMMANDS };
    delete without['Record payment'];
    expect(labelFindings(addForm('Record payment'), F, without)).toHaveLength(1);
  });
  it('a toggle label passes; the LAST button of a form is judged even without type="submit"', () => {
    expect(labelFindings(addForm('Retire'), F)).toEqual([]);
    const lastBtn = `export default function P() { return (<form action={act}><button>Add room</button></form>); }`;
    expect(labelFindings(lastBtn, F)).toHaveLength(1);
  });
  it('a stale entry is detected by the live-set comparison (detector shape on literals)', () => {
    const live = new Set(lockFindings(rawForm, F).map((f) => f.file));
    expect(['app/gone/page.tsx'].filter((f) => !live.has(f))).toEqual(['app/gone/page.tsx']);
    expect([F].filter((f) => !live.has(f))).toEqual([]);
  });
});

/** Report helper for the orchestrator: set T384_REPORT=1 to print the per-file counts that seed the baselines. */
describe.skipIf(!process.env.T384_REPORT)('report', () => {
  it('prints counts', () => {
    const g7 = scan(lockFindings);
    const g8 = scan((s, f) => labelFindings(s, f));
    console.log('G7 total', g7.length, 'files', Object.keys(counts(g7)).length, JSON.stringify(counts(g7)));
    console.log('G8 total', g8.length, 'files', Object.keys(counts(g8)).length, JSON.stringify(counts(g8)));
    const byLabel: Record<string, number> = {};
    for (const f of g8) byLabel[f.detail] = (byLabel[f.detail] ?? 0) + 1;
    console.log('G8 labels', JSON.stringify(byLabel));
    if (process.env.T384_DUMP) {
      const fs = require('node:fs');
      fs.writeFileSync(process.env.T384_DUMP, JSON.stringify({ g7: counts(g7), g8: counts(g8), g8Detail: g8.map((f) => `${f.detail} @ ${f.file}:${f.line}`) }, null, 1));
    }
  });
});
