import { renderToStaticMarkup } from 'react-dom/server';
import { vi } from 'vitest';

/**
 * T-389 S3 (TESTER) - remittance: the store's cash policy (cadence + un-remitted ceiling).
 * Census: remittance/page.tsx, <EditableRecord action={setCashPolicyAction} label="cash policy" hidden={{ storeId }}>.
 * Refusal driven: a ceiling typed "1,0OO" (the domain refuses it in words; the box is inputMode=decimal text, so the
 * browser cannot pre-empt it).
 *
 * CONTRACT PINNED HERE (spec silent on the singleton's allow-list; the builder matches):
 *  - record id = the storeId (spec: "remittance cash policy ... use the storeId").
 *  - allow-list = remittanceCadence, unremittedCeiling. NOT storeId.
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
  const code = uid(`t389s3rm-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name, remittance_cadence, unremitted_ceiling) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}, 'weekly', '20000.00') returning id`;
  const storeId = store!.id;
  const adminId = await person(orgId, 'Admin', 'admin', [storeId]);
  const admin2Id = await person(orgId, 'Admin Two', 'admin', [storeId]);
  return { orgId, storeId, admin: actor(orgId, adminId), other: actor(orgId, admin2Id) };
}
type C = Awaited<ReturnType<typeof setup>>;

keepTypingLegs<C>({
  area: 'remittance cash policy',
  setup,
  admin: (c) => c.admin,
  other: (c) => c.other,
  recordId: (c) => c.storeId,
  // The cadence select is unique to this record's form; the storeId hidden input also sits in the handover form.
  marker: () => 'name="remittanceCadence"',
  refusedForm: (c, over = {}) => {
    const base: Record<string, string> = { storeId: c.storeId, remittanceCadence: 'monthly', unremittedCeiling: '1,0OO' };
    const fd = new FormData();
    for (const [k, v] of Object.entries({ ...base, ...over })) if (v !== null) fd.set(k, v);
    return fd;
  },
  async submit(_c, fd, who) {
    h.actor = who;
    const { setCashPolicyAction } = await import('../../src/app/remittance/actions');
    const signal = await captureRedirect(() => setCashPolicyAction(fd));
    const o = outcomeOf(signal);
    return { signal, error: o.flash.error, ok: o.flash.ok };
  },
  expectError: /ceiling/i,
  expectedFields: () => ({ remittanceCadence: 'monthly', unremittedCeiling: '1,0OO' }),
  neverKept: () => ['storeId'],
  changedLeg: () => ({ changed: 'unremittedCeiling', fields: { unremittedCeiling: '1,0OO' } }),
  async render(_c, who, params) {
    h.actor = who;
    seen.records = [];
    const { default: Page } = await import('../../src/app/remittance/page');
    return renderToStaticMarkup((await Page({ searchParams: Promise.resolve(params) })) as never);
  },
  typedOf: (_c, id) => {
    const rec = seen.records.find((r) => r && r.label === 'cash policy' && (r.hidden as Record<string, string> | undefined)?.storeId === id);
    return { found: rec !== undefined, typed: rec?.typed as never };
  },
  stored: () => ['value="20000.00"', 'value="weekly" selected'],
  typedNotDrawn: () => ['1,0OO', 'value="monthly" selected'],
  tooLong: { name: 'unremittedCeiling' },
  goodForm: (c) => {
    const fd = new FormData();
    fd.set('storeId', c.storeId);
    fd.set('remittanceCadence', 'every_3_days');
    fd.set('unremittedCeiling', '15000.00');
    return fd;
  },
  expectOk: 'Cash policy updated.',
});
