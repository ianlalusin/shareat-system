import { config } from 'dotenv';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * T-382 S3 - the screen half of the guarded POS unlink: `/settings/pos-link` and `unlinkStoreFromPosAction`.
 * `docs/tasks/382-pos-store-unlink.md` section S3, tests W1-W5 (SPEC 6a05fd3, ✎AMEND REV-9 sentence). TESTER, not
 * BUILDER: no production code.
 *
 * Real Postgres and the REAL domain underneath; only the session, Next's navigation helpers, the cookie jar (the
 * T-380 S1 jar, `../helpers/flash-jar*`) and the `Page` shell are doubled. Banners are read through `outcomeOf`
 * (T-380 S1b), and every banner leg ALSO reads the raw redirect URL, because `outcomeOf` falls back to the URL until
 * T-380 S6 and so would pass on a screen that still puts the banner in the address bar.
 *
 * ## Why these are red on HEAD (the reason, per test)
 * `unlinkStoreFromPosAction`, `canUnlink` and the Unlink section do not exist, and migration 0187 does not exist.
 *  - W1 (super admin sees the section): MISSING FEATURE (no section). The admin half ("no section") passes on HEAD.
 *  - W2, W3, W4 (the action): MISSING FEATURE (`unlinkStoreFromPosAction` is not exported). W3's address-bar half is
 *    additionally BEHAVIOURAL once the action exists: it fails if the action uses `back({ ok })` (the page address).
 *  - W5 (unlinked card): MISSING FEATURE (it unlinks through `D.unlinkStoreFromPos` first).
 *
 * ## Pinned where the spec is silent (a question to the builder, never a test edit)
 *  - the action is `unlinkStoreFromPosAction(fd)` reading the form fields `storeId`, `reason` and `confirm` (the
 *    checkbox; ticked posts `on`), ending in a redirect to `/settings/pos-link` (`redirectWithFlash`);
 *  - the section is found by its heading text "Unlink from POS" and the button "Unlink {Store}", the reason box is a
 *    `<textarea>` with `maxLength="500"`, the confirmation is a `type="checkbox"`;
 *  - "{date}" in "Unlinked {date} by {name}: {reason}" is asserted only as non-empty (the builder picks the format);
 *  - the confirm sentence and the R3 sentence are asserted word for word, on the tag-stripped text.
 *
 * ## Mutants (named per leg; applied by the AUDITOR)
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
import { parseBusinessDate } from '@shareat/core/datetime';
import { importTestDay } from '../../../../packages/domain/tests/integration/_fixtures/pos-day';
import { s6Fixture } from '../../../../packages/domain/tests/integration/_fixtures/pos-s6';
import { humanDate as humanDateOf } from '../../../../packages/domain/src/shared/refusal-leaf';
import PosLinkSettingsPage from '../../src/app/settings/pos-link/page';
import { captureRedirect, currentJar, FLASH_COOKIE, outcomeOf, pageParamsOf, resetJar } from '../helpers/flash-jar';

