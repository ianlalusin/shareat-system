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
 *      Audit round: hidden names id / *Id / version / code / slug; defaults from ANY variable (destructured
 *      included); `src/components/**` is scanned as well as `src/app/**` (keys prefixed `components/`); a
 *      form inside the `extra={...}` prop of EditableRecord still counts.
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
const COMPONENTS_ROOT = resolve(__dirname, '..', 'src', 'components');
const rel = (f: string) => relative(APP_ROOT, f).replace(/\\/g, '/');

/** Files whose raw record-bound form is deliberate. Each needs a reason. Empty at the end of S3b. */
const EXEMPT: Record<string, string> = {};

/**
 * L5 / Q2 = a (Ian; orchestrator ruling 2026-10-08). A COMMAND posts money, moves stock, changes a record's
 * status, or grants / revokes access, and keeps its own verb. Every key is an EXACT label as it appears in app/ (audit round: no prefix matching, so
 * "Post the opening balances" and a new "Post x" are judged separately). Plain data entry
 * (Save X, Set X, Add / Create / Record X on master data, Rename, Hire) is NOT here: it must say Save.
 */
// T-412: the destructive verbs (Void, Reverse, Delete, Write off, Revoke, End employment, Post separation, ...) are no longer
// `<button>` labels written in app/ - they are the `label=` prop of <ConfirmDestructive>, whose own submit button is the one
// control (apps/erp/tests/t412-destructive-census.test.ts is the guard for those). Their entries left this list with them.
const COMMANDS: Record<string, string> = {
  'Remove staff positions': 'T-451: explicit removal of legacy assignments for privileged roles; existing role and authorization stay intact',
  'View certificate': 'T-436: opens a leave certificate (one-time link, audited); a POST so the view is recorded',
  'Cancel': 'T-436: withdraws a pending leave request',
  'Request leave': 'T-436: files a pending leave request for approval',
  'Record absence': 'T-436: records a leave or absence day that already happened',
  'Attach certificate': 'T-436: attaches a medical certificate to a leave request',
  'Save leave limit': 'T-436: saves a leave cap',
  'Add kind': 'T-436: adds a leave kind',
  'Delete draft': 'T-418: discards an unposted expense draft; one click, no PIN (Ian 16 Oct)',
  'Delete usage draft': 'T-418: discards an unposted usage draft; one click, no PIN (Ian 16 Oct)',
  'Delete template': 'T-418: deletes a never-used recurring template; one click, no PIN (Ian 16 Oct)',
  'Restore recipe': 'moves a status (T-413)',
  'Save recipe': 'T-413: label pinned by the T-413 screen tests; it saves a recipe (planner to rule: Save vs Save recipe)',
  'Record payment': 'books money out for good (Q2)',
  'Record transfer': 'moves money between accounts',
  'Record the draw': 'books an owner draw',
  'Record contribution': 'books an owner contribution',
  'Record drawing': 'books an owner drawing',
  'Record loan': 'books a loan',
  'Record obligation': 'books a liability',
  'Record prepaid item': 'books a prepayment',
  'Record handover': 'books a cash handover',
  'Record': 'books a payout (cash-requests)',
  'Post': 'posts to the ledger',
  'Post correction': 'posts to the ledger',
  'Post payout(s)': 'posts to the ledger',
  'Post payslip(s)': 'posts to the ledger',
  'Value the count': 'writes the generated opening inventory entry (T-390 S5)',
  'Post this settlement': 'posts to the ledger',
  'Pay': 'books a payment',
  'Clear the approval-PIN cap': 'lifts an administrator-PIN cap early (T-416, audited)',
  'Reopen PIN sign-in': 'lets PIN sign-in back in at a stopped store (T-395 S2, audited)',
  'Add directly (super-admin)': 'creates an item with no approval, bypassing the request flow (items page)',
  'Charge': 'books a charge',
  'Charge to this person': 'books a charge',
  'Refund': 'books a refund',
  'Distribute': 'distributes money',
  'Recognise as other income': 'books income',
  'Book it': 'books a posting',
  'Transfer': 'moves stock',
  'Receive': 'receives stock',
  'Dispatch': 'dispatches stock',
  'Return': 'returns stock or goods',
  'Approve': 'moves a status',
  'Approve &amp; post': 'moves a status',
  'Approve (no stock)': 'moves a status',
  'Accept': 'moves a status',
  'Accept for now': 'moves a status',
  'Reject': 'moves a status',
  'Decline': 'moves a status',
  'Refuse': 'moves a status',
  'Decide': 'moves a status',
  'Defer': 'moves a status',
  'Verify': 'moves a status',
  'Verify &amp; post': 'moves a status',
  'Verify &mdash; all four must be checked': 'moves a status',
  'Void': 'voids a document',
  'Cancel count': 'moves a status',
  'Commit': 'commits a count',
  'Close': 'moves a status',
  'Close shift': 'moves a status',
  'Confirm term': 'confirms a status change',
  'I confirm this is done': 'confirms a cutover step',
  'Finalize': 'moves a status',
  'Finish this pull — nothing left to post': 'moves a status',
  'Mark paid by the platform — posts nothing': 'moves a status',
  'Mark ready': 'moves a status',
  'Propose': 'moves a status',
  'Submit': 'moves a status',
  'Submit request': 'moves a status',
  'Submit to': 'moves a status',
  'Resolve': 'moves a status',
  'Dispute — flag for review, does not stop the 15-day clock': 'moves a status',
  'Override': 'overrides a verified day',
  '\u2192 Move to reviewing': 'moves a status',
  'Flag as unmappable': 'moves a status',
  'Open branch': 'opening a store is a status change',
  'Create the missing month': 'creates a period',
  'Make default': 'changes which record is default',
  'Discard': 'discards a record',
  'Remove': 'removes a link or cap',
  'Release': 'releases money held',
  'Withdraw': 'withdraws a request',
  'Withdraw day': 'withdraws a request',
  'Link': 'links records',
  'Pair': 'pairs a device',
  'Grant selected': 'grants access',
  'Hold in their own right': 'grants access',
  'Enrol card': 'grants a credential',
  'Enrol fingerprint (test/dev only)': 'grants a credential',
  'Import from POS': 'imports sales',
  'Re-import from POS': 'imports sales',
  'Run': 'runs a depreciation',
  'Record closing count': 'books a till count',
  'Record expense': 'books an expense',
  'Open count': 'opens a count',
  'Open shift': 'opens a shift',
  'Settle': 'settles a balance',
  'Unlink': 'removes a link',
  'Pair this tablet': "T-464: pairs this browser as the store's POS tablet and signs the manager out (a command that moves a device's status, not data entry)",
  // 2026-10-09 T-384 sweep fallout: 'Link store' removed (no button carries it any more). Added per A5/A6:
  'Apply to every store': 'fans one setting out to every store (a bulk write, not a record edit)',
  'Copy': 'copies a record into a new one',
  'Add': 'admin/users/[personId]: grants access',
  'Log invoice': 'books a supplier invoice',
  'Anchor': 'anchors a balance / period (a posting)',
  'Confirm change': 'confirms a status change',
  'Set up rooms': 'provisions rooms (a one-shot setup action)',
  'Build plan': 'generates a plan (an action, not data entry)',
  'Keep &ldquo;&rdquo;': 'items/page: a permanent item merge (label is Keep &ldquo;{name}&rdquo;)',
  'Different items — stop asking': 'T-443: records that a look-alike pair are different products, so the panel stops suggesting a merge',
  'Undo': 'T-443: removes a dismissal, so the look-alike pair is suggested again',
  'Request item': 'files a request (moves a status)',
  'Mark duplicate': 'closes a menu item request as a duplicate (moves a status)',
  'Clear': 'clears a held value / flag (an action)',
  'Switch': 'switches the active store / context',
  'Seed from map': 'menu/usage-source: copies the POS item map into menu rules in one action (T-401 S4)',
  'Save link': 'menu/usage-source: links a menu item to a POS item key (T-401 S4)',
  'Switch to menu rules': 'menu/usage-source: flips which source drives usage deduction (T-401 S4)',
  'Switch back to POS item maps': 'menu/usage-source: flips usage deduction back to the POS item maps (T-401 S4)',
  'Assign role': 'grants access',
  'Cancel order': 'moves a status',
  'Issue PIN': 'issues a credential',
  'Provision terminal': 'issues a device credential',
  'Reinstate': 'moves a status',
  'Retire this channel': 'moves a status',
  // T-434 staff photo/signature (managers only; bible rows 353/355)
  'Save photo': 'T-434 staff photo/signature (managers only; bible rows 353/355): uploads a photo; plain data entry that should read "Save"',
  'Remove photo': 'T-434 staff photo/signature (managers only; bible rows 353/355): removes the photo',
  'View signature': 'T-434 staff photo/signature (managers only; bible rows 353/355): opens a signature, audited',
  'Remove signature': 'T-434 staff photo/signature (managers only; bible rows 353/355): removes the signature',
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
/**
 * T-387 S8: the kit renders the native controls these guards look for. `<Input>`/`<Select>`/`<Textarea>`
 * are an input/select/textarea; `<Button>` and `<SubmitButton>` are a button. Read them as the native tag,
 * or the sweep onto the kit would silently blind G7/G8 (the counts "fall" because the guard stopped seeing
 * the controls, not because the forms changed). A kit `<Button>` with no `type` renders type="button"
 * (Button.tsx), unlike a native button's implicit submit; `<SubmitButton>` is always a submit.
 */
const KIT_NATIVE: Record<string, string> = { Input: 'input', Select: 'select', Textarea: 'textarea', Button: 'button', SubmitButton: 'button' };
function nativeTag(o: ts.JsxOpeningElement | ts.JsxSelfClosingElement): string {
  const t = tagName(o);
  return KIT_NATIVE[t] ?? t;
}
function buttonType(o: ts.JsxOpeningElement | ts.JsxSelfClosingElement): string | undefined {
  const t = tagName(o);
  if (t === 'SubmitButton') return 'submit';
  if (t === 'Button') return attrString(o, 'type') ?? 'button';
  return attrString(o, 'type') ?? (t === 'button' ? 'submit' : undefined);
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
/**
 * Is `n` rendered through `<tag>`? A form passed in the `extra={...}` prop of EditableRecord is NOT: extra
 * is outside the locked fieldset, so a raw record form hiding there must still count (audit round).
 */
function inside(n: ts.Node, tag: string): boolean {
  let viaExtra = false;
  for (let p = n.parent; p; p = p.parent) {
    if (ts.isJsxAttribute(p) && p.name.getText() === 'extra') viaExtra = true;
    const o = opening(p);
    if (o && tagName(o) === tag) return !viaExtra;
  }
  return false;
}
/**
 * T-440 S1 (A3 / T-S1-16): a form is the native `<form>` OR the `<CheckedForm>` that renders one. Without this, every add form
 * converted to CheckedForm would leave G7 and G8 (the guards would see no form and the counts would "fall" for the wrong reason).
 */
const FORM_TAGS: ReadonlySet<string> = new Set(['form', 'CheckedForm']);
function isNonGetForm(n: ts.Node): boolean {
  const o = opening(n);
  if (!o || !FORM_TAGS.has(tagName(o))) return false;
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
/**
 * Does a default read a variable: `row.name`, `link?.name`, or a destructured `name` / `name ?? ''`? Any
 * identifier that is not a property name (and not `undefined`) counts; pure literals do not.
 */
function readsRecord(e: ts.Node): boolean {
  let hit = false;
  const v = (x: ts.Node) => {
    if (ts.isIdentifier(x) && x.text !== 'undefined' && !(x.parent && ts.isPropertyAccessExpression(x.parent) && x.parent.name === x)) hit = true;
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
      if (nativeTag(o) !== 'input' || attrString(o, 'type') !== 'hidden') return false;
      const nm = attrString(o, 'name');
      return nm !== undefined && /^(id|version|code|slug)$|Id$/.test(nm);
    });
    if (!hasHiddenId) continue;
    const bound = kids.some((k) => {
      const o = opening(k)!;
      if (!['input', 'select', 'textarea'].includes(nativeTag(o))) return false;
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
  return Object.prototype.hasOwnProperty.call(commands, label);
}
function labelAllowed(label: string, commands: Record<string, string>): boolean {
  return SAVE_OK.has(label) || NAVIGATION.has(label) || TOGGLE_WORDS.has(label) || isCommand(label, commands);
}
/** Buttons G8 looked at: the label it judged, or a DYNAMIC button whose text is not a literal (`{label}`). */
interface LabelScan {
  judged: Array<{ label: string; line: number }>;
  dynamic: Array<{ line: number }>;
}
function labelScan(source: string, file: string): LabelScan {
  const sf = parse(source, file);
  const out: LabelScan = { judged: [], dynamic: [] };
  if (OUT_OF_SCOPE.some((d) => file.startsWith(d))) return out;
  for (const form of allJsx(sf).filter(isNonGetForm)) {
    const btns = descendants(form, (x) => {
      const o = opening(x);
      if (!o) return false;
      if (nativeTag(o) === 'button') return true;
      return nativeTag(o) === 'input' && attrString(o, 'type') === 'submit';
    });
    const picked = new Set<ts.Node>();
    for (const b of btns) {
      const o = opening(b);
      if (!o) continue;
      const type = buttonType(o);
      if (type === 'submit') picked.add(b);
    }
    const lastBtn = btns[btns.length - 1];
    if (lastBtn) picked.add(lastBtn);
    for (const b of picked) {
      const label = buttonLabel(b);
      const line = lineOf(sf, b);
      if (label) out.judged.push({ label, line });
      else if (ts.isJsxElement(b) && b.children.some((c) => ts.isJsxExpression(c) && c.expression)) out.dynamic.push({ line });
    }
  }
  return out;
}
/** G8 over one source. */
function labelFindings(source: string, file: string, commands: Record<string, string> = COMMANDS): Finding[] {
  return labelScan(source, file)
    .judged.filter((j) => !labelAllowed(j.label, commands))
    .map((j) => ({ file, line: j.line, detail: `submit label "${j.label}"` }));
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.tsx')) out.push(full);
  }
  return out;
}
function scan(fn: (src: string, file: string) => Finding[], withComponents = false): Finding[] {
  const app = walk(APP_ROOT).flatMap((f) => fn(readFileSync(f, 'utf8'), rel(f)));
  if (!withComponents) return app;
  // src/components/** too (audit round): shared components can hide a raw record form. Keys are prefixed.
  const comp = walk(COMPONENTS_ROOT).flatMap((f) =>
    fn(readFileSync(f, 'utf8'), 'components/' + relative(COMPONENTS_ROOT, f).replace(/\\/g, '/')),
  );
  return [...app, ...comp];
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
    const found = scan(lockFindings, true).filter((f) => !(f.file in EXEMPT));
    expect(ratchet(counts(found), baseline('editable-record-baseline.json'))).toEqual([]);
  });
  it('EXEMPT has no stale entry (each exempt file still has a raw form) and every entry has a reason', () => {
    const live = new Set(scan(lockFindings, true).map((f) => f.file));
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
        if (nativeTag(o) === 'button') {
          const l = buttonLabel(n);
          if (l) seen.add(l);
        }
      }
    }
    const unseen = Object.keys(COMMANDS).filter((k) => ![...seen].some((l) => isCommand(l, { [k]: '' })));
    expect(unseen).toEqual([]);
  });
});

