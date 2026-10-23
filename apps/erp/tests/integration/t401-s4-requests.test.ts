import { afterAll, describe, expect, it, vi } from 'vitest';

import { cast, expectAccessRefused, expectSentenceError, fd, plain, rawItem, render, run, sql, uid, type Cast } from './t401-s4-common';

// T-448: a known verb (Approve, Reject, Save recipe, ...) is an icon button: its words are the aria-label, not visible text.
// Expose them to the text checks so "shows X" and "does not show X" both still mean something.
const plainL = (html: string): string => plain(html.replace(/<button\b[^>]*aria-label="([^"]*)"[^>]*>/g, '<button> $1 '));

/**
 * T-401 S4 (TESTER) - /menu/requests: request -> duplicate shown -> submit; approve / mark duplicate / reject as super admin.
 * Contract (including the TWO-STEP duplicate check on submit): header of t401-s4-common.ts.
 * Red today: `apps/erp/src/app/menu/requests/{actions.ts,page.tsx}` do not exist.
 *
 * Mutants: the first submit writes the request before showing the matches; the match list is empty for a normalised name
 * ("samgyupsal  set" vs "Samgyupsal Set"); an unrelated name triggers the warning; admin sees Approve; a manager sees other
 * managers' requests; approve leaves the request open; the picker lists a store the manager is not scoped to.
 */
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
vi.mock('../../src/lib/session', async () => (await import('./t401-s4-common')).sessionMock());
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));

afterAll(async () => {
  const { closeDb } = await import('@shareat/db');
  await closeDb();
  await sql.end({ timeout: 5 });
});

const ACTIONS = () => import('../../src/app/menu/requests/actions');
const PAGE = () => import('../../src/app/menu/requests/page');

interface Req {
  id: string;
  name: string;
  status: string;
  store_id: string;
  requested_by: string;
  item_type: string;
  category_id: string | null;
  note: string | null;
  resolved_item_id: string | null;
  resolution_note: string | null;
}
const reqs = (c: Cast) =>
  sql<Req[]>`
    select id, name, status, store_id, requested_by, item_type, category_id, note, resolved_item_id, resolution_note
      from menu_item_requests where org_id = ${c.orgId} order by created_at, id`;
const byName = async (c: Cast, name: string) => (await reqs(c)).filter((r) => r.name === name);

interface Actor2 {
  personId: string;
  orgId: string;
}