const hd = (d: string) => humanDateOf(parseBusinessDate(d));
const sql = postgres(url, { max: 6 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const D1 = '2027-01-10';
const D2 = '2027-01-11';
const REASON = 'wrong store 123';

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

/** Lipa LINKED (POS name "Test POS store"), a super admin, an admin and a manager; `verified` imported days. */
async function fixture(hint: string, o: { verified?: number; openDay?: boolean } = {}) {
  const base = await s6Fixture(sql, `t382s3-${hint}`);
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${base.orgId}, 'Super') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${base.orgId}, 'super_admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${base.storeId})`;
  const superAdmin = { personId: p!.id, orgId: base.orgId };
  const dates = [D1, D2].slice(0, o.verified ?? 0);
  for (const date of dates) {
    const { id } = await asOrg(base.orgId, (tx) => importTestDay(tx, base.manager, { storeId: base.storeId, businessDate: date }));
    await asOrg(base.orgId, (tx) => D.verifySalesDay(tx, base.manager, id));
  }
  if (o.openDay) await asOrg(base.orgId, (tx) => importTestDay(tx, base.manager, { storeId: base.storeId, businessDate: '2027-01-15' }));
  return { ...base, superAdmin, adminActor: { personId: base.adminId, orgId: base.orgId } };
}
type F = Awaited<ReturnType<typeof fixture>>;

const linkRow = async (storeId: string) =>
  (await sql<{ unlinked_at: Date | null; unlink_reason: string | null }[]>`select unlinked_at, unlink_reason from pos_v1_store_links where store_id = ${storeId}`)[0];

/** The page as one person reads it: markup, entities decoded, tags stripped, whitespace collapsed. */
const plain = (html: string): string =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&#x27;/g, "'").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&gt;/g, '>').replace(/&lt;/g, '<')
    .replace(/\s+/g, ' ');
async function renderAs(who: { personId: string; orgId: string }, params: Record<string, string> = {}): Promise<{ html: string; text: string }> {
  h.actor = who;
  const el = await PosLinkSettingsPage({ searchParams: Promise.resolve(params) });
  const html = renderToStaticMarkup(el as never);
  return { html, text: plain(html) };
}

type ActionFn = (fd: FormData) => Promise<void>;
async function unlinkAction(): Promise<ActionFn> {
  const mod = (await import('../../src/app/settings/pos-link/actions')) as unknown as Record<string, unknown>;
  const fn = mod['unlinkStoreFromPosAction'];
  if (typeof fn !== 'function') throw new Error('unlinkStoreFromPosAction is not exported from settings/pos-link/actions (T-382 S3 not built)');
  return fn as ActionFn;
}
function form(f: F, fields: Record<string, string>): FormData {
  const fd = new FormData();
  fd.set('storeId', f.storeId);
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}
async function run(who: { personId: string; orgId: string }, fd: FormData) {
  resetJar();
  h.actor = who;
  const act = await unlinkAction();
  const signal = await captureRedirect(() => act(fd));
  return { signal, outcome: outcomeOf(signal), raw: signal.url };
}

const confirmSentence = (store: string, posName: string, n: number) =>
  `Unlinking ${store} from POS store ${posName}: from the next sales day you type in, ${store}'s sales are typed, not imported. ` +
  `The ${n} days already imported from POS stay exactly as they are. They can't be edited, re-imported or corrected from POS. ` +
  `A manager can still withdraw an imported day and type it again. An admin can link the store again later.`;
const r3Sentence = (store: string, dates: string[]) =>
  `${store} has imported sales days that aren't verified yet (${dates.join(', ')}). Verify or withdraw them before unlinking it.`;

// =====================================================================================================
describe('W1 - who sees the Unlink section', () => {
  it('a super admin sees "Unlink from POS" with the confirm sentence (store, POS store name, imported-day count), a reason box, a checkbox and the button', async () => {
    const f = await fixture('w1', { verified: 2 });
    const { html, text } = await renderAs(f.superAdmin);
    expect(text).toContain('Unlink from POS');
    expect(text, 'the confirm sentence, word for word (REV-9 ending)').toContain(confirmSentence('Lipa', 'Test POS store', 2));
    expect(html, 'a reason box with the 500 limit').toMatch(/<textarea[^>]*maxLength="500"|<textarea[^>]*maxlength="500"/i);
    expect(html, 'a confirmation checkbox').toMatch(/<input[^>]*type="checkbox"/);
    expect(text).toContain("I understand: Lipa's sales will be typed from now on.");
    expect(text, 'the button names the store').toContain('Unlink Lipa');
  });

  it('an admin (manage_chart_of_accounts, not super admin) sees the page and the link form but NO Unlink section; passes on HEAD', async () => {
    const f = await fixture('w1a', { verified: 2 });
    const { html, text } = await renderAs(f.adminActor);
    // 2026-10-09 (T-384 S1b A0 L1): a linked store's link form is a locked EditableRecord; its button is now Edit, not 'Save link'.
    expect(text, 'control: the admin reaches the page and its link form').toContain('POS store');
    expect(html).toMatch(/aria-label="Edit Lipa"|aria-label="Edit [^"]*"/);
    expect(text).not.toContain('Unlink from POS');
    expect(text).not.toContain('Unlink Lipa');
    expect(html).not.toMatch(/<input[^>]*type="checkbox"/);
  });
  // Mutant: the section ungated (shown to every viewer of the page) -> the admin leg is red.
});

describe('W2 - the confirmation box', () => {
  it('unticked -> "Tick the box to confirm."; the link row is unchanged; no audit row', async () => {
    const f = await fixture('w2', { verified: 1 });
    const { outcome, signal, raw } = await run(f.superAdmin, form(f, { reason: REASON }));
    expect(signal.url.startsWith('/settings/pos-link')).toBe(true);
    expect(outcome.flash.error).toBe('Tick the box to confirm.');
    // Auditor (T-382): a REFUSAL goes back through the flash too; the typed reason never reaches the address (DEF-476).
    expect(decodeURIComponent(raw.replace(/\+/g, ' ')), 'the reason is not in the address on a refusal').not.toContain('wrong store');
    expect(raw).not.toMatch(/[?&](ok|error|reason)=/);
    expect(outcome.flash.ok).toBeUndefined();
    expect((await linkRow(f.storeId))!.unlinked_at).toBeNull();
    expect(await sql`select 1 from audit_log where org_id = ${f.orgId} and action = 'unlink_store_from_pos'`).toHaveLength(0);
  });
  // Mutant: the box check removed -> the unticked post unlinks, red.
});

describe('W3 - a ticked post unlinks, and neither the reason nor the banner travels in the address', () => {
  it('success banner from the flash; the redirect URL carries no reason and no banner text; the reason is stored', async () => {
    const f = await fixture('w3', { verified: 2 });
    const { outcome, raw } = await run(f.superAdmin, form(f, { reason: REASON, confirm: 'on' }));
    expect(outcome.flash.ok).toBe('Lipa is unlinked from POS. Its sales days are typed from now on.');
    expect(outcome.flash.error).toBeUndefined();
    expect(currentJar().has(FLASH_COOKIE), 'the banner is in the flash cookie').toBe(true);
    const decoded = decodeURIComponent(raw.replace(/\+/g, ' '));
    expect(decoded, 'DEF-476: the reason is not in the address bar').not.toContain('wrong store');
    expect(decoded).not.toContain('123');
    expect(decoded, 'nor the banner').not.toMatch(/unlinked from POS|typed from now on/);
    expect(raw).not.toMatch(/[?&](ok|error|reason)=/);
    const row = await linkRow(f.storeId);
    expect(row!.unlinked_at).toBeInstanceOf(Date);
    expect(row!.unlink_reason).toBe(REASON);
  });
  // Mutant: `back({ ok })` with the URL (the pre-T-380 shape) -> the raw-URL asserts are red.
});

describe('W4 - R3 on the screen: an open imported day blocks the unlink', () => {
  it('the loader shows the R3 sentence and NO form; the action posted anyway refuses with the same sentence', async () => {
    const f = await fixture('w4', { verified: 1, openDay: true });
    const { html, text } = await renderAs(f.superAdmin);
    expect(text, 'the sentence names the open day').toContain(r3Sentence('Lipa', [hd('2027-01-15')]));
    expect(text, 'and no form: no button, no confirmation').not.toContain('Unlink Lipa');
    expect(text).not.toContain('I understand:');
    expect(html).not.toMatch(/<input[^>]*type="checkbox"/);

    const { outcome, raw } = await run(f.superAdmin, form(f, { reason: REASON, confirm: 'on' }));
    expect(outcome.flash.error).toBe(r3Sentence('Lipa', [hd('2027-01-15')]));
    expect(decodeURIComponent(raw.replace(/\+/g, ' ')), 'auditor: the reason is not in the address on the R3 refusal').not.toContain('wrong store');
    expect(raw).not.toMatch(/[?&](ok|error|reason)=/);
    expect(outcome.flash.ok).toBeUndefined();
    expect((await linkRow(f.storeId))!.unlinked_at, 'nothing unlinked').toBeNull();
  });
  // Mutant: the loader ignores R3 (always shows the form) -> the first half is red.
});

describe('W5 - an unlinked store\'s card', () => {
  it('shows "Not linked — sales are typed", "Unlinked {date} by {name}: {reason}" and the link form; not the linked badge, not the Unlink section', async () => {
    const f = await fixture('w5', { verified: 1 });
    const fn = (D as unknown as Record<string, unknown>)['unlinkStoreFromPos'];
    if (typeof fn !== 'function') throw new Error('unlinkStoreFromPos is not exported from @shareat/domain (T-382 S2 not built)');
    await asOrg(f.orgId, (tx) =>
      (fn as (tx: Tx, a: typeof f.superAdmin, i: { storeId: string; reason: string }) => Promise<unknown>)(tx, f.superAdmin, { storeId: f.storeId, reason: REASON }),
    );
    const { html, text } = await renderAs(f.superAdmin);
    expect(text).toContain('Not linked — sales are typed');
    expect(text, 'who, when (any format) and why').toMatch(/Unlinked .+ by Super: wrong store 123/);
    expect(text, 'not shown as linked').not.toContain('Linked to');
    // 2026-10-09 (T-384 S1b A0 L4): an unlinked store's link form is an add form; its submit now reads 'Save', not 'Link store'.
    expect(html, 'the link form is there for a relink (R8)').toMatch(/<button[^>]*type="submit"[^>]*>\s*Save\s*<\/button>/);
    expect(html).toMatch(/name="posStoreId"/);
    expect(text, 'no Unlink section on an unlinked store').not.toContain('Unlink Lipa');
  });
  // Mutant: `listLinks` rows treated as live in the loader -> the card says "Linked to Test POS store", red.
});