/** Buttons whose text is not a literal (`{label}`), per file. Pinned so a new one is a decision, not silence. */
const DYNAMIC_BUTTONS: Record<string, number> = {
  'expenses/recurring/page.tsx': 1,
};
describe('G8b: dynamic-label buttons are an explicit list', () => {
  it('equals DYNAMIC_BUTTONS', () => {
    const actual: Record<string, number> = {};
    for (const f of walk(APP_ROOT)) {
      const n = labelScan(readFileSync(f, 'utf8'), rel(f)).dynamic.length;
      if (n) actual[rel(f)] = n;
    }
    expect(actual).toEqual(DYNAMIC_BUTTONS);
  });
});

describe('T-S1-16 (T-440 A3): CheckedForm counts as a form, so the guards stay sighted (mutant: tag list reverted to form only)', () => {
  const F = 'app/x/page.tsx';
  const checked = (label: string) =>
    `export default function P() { return (<CheckedForm rules={R} action={act}><input name="name" /><button type="submit">${label}</button></CheckedForm>); }`;
  const checkedKit = (label: string) =>
    `export default function P() { return (<CheckedForm rules={R} action={act}><Input name="name" /><SubmitButton>${label}</SubmitButton></CheckedForm>); }`;
  const checkedRecord = `export default function P({ row }: any) { return (
    <CheckedForm rules={R} action={act}>
      <input type="hidden" name="id" value={row.id} />
      <input name="name" defaultValue={row.name} />
      <button type="submit">Save</button>
    </CheckedForm>); }`;

  it('G8: a <CheckedForm> ending in "Save item" is flagged, like a <form> would be; "Save" and "Save draft" pass', () => {
    expect(labelFindings(checked('Save item'), F).map((f) => f.detail)).toEqual(['submit label "Save item"']);
    expect(labelFindings(checkedKit('Save item'), F).map((f) => f.detail)).toEqual(['submit label "Save item"']);
    for (const ok of ['Save', 'Save draft']) expect(labelFindings(checked(ok), F), ok).toEqual([]);
  });
  it('G8: the LAST button of a <CheckedForm> is judged even without type="submit", and a COMMANDS verb still passes', () => {
    const lastBtn = `export default function P() { return (<CheckedForm rules={R} action={act}><button>Add room</button></CheckedForm>); }`;
    expect(labelFindings(lastBtn, F)).toHaveLength(1);
    expect(labelFindings(checked('Record payment'), F)).toEqual([]);
  });
  it('G7: a raw record-bound <CheckedForm> (hidden id + a default read from a record) is flagged; inside <EditableRecord> it is not', () => {
    expect(lockFindings(checkedRecord, F)).toHaveLength(1);
    const wrapped = `export default function P({ row }: any) { return (
      <EditableRecord action={act} label="x" hidden={{ id: row.id }}>
        <CheckedForm rules={R} action={act}>
          <input type="hidden" name="id" value={row.id} />
          <input name="name" defaultValue={row.name} />
        </CheckedForm>
      </EditableRecord>); }`;
    expect(lockFindings(wrapped, F)).toEqual([]);
  });
  it('an unbound add <CheckedForm> is not a G7 finding; a GET CheckedForm is not a form for G8', () => {
    expect(lockFindings(checked('Save'), F)).toEqual([]);
    expect(labelFindings(checked('Save item').replace('<CheckedForm rules={R}', '<CheckedForm method="get" rules={R}'), F)).toEqual([]);
  });
  it('the live scan really contains a <CheckedForm> once the pilots are converted (the guard is exercised on real source, not only fixtures)', () => {
    const seen = scan((src, f) => (/<CheckedForm\b/.test(src) ? [{ file: f, line: 1, detail: 'uses CheckedForm' }] : []), true);
    expect(seen.map((x) => x.file)).toContain('ap/suppliers/page.tsx');
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
  it('G7: a version / code / slug hidden field makes a record form (audit round)', () => {
    for (const n of ['version', 'code', 'slug']) {
      const src = rawForm.replace('name="id"', `name="${n}"`);
      expect(lockFindings(src, F), n).toHaveLength(1);
    }
  });
  it('G7: defaults from a destructured variable count, literal defaults do not', () => {
    const destructured = `export default function P({ name }: any) { return (<form action={act}><input type="hidden" name="storeId" value="s" /><input name="n" defaultValue={name ?? ''} /></form>); }`;
    expect(lockFindings(destructured, F)).toHaveLength(1);
    const literal = destructured.replace("defaultValue={name ?? ''}", 'defaultValue="x"');
    expect(lockFindings(literal, F)).toEqual([]);
  });
  it('G7: a raw record form inside the extra={...} prop of EditableRecord still counts', () => {
    const inExtra = `export default function P({ row }: any) { return (
      <EditableRecord action={act} label="x" hidden={{ id: row.id }} extra={
        <form action={act}><input type="hidden" name="id" value={row.id} /><input name="n" defaultValue={row.n} /></form>
      }><input name="n" defaultValue={row.n} /></EditableRecord>); }`;
    expect(lockFindings(inExtra, F)).toHaveLength(1);
  });
  it('G7: src/components/** is part of the scan (keys are prefixed)', () => {
    const seen: string[] = [];
    scan((_s, f) => (seen.push(f), []), true);
    expect(seen.some((f) => f.startsWith('components/ui/'))).toBe(true);
    expect(seen.some((f) => f.startsWith('settings/'))).toBe(true);
  });
  it('G8: a dynamic `{label}` button is reported, not skipped', () => {
    const dyn = `export default function P({ label }: any) { return (<form action={act}><button type="submit">{label}</button></form>); }`;
    const sc = labelScan(dyn, F);
    expect(sc.judged).toEqual([]);
    expect(sc.dynamic).toHaveLength(1);
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
    const g7 = scan(lockFindings, true);
    const g8 = scan((s, f) => labelFindings(s, f));
    console.log('G7 total', g7.length, 'files', Object.keys(counts(g7)).length, JSON.stringify(counts(g7)));
    console.log('G8 total', g8.length, 'files', Object.keys(counts(g8)).length, JSON.stringify(counts(g8)));
    const byLabel: Record<string, number> = {};
    for (const f of g8) byLabel[f.detail] = (byLabel[f.detail] ?? 0) + 1;
    console.log('G8 labels', JSON.stringify(byLabel));
    if (process.env.T384_LABELS) {
      const fs = require('node:fs');
      const all: Record<string, string[]> = {};
      const dyn: string[] = [];
      for (const f of walk(APP_ROOT)) {
        const sc = labelScan(readFileSync(f, 'utf8'), rel(f));
        for (const j of sc.judged) (all[j.label] ??= []).push(rel(f) + ':' + j.line);
        for (const d of sc.dynamic) dyn.push(rel(f) + ':' + d.line);
      }
      fs.writeFileSync(process.env.T384_LABELS, JSON.stringify({ all, dyn }, null, 1));
    }
    if (process.env.T384_DUMP) {
      const fs = require('node:fs');
      fs.writeFileSync(process.env.T384_DUMP, JSON.stringify({ g7: counts(g7), g8: counts(g8), g8Detail: g8.map((f) => `${f.detail} @ ${f.file}:${f.line}`) }, null, 1));
    }
  });
});
