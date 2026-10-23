import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { Actor } from '@shareat/auth';
import { FLASH_COOKIE, captureRedirect, currentJar, pageParamsOf, resetJar, outcomeOf } from '../helpers/flash-jar';
import {
  fixture, markup, pickForm, plain, sql, LONG, TOO_LONG_SENTENCE,
  type BaseCtx, type FormCase as S2FormCase, type Markup,
} from './t389-s2-common';

export { asOrg, actor, fixture, markup, plain, sql, uid, LONG, type BaseCtx, type Markup } from './t389-s2-common';

/**
 * T-389 S4 (TESTER) - the shared harness for the sweep-L3 web tests (items, stock, cutover count, commissary).
 * Spec: docs/tasks/389-refused-save-keeps-typing.md; bible row 300 (the typed slot supersedes the T-380 keep; the page
 * draws STORED values only). It is S2's `createHarness` (t389-s2-common.ts) with four changes the S4 forms need, kept here
 * because S2's file is not this slice's to edit:
 *
 *  1. `ok` may be null: cutover/count saves with NO banner (it redirects with an empty flash), so the good leg asserts "no
 *     error, no ok, no typed slot".
 *  2. a good save may RETURN instead of redirecting (inventory/low-stock revalidates and returns); the good leg then
 *     asserts the return and an unchanged jar.
 *  3. `around` wraps a REFUSED submit only: a permission refusal (items flags, store sellability) has no data driver, so the
 *     test revokes the person's role for the Save and restores it before the page is drawn (a role removed while the page
 *     was open, the case a real till sees).
 *  4. `guards`: extra refusals that happen BEFORE the data path (the super-admin AuthorizationError branch of rename and
 *     unit). Spec R2: "A guard clause that refuses before the try ... wires the same call." Each must keep the typed slot.
 *
 * Legs are the S2 set (slot / changed / reopen / person / siblings / dropped / control / noFlash / good). A `<details>` never
 * wraps an S4 form, so none is asserted.
 */
export interface S4Case<C extends BaseCtx> extends Omit<S2FormCase<C>, 'ok' | 'good'> {
  ok: RegExp | null;
  good(ctx: C): FormData;
  /** the good save returns normally (no redirect) */
  goodReturns?: boolean;
  around?: { before(ctx: C): Promise<void>; after(ctx: C): Promise<void> };
  guards?: Array<{
    label: string;
    /** who signs in for this refusal (default: the person whose Save is refused) */
    who(ctx: C): Actor;
    form(ctx: C): FormData;
    refusal: RegExp;
  }>;
}
export type { S4Case as FormCase };

type Rec = { typed?: { kind?: string; fields?: Record<string, unknown> } | null; action?: { name?: string }; hidden?: Record<string, string> };

function detailsOpenAround(html: string, seg: string): boolean | null {
  const at = html.indexOf(seg);
  const open = html.lastIndexOf('<details', at);
  if (open < 0 || html.lastIndexOf('</details>', at) > open) return null;
  return /\bopen\b/.test(html.slice(open, html.indexOf('>', open)));
}

