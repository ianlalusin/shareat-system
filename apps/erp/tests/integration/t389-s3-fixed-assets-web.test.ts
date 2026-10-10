import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

/**
 * T-389 S3 (TESTER) - fixed-assets/[id]: TWO forms on one page, two forms to keep.
 *   (a) Depreciation terms: <EditableRecord action={updateTermsAction} label={asset.name}>. Refusal driven: a useful life
 *       typed "0x10" (the domain refuses it in words; the box is inputMode=numeric text, so the browser cannot pre-empt it).
 *   (b) In-service date: <EditableRecord action={setAssetInServiceAction} label="<name> in-service date">. Refusal driven:
 *       the PLAIN-error branch: mode "A specific date" with the date box left blank (the domain says a date is required).
 *       The second branch of that action (the "confirm to proceed" checkpoint) keeps its existing T-380 keep keys and is
 *       NOT touched here: spec "Census: two-step confirm forms".
 *
 * CONTRACT PINNED HERE (spec silent; the builder matches):
 *  - record id for BOTH = the asset's own hidden `assetId`; the two forms must carry DIFFERENT form keys, so a refusal
 *    of one never reopens the other (the cross-form leg below).
 *  - terms allow-list = name, category, usefulLifeMonths, interval, salvageValue, notes.
 *  - in-service allow-list = mode, inServiceOn, reason. NOT assetId, filterStore (nor confirmedPlan, which lives in the
 *    confirm form only).
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

import { createAsset } from '@shareat/domain';
import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { actor, asOrg, captureRedirect, closeAfterAll, cookiePayload, formAround, keepTypingLegs, outcomeOf, pageParamsOf, person, resetJar, sql, uid } from './t389-s3-common';

closeAfterAll();

const NAME = 'Chest freezer';

async function setup(hint: string) {
  const code = uid(`t389s3fa-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  for (let m = 1; m <= 12; m++) {
    const mm = String(m).padStart(2, '0');
    const last = new Date(Date.UTC(2026, m, 0)).getUTCDate();
    await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, ${`2026-${mm}-01`}, ${`2026-${mm}-${last}`}, 'open')`;
  }
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, opening_date) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}, '2020-01-01') returning id`;
  const storeId = store!.id;
  const adminId = await person(orgId, 'Admin', 'admin', [storeId]);
  const admin2Id = await person(orgId, 'Admin Two', 'admin', [storeId]);
  const admin = actor(orgId, adminId);
  const { id: assetId } = await asOrg(orgId, (tx) =>
    createAsset(tx, admin, {
      storeId, name: NAME, category: 'equipment', acquiredOn: '2026-01-15', cost: '120000.00', usefulLifeMonths: 36, interval: 'monthly',
      salvageValue: '1000.00', notes: 'Stored notes',
    }),
  );
  return { orgId, storeId, assetId, admin, other: actor(orgId, admin2Id) };
}
type C = Awaited<ReturnType<typeof setup>>;

const submitWith =
  (name: 'updateTermsAction' | 'setAssetInServiceAction') =>
  async (_c: C, fd: FormData, who: { personId: string; orgId: string }) => {
    h.actor = who;
    const actions = await import('../../src/app/fixed-assets/actions');
    const signal = await captureRedirect(() => actions[name](fd));
    const o = outcomeOf(signal);
    return { signal, error: o.flash.error, ok: o.flash.ok };
  };

async function renderPage(c: C, who: { personId: string; orgId: string }, params: Record<string, string>) {
  h.actor = who;
  seen.records = [];
  const { default: Page } = await import('../../src/app/fixed-assets/[id]/page');
  return renderToStaticMarkup((await Page({ params: Promise.resolve({ id: c.assetId }), searchParams: Promise.resolve(params) })) as never);
}
const termsRecord = (id: string) => seen.records.find((r) => r && (r.hidden as Record<string, string> | undefined)?.assetId === id && r.label === NAME);
const serviceRecord = (id: string) =>
  seen.records.find((r) => r && (r.hidden as Record<string, string> | undefined)?.assetId === id && String(r.label).endsWith('in-service date'));

function formWith(base: Record<string, string>, over: Record<string, string | null>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ ...base, ...over })) if (v !== null) fd.set(k, v);
  return fd;
}

const TERMS_BASE = (c: C): Record<string, string> => ({
  assetId: c.assetId, filterStore: '', name: 'Typed Freezer Name', category: 'machinery', usefulLifeMonths: '0x10', interval: 'quarterly',
  salvageValue: '2500.50', notes: 'Typed notes',
});
const SERVICE_BASE = (c: C): Record<string, string> => ({ assetId: c.assetId, filterStore: '', mode: 'set', inServiceOn: '', reason: 'Typed reason' });

keepTypingLegs<C>({
  area: 'fixed-assets depreciation terms',
  setup,
  admin: (c) => c.admin,
  other: (c) => c.other,
  recordId: (c) => c.assetId,
  marker: () => 'name="usefulLifeMonths"',
  refusedForm: (c, over = {}) => formWith(TERMS_BASE(c), over),
  submit: submitWith('updateTermsAction'),
  expectError: /whole number/i,
  expectedFields: () => ({
    name: 'Typed Freezer Name', category: 'machinery', usefulLifeMonths: '0x10', interval: 'quarterly', salvageValue: '2500.50', notes: 'Typed notes',
  }),
  neverKept: () => ['assetId', 'filterStore'],
  changedLeg: () => ({ changed: 'notes,usefulLifeMonths', fields: { notes: 'Typed notes', usefulLifeMonths: '0x10' } }),
  render: renderPage,
  typedOf: (_c, id) => {
    const rec = termsRecord(id);
    return { found: rec !== undefined, typed: rec?.typed as never };
  },
  stored: () => [`value="${NAME}"`, 'value="36"', 'value="1000.00"', 'Stored notes', 'value="equipment" selected', 'value="monthly" selected'],
  typedNotDrawn: () => ['Typed Freezer Name', '0x10', 'Typed notes', '2500.50'],
  tooLong: { name: 'notes' },
  goodForm: (c) => formWith(TERMS_BASE(c), { name: NAME, category: 'equipment', usefulLifeMonths: '36', interval: 'monthly', salvageValue: '1000.00', notes: 'Stored notes' }),
  expectOk: 'terms',
});

keepTypingLegs<C>({
  area: 'fixed-assets in-service date',
  setup,
  admin: (c) => c.admin,
  other: (c) => c.other,
  recordId: (c) => c.assetId,
  marker: () => 'name="inServiceOn"',
  refusedForm: (c, over = {}) => formWith(SERVICE_BASE(c), over),
  submit: submitWith('setAssetInServiceAction'),
  expectError: /./,
  expectedFields: () => ({ mode: 'set', inServiceOn: '', reason: 'Typed reason' }),
  neverKept: () => ['assetId', 'filterStore', 'confirmedPlan'],
  changedLeg: () => ({ changed: 'mode,reason', fields: { mode: 'set', reason: 'Typed reason' } }),
  render: renderPage,
  typedOf: (_c, id) => {
    const rec = serviceRecord(id);
    return { found: rec !== undefined, typed: rec?.typed as never };
  },
  stored: () => ['value="acquired" selected', 'value="2026-01-15"'],
  typedNotDrawn: () => ['Typed reason', 'value="set" selected'],
  tooLong: { name: 'reason' },
  goodForm: (c) => formWith(SERVICE_BASE(c), { inServiceOn: '2026-02-01', reason: 'Corrected date' }),
  expectOk: 'inservice',
});

describe('T-389 S3 fixed-assets - the two forms on one asset page never reopen each other', () => {
  it('X1: a refused TERMS save reopens the terms record only; the in-service record stays locked with nothing typed', async () => {
    const c = await setup('x1');
    resetJar();
    const r = await submitWith('updateTermsAction')(c, formWith(TERMS_BASE(c), {}), c.admin);
    expect(r.error, 'a refusal').toMatch(/whole number/i);
    expect((await cookiePayload()).t, 'precondition: the terms form kept its typing (red on HEAD)').toBeDefined();
    const html = await renderPage(c, c.admin, pageParamsOf(r.signal.url));
    expect(termsRecord(c.assetId)?.typed).toMatchObject({ kind: 'typed' });
    expect(serviceRecord(c.assetId)?.typed ?? null).toBeNull();
    expect(formAround(html, 'name="inServiceOn"')).toContain('<fieldset disabled');
  });

  it('X2: a refused IN-SERVICE save reopens the in-service record only; the terms record stays locked with nothing typed', async () => {
    const c = await setup('x2');
    resetJar();
    const r = await submitWith('setAssetInServiceAction')(c, formWith(SERVICE_BASE(c), {}), c.admin);
    expect(r.error, 'a plain refusal, not the confirm checkpoint').toBeTruthy();
    expect((await cookiePayload()).t, 'precondition: the in-service form kept its typing (red on HEAD)').toBeDefined();
    const html = await renderPage(c, c.admin, pageParamsOf(r.signal.url));
    expect(serviceRecord(c.assetId)?.typed).toMatchObject({ kind: 'typed' });
    expect(termsRecord(c.assetId)?.typed ?? null).toBeNull();
    expect(formAround(html, 'name="usefulLifeMonths"')).toContain('<fieldset disabled');
  });
});
