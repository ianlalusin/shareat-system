import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-389 S3 (TESTER) - shared harness for the sweep-L2 web tests (money and sales days).
 * Not a test file (no .test.ts suffix). Each `t389-s3-<area>-web.test.ts` owns its own vi.mock block and its own
 * fixture, then hands `keepTypingLegs` a spec; the legs below are the same K5 contract S1 pinned for the supplier form:
 *
 *   W1  a refused save puts exactly the allow-listed, user-editable fields in the typed slot of the signed flash,
 *       bound to the record id AND to the signed-in person, and nothing else (no hidden ids, no secrets);
 *       the address holds no typed value.
 *   W2  with the client's __changed list only the changed names ride, an unticked/absent changed box as [].
 *   W3  the page reopens THIS record with `typed`, still draws the STORED values (the server never draws typed ones).
 *   W4  a sibling record of the same form on the same page gets nothing (stays locked).
 *   W5  another signed-in person, given the same flash, sees nothing (shared till PC).
 *   W6  control (green on HEAD): no flash -> locked, nothing typed.
 *   W7  typing too long to keep -> `td` (with actor) in the cookie and no `t`; the page shows the `dropped` view.
 *   W8  control: a good save writes no typed slot.
 *
 * The form key (`<area>.<form>`) is NOT pinned (the page and the action share one definition, G10b enforces that it is
 * unique and used); the record id, the allow-list and the actor binding ARE pinned.
 */
config({ path: '.env.local' });

export const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { FLASH_COOKIE, captureRedirect, currentJar, outcomeOf, pageParamsOf, resetJar } from '../helpers/flash-jar';

export const sql = postgres(url, { max: 5 });
let seq = 0;
export const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
export const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

export function closeAfterAll(): void {
  afterAll(async () => {
    const { closeDb } = await import('@shareat/db');
    await closeDb();
    await sql.end({ timeout: 5 });
  });
}

export async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

export async function person(orgId: string, name: string, role: string, storeIds: string[]): Promise<string> {
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
  for (const s of storeIds) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
  return p!.id;
}

export type TypedCookie = { form: string; record: string; actor?: string; fields: Record<string, string | string[]> };
export async function cookiePayload(): Promise<{
  msg: Record<string, string>;
  keep: Record<string, string>;
  t?: TypedCookie;
  td?: { form: string; record: string; actor?: string };
}> {
  const { decodeFlash } = await import('../../src/lib/flash');
  return decodeFlash(currentJar().get(FLASH_COOKIE)!.value) as never;
}

export const plain = (html: string) =>
  html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/** The <form>...</form> holding `marker` (a hidden input of the record, e.g. `name="assetId" value="<id>"`). */
export function formAround(html: string, marker: string): string {
  const at = html.indexOf(marker);
  expect(at, `the record's form is on the page (marker ${marker})`).toBeGreaterThan(0);
  const start = html.lastIndexOf('<form', at);
  return html.slice(start, html.indexOf('</form>', at));
}
/** Is the <details> that wraps `marker` open? null = the marker is not inside a <details> at all. */
export function detailsOpenAround(html: string, marker: string): boolean | null {
  const at = html.indexOf(marker);
  const open = html.lastIndexOf('<details', at);
  if (open < 0 || html.lastIndexOf('</details>', at) > open) return null;
  return /\bopen\b/.test(html.slice(open, html.indexOf('>', open)));
}
export const SAVE_BUTTON = /<button[^>]*type="submit"[^>]*>\s*Save[^<]*<\/button>/;
export const TOO_LONG_SENTENCE = 'What you typed was too long to keep. This shows what is saved. Press Edit and enter your change again.';

export type TypedView = { kind?: string; fields?: Record<string, unknown>; hint?: string } | null | undefined;

