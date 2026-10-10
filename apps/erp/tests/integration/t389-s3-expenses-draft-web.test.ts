import { randomUUID } from 'node:crypto';
import { renderToStaticMarkup } from 'react-dom/server';
import { vi } from 'vitest';

/**
 * T-389 S3 (TESTER) - expenses/[id]: "Correct this draft" (category + particulars).
 * Census: expenses/[id]/page.tsx, <EditableRecord action={updateDraftAction} label="draft" saveLabel="Save draft"
 * hidden={{ storeId, expenseId }}>, shown only while the expense is a draft. Refusal driven: a category that does not
 * exist (a stale option, or one from another org) - editExpense says it is gone; the select cannot pre-empt it.
 *
 * CONTRACT PINNED HERE (spec silent; the builder matches):
 *  - record id = the expense's own hidden `expenseId`.
 *  - allow-list = categoryId (a visible select, so NOT a hidden id), particulars. NOT storeId, expenseId.
 *  - the page has one such form, so there is no sibling leg.
 * Harness and legs: t389-s3-common.ts (the S1 supplier pattern). Fixture shape from t369-s5-override-web.
 */
const h = vi.hoisted(() => ({ actor: null as null | { personId: string; orgId: string } }));
const seen = vi.hoisted(() => ({ records: [] as Array<Record<string, unknown>> }));

vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
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

import { createExpense } from '@shareat/domain';
import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../../packages/db/seed/expense-categories';
import { postEntry } from '../../../../packages/domain/src/ledger/post-entry';
import { actor, asOrg, captureRedirect, closeAfterAll, keepTypingLegs, outcomeOf, person, sql, uid } from './t389-s3-common';

closeAfterAll();

const PARTICULARS = 'Pork, cash (2026-02-10)';

async function setup(hint: string) {
  const code = uid(`t389s3ex-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open'), (${orgId}, '2026-02-01', '2026-02-28', 'open')`;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('lipa')}, 'Lipa') returning id`;
  const storeId = store!.id;
  const adminId = await person(orgId, 'Admin', 'admin', [storeId]);
  const admin2Id = await person(orgId, 'Admin Two', 'admin', [storeId]);
  const managerId = await person(orgId, 'Manager', 'manager', [storeId]);
  const admin = actor(orgId, adminId);
  const [cash] = await sql<{ id: string; gl_account_code: string }[]>`
    select id, gl_account_code from money_accounts where store_id = ${storeId} and instrument = 'cash' and custodian = 'cashier' and is_foundation`;
  await asOrg(orgId, (tx) =>
    postEntry(tx, {
      orgId, entryDate: '2026-01-02', sourceType: 'manual_journal', sourceId: uid('fund'), idempotencyKey: uid('fund'), memo: 'fixture funding', postedBy: adminId,
      lines: [{ accountCode: cash!.gl_account_code, storeId, debit: '100000.00' }, { accountCode: '3900', storeId, credit: '100000.00' }],
    }),
  );
  const [supplier] = await sql<{ id: string }[]>`insert into suppliers (org_id, name, created_by) values (${orgId}, 'Pork Co', ${adminId}) returning id`;
  const [file] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${orgId}, ${storeId}, 'receipt_photo', ${`orgs/${orgId}/stores/${storeId}/receipt_photo/${uid('r')}.jpg`}, 'image/jpeg', 1024, ${uid('sum')}, ${adminId}) returning id`;
  const [cat] = await sql<{ id: string }[]>`select id from expense_categories where org_id = ${orgId} and category = 'Cost of Goods Sold — General'`;
  const [inv] = await sql<{ id: string }[]>`
    insert into supplier_invoices (org_id, store_id, supplier_id, invoice_date, total_amount, status, receipt_file_id, verified_by, verified_at, created_by,
                                   attested_supplier, attested_invoice, attested_items, attested_price)
    values (${orgId}, ${storeId}, ${supplier!.id}, '2026-02-10', '99999999.00', 'verified', ${file!.id}, ${managerId}, now(), ${adminId}, true, true, true, true) returning id`;
  const made = await asOrg(orgId, (tx) =>
    createExpense(tx, admin, {
      storeId, supplierId: supplier!.id, supplierInvoiceId: inv!.id, businessDate: '2026-02-10', categoryId: cat!.id,
      particulars: PARTICULARS, payments: [{ method: 'cash', amount: '1200.00', moneyAccountId: cash!.id }],
    }),
  );
  return { orgId, storeId, expenseId: made.id, categoryId: cat!.id, badCategoryId: randomUUID(), admin, other: actor(orgId, admin2Id) };
}
type C = Awaited<ReturnType<typeof setup>>;

keepTypingLegs<C>({
  area: 'expenses/[id] draft correction',
  setup,
  admin: (c) => c.admin,
  other: (c) => c.other,
  recordId: (c) => c.expenseId,
  // The particulars box is unique to this record's form (the approve and delete forms also carry expenseId).
  marker: () => 'name="particulars"',
  refusedForm: (c, over = {}) => {
    const base: Record<string, string> = { storeId: c.storeId, expenseId: c.expenseId, categoryId: c.badCategoryId, particulars: 'Typed Particulars' };
    const fd = new FormData();
    for (const [k, v] of Object.entries({ ...base, ...over })) if (v !== null) fd.set(k, v);
    return fd;
  },
  async submit(_c, fd, who) {
    h.actor = who;
    const { updateDraftAction } = await import('../../src/app/expenses/actions');
    const signal = await captureRedirect(() => updateDraftAction(fd));
    const o = outcomeOf(signal);
    return { signal, error: o.flash.error, ok: o.flash.ok };
  },
  expectError: /categor/i,
  expectedFields: (c) => ({ categoryId: c.badCategoryId, particulars: 'Typed Particulars' }),
  neverKept: () => ['storeId', 'expenseId'],
  changedLeg: () => ({ changed: 'particulars', fields: { particulars: 'Typed Particulars' } }),
  async render(c, who, params) {
    h.actor = who;
    seen.records = [];
    const { default: Page } = await import('../../src/app/expenses/[id]/page');
    return renderToStaticMarkup((await Page({ params: Promise.resolve({ id: c.expenseId }), searchParams: Promise.resolve(params) })) as never);
  },
  typedOf: (_c, id) => {
    const rec = seen.records.find((r) => r && (r.hidden as Record<string, string> | undefined)?.expenseId === id);
    return { found: rec !== undefined, typed: rec?.typed as never };
  },
  stored: (c) => [`value="${PARTICULARS}"`, `value="${c.categoryId}" selected`],
  typedNotDrawn: (c) => ['Typed Particulars', c.badCategoryId],
  tooLong: { name: 'particulars' },
  goodForm: (c) => {
    const fd = new FormData();
    fd.set('storeId', c.storeId);
    fd.set('expenseId', c.expenseId);
    fd.set('categoryId', c.categoryId);
    fd.set('particulars', 'Corrected particulars');
    return fd;
  },
  expectOk: true,
});
