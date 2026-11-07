import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findUnsafeRedirectInCatchForFile } from './redirect-in-catch-sweep';

/**
 * T-511 S5b (TESTER, 2026-11-05) - the SHAPE of the review screen and its actions, read from source, because several repo guards judge source and each fails far from the
 * cause (G7 EditableRecord, G8 submit labels, redirect-in-catch, no-client-supplied-actor, t411 row links, touch targets). No database, no render (the actions' behaviour is in
 * t511-s5b-review-actions.test.ts, the data in packages/domain/tests/integration/t511-s5b-*.test.ts). Spec: docs/tasks/511-settlement-upload-s5-spec.md "S5b" item 5 and 6.
 *
 * RED today, for one reason: `apps/erp/src/app/channel-settlements/review/` does not exist (the first read below fails).
 *
 * CONTRACT (files and conventions; the builder must meet these or ask BOSS to change the tests):
 *  S1  Files: review/page.tsx (the day table), review/DayDetail.tsx (the detail), review/actions.ts or actions.tsx ('use server'). A nav item with href "/channel-settlements/review".
 *  S2  APPROVE IS HIDDEN until slice 7: the word "Approve" (and approveDay-style names) appears in no code of the review folder. A comment may mention it.
 *  S3  Conventions: every submit goes through `SubmitButton` (no hand-made `<button type="submit">`, no `<input type="submit">`); the reject reason is a `CheckedForm` or `EditableRecord`
 *      with `rules=` (the field rules come from the domain, not typed again here); controls in the table sit in `RowAction`; the table is `Table card=` for the phone layout.
 *  S4  Actions: 'use server' first; requireActor FIRST in each exported action; the actor never read from the form; each calls its domain function inside `withOrgPrincipal`; the catch
 *      goes through `errorMessage(err)` into `redirectWithFlash`; the success redirect is after the try (the redirect-in-catch sweep finds nothing); no `new Error(` and no raw `throw`.
 *  S5  No raw codes in what a person reads: no JSX renders a `.code` or the bare `reviewState` / `paidState` / `platform` / loan-check `status` value; the screen maps them to words.
 *      Wording that must exist in the screen or the domain: the approved PandaGO tail, and "VAT on fees" as a label in DayDetail.
 *  S6  The screen reads through the domain (`listReviewDays`, `getReviewDayDetail`) and never queries: no drizzle, no `sql` template, no `@shareat/db` repo import in page or DayDetail.
 */
const SRC = resolve(__dirname, '..', 'src');
const DOMAIN = resolve(__dirname, '..', '..', '..', 'packages', 'domain', 'src');
const DIR = join(SRC, 'app', 'channel-settlements', 'review');
const read = (p: string): string => {
  expect(existsSync(p), `${p} must exist`).toBe(true);
  return readFileSync(p, 'utf8');
};
const codeOnly = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const actionsPath = (): string => (existsSync(join(DIR, 'actions.ts')) ? join(DIR, 'actions.ts') : join(DIR, 'actions.tsx'));
const page = (): string => read(join(DIR, 'page.tsx'));
const detail = (): string => read(join(DIR, 'DayDetail.tsx'));
const actions = (): string => read(actionsPath());
const all = (): string => codeOnly([page(), detail(), actions()].join('\n'));

/** The body of one exported async function: from its declaration to the next top-level export (or the end of the file). */
function fn(text: string, name: string): string {
  const at = text.indexOf(`export async function ${name}(`);
  expect(at, `export async function ${name} not found`).toBeGreaterThan(-1);
  const rest = text.slice(at + 10);
  const next = rest.search(/\nexport /);
  return next === -1 ? text.slice(at) : text.slice(at, at + 10 + next);
}

describe('T-511 S5b screen - files and navigation', () => {
  it('page, detail and actions exist; the nav lists the review screen [kills: a screen nobody can reach]', () => {
    page();
    detail();
    actions();
    // T-544: the sidebar has one settlements entry; the review screen is a tab under it.
    expect(readFileSync(join(SRC, 'app', 'channel-settlements', 'tabs.ts'), 'utf8')).toMatch(/href:\s*'\/channel-settlements\/review'/);
  });
});

