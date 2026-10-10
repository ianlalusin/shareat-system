import { config } from 'dotenv';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

import { transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { FLASH_COOKIE, captureRedirect, currentJar, outcomeOf, pageParamsOf, resetJar } from '../helpers/flash-jar';

/**
 * T-389 S2 (TESTER) - the shared harness for the sweep-L1 web tests (admin, settings, staff).
 * Spec: docs/tasks/389-refused-save-keeps-typing.md - R1-R5, K5, section 9.4. Pattern: t389-s1-supplier-web.test.ts.
 *
 * Each test file owns the four `vi.mock`s (they hoist per file): next/navigation + cookie jar, session, the Page shell,
 * and the `@/components/forms` pass-through that records every EditableRecord's props into `seen.records`. This file owns
 * everything else: the Postgres fixtures and `runTypedLegs`, the one set of legs every saved-record form must pass.
 *
 * THE LEGS (one `describe` per form; the first four need the feature, the last four are green controls today):
 *   slot      a refused save puts the allow-listed fields in the signed cookie's typed slot (no hidden ids), kept for the
 *             signed-in person, with the form key and record id the contract pins
 *   changed   with the client's `__changed` list only those names ride; a changed-but-unsent name rides as []
 *   reopen    the page reopens THIS record in edit mode, still draws the STORED values (never a typed one, judged on the
 *             record's own <form> markup: the error banner may legitimately quote what was typed), and hands the record
 *             `typed = { kind: 'typed', fields }`; a <details> around it (none in S2 today) must be open
 *   person    another signed-in person given the same flash sees the record locked, nothing typed
 *   siblings  another record, or another form on the same row, stays locked with nothing typed
 *   dropped   typing too long for the cookie: `td` (with the actor) and no `t`; the record stays locked with the stored
 *             values and the "too long" sentence
 *   control   the refusal still reads as a refusal and nothing typed reaches the address            (green today)
 *   noFlash   no flash: record found, locked, nothing typed                                          (green today)
 *   good      a good save: ok banner, no typed slot, no dropped notice                               (green today)
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

export const sql = postgres(url, { max: 5 });
let seq = 0;
export const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  const { closeDb } = await import('@shareat/db');
  await closeDb();
  await sql.end({ timeout: 5 });
});

export async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}
export const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

/** An org with a chart of accounts, one store, and two admins scoped to it (`admin` signs in; `other` is another person). */
export async function fixture(hint: string, opts: { chart?: boolean } = {}) {
  const code = uid(`t389s2-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  if (opts.chart) await seedChartOfAccounts(sql, orgId);
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const storeId = store!.id;
  const people: Actor[] = [];
  for (const name of ['Admin', 'Other Admin']) {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, 'admin')`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    people.push(actor(orgId, p!.id));
  }
  return { orgId, storeId, admin: people[0]!, other: people[1]! };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;

// ---- markup helpers -------------------------------------------------------------------------------------------------

export const plain = (html: string) =>
  html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

const unescapeHtml = (s: string) => s.replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** Every <form>...</form> on the page (EditableRecord forms never nest). */
export function formSegments(html: string): string[] {
  return html.match(/<form\b[\s\S]*?<\/form>/g) ?? [];
}
/** The ONE form whose markup holds every string in `has` (a hidden id plus a control name picks one record's form). */
export function pickForm(html: string, has: string[]): string {
  const hits = formSegments(html).filter((s) => has.every((h) => s.includes(h)));
  expect(hits.length, `exactly one <form> holds ${JSON.stringify(has)} (found ${hits.length})`).toBe(1);
  return hits[0]!;
}
const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\s${name}(?:="([^"]*)")?(?=[\\s/>])`).exec(tag);
  return m ? unescapeHtml(m[1] ?? '') : null;
};
const inputTags = (seg: string, name: string) => (seg.match(/<input\b[^>]*>/g) ?? []).filter((t) => attr(t, 'name') === name);
export const markup = {
  /** value of a text / date / number input */
  inputValue(seg: string, name: string): string | null {
    const t = inputTags(seg, name).find((x) => !['radio', 'checkbox', 'hidden'].includes(attr(x, 'type') ?? 'text'));
    return t ? (attr(t, 'value') ?? '') : null;
  },
  textareaValue(seg: string, name: string): string | null {
    const m = new RegExp(`<textarea\\b[^>]*\\sname="${name}"[^>]*>([\\s\\S]*?)</textarea>`).exec(seg);
    return m ? unescapeHtml(m[1]!) : null;
  },
  /** value of the selected <option> (the first when none is marked), or null when there is no such <select> */
  selectedValue(seg: string, name: string): string | null {
    const m = new RegExp(`<select\\b[^>]*\\sname="${name}"[^>]*>([\\s\\S]*?)</select>`).exec(seg);
    if (!m) return null;
    const opts = m[1]!.match(/<option\b[^>]*>/g) ?? [];
    const pick = opts.find((o) => attr(o, 'selected') !== null) ?? opts[0];
    return pick ? (attr(pick, 'value') ?? '') : null;
  },
  /** is the radio / checkbox with this name and value ticked? null when there is no such control */
  checked(seg: string, name: string, value: string): boolean | null {
    const t = inputTags(seg, name).find((x) => attr(x, 'value') === value);
    return t ? attr(t, 'checked') !== null : null;
  },
  /** the values ticked in a checkbox group / radio group */
  checkedValues(seg: string, name: string): string[] {
    return inputTags(seg, name).filter((t) => attr(t, 'checked') !== null).map((t) => attr(t, 'value') ?? '');
  },
};
export type Markup = typeof markup;