export interface Spec<C> {
  /** Names the describe block. */
  area: string;
  setup(hint: string): Promise<C>;
  /** The person whose Save is refused, and a second signed-in person with the same page access. */
  admin(c: C): Actor;
  other(c: C): Actor;
  /** The record id the typed slot is bound to (the form's own hidden id; the storeId for a singleton). */
  recordId(c: C): string;
  /** The hidden marker that locates this record's <form> in the rendered page. */
  marker(c: C, id: string): string;
  /** A sibling record of the same form on the same page (stays locked); omit when the page has only one. */
  siblingId?(c: C): string;
  /** The refusing form exactly as the browser posts it (no __changed). `over` replaces/removes (null) a name. */
  refusedForm(c: C, over?: Record<string, string | null>): FormData;
  /** Runs the real action as `who`. */
  submit(c: C, fd: FormData, who: Actor): Promise<{ signal: { url: string }; error?: string | undefined; ok?: string | undefined }>;
  /** The refusal banner text the action sets (a RegExp or the exact sentence). */
  expectError: RegExp | string;
  /** W1: the typed fields when the whole form is posted with no __changed. */
  expectedFields(c: C): Record<string, string | string[]>;
  /** W1: substrings that must be nowhere in the signed payload or the address (hidden ids, secrets). */
  neverKept(c: C): string[];
  /** W2: a __changed list and what must then ride. */
  changedLeg(c: C): { changed: string; fields: Record<string, string | string[]>; over?: Record<string, string | null> };
  /** Renders the page as `who` with the given search params; the file's pass-through must have recorded the records. */
  render(c: C, who: Actor, params: Record<string, string>): Promise<string>;
  /** The `typed` prop the page handed the EditableRecord whose hidden marker is `id` (undefined: not found). */
  typedOf(c: C, id: string): { found: boolean; typed: TypedView };
  /** W3: what the page must draw (stored values, in the record's form) and must NOT draw (the typed values). */
  stored(c: C): string[];
  typedNotDrawn(c: C): string[];
  /** The page wraps this record in a closed <details> (supplier/budget/recurring): it must open on a typed/dropped view. */
  inDetails?: boolean;
  /** W7: one allow-listed field and a value too long for the cookie. */
  tooLong: { name: string | ((c: C) => string) };
  /** W8: a form the server accepts, and the banner it sets. */
  goodForm(c: C): FormData;
  expectOk: RegExp | string | true;
}

function textOf(expected: RegExp | string, got: string | undefined): void {
  if (typeof expected === 'string') expect(got).toBe(expected);
  else expect(got ?? '').toMatch(expected);
}

