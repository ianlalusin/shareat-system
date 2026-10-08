import { config } from 'dotenv';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * T-384 S1b-min (TESTER) - the page must POST the version S1a made the actions require.
 * Bug (browser smoke): `updateTenderAction` / `setTenderActiveAction` refuse a blank version, but the tender edit form
 * and the Retire/Restore form post only storeId + tenderId, so EVERY edit/retire is refused with the stale sentence;
 * and redirects end in `#store-<uuid>` while no element carries that id.
 *  - V1: edit form has hidden `version` = the tender current version (the repo: microseconds of
 *    coalesce(updated_at, created_at)); V2: same for the Retire form; V3: Restore form carries the NEW version.
 *    Red: the form has no `version` input.
 *  - A1: each store card has id="store-<storeId>".  Red: no such id.
 *  - E1/E2: page version -> action succeeds and lands; the SAME (now old) version -> stale sentence, no change.
 *    Red: the page yields no version to submit.
 * Real Postgres + real domain; session, navigation, cookie jar and Page shell doubled (harness: t382-s3-unlink-web).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

const h = vi.hoisted(() => ({ actor: null as null | { personId: string; orgId: string } }));

vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => h.actor),
  requireSession: vi.fn(async () => ({
    actor: h.actor, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01'),
  })),
}));
vi.mock('@/lib/constraint-messages', async () => await import('../../src/lib/constraint-messages'));
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));

import * as D from '@shareat/domain';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { sql as dsql } from 'drizzle-orm';
import { s6Fixture } from '../../../../packages/domain/tests/integration/_fixtures/pos-s6';
import PosLinkSettingsPage from '../../src/app/settings/pos-link/page';
import { captureRedirect, outcomeOf, resetJar } from '../helpers/flash-jar';

const sql = postgres(url, { max: 6 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const STALE =
  'This tender was changed after this page was opened. The page now shows what is saved. Check it and save again.';

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

async function fixture(hint: string) {
  const base = await s6Fixture(sql, `t384s1bmin-${hint}`);
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${base.orgId}, 'Super') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${base.orgId}, 'super_admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${base.storeId})`;
  const superAdmin = { personId: p!.id, orgId: base.orgId };
  const { id: tenderId } = await asOrg(base.orgId, (tx) =>
    D.createTender(tx, superAdmin, { storeId: base.storeId, name: 'Cash drawer', kind: 'cash', posV1Alias: 'T384 Drawer' }),
  );
  return { ...base, superAdmin, tenderId };
}
type F = Awaited<ReturnType<typeof fixture>>;

/** The repo's version of the tender, computed the way the repo computes it. */
async function repoVersion(tenderId: string): Promise<string> {
  const [r] = await sql<{ v: string }[]>`select (extract(epoch from coalesce(updated_at, created_at)) * 1000000)::bigint::text as v from tenders where id = ${tenderId}`;
  return r!.v;
}
const tenderRow = async (id: string) =>
  (await sql<{ name: string; is_active: boolean }[]>`select name, is_active from tenders where id = ${id}`)[0]!;

async function render(f: F): Promise<string> {
  h.actor = f.superAdmin;
  const el = await PosLinkSettingsPage({ searchParams: Promise.resolve({}) });
  return renderToStaticMarkup(el as never);
}

/** Hidden inputs of every <form> that carries this tender id. */
function formsFor(html: string, tenderId: string): { fields: Record<string, string>; text: string }[] {
  const out: { fields: Record<string, string>; text: string }[] = [];
  for (const chunk of html.split('<form').slice(1)) {
    const body = chunk.split('</form>')[0]!;
    const fields: Record<string, string> = {};
    for (const m of body.matchAll(/<input[^>]*>/g)) {
      const tag = m[0];
      const name = /name="([^"]*)"/.exec(tag)?.[1];
      const value = /value="([^"]*)"/.exec(tag)?.[1];
      if (name && value !== undefined && /type="hidden"/.test(tag)) fields[name] = value;
    }
    if (fields['tenderId'] === tenderId) out.push({ fields, text: body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ') });
  }
  return out;
}
const editForm = (html: string, id: string) => formsFor(html, id).find((x) => !('isActive' in x.fields));
const retireForm = (html: string, id: string) => formsFor(html, id).find((x) => 'isActive' in x.fields);

type ActionFn = (fd: FormData) => Promise<void>;
async function act(name: 'updateTenderAction' | 'setTenderActiveAction', who: F['superAdmin'], fd: FormData) {
  resetJar();
  h.actor = who;
  const mod = (await import('../../src/app/settings/pos-link/actions')) as unknown as Record<string, ActionFn>;
  const signal = await captureRedirect(() => mod[name]!(fd));
  return { signal, outcome: outcomeOf(signal) };
}
function edit(f: F, version: string, name: string): FormData {
  const fd = new FormData();
  fd.set('storeId', f.storeId);
  fd.set('tenderId', f.tenderId);
  fd.set('name', name);
  fd.set('posV1Alias', 'T384 Drawer');
  fd.set('version', version);
  return fd;
}
function retire(f: F, version: string, isActive: boolean): FormData {
  const fd = new FormData();
  fd.set('storeId', f.storeId);
  fd.set('tenderId', f.tenderId);
  fd.set('isActive', String(isActive));
  fd.set('version', version);
  return fd;
}