/** The value the page's "Send request anyway" button carries (the token shape is the builder's; the tests do not assume it). */
function confirmToken(html: string): string {
  const m = /<(?:input|button)\b[^>]*\sname="confirmed"[^>]*\svalue="([^"]*)"|<(?:input|button)\b[^>]*\svalue="([^"]*)"[^>]*\sname="confirmed"/.exec(html);
  expect(m, 'the warning page carries a name="confirmed" control').not.toBeNull();
  return (m![1] ?? m![2])!;
}
/** What a person does: submit; if warned, press "Send request anyway" on the page they were shown. */
async function submitChecked(c: Cast, who: Actor2, fields: Record<string, string>) {
  const base = { storeId: c.storeA, itemType: 'a_la_carte', ...fields };
  const first = await run(ACTIONS, 'submitItemRequestAction', who, fd(base));
  if (!first.flash.warning) return first;
  const token = confirmToken(await render(PAGE, who, { flashFrom: first.url }));
  return run(ACTIONS, 'submitItemRequestAction', who, fd({ ...base, confirmed: token }));
}

async function world(hint: string) {
  const c = await cast(`s4rq-${hint}`);
  const existing = await rawItem(c, 'a_la_carte', 'Samgyupsal Set');
  return { c, existing };
}
const asked = (c: Cast, extra: Record<string, string> = {}) =>
  fd({ storeId: c.storeA, name: 'Wagyu Platter', itemType: 'a_la_carte', ...extra });

describe('request -> duplicate shown -> submit (manager)', () => {
  it('step 1: a name that looks like an existing item writes NOTHING and the banner names the match', async () => {
    const w = await world('dup');
    const out = await run(ACTIONS, 'submitItemRequestAction', w.c.managerA, asked(w.c, { name: 'samgyupsal  set' }));
    expect(out.path).toBe('/menu/requests');
    expect(out.flash.error).toBeUndefined();
    expect(out.flash.ok).toBeUndefined();
    expect(out.flash.warning, 'a warning that names the existing item').toContain('Samgyupsal Set');
    expect(await reqs(w.c), 'nothing written before the manager has seen the match').toHaveLength(0);
  });

  it('the page then draws the warning with the match and a "Send request anyway" button; without the warning there is no such button', async () => {
    const w = await world('dup-page');
    const out = await run(ACTIONS, 'submitItemRequestAction', w.c.managerA, asked(w.c, { name: 'Samgyupsal Set' }));
    const withWarning = await render(PAGE, w.c.managerA, { flashFrom: out.url });
    expect(plainL(withWarning)).toContain('Samgyupsal Set');
    expect(plainL(withWarning)).toContain('Send request anyway');
    const token = confirmToken(withWarning);
    expect(token, 'a per-name token, never the bare "1"').not.toBe('1');
    expect(token.length).toBeGreaterThanOrEqual(8);
    await rawItem(w.c, 'a_la_carte', 'Pork Belly Set');
    const other = await run(ACTIONS, 'submitItemRequestAction', w.c.managerA, asked(w.c, { name: 'Pork Belly Set' }));
    expect(confirmToken(await render(PAGE, w.c.managerA, { flashFrom: other.url })), 'a different name carries a different token').not.toBe(token);
    const plainPage = await render(PAGE, w.c.managerA, {});
    expect(plainL(plainPage)).not.toContain('Send request anyway');
  });

  it('step 2: the same form with confirmed=1 creates the open request for that manager and store ("Request sent."); name, type, category hint and note are kept', async () => {
    const w = await world('confirm');
    const out = await submitChecked(w.c, w.c.managerA, { name: 'Samgyupsal Set', note: 'guests ask for it', categoryId: w.c.categoryId });
    expect(out.flash.error).toBeUndefined();
    expect(out.flash.ok).toBe('Request sent.');
    const [row] = await byName(w.c, 'Samgyupsal Set');
    expect(row).toMatchObject({
      status: 'open', store_id: w.c.storeA, requested_by: w.c.managerA.personId, item_type: 'a_la_carte', category_id: w.c.categoryId, note: 'guests ask for it', resolved_item_id: null,
    });
  });

  it('a name with no look-alike is created straight away, with no confirmation step', async () => {
    const w = await world('nodup');
    const out = await run(ACTIONS, 'submitItemRequestAction', w.c.managerA, asked(w.c));
    expect(out.flash.warning).toBeUndefined();
    expect(out.flash.ok).toBe('Request sent.');
    expect(await byName(w.c, 'Wagyu Platter')).toHaveLength(1);
  });

  it('blank name and an unknown item type are refused in sentences; nothing written', async () => {
    const w = await world('bad');
    expectSentenceError((await run(ACTIONS, 'submitItemRequestAction', w.c.managerA, asked(w.c, { name: '  ', confirmed: '1' }))).flash.error, 'blank name');
    expectSentenceError((await run(ACTIONS, 'submitItemRequestAction', w.c.managerA, asked(w.c, { itemType: 'dessert', confirmed: '1' }))).flash.error, 'bad type');
    expect(await reqs(w.c)).toHaveLength(0);
  });

  it('a manager withdraws their own open request ("Request withdrawn.")', async () => {
    const w = await world('wd');
    await run(ACTIONS, 'submitItemRequestAction', w.c.managerA, asked(w.c));
    const [row] = await byName(w.c, 'Wagyu Platter');
    const out = await run(ACTIONS, 'withdrawItemRequestAction', w.c.managerA, fd({ id: row!.id }));
    expect(out.flash.ok).toBe('Request withdrawn.');
    expect((await byName(w.c, 'Wagyu Platter'))[0]!.status).toBe('withdrawn');
  });
});

describe('the duplicate check cannot be skipped by reusing a confirmation', () => {
  it('warn on A, then "confirm" with a DIFFERENT look-alike B: B is checked again (warning, nothing written)', async () => {
    const w = await world('bound');
    await rawItem(w.c, 'a_la_carte', 'Pork Belly Set');
    const first = await run(ACTIONS, 'submitItemRequestAction', w.c.managerA, asked(w.c, { name: 'Samgyupsal Set' }));
    expect(first.flash.warning).toBeTruthy();
    const token = confirmToken(await render(PAGE, w.c.managerA, { flashFrom: first.url }));
    for (const reuse of [token, '1']) {
      const b = await run(ACTIONS, 'submitItemRequestAction', w.c.managerA, asked(w.c, { name: 'Pork Belly Set', confirmed: reuse }));
      expect(b.flash.warning, `B with confirmation "${reuse}" is warned about again`).toContain('Pork Belly Set');
      expect(b.flash.ok).toBeUndefined();
      expect(await reqs(w.c), 'nothing written').toHaveLength(0);
    }
    const a = await run(ACTIONS, 'submitItemRequestAction', w.c.managerA, asked(w.c, { name: 'Samgyupsal Set', confirmed: token }));
    expect(a.flash.ok, 'the confirmation still works for the name it was shown for').toBe('Request sent.');
    expect(await reqs(w.c)).toHaveLength(1);
  });

  it('an OPEN request counts as a look-alike: a second ask for the same / similar name shows the warning and writes nothing', async () => {
    const w = await world('open-dup');
    const one = await run(ACTIONS, 'submitItemRequestAction', w.c.managerA, asked(w.c));
    expect(one.flash.ok).toBe('Request sent.');
    for (const [who, name] of [[w.c.manager2, 'wagyu  platter'], [w.c.managerA, 'Wagyu Platter']] as const) {
      const again = await run(ACTIONS, 'submitItemRequestAction', who, asked(w.c, { name }));
      expect(again.flash.warning, `"${name}" while one is open`).toContain('Wagyu Platter');
      expect(again.flash.ok).toBeUndefined();
    }
    expect(await byName(w.c, 'Wagyu Platter')).toHaveLength(1);
    expect(await reqs(w.c)).toHaveLength(1);
  });
});

describe('/menu/requests - what each person sees', () => {
  it("the manager's form offers only the stores they are scoped to", async () => {
    const w = await world('picker');
    const html = await render(PAGE, w.c.managerA, {});
    const m = /<select\b[^>]*\sname="storeId"[^>]*>([\s\S]*?)<\/select>/.exec(html);
    expect(m, 'a <select name="storeId"> is drawn').not.toBeNull();
    const values = [...m![1]!.matchAll(/<option\b[^>]*\svalue="([^"]*)"/g)].map((x) => x[1]);
    expect(values).toEqual([w.c.storeA]);
    expect(html).not.toContain(w.c.storeB);
    const both = await render(PAGE, w.c.manager, {});
    expect(both).toContain(w.c.storeB);
  });

  it("a manager sees THEIR requests with outcomes (Open, Approved, Rejected with the reason, Duplicate of <item>) and not another manager's", async () => {
    const w = await world('mine');
    const mk = async (who: Actor2, name: string, status: string, extra = '') => {
      const resolved = status === 'open' ? null : w.c.superAdmin.personId;
      await sql`
        insert into menu_item_requests (org_id, store_id, requested_by, name, item_type, status, resolved_item_id, resolved_by, resolved_at, resolution_note, created_by)
        values (${w.c.orgId}, ${w.c.storeA}, ${who.personId}, ${name}, 'a_la_carte', ${status},
                ${status === 'duplicate' || status === 'approved' ? w.existing.itemId : null}, ${resolved}, ${resolved ? sql`now()` : null},
                ${status === 'rejected' ? extra : null}, ${who.personId})`;
    };
    await mk(w.c.manager, 'Open Thing', 'open');
    await mk(w.c.manager, 'Approved Thing', 'approved');
    await mk(w.c.manager, 'Rejected Thing', 'rejected', 'we already sell it as a set');
    await mk(w.c.manager, 'Duplicate Thing', 'duplicate');
    await mk(w.c.manager2, 'Someone Elses Thing', 'open');
    const t = plainL(await render(PAGE, w.c.manager, {}));
    for (const name of ['Open Thing', 'Approved Thing', 'Rejected Thing', 'Duplicate Thing']) expect(t, name).toContain(name);
    expect(t).toContain('Open');
    expect(t).toContain('Approved');
    expect(t).toContain('Rejected');
    expect(t, 'the reason the requester is told').toContain('we already sell it as a set');
    expect(t).toContain('Duplicate of Samgyupsal Set');
    expect(t, "another manager's request is not theirs").not.toContain('Someone Elses Thing');
  });

  it('staff are refused (names request_menu_item); a manager sees no Approve / Mark duplicate / Reject; an admin does not either', async () => {
    const w = await world('buttons');
    await run(ACTIONS, 'submitItemRequestAction', w.c.manager, asked(w.c));
    expectAccessRefused(await render(PAGE, w.c.staff, {}), 'request_menu_item');
    for (const [label, who] of [['manager', w.c.manager], ['admin', w.c.admin]] as const) {
      const t = plainL(await render(PAGE, who, {}));
      for (const b of ['Approve', 'Mark duplicate', 'Reject']) expect(t, `${label} must not see "${b}"`).not.toContain(b);
    }
  });

  it('the super admin sees the open queue (all stores, all requesters) with each request\'s likely matches and the three buttons; the approve box pre-selects the category hint', async () => {
    const w = await world('queue');
    await submitChecked(w.c, w.c.manager, { name: 'Samgyupsal Set', categoryId: w.c.categoryId });
    await run(ACTIONS, 'submitItemRequestAction', w.c.manager2, fd({ storeId: w.c.storeB, name: 'Wagyu Platter', itemType: 'a_la_carte' }));
    const html = await render(PAGE, w.c.superAdmin, {});
    const t = plainL(html);
    expect(t).toContain('Samgyupsal Set');
    expect(t).toContain('Wagyu Platter');
    for (const b of ['Approve', 'Mark duplicate', 'Reject']) expect(t, b).toContain(b);
    expect(t.indexOf('Samgyupsal Set'), 'the match is listed (the existing item AND the request carry the name)').not.toBe(t.lastIndexOf('Samgyupsal Set'));
    const sel = /<select\b[^>]*\sname="categoryId"[^>]*>([\s\S]*?)<\/select>/.exec(html);
    expect(sel, 'a category select on the approve form').not.toBeNull();
    expect(sel![1]).toMatch(new RegExp(`<option[^>]*value="${w.c.categoryId}"[^>]*selected|<option[^>]*selected[^>]*value="${w.c.categoryId}"`));
  });
});

describe('resolving a request (super admin only)', () => {
  async function open(w: Awaited<ReturnType<typeof world>>, name = 'Wagyu Platter') {
    await submitChecked(w.c, w.c.managerA, { name });
    return (await byName(w.c, name))[0]!;
  }

  it('approve: the item (named and typed as asked) and its default variant exist, the request is approved and points at it ("Item added from the request.")', async () => {
    const w = await world('approve');
    const r = await open(w);
    const out = await run(ACTIONS, 'approveItemRequestAction', w.c.superAdmin, fd({ id: r.id, categoryId: w.c.categoryId }));
    expect(out.flash.ok).toBe('Item added from the request.');
    expect(out.path).toBe('/menu/requests');
    const after = (await byName(w.c, 'Wagyu Platter'))[0]!;
    expect(after.status).toBe('approved');
    expect(after.resolved_item_id).toBeTruthy();
    const [item] = await sql<{ name: string; item_type: string; category_id: string }[]>`select name, item_type, category_id from menu_items where id = ${after.resolved_item_id!}`;
    expect(item).toMatchObject({ name: 'Wagyu Platter', item_type: 'a_la_carte', category_id: w.c.categoryId });
    expect(Number((await sql<{ n: number }[]>`select count(*)::int as n from menu_item_variants where menu_item_id = ${after.resolved_item_id!} and is_default`)[0]!.n)).toBe(1);
  });

  it('approving twice is refused in a sentence: one item only', async () => {
    const w = await world('approve2');
    const r = await open(w);
    await run(ACTIONS, 'approveItemRequestAction', w.c.superAdmin, fd({ id: r.id, categoryId: w.c.categoryId }));
    const again = await run(ACTIONS, 'approveItemRequestAction', w.c.superAdmin, fd({ id: r.id, categoryId: w.c.categoryId }));
    expectSentenceError(again.flash.error, 'second approval');
    expect(Number((await sql<{ n: number }[]>`select count(*)::int as n from menu_items where org_id = ${w.c.orgId} and name = 'Wagyu Platter'`)[0]!.n)).toBe(1);
  });

  it('approve into a category that does not exist is refused and the request stays open', async () => {
    const w = await world('approve3');
    const r = await open(w);
    const out = await run(ACTIONS, 'approveItemRequestAction', w.c.superAdmin, fd({ id: r.id, categoryId: '00000000-0000-4000-8000-000000000000' }));
    expect(out.flash.error).toBeTruthy();
    expect((await byName(w.c, 'Wagyu Platter'))[0]!.status).toBe('open');
  });

  it('mark duplicate points at the existing item ("Marked as a duplicate."); a missing item is refused', async () => {
    const w = await world('markdup');
    const r = await open(w, 'Samgyupsal Combo');
    const bad = await run(ACTIONS, 'markItemRequestDuplicateAction', w.c.superAdmin, fd({ id: r.id, itemId: '00000000-0000-4000-8000-000000000000' }));
    expect(bad.flash.error).toBeTruthy();
    const ok = await run(ACTIONS, 'markItemRequestDuplicateAction', w.c.superAdmin, fd({ id: r.id, itemId: w.existing.itemId }));
    expect(ok.flash.ok).toBe('Marked as a duplicate.');
    expect((await byName(w.c, 'Samgyupsal Combo'))[0]).toMatchObject({ status: 'duplicate', resolved_item_id: w.existing.itemId });
  });

  it('reject needs a reason; with one the request is rejected and the note stored ("Request rejected.")', async () => {
    const w = await world('reject');
    const r = await open(w);
    const none = await run(ACTIONS, 'rejectItemRequestAction', w.c.superAdmin, fd({ id: r.id, note: '   ' }));
    expectSentenceError(none.flash.error, 'reject without a reason');
    expect((await byName(w.c, 'Wagyu Platter'))[0]!.status).toBe('open');
    const ok = await run(ACTIONS, 'rejectItemRequestAction', w.c.superAdmin, fd({ id: r.id, note: 'not on the menu this season' }));
    expect(ok.flash.ok).toBe('Request rejected.');
    expect((await byName(w.c, 'Wagyu Platter'))[0]).toMatchObject({ status: 'rejected', resolution_note: 'not on the menu this season' });
  });

  it('the requester sees the outcome afterwards, in words', async () => {
    const w = await world('outcome');
    const r = await open(w, `Ube Cheesecake ${uid('x')}`);
    await run(ACTIONS, 'rejectItemRequestAction', w.c.superAdmin, fd({ id: r.id, note: 'dessert menu is closed' }));
    const t = plainL(await render(PAGE, w.c.managerA, {}));
    expect(t).toContain(r.name);
    expect(t).toContain('Rejected');
    expect(t).toContain('dessert menu is closed');
  });
});