export function keepTypingLegs<C>(spec: Spec<C>): void {
  describe(`T-389 S3 ${spec.area} - a refused save keeps what was typed (DEF-617)`, () => {
    it('W1: a refused save (no JavaScript, no __changed) puts every user-editable field in the typed slot, bound to the record and to the signed-in person - and nothing else', async () => {
      const c = await spec.setup('w1');
      resetJar();
      const r = await spec.submit(c, spec.refusedForm(c), spec.admin(c));
      textOf(spec.expectError, r.error);
      const p = await cookiePayload();
      expect(p.t, 'the refusal carries a typed slot (red on HEAD: nothing is kept)').toBeDefined();
      expect(p.t?.form, 'a form key').toMatch(/^[a-z][a-zA-Z0-9.]+$/);
      expect(p.t?.record).toBe(spec.recordId(c));
      expect(p.t?.actor, 'bound to the signed-in person').toBe(spec.admin(c).personId);
      expect(p.t?.fields).toEqual(spec.expectedFields(c));
      const wire = JSON.stringify(p) + decodeURIComponent(r.signal.url);
      for (const never of spec.neverKept(c)) expect(wire, `${never} is never kept`).not.toContain(never);
      expect(Object.keys(p.keep), 'no keep keys needed').toEqual([]);
      for (const typed of spec.typedNotDrawn(c)) expect(decodeURIComponent(r.signal.url), 'nothing typed in the address').not.toContain(typed);
    });

    it('W2: with the client __changed list only the changed names ride (an unticked or absent changed box as an empty array); __changed itself is never stored', async () => {
      const c = await spec.setup('w2');
      resetJar();
      const fd = spec.refusedForm(c, spec.changedLeg(c).over);
      fd.set('__changed', spec.changedLeg(c).changed);
      const r = await spec.submit(c, fd, spec.admin(c));
      textOf(spec.expectError, r.error);
      const p = await cookiePayload();
      expect(p.t?.fields).toEqual(spec.changedLeg(c).fields);
      expect(JSON.stringify(p)).not.toContain('__changed');
    });

    it("W3: the page reopens THIS record in edit mode with the typing handed to it, and draws the STORED values (the server never draws a typed value)", async () => {
      const c = await spec.setup('w3');
      resetJar();
      const r = await spec.submit(c, spec.refusedForm(c), spec.admin(c));
      textOf(spec.expectError, r.error);
      const p = await cookiePayload();
      expect(p.t, 'precondition: the refusal kept a typed slot (red on HEAD)').toBeDefined();
      const id = spec.recordId(c);
      const html = await spec.render(c, spec.admin(c), pageParamsOf(r.signal.url));
      const seen = spec.typedOf(c, id);
      expect(seen.found, 'the record is on the page').toBe(true);
      expect(seen.typed, 'the record is handed the typing (red on HEAD: no typed prop)').toMatchObject({ kind: 'typed', fields: p.t?.fields ?? {} });
      const form = formAround(html, spec.marker(c, id));
      expect(form, 'reopened, not locked').not.toContain('<fieldset disabled');
      expect(form, 'Save is showing').toMatch(SAVE_BUTTON);
      for (const s of spec.stored(c)) expect(form, `stored ${s} drawn`).toContain(s);
      // The banner may quote the user's own typed value (their own flash); the judged region is the record's FORM.
      for (const t of spec.typedNotDrawn(c)) expect(form, `${t} is never drawn into the form by the server`).not.toContain(t);
      if (spec.inDetails) expect(detailsOpenAround(html, spec.marker(c, id)), 'the <details> around the form is open so the reopened record can be seen').toBe(true);
    });

    if (spec.siblingId) {
      it("W4: another record of the same form on the same page, given the same flash, stays locked with nothing typed", async () => {
        const c = await spec.setup('w4');
        resetJar();
        const r = await spec.submit(c, spec.refusedForm(c), spec.admin(c));
        textOf(spec.expectError, r.error);
        const sib = spec.siblingId!(c);
        const html = await spec.render(c, spec.admin(c), pageParamsOf(r.signal.url));
        const seen = spec.typedOf(c, sib);
        expect(seen.found, 'the sibling is on the page').toBe(true);
        expect(seen.typed ?? null).toBeNull();
        expect(formAround(html, spec.marker(c, sib))).toContain('<fieldset disabled');
        if (spec.inDetails) expect(detailsOpenAround(html, spec.marker(c, sib))).toBe(false);
      });
    }

    it('W5: another signed-in person, given the same flash, sees the record locked with nothing typed (the slot is bound to who typed it)', async () => {
      const c = await spec.setup('w5');
      resetJar();
      const r = await spec.submit(c, spec.refusedForm(c), spec.admin(c));
      textOf(spec.expectError, r.error);
      expect((await cookiePayload()).t, 'precondition: a typed slot was kept for the first person (red on HEAD)').toBeDefined();
      const id = spec.recordId(c);
      const html = await spec.render(c, spec.other(c), pageParamsOf(r.signal.url));
      const seen = spec.typedOf(c, id);
      expect(seen.found).toBe(true);
      expect(seen.typed ?? null).toBeNull();
      expect(formAround(html, spec.marker(c, id))).toContain('<fieldset disabled');
      if (spec.inDetails) expect(detailsOpenAround(html, spec.marker(c, id))).toBe(false);
    });

    it('W6 (control, green on HEAD): with no flash the record is locked, nothing typed', async () => {
      const c = await spec.setup('w6');
      resetJar();
      const id = spec.recordId(c);
      const html = await spec.render(c, spec.admin(c), {});
      const seen = spec.typedOf(c, id);
      expect(seen.found).toBe(true);
      expect(seen.typed ?? null).toBeNull();
      const form = formAround(html, spec.marker(c, id));
      expect(form).toContain('<fieldset disabled');
      for (const s of spec.stored(c)) expect(form, `stored ${s} is drawn (the markers W3 relies on)`).toContain(s);
      for (const t of spec.typedNotDrawn(c)) expect(html, `${t} is not on the page`).not.toContain(t);
      if (spec.inDetails) expect(detailsOpenAround(html, spec.marker(c, id))).toBe(false);
    });

    it('W7: typing too long to keep: td (with the person) in the cookie and no t; the page shows the sentence, the record stays locked with the stored values', async () => {
      const c = await spec.setup('w7');
      resetJar();
      const r = await spec.submit(c, spec.refusedForm(c, { [typeof spec.tooLong.name === 'function' ? spec.tooLong.name(c) : spec.tooLong.name]: 'LongValue-'.repeat(560) }), spec.admin(c));
      expect(r.error, 'still a refusal (the long value may change which sentence)').toBeTruthy();
      const p = await cookiePayload();
      expect(p.t, 'dropped whole, never shortened').toBeUndefined();
      expect(p.td, 'the dropped marker (red on HEAD: nothing is kept)').toMatchObject({ record: spec.recordId(c), actor: spec.admin(c).personId });
      const html = await spec.render(c, spec.admin(c), pageParamsOf(r.signal.url));
      const id = spec.recordId(c);
      const form = formAround(html, spec.marker(c, id));
      expect(form).toContain('<fieldset disabled');
      expect(plain(html)).toContain(TOO_LONG_SENTENCE);
      expect(spec.typedOf(c, id).typed).toEqual({ kind: 'dropped' });
      // The banner may quote the user's own value; the judged region is the record's form.
      expect(form).not.toContain('LongValue-');
      if (spec.inDetails) expect(detailsOpenAround(html, spec.marker(c, id)), 'the sentence must be visible').toBe(true);
    });

    it('W8 (control): a good save is unchanged - ok banner, nothing typed in the cookie', async () => {
      const c = await spec.setup('w8');
      resetJar();
      const r = await spec.submit(c, spec.goodForm(c), spec.admin(c));
      expect(r.error, 'the control form is accepted').toBeUndefined();
      if (spec.expectOk !== true) textOf(spec.expectOk, r.ok);
      const jarValue = currentJar().get(FLASH_COOKIE)?.value;
      if (jarValue) {
        const p = await cookiePayload();
        expect(p.t).toBeUndefined();
        expect(p.td).toBeUndefined();
      }
    });
  });
}

export { captureRedirect, outcomeOf, pageParamsOf, resetJar };
