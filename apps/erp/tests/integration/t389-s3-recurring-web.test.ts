import { renderToStaticMarkup } from 'react-dom/server';
import { vi } from 'vitest';

/**
 * T-389 S3 (TESTER) - expenses/recurring: the edit form of a recurring template.
 * Census: expenses/recurring/page.tsx `TemplateForm`, <EditableRecord action={updateTemplateAction} hidden={{ storeId,
 * templateId }}>, rendered for an existing template (the "new template" form is an add form: N1, out of scope).
 * Refusal driven: a default amount of 0 ("The default amount has to be greater than zero."): the box is `required`
 * text, so the browser cannot pre-empt a zero.
 *
 * CONTRACT PINNED HERE (spec silent; the builder matches):
 *  - record id = the template's own hidden `templateId`.
 *  - allow-list = name, supplierId, categoryId, defaultAmount, interval, anchorDay, defaultMoneyAccountId (all visible
 *    controls), tillIsDeliberate (checkbox). NOT storeId, templateId.
 *  - SPEC GAP (same as S1's supplier): the form sits inside a closed <details> ("Edit, pause or remove"). A reopened
 *    (or dropped) template must be VISIBLE, so the page opens THAT template's <details> when it has a typed view.
 * Harness and legs: t389-s3-common.ts (the S1 supplier pattern).
 */
const h = vi.hoisted(() => ({ actor: null as null | { personId: string; orgId: string } }));
const seen = vi.hoisted(() => ({ records: [] as Array<Record<string, unknown>> }));

vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => h.actor),
  requireSession: vi.fn(async () => ({ actor: h.actor, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01') })),
}));
vi.mock('@/lib/constraint-messages', async () => await import('../../src/lib/constraint-messages'));
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));
vi.mock('@/components/forms', async (orig) => {
  const real = await orig<typeof import('@/components/forms')>();
  const { createElement } = await import('react');
  return {
    ...real,
    EditableRecord: (p: Record<string, unknown>) => {
      if (p) seen.records.push(p);
      return createElement(real.EditableRecord as never, p as never);
    },
  };
});

import { createRecurringTemplate } from '@shareat/domain';
import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { RECURRING_TEMPLATE_RULES } from '@shareat/domain/field-rules';
import { requirementOf } from '../helpers/rule-sentence';
import { actor, asOrg, captureRedirect, closeAfterAll, keepTypingLegs, outcomeOf, person, sql, uid } from './t389-s3-common';

closeAfterAll();

const STORED_NAME = 'Lipa branch rent';

async function setup(hint: string) {
  const code = uid(`t389s3rc-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const storeId = store!.id;
  const adminId = await person(orgId, 'Admin', 'admin', [storeId]);
  const admin2Id = await person(orgId, 'Admin Two', 'admin', [storeId]);
  const admin = actor(orgId, adminId);
  const cat = async () =>
    (await sql<{ id: string }[]>`insert into expense_categories (org_id, "group", category, account_code) values (${orgId}, 'OPEX', ${uid('cat')}, '6200') returning id`)[0]!.id;
  const catA = await cat();
  const catB = await cat();
  const sup = async (name: string) =>
    (await sql<{ id: string }[]>`insert into suppliers (org_id, name, created_by) values (${orgId}, ${`${name} ${uid('s')}`}, ${adminId}) returning id`)[0]!.id;
  const supA = await sup('Landlord');
  const supB = await sup('Utility');
  const mk = async (name: string) =>
    (await asOrg(orgId, (tx) =>
      createRecurringTemplate(tx, admin, { storeId, name, categoryId: catA, supplierId: supA, defaultAmount: '25000.00', interval: 'monthly', anchorDay: 5 }),
    )).id;
  const templateId = await mk(STORED_NAME);
  const siblingId = await mk('Lipa internet');
  return { orgId, storeId, templateId, siblingId, catA, catB, supA, supB, admin, other: actor(orgId, admin2Id) };
}
type C = Awaited<ReturnType<typeof setup>>;

keepTypingLegs<C>({
  area: 'expenses/recurring template',
  setup,
  admin: (c) => c.admin,
  other: (c) => c.other,
  recordId: (c) => c.templateId,
  siblingId: (c) => c.siblingId,
  marker: (_c, id) => `name="templateId" value="${id}"`,
  inDetails: true,
  refusedForm: (c, over = {}) => {
    const base: Record<string, string> = {
      storeId: c.storeId, templateId: c.templateId, name: 'Typed Rent Name', supplierId: c.supB, categoryId: c.catB,
      defaultAmount: '0', interval: 'weekly', anchorDay: '3', defaultMoneyAccountId: '', tillIsDeliberate: 'on',
    };
    const fd = new FormData();
    for (const [k, v] of Object.entries({ ...base, ...over })) if (v !== null) fd.set(k, v);
    return fd;
  },
  async submit(_c, fd, who) {
    h.actor = who;
    const { updateTemplateAction } = await import('../../src/app/expenses/recurring/actions');
    const signal = await captureRedirect(() => updateTemplateAction(fd));
    const o = outcomeOf(signal);
    return { signal, error: o.flash.error, ok: o.flash.ok };
  },
  expectError: requirementOf(RECURRING_TEMPLATE_RULES.defaultAmount, '0'),
  expectedFields: (c) => ({
    name: 'Typed Rent Name', supplierId: c.supB, categoryId: c.catB, defaultAmount: '0', interval: 'weekly', anchorDay: '3',
    defaultMoneyAccountId: '', tillIsDeliberate: 'on',
  }),
  neverKept: () => ['storeId', 'templateId'],
  // The checkbox left UNticked and changed: it must reopen unticked, so it rides as an empty array.
  changedLeg: () => ({ changed: 'name,tillIsDeliberate', over: { tillIsDeliberate: null }, fields: { name: 'Typed Rent Name', tillIsDeliberate: [] } }),
  async render(c, who, params) {
    h.actor = who;
    seen.records = [];
    const { default: Page } = await import('../../src/app/expenses/recurring/page');
    return renderToStaticMarkup((await Page({ searchParams: Promise.resolve({ store: c.storeId, ...params }) })) as never);
  },
  typedOf: (_c, id) => {
    const rec = seen.records.find((r) => r && (r.hidden as Record<string, string> | undefined)?.templateId === id);
    return { found: rec !== undefined, typed: rec?.typed as never };
  },
  stored: (c) => [`value="${STORED_NAME}"`, 'value="25000.00"', `value="${c.supA}" selected`],
  typedNotDrawn: () => ['Typed Rent Name'],
  tooLong: { name: 'name' },
  goodForm: (c) => {
    const fd = new FormData();
    fd.set('storeId', c.storeId);
    fd.set('templateId', c.templateId);
    fd.set('name', STORED_NAME);
    fd.set('supplierId', c.supA);
    fd.set('categoryId', c.catA);
    fd.set('defaultAmount', '26000.00');
    fd.set('interval', 'monthly');
    fd.set('anchorDay', '5');
    fd.set('defaultMoneyAccountId', '');
    return fd;
  },
  expectOk: 'Template updated.',
});