export function createHarness(deps: { h: { actor: Actor | null }; seen: { records: Array<Record<string, unknown>> } }) {
  const { h, seen } = deps;

  async function payload(): Promise<{ msg: Record<string, string>; keep: Record<string, string>; t?: { form: string; record: string; fields: Record<string, string | string[]>; actor?: string }; td?: { form: string; record: string; actor?: string } }> {
    const { decodeFlash } = await import('../../src/lib/flash');
    return decodeFlash(currentJar().get(FLASH_COOKIE)!.value) as never;
  }
  function find(sel: { action: string; hidden: Record<string, string> }): Rec | undefined {
    return (seen.records as Rec[]).find((r) => r != null && r.action?.name === sel.action && Object.entries(sel.hidden).every(([k, v]) => r.hidden?.[k] === v));
  }

  function runTypedLegs<C extends BaseCtx>(c: S4Case<C>): void {
    async function submit(ctx: C, fd: FormData, opts: { who?: Actor; refusing?: boolean } = {}) {
      resetJar();
      h.actor = opts.who ?? ctx.f.admin;
      const act = await c.action();
      if (opts.refusing && c.around) await c.around.before(ctx);
      try {
        let signal: Awaited<ReturnType<typeof captureRedirect>> | null = null;
        let returned = false;
        try {
          signal = await captureRedirect(() => act(fd));
        } catch (e) {
          if (e instanceof Error && /expected a redirect, but the action returned normally/.test(e.message)) returned = true;
          else throw e;
        }
        return { signal, returned, outcome: signal ? outcomeOf(signal) : { flash: {} as Record<string, string | undefined> } };
      } finally {
        if (opts.refusing && c.around) await c.around.after(ctx);
      }
    }
    async function refuse(ctx: C, fd: FormData = c.refused(ctx)) {
      const r = await submit(ctx, fd, { refusing: true });
      expect(r.signal, 'the action redirected with a refusal').not.toBeNull();
      return { ...r, signal: r.signal! };
    }
    async function render(ctx: C, params: Record<string, string> = {}, who: Actor = ctx.f.admin): Promise<string> {
      h.actor = who;
      seen.records = [];
      const Page = await c.page();
      const el = await Page(c.props(ctx, params));
      return renderToStaticMarkup(el as never);
    }
    const notDrawnOf = (ctx: C): string[] => {
      const values = typeof c.notDrawn === 'function' ? c.notDrawn(ctx) : c.notDrawn;
      for (const v of values) {
        // A full UUID (a real record or type id, e.g. goneType) cannot collide by chance, so it is exempt; a short hex-only
        // value such as 'abc' can match inside a UUID and is refused.
        const fullUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
        if (!fullUuid && /^[0-9a-f-]+$/i.test(v)) throw new Error(`DEF-744: notDrawn value "${v}" in ${c.form} is hex-only and can match a record id (UUID) by chance; use a value with a non-hex letter, e.g. 'xyz'`);
      }
      return values;
    };

    describe(`T-389 S4 ${c.label} - a refused save keeps what was typed (DEF-617) [${c.form}]`, () => {
      it(`slot: the refusal puts the allow-listed fields (and no hidden id) in the typed slot, kept for the signed-in person${c.note ? ` [${c.note}]` : ''}`, async () => {
        const ctx = await c.setup('slot');
        const r = await refuse(ctx);
        expect(r.outcome.flash.error, 'a refusal').toMatch(c.refusal);
        const p = await payload();
        expect(p.t?.form, 'the typed slot carries the pinned form key').toBe(c.form);
        expect(p.t?.record).toBe(ctx.record);
        expect(p.t?.actor, 'kept for the person whose Save was refused').toBe(ctx.f.admin.personId);
        expect(p.t?.fields).toEqual(c.fields(ctx));
        for (const hid of c.hiddenNames) expect(Object.keys(p.t?.fields ?? {}), `${hid} is a hidden id, never kept`).not.toContain(hid);
        expect(JSON.stringify(p), '__changed itself is never stored').not.toContain('__changed');
      });

      it('changed: with the client __changed list only those names ride; a changed name the browser sent nothing for rides as []', async () => {
        const ctx = await c.setup('changed');
        const fd = c.refused(ctx);
        fd.set('__changed', c.changed.list);
        await refuse(ctx, fd);
        const p = await payload();
        expect(p.t?.form).toBe(c.form);
        expect(p.t?.fields).toEqual(c.changed.fields(ctx));
        expect(JSON.stringify(p)).not.toContain('__changed');
      });

      it('reopen: the page reopens THIS record in edit mode, draws the STORED values, and hands the record the typing', async () => {
        const ctx = await c.setup('reopen');
        const r = await refuse(ctx);
        const p = await payload();
        const html = await render(ctx, pageParamsOf(r.signal.url));
        expect(plain(html), 'the refusal banner').toMatch(c.refusal);
        const seg = pickForm(html, c.has(ctx));
        expect(seg, 'reopened: not locked').not.toContain('<fieldset disabled');
        expect(seg, 'Save is showing').toMatch(/<button[^>]*type="submit"[^>]*aria-label="Save"[^>]*>/); // T-448: Save is an icon button (words are aria-label + data-tip)
        await c.stored(ctx, seg, markup);
        for (const typed of notDrawnOf(ctx)) expect(seg, `"${typed}" is typed, never drawn by the server (the browser applies it)`).not.toContain(typed);
        const rec = find(c.sel(ctx));
        expect(rec, 'the page rendered this record').toBeDefined();
        expect(rec?.typed, 'the page hands the record the typed view').toEqual({ kind: 'typed', fields: p.t!.fields });
        expect(detailsOpenAround(html, seg), 'a <details> around a reopened record must be open').not.toBe(false);
      });

      it('person: another signed-in person given the same flash sees the record locked, nothing typed', async () => {
        const ctx = await c.setup('person');
        const r = await refuse(ctx);
        const params = pageParamsOf(r.signal.url);
        await render(ctx, params);
        expect(find(c.sel(ctx))?.typed?.kind, 'the person whose Save was refused is shown the typing (so "nothing for the other" proves something)').toBe('typed');
        const html = await render(ctx, params, ctx.f.other);
        const rec = find(c.sel(ctx));
        expect(rec, 'the page rendered this record').toBeDefined();
        expect(rec?.typed ?? null).toBeNull();
        expect(pickForm(html, c.has(ctx))).toContain('<fieldset disabled');
      });

      it('siblings: any other record, and any other form on the same row, stays locked with nothing typed', async () => {
        const ctx = await c.setup('siblings');
        const sibs = c.siblings ? await c.siblings(ctx) : [];
        const r = await refuse(ctx);
        expect((await payload()).t?.form, 'the refused form keeps its typing (so a sibling check proves something)').toBe(c.form);
        const html = await render(ctx, pageParamsOf(r.signal.url));
        expect(find(c.sel(ctx))?.typed, 'the refused record itself reopens').toEqual({ kind: 'typed', fields: (await payload()).t!.fields });
        for (const s of sibs) {
          const rec = find(s.sel);
          expect(rec, `${s.label}: rendered`).toBeDefined();
          expect(rec?.typed ?? null, `${s.label}: nothing typed`).toBeNull();
          expect(pickForm(html, s.has), `${s.label}: locked`).toContain('<fieldset disabled');
        }
      });

      it('dropped: typing too long for the cookie -> td (with the actor) and no t; the record stays locked with the stored values and says so', async () => {
        const ctx = await c.setup('dropped');
        const r = await refuse(ctx, c.refused(ctx, c.tooLong));
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
        expect(seg, 'the long value is never drawn into the record').not.toContain('LongTyping-');
      });

      for (const g of c.guards ?? []) {
        it(`guard: ${g.label} - a refusal before the data path keeps the typing too`, async () => {
          const ctx = await c.setup('guard');
          const r = await submit(ctx, g.form(ctx), { who: g.who(ctx) });
          expect(r.signal, 'redirected with a refusal').not.toBeNull();
          expect(r.outcome.flash.error).toMatch(g.refusal);
          const p = await payload();
          expect(p.t?.form, 'the guard branch calls keepTyping (red on HEAD: nothing kept)').toBe(c.form);
          expect(p.t?.record).toBe(ctx.record);
        });
      }

      it('control (green today): the refusal reads as a refusal and nothing typed reaches the address', async () => {
        const ctx = await c.setup('control');
        const r = await refuse(ctx);
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

      it('good (green today): a good save is unchanged - no error, no typed slot, no dropped notice', async () => {
        const ctx = await c.setup('good');
        const r = await submit(ctx, c.good(ctx));
        if (c.goodReturns) {
          expect(r.returned, 'this action saves and returns (no redirect)').toBe(true);
          const raw = currentJar().get(FLASH_COOKIE)?.value;
          expect(raw === undefined || (await payload()).t === undefined).toBe(true);
          return;
        }
        expect(r.signal, 'redirected').not.toBeNull();
        expect(r.outcome.flash.error, 'saved, not refused').toBeUndefined();
        if (c.ok) expect(r.outcome.flash.ok).toMatch(c.ok);
        else expect(r.outcome.flash.ok, 'this save says nothing').toBeUndefined();
        const raw = currentJar().get(FLASH_COOKIE)?.value;
        if (raw) {
          const p = await payload();
          expect(p.t).toBeUndefined();
          expect(p.td).toBeUndefined();
        }
      });
    });
  }

  return { runTypedLegs };
}

/** S2's fixture (an org, one store, two admins scoped to it) with both people promoted to super_admin. */
export async function superFixture(hint: string, opts: { chart?: boolean } = {}) {
  const f = await fixture(hint, opts);
  await sql`update person_roles set role = 'super_admin' where person_id in (${f.admin.personId}, ${f.other.personId})`;
  return f;
}