/** Is the <details> that wraps `seg` open? null = it is not inside a <details> at all. */
function detailsOpenAround(html: string, seg: string): boolean | null {
  const at = html.indexOf(seg);
  const open = html.lastIndexOf('<details', at);
  if (open < 0 || html.lastIndexOf('</details>', at) > open) return null;
  return /\bopen\b/.test(html.slice(open, html.indexOf('>', open)));
}

export const LONG = 'LongTyping-'.repeat(560); // about 6,000 characters: over the 3,000-byte cookie budget
export const TOO_LONG_SENTENCE = 'What you typed was too long to keep. This shows what is saved. Press Edit and enter your change again.';

// ---- the case description ---------------------------------------------------------------------------------------

export interface BaseCtx {
  f: Fixture;
  /** the record id the typed slot must carry ('' for a singleton) */
  record: string;
}
export interface RecordSel {
  /** the server action's function name, as the page passes it to EditableRecord */
  action: string;
  /** hidden fields the record carries, e.g. { categoryId } */
  hidden: Record<string, string>;
}
export interface Sibling {
  label: string;
  sel: RecordSel;
  /** strings that pick that record's <form> out of the page */
  has: string[];
}
export interface FormCase<C extends BaseCtx> {
  label: string;
  /** PINNED form key (the builder's typed-forms.ts must match) */
  form: string;
  setup(hint: string): Promise<C>;
  /** the action under test */
  action(): Promise<(fd: FormData) => Promise<void>>;
  /** the page's default export */
  page(): Promise<(props: { params: Promise<never>; searchParams: Promise<Record<string, string>> }) => Promise<unknown>>;
  /** the page props for this record, plus the nav / flash params of a redirect */
  props(ctx: C, params: Record<string, string>): { params: Promise<never>; searchParams: Promise<Record<string, string>> };
  sel(ctx: C): RecordSel;
  /** strings that pick this record's <form> out of the page */
  has(ctx: C): string[];
  /** hidden field names: never allowed in the typed slot */
  hiddenNames: string[];
  /** FormData of a refused save with the typed values below. `over` replaces or (null) removes a field. */
  refused(ctx: C, over?: Record<string, string | string[] | null>): FormData;
  refusal: RegExp;
  /** exactly what rides with no `__changed` list */
  fields(ctx: C): Record<string, string | string[]>;
  changed: { list: string; fields(ctx: C): Record<string, string | string[]> };
  /** free-text values the user typed that must NOT appear in this record's <form> markup */
  notDrawn: string[] | ((ctx: C) => string[]);
  /** assert the STORED values are what the record's markup draws */
  stored(ctx: C, seg: string, m: Markup): void | Promise<void>;
  /** a refused save whose typing is over the cookie budget but is still refused by the server */
  tooLong: Record<string, string | string[]>;
  good(ctx: C): FormData;
  ok: RegExp;
  siblings?(ctx: C): Promise<Sibling[]>;
  /** why a leg cannot be driven for this form, reported rather than worked around */
  note?: string;
}

type Rec = { typed?: { kind?: string; fields?: Record<string, unknown> } | null; action?: { name?: string }; hidden?: Record<string, string> };

export interface Harness {
  runTypedLegs<C extends BaseCtx>(c: FormCase<C>): void;
}