describe('V - the page posts the tender version', () => {
  it('V1: the edit form carries hidden name="version" equal to the tender current version', async () => {
    const f = await fixture('v1');
    const html = await render(f);
    const form = editForm(html, f.tenderId);
    expect(form, 'the tender edit form is on the page').toBeDefined();
    expect(form!.fields['version'], 'edit form hidden version').toBe(await repoVersion(f.tenderId));
  });

  // 2026-10-09 (T-384 S1b R3): Retire is the EditableRecord's `extra`, rendered only while editing, so it is NOT in the
  // locked server render this file reads. The assertion that its form carries the current version is kept, and moved to
  // the thing that renders it: the version rides on the record's own hidden inputs (the Retire form is built from the
  // same `x.version`, checked in the source), and E2 below still drives the action with the version read off the page.
  it('V2: the Retire form (an `extra` of the record) is built with the tender version; the locked render carries that version on the record form', async () => {
    const f = await fixture('v2');
    const html = await render(f);
    expect(editForm(html, f.tenderId)!.fields['version'], 'record form hidden version').toBe(await repoVersion(f.tenderId));
    expect(retireForm(html, f.tenderId), 'no Retire button while the record is locked (shown only in edit mode)').toBeUndefined();
    const src = readFileSync(resolve(__dirname, '..', '..', 'src', 'app', 'settings', 'pos-link', 'page.tsx'), 'utf8');
    expect(src, 'Retire form posts name="version"').toMatch(/setTenderActiveAction[\s\S]{0,700}name="version"/);
  });

  it('V3: after a retire the Restore form carries the NEW version, not the old one', async () => {
    const f = await fixture('v3');
    const v0 = await repoVersion(f.tenderId);
    await act('setTenderActiveAction', f.superAdmin, retire(f, v0, false));
    const form = retireForm(await render(f), f.tenderId);
    expect(form!.text).toContain('Restore');
    expect(form!.fields['version'], 'restore form hidden version').toBe(await repoVersion(f.tenderId));
    expect(form!.fields['version']).not.toBe(v0);
  });
});

describe('A - the anchor target exists', () => {
  it('A1: the store card has id="store-<storeId>"', async () => {
    const f = await fixture('a1');
    const html = await render(f);
    expect(html).toContain(`id="store-${f.storeId}"`);
  });
});

describe('E - end to end: the version read off the page drives the actions', () => {
  it('E1: updateTenderAction with the page version saves; the same (now old) version is refused with the stale sentence', async () => {
    const f = await fixture('e1');
    const pageV = editForm(await render(f), f.tenderId)?.fields['version'];
    expect(pageV, 'the page offers a version to submit').toBeTruthy();
    const ok = await act('updateTenderAction', f.superAdmin, edit(f, pageV!, 'Cash box'));
    expect(ok.outcome.flash.error).toBeUndefined();
    expect(ok.outcome.flash.ok).toBe('Cash box saved.'); // 2026-10-09 (T-384 S1b R7): ok names the tender; was 'Tender saved.'
    expect((await tenderRow(f.tenderId)).name).toBe('Cash box');
    expect(ok.signal.url).toContain(`#store-${f.storeId}`);

    const stale = await act('updateTenderAction', f.superAdmin, edit(f, pageV!, 'Third name'));
    expect(stale.outcome.flash.error).toBe(STALE);
    expect((await tenderRow(f.tenderId)).name, 'a stale post changes nothing').toBe('Cash box');
  });

  it('E2: setTenderActiveAction with the page version retires; the same (now old) version is refused', async () => {
    const f = await fixture('e2');
    const pageV = editForm(await render(f), f.tenderId)?.fields['version']; // 2026-10-09: Retire is edit-mode only; same version as the record form
    expect(pageV, 'the page offers a version to submit').toBeTruthy();
    const ok = await act('setTenderActiveAction', f.superAdmin, retire(f, pageV!, false));
    expect(ok.outcome.flash.error).toBeUndefined();
    expect(ok.outcome.flash.ok).toBe('Cash drawer retired.'); // 2026-10-09 (T-384 S1b R7): was 'Tender retired.'
    expect((await tenderRow(f.tenderId)).is_active).toBe(false);

    const stale = await act('setTenderActiveAction', f.superAdmin, retire(f, pageV!, true));
    expect(stale.outcome.flash.error).toBe(STALE);
    expect((await tenderRow(f.tenderId)).is_active, 'a stale restore changes nothing').toBe(false);
  });
});
