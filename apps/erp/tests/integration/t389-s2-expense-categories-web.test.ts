import { expect, vi } from 'vitest';

/**
 * T-389 S2 (TESTER) - settings/expense-categories: the rename form and the account form on each category row keep what
 * was typed after a refused save (DEF-617). Spec: docs/tasks/389-refused-save-keeps-typing.md. Harness: t389-s2-common.ts.
 *
 * Forms (page -> action -> the refusal driven):
 *   Rename   renameCategoryAction       a name another category already has ("names are compared ignoring case and spacing")
 *   Account  setCategoryAccountAction   an account code that does not exist (a code retired between page load and Save)
 * Both live on EVERY user-made row (a seeded row has no rename form; an unmapped row has an open add form, out of scope N1),
 * so the legs also prove a sibling row and the OTHER form on the same row stay locked.
 *
 * CONTRACT PINNED HERE (spec silent; the builder matches):
 *  - form keys `expenseCategory.rename` and `expenseCategory.account`; record = the category id for both.
 *  - allow-lists: rename = category; account = accountCode. NOT categoryId, NOT categoryLabel (hidden).
 *  - the rename form's "too long" leg: honest typing cannot make a refused name that is long (a long NEW name simply
 *    saves), so the leg renames onto an existing category that itself has a 2,750-character name. That name is drawn on
 *    the page in ITS row's input, so the "never drawn" checks are made on the refused record's own <form>.
 */
const h = vi.hoisted(() => ({ actor: null as null | { personId: string; orgId: string } }));
const seen = vi.hoisted(() => ({ records: [] as Array<Record<string, unknown>> }));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => h.actor),
  requireSession: vi.fn(async () => ({ actor: h.actor, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01') })),
}));
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));
vi.mock('@/components/forms', async (orig) => {
  const real = await orig<typeof import('@/components/forms')>();
  const { createElement } = await import('react');
  return {
    ...real,
    EditableRecord: (p: Record<string, unknown>) => {
      seen.records.push(p);
      return createElement(real.EditableRecord as never, p as never);
    },
  };
});

import { createCategory } from '@shareat/domain';
import { asOrg, createHarness, fixture, sql, uid, type BaseCtx, type FormCase } from './t389-s2-common';

const { runTypedLegs } = createHarness({ h, seen });

const LONG_NAME = 'LongTyping-'.repeat(250); // 2,750 characters

interface CatCtx extends BaseCtx {
  a: string; // the category whose Save is refused
  aName: string;
  c: string; // a sibling category (the duplicate target)
  cName: string;
  acc: string; // the account A and C post to
  acc2: string; // another postable account
}
async function catCtx(hint: string): Promise<CatCtx> {
  const f = await fixture(`cat-${hint}`, { chart: true });
  const codes = await sql<{ code: string }[]>`select code from accounts where org_id = ${f.orgId} and is_postable and status = 'active' order by code limit 2`;
  const [acc, acc2] = [codes[0]!.code, codes[1]!.code];
  const mk = (category: string) => asOrg(f.orgId, (tx) => createCategory(tx, f.admin, { group: 'OPEX', category, accountCode: acc })).then((r) => r.categoryId);
  const aName = `Stored Cat ${uid(hint)}`;
  const cName = `Dup Target ${uid(hint)}`;
  const a = await mk(aName);
  const c = await mk(cName);
  await mk(LONG_NAME); // the rename form's too-long leg renames onto this one
  return { f, record: a, a, aName, c, cName, acc, acc2 };
}
const props = (_ctx: BaseCtx, params: Record<string, string>) => ({ params: Promise.resolve({}) as never, searchParams: Promise.resolve(params) });
const acts = () => import('../../src/app/settings/expense-categories/actions');
const page = async () => (await import('../../src/app/settings/expense-categories/page')).default as never;

const renameHas = (id: string) => [`name="categoryId" value="${id}"`, 'name="category"'];
const accountHas = (id: string) => [`name="categoryId" value="${id}"`, 'name="accountCode"'];

const rename: FormCase<CatCtx> = {
  label: 'settings expense-category rename',
  form: 'expenseCategory.rename',
  setup: catCtx,
  action: async () => (await acts()).renameCategoryAction,
  page,
  props,
  sel: (ctx) => ({ action: 'renameCategoryAction', hidden: { categoryId: ctx.a } }),
  has: (ctx) => renameHas(ctx.a),
  hiddenNames: ['categoryId'],
  // typed: the name another category already has
  refused: (ctx, over = {}) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries({ categoryId: ctx.a, category: ctx.cName, ...over })) if (v !== null) fd.set(k, v as string);
    return fd;
  },
  refusal: /already has a category called/,
  fields: (ctx) => ({ category: ctx.cName }),
  changed: { list: 'category', fields: (ctx) => ({ category: ctx.cName }) },
  // the typed name is another row's name: it is drawn in THAT row's input, never in the refused record's form
  notDrawn: (ctx) => [ctx.cName],
  stored: (ctx, seg, m) => expect(m.inputValue(seg, 'category'), 'the stored name is drawn').toBe(ctx.aName),
  tooLong: { category: LONG_NAME }, // onto the long-named category: still a duplicate refusal
  good: (ctx) => rename.refused(ctx, { category: `Renamed Cat ${uid('good')}` }),
  ok: /Renamed to/,
  siblings: async (ctx) => [
    { label: 'another category (rename)', sel: { action: 'renameCategoryAction', hidden: { categoryId: ctx.c } }, has: renameHas(ctx.c) },
    { label: 'the SAME category, account form', sel: { action: 'setCategoryAccountAction', hidden: { categoryId: ctx.a } }, has: accountHas(ctx.a) },
  ],
  note: 'too-long leg renames onto a 2,750-char category name',
};

const account: FormCase<CatCtx> = {
  label: 'settings expense-category account',
  form: 'expenseCategory.account',
  setup: catCtx,
  action: async () => (await acts()).setCategoryAccountAction,
  page,
  props,
  sel: (ctx) => ({ action: 'setCategoryAccountAction', hidden: { categoryId: ctx.a } }),
  has: (ctx) => accountHas(ctx.a),
  hiddenNames: ['categoryId', 'categoryLabel'],
  refused: (ctx, over = {}) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries({ categoryId: ctx.a, categoryLabel: ctx.aName, accountCode: '9X9X', ...over })) if (v !== null) fd.set(k, v as string);
    return fd;
  },
  refusal: /There is no account with code 9X9X/,
  fields: () => ({ accountCode: '9X9X' }),
  changed: { list: 'accountCode', fields: () => ({ accountCode: '9X9X' }) },
  notDrawn: ['9X9X'],
  stored: (ctx, seg, m) => expect(m.selectedValue(seg, 'accountCode'), 'the stored account is selected').toBe(ctx.acc),
  tooLong: { accountCode: 'LongTyping-'.repeat(560) },
  good: (ctx) => account.refused(ctx, { accountCode: ctx.acc2 }),
  ok: /now posts to/,
  siblings: async (ctx) => [
    { label: 'another category (account)', sel: { action: 'setCategoryAccountAction', hidden: { categoryId: ctx.c } }, has: accountHas(ctx.c) },
    { label: 'the SAME category, rename form', sel: { action: 'renameCategoryAction', hidden: { categoryId: ctx.a } }, has: renameHas(ctx.a) },
  ],
};

runTypedLegs(rename);
runTypedLegs(account);