export function createHarness(deps: { h: { actor: Actor | null }; seen: { records: Array<Record<string, unknown>> } }): Harness {
  const { h, seen } = deps;

  async function payload(): Promise<{ msg: Record<string, string>; keep: Record<string, string>; t?: { form: string; record: string; fields: Record<string, string | string[]>; actor?: string }; td?: { form: string; record: string; actor?: string } }> {
    const { decodeFlash } = await import('../../src/lib/flash');
    return decodeFlash(currentJar().get(FLASH_COOKIE)!.value) as never;
  }
  function find(sel: RecordSel): Rec | undefined {
    return (seen.records as Rec[]).find((r) => r != null && r.action?.name === sel.action && Object.entries(sel.hidden).every(([k, v]) => r.hidden?.[k] === v));
  }

  function runTypedLegs<C extends BaseCtx>(c: FormCase<C>): void {
    async function submit(ctx: C, fd: FormData, who: Actor = ctx.f.admin) {
      resetJar();
      h.actor = who;
      const act = await c.action();
      const signal = await captureRedirect(() => act(fd));
      return { signal, outcome: outcomeOf(signal) };
    }
    async function render(ctx: C, params: Record<string, string> = {}, who: Actor = ctx.f.admin): Promise<string> {
      h.actor = who;
      seen.records = [];
      const Page = await c.page();
      const el = await Page(c.props(ctx, params));
      return renderToStaticMarkup(el as never);
    }
    const hiddenRe = c.hiddenNames;
    const notDrawnOf = (ctx: C): string[] => (typeof c.notDrawn === 'function' ? c.notDrawn(ctx) : c.notDrawn);

    describe(`T-389 S2 ${c.label} - a refused save keeps what was typed (DEF-617) [${c.form}]`, () => {
      it(`slot: the refusal puts the allow-listed fields (and no hidden id) in the typed slot, kept for the signed-in person${c.note ? ` [${c.note}]` : ''}`, async () => {
        const ctx = await c.setup('slot');
        await submit(ctx, c.refused(ctx));
        const p = await payload();
        expect(p.t?.form, 'the typed slot carries the pinned form key').toBe(c.form);
        expect(p.t?.record).toBe(ctx.record);
        expect(p.t?.actor, 'kept for the person whose Save was refused').toBe(ctx.f.admin.personId);
        expect(p.t?.fields).toEqual(c.fields(ctx));
        for (const hid of hiddenRe) expect(Object.keys(p.t?.fields ?? {}), `${hid} is a hidden id, never kept`).not.toContain(hid);
        expect(JSON.stringify(p), '__changed itself is never stored').not.toContain('__changed');
        // Red on HEAD: the action keeps nothing. Mutant: allow-list a hidden id -> the toEqual / hidden-id legs go red.
      });

      it('changed: with the client __changed list only those names ride; a changed name the browser sent nothing for rides as []', async () => {
        const ctx = await c.setup('changed');
        const fd = c.refused(ctx);
        fd.set('__changed', c.changed.list);
        await submit(ctx, fd);
        const p = await payload();
        expect(p.t?.form).toBe(c.form);
        expect(p.t?.fields).toEqual(c.changed.fields(ctx));
        expect(JSON.stringify(p)).not.toContain('__changed');
        // Mutant: ignore __changed -> every submitted name rides, red. Skip a changed-but-absent name -> [] missing, red.
      });

      it('reopen: the page reopens THIS record in edit mode, draws the STORED values, and hands the record the typing', async () => {
        const ctx = await c.setup('reopen');
        const r = await submit(ctx, c.refused(ctx));
        const p = await payload();
        const html = await render(ctx, pageParamsOf(r.signal.url));
        expect(plain(html), 'the refusal banner').toMatch(c.refusal);
        const seg = pickForm(html, c.has(ctx));
        expect(seg, 'reopened: not locked').not.toContain('<fieldset disabled');
        expect(seg, 'Save is showing').toMatch(/<button[^>]*type="submit"[^>]*>\s*Save\s*<\/button>/);
        await c.stored(ctx, seg, markup);
        for (const typed of notDrawnOf(ctx)) expect(seg, `"${typed}" is typed, never drawn by the server (the browser applies it)`).not.toContain(typed);
        const rec = find(c.sel(ctx));
        expect(rec, 'the page rendered this record').toBeDefined();
        expect(rec?.typed, 'the page hands the record the typed view').toEqual({ kind: 'typed', fields: p.t!.fields });
        expect(detailsOpenAround(html, seg), 'a <details> around a reopened record must be open').not.toBe(false);
        // Red on HEAD: no typed slot, so the record is locked and `typed` is not passed.
        // Mutant: draw typed values as the defaults -> the notDrawn / stored legs go red. typedFor ignores the record -> siblings leg red.
      });

      it('person: another signed-in person given the same flash sees the record locked, nothing typed', async () => {
        const ctx = await c.setup('person');
        const r = await submit(ctx, c.refused(ctx));
        const params = pageParamsOf(r.signal.url);
        await render(ctx, params);
        expect(find(c.sel(ctx))?.typed?.kind, 'the person whose Save was refused is shown the typing (so "nothing for the other" proves something)').toBe('typed');
        const html = await render(ctx, params, ctx.f.other);
        const rec = find(c.sel(ctx));
        expect(rec, 'the page rendered this record').toBeDefined();
        expect(rec?.typed ?? null).toBeNull();
        expect(pickForm(html, c.has(ctx))).toContain('<fieldset disabled');
        // Mutant: typedFor ignores the actor -> the other person is shown the typing, red. (Also needs the typed slot to exist: red on HEAD only via the slot guard in `slot`.)
      });

      it('siblings: any other record, and any other form on the same row, stays locked with nothing typed', async () => {
        const ctx = await c.setup('siblings');
        const sibs = c.siblings ? await c.siblings(ctx) : [];
        const r = await submit(ctx, c.refused(ctx));
        expect((await payload()).t?.form, 'the refused form keeps its typing (so a sibling check proves something)').toBe(c.form);
        const html = await render(ctx, pageParamsOf(r.signal.url));
        expect(find(c.sel(ctx))?.typed, 'the refused record itself reopens').toEqual({ kind: 'typed', fields: (await payload()).t!.fields });
        for (const s of sibs) {
          const rec = find(s.sel);
          expect(rec, `${s.label}: rendered`).toBeDefined();
          expect(rec?.typed ?? null, `${s.label}: nothing typed`).toBeNull();
          expect(pickForm(html, s.has), `${s.label}: locked`).toContain('<fieldset disabled');
        }
        // Mutant: typedFor ignores the record id or the form key -> a sibling reopens with this record's typing, red.
      });

      it('dropped: typing too long for the cookie -> td (with the actor) and no t; the record stays locked with the stored values and says so', async () => {
        const ctx = await c.setup('dropped');
        const r = await submit(ctx, c.refused(ctx, c.tooLong));
        expect(r.outcome.flash.error, 'still a refusal').toBeTruthy();
        const p = await payload();
        expect(p.t, 'no typed slot').toBeUndefined();
        expect(p.td).toEqual({ form: c.form, record: ctx.record, actor: ctx.f.admin.personId });
        const html = await render(ctx, pageParamsOf(r.signal.url));
        const seg = pickForm(html, c.has(ctx));
        expect(seg, 'stays locked').toContain('<fieldset disabled');
        await c.stored(ctx, seg, markup);
        expect(plain(html)).toContain(TOO_LONG_SENTENCE);
        expect(find(c.sel(ctx))?.typed).toEqual({ kind: 'dropped' });
        expect(detailsOpenAround(html, seg), 'a <details> around the notice must be open').not.toBe(false);
        expect(seg, 'the long value is never drawn into the record').not.toContain('LongTyping-');
        // Red on HEAD: no td in the cookie. Mutant: shorten the value instead of dropping -> t present, red.
      });

      it('control (green today): the refusal reads as a refusal and nothing typed reaches the address', async () => {
        const ctx = await c.setup('control');
        const r = await submit(ctx, c.refused(ctx));
        expect(r.outcome.flash.error, 'a refusal, not a save').toMatch(c.refusal);
        expect(r.outcome.flash.ok).toBeUndefined();
        const typedUrl = decodeURIComponent(r.signal.url);
        for (const typed of notDrawnOf(ctx)) expect(typedUrl, 'nothing typed in the address').not.toContain(typed);
      });

      it('noFlash (green today): with no flash the record is found, locked, nothing typed', async () => {
        const ctx = await c.setup('noflash');
        const html = await render(ctx);
        const rec = find(c.sel(ctx));
        expect(rec, 'the selector finds this record (the other legs rely on it)').toBeDefined();
        expect(rec?.typed ?? null).toBeNull();
        const seg = pickForm(html, c.has(ctx));
        expect(seg).toContain('<fieldset disabled');
        await c.stored(ctx, seg, markup);
      });

      it('good (green today): a good save is unchanged - ok banner, no typed slot, no dropped notice', async () => {
        const ctx = await c.setup('good');
        const r = await submit(ctx, c.good(ctx));
        expect(r.outcome.flash.error, 'saved, not refused').toBeUndefined();
        expect(r.outcome.flash.ok).toMatch(c.ok);
        const p = await payload();
        expect(p.t).toBeUndefined();
        expect(p.td).toBeUndefined();
        // Mutant: keepTyping called on the success path -> t present, red.
      });
    });
  }

  return { runTypedLegs };
}