describe('T-511 S5b screen - Approve is hidden until slice 7', () => {
  it('the word Approve and any approve-style name appear in no code of the review folder [kills: a button that books before S7]', () => {
    const text = all();
    expect(text).not.toMatch(/\bApprove\b/);
    expect(text).not.toMatch(/\bapprove[A-Z]\w*/);
    expect(text).not.toMatch(/\bapprove\(/);
  });
});

describe('T-511 S5b screen - the house conventions', () => {
  it('every submit is a SubmitButton: no raw submit button, no submit input [kills: the G8 label guard and the double-submit guard]', () => {
    const text = [codeOnly(page()), codeOnly(detail())].join('\n');
    expect(text).toMatch(/\bSubmitButton\b/);
    expect(text).not.toMatch(/<button[^>]*type=["']submit["']/);
    expect(text).not.toMatch(/<input[^>]*type=["']submit["']/);
    for (const m of text.matchAll(/<button\b[^>]*>/g)) expect(m[0], 'a <button> with no type submits').toMatch(/type=["'](button|reset)["']/);
  });

  it('the reject form is a CheckedForm or EditableRecord with rules=, the id travels as a hidden field, and the reason is a text control from the rule [kills: a hand-typed required/maxLength; the G7 lock]', () => {
    const text = [codeOnly(page()), codeOnly(detail())].join('\n');
    expect(text).toMatch(/<(CheckedForm|EditableRecord)\b[^>]*rules=/);
    expect(text).toMatch(/name=["']lineId["']|hidden=\{\{\s*lineId/);
    expect(text).toMatch(/name=["']reason["']|nativeAttrs\([\w.]*reason/i);
  });

  it('row controls sit in RowAction and the day table has a phone card layout [kills: a table that breaks on a phone; controls that steal the row click]', () => {
    const p = codeOnly(page());
    expect(p).toMatch(/\bRowAction\b/);
    expect(p).toMatch(/<Table\b[^>]*card=/);
  });

  it('the screen reads through the domain and never queries: no drizzle, no sql template, no repo import [kills: SQL in a page; the no-ungated-read-surface route around the domain]', () => {
    for (const text of [codeOnly(page()), codeOnly(detail())]) {
      expect(text).not.toMatch(/from 'drizzle-orm/);
      expect(text).not.toMatch(/\bsql`/);
      expect(text).not.toMatch(/Repo\b.*from '@shareat\/db'|import \{[^}]*Repo[^}]*\} from '@shareat\/db'/);
    }
    expect(codeOnly(page())).toMatch(/\blistReviewDays\b/);
    expect(codeOnly([page(), detail()].join('\n'))).toMatch(/\bgetReviewDayDetail\b/);
  });
});

describe('T-511 S5b actions - the shape every action keeps', () => {
  const names = ['rejectDayAction', 'reopenDayAction', 'overrideLoanAllocationAction'];

  it("'use server' is the first statement and the three actions are exported async functions [kills: an action that is not a server action]", () => {
    expect(codeOnly(actions()).trimStart().startsWith("'use server'")).toBe(true);
    for (const n of names) expect(actions()).toMatch(new RegExp(`export async function ${n}\\(`));
  });

  it('each action takes requireActor first, calls its domain function inside withOrgPrincipal, and never reads the actor from the form [kills: a client-supplied actor; a domain call outside the principal]', () => {
    const domainFor: Record<string, string> = { rejectDayAction: 'rejectDay(', reopenDayAction: 'reopenDay(', overrideLoanAllocationAction: 'overrideLoanAllocation(' };
    for (const n of names) {
      const body = fn(actions(), n);
      expect(body, n).toMatch(/\{\s*const actor = await requireActor\(/);
      expect(body, n).toMatch(/withOrgPrincipal\(\s*actor\.orgId/);
      expect(body, n).toContain(domainFor[n]!);
      expect(body, n).not.toMatch(/get\(\s*['"](actor|actorId|personId|orgId)['"]/);
      expect(body, n).not.toMatch(/str\(\s*\w+\s*,\s*['"](actor|actorId|personId|orgId)['"]/);
    }
  });

  it('each action puts the error through errorMessage into redirectWithFlash in the catch, and redirects on success AFTER the try; the redirect-in-catch sweep finds nothing [kills: a NEXT_REDIRECT banner; a swallowed refusal]', () => {
    for (const n of names) {
      const body = fn(actions(), n);
      const catchAt = body.indexOf('catch');
      expect(catchAt, n).toBeGreaterThan(-1);
      expect(body.slice(catchAt), n).toMatch(/redirectWithFlash\([^)]*\{\s*error:\s*errorMessage\(err\)/);
      expect(body.lastIndexOf('redirectWithFlash('), `${n}: the success redirect comes after the catch`).toBeGreaterThan(catchAt + 10);
      expect(body.slice(body.lastIndexOf('redirectWithFlash(')), n).toMatch(/\bok:/);
    }
    expect(findUnsafeRedirectInCatchForFile(actionsPath())).toEqual([]);
  });

  it('no raw Error and no bare throw in the actions: refusals come from the domain [kills: the throw ratchet]', () => {
    const text = codeOnly(actions());
    expect(text).not.toMatch(/new Error\(/);
    expect(text).not.toMatch(/\bthrow\b/);
  });
});

describe('T-511 S5b screen - what a person reads', () => {
  it('no JSX prints a code or a raw state value: the screen turns reviewState, paidState, platform and the loan-check status into words [kills: "pending", "not_paid" or "waiting_for_other_stores" on the screen]', () => {
    for (const text of [codeOnly(page()), codeOnly(detail())]) {
      expect(text).not.toMatch(/\{\s*[\w.?]*\.code\s*\}/);
      expect(text).not.toMatch(/\{\s*[\w.?]*\.(reviewState|paidState|platform|status)\s*\}/);
    }
  });

  it('the detail has a "VAT on fees" label and the approved PandaGO wording exists (screen or domain) [kills: VAT hidden inside the fee; PandaGO silent]', () => {
    expect(codeOnly(detail())).toContain('VAT on fees');
    const tail =
      'will be paid to you by Foodpanda (cash on delivery that PandaGO riders collected for you, less PandaGO fees). It is not part of the sales receivable and is not booked here; record it yourself.';
    const domain = existsSync(join(DOMAIN, 'settlement-intake', 'review.ts')) ? readFileSync(join(DOMAIN, 'settlement-intake', 'review.ts'), 'utf8') : '';
    expect(`${all()}\n${domain}`.replace(/\s+/g, ' ')).toContain(tail);
  });

  it('the sales correction is shown as the domain\'s sentence, not re-worded in the screen [kills: a second copy of the preview wording]', () => {
    expect(codeOnly(detail())).toMatch(/salesCorrection/);
    expect(codeOnly(detail())).not.toMatch(/will be corrected to/i);
  });
});
