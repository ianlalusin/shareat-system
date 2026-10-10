import { renderToStaticMarkup } from 'react-dom/server';
import { vi } from 'vitest';

/**
 * T-389 S3 (TESTER) - money-accounts: the rename form of a foundation account (name + overdraft limit).
 * Census: page money-accounts/page.tsx, form = <EditableRecord action={renameMoneyAccountAction}>, one per active
 * foundation account (5 per store). Refusal driven: a NEGATIVE overdraft limit on the cashier drawer (the browser's
 * `required` is only on the name, so it cannot pre-empt it).
 *
 * CONTRACT PINNED HERE (spec silent; the builder matches):
 *  - record id = the account's own hidden `moneyAccountId`.
 *  - allow-list = name, overdraftLimit (overdraftLimit exists only on the cashier drawer). NOT moneyAccountId.
 * Harness and legs: t389-s3-common.ts (the S1 supplier pattern).
 */
const h = vi.hoisted(() => ({ actor: null as null | { personId: string; orgId: string } }));
const seen = vi.hoisted(() => ({ records: [] as Array<Record<string, unknown>> }));

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
      if (p) seen.records.push(p);
      return createElement(real.EditableRecord as never, p as never);
    },
  };
});

import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { actor, captureRedirect, closeAfterAll, keepTypingLegs, outcomeOf, person, resetJar, sql, uid } from './t389-s3-common';

closeAfterAll();

async function setup(hint: string) {
  const code = uid(`t389s3ma-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const storeId = store!.id;
  const adminId = await person(orgId, 'Admin', 'admin', [storeId]);
  const admin2Id = await person(orgId, 'Admin Two', 'admin', [storeId]);
  const [cashier] = await sql<{ id: string; name: string; overdraft_limit: string }[]>`
    select id, name, overdraft_limit::text as overdraft_limit from money_accounts where store_id = ${storeId} and custodian = 'cashier' and is_foundation and is_active limit 1`;
  const [office] = await sql<{ id: string; name: string }[]>`
    select id, name from money_accounts where store_id = ${storeId} and custodian = 'office' and is_foundation and is_active limit 1`;
  return { orgId, storeId, admin: actor(orgId, adminId), other: actor(orgId, admin2Id), cashier: cashier!, office: office! };
}
type C = Awaited<ReturnType<typeof setup>>;

keepTypingLegs<C>({
  area: 'money-accounts rename',
  setup,
  admin: (c) => c.admin,
  other: (c) => c.other,
  recordId: (c) => c.cashier.id,
  siblingId: (c) => c.office.id,
  marker: (_c, id) => `name="moneyAccountId" value="${id}"`,
  refusedForm: (c, over = {}) => {
    const base: Record<string, string> = { moneyAccountId: c.cashier.id, name: 'Typed Drawer Name', overdraftLimit: '-7.25' };
    const fd = new FormData();
    for (const [k, v] of Object.entries({ ...base, ...over })) if (v !== null) fd.set(k, v);
    return fd;
  },
  async submit(c, fd, who) {
    h.actor = who;
    const { renameMoneyAccountAction } = await import('../../src/app/money-accounts/actions');
    const signal = await captureRedirect(() => renameMoneyAccountAction(fd));
    const o = outcomeOf(signal);
    return { signal, error: o.flash.error, ok: o.flash.ok };
  },
  expectError: /overdraft limit/i,
  expectedFields: () => ({ name: 'Typed Drawer Name', overdraftLimit: '-7.25' }),
  neverKept: () => ['moneyAccountId'],
  changedLeg: () => ({ changed: 'name', fields: { name: 'Typed Drawer Name' } }),
  async render(c, who, params) {
    h.actor = who;
    seen.records = [];
    const { default: Page } = await import('../../src/app/money-accounts/page');
    return renderToStaticMarkup((await Page({ searchParams: Promise.resolve(params) })) as never);
  },
  typedOf: (_c, id) => {
    const rec = seen.records.find((r) => r && (r.hidden as Record<string, string> | undefined)?.moneyAccountId === id);
    return { found: rec !== undefined, typed: rec?.typed as never };
  },
  stored: (c) => [`value="${c.cashier.name}"`, `value="${c.cashier.overdraft_limit}"`],
  typedNotDrawn: () => ['Typed Drawer Name', '-7.25'],
  tooLong: { name: 'name' },
  goodForm: (c) => {
    const fd = new FormData();
    fd.set('moneyAccountId', c.cashier.id);
    fd.set('name', 'Renamed Drawer');
    fd.set('overdraftLimit', '');
    return fd;
  },
  expectOk: 'renamed',
});
