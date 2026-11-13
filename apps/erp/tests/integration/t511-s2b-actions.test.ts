import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-511 S2b (TESTER) - the two admin-edit server actions, driven through the REAL action, REAL domain function and REAL database
 * (session mocked, redirect captured, banner read through the flash jar). Spec: docs/tasks/511-settlement-upload-s2-spec.md "The two
 * admin edits (2b)" item 3. Patterns: t389-s2-sales-channels-web.test.ts, t350-channel-payout-change.test.ts.
 *
 * Contract pinned here (the builder matches it):
 *   apps/erp/src/app/settings/sales-channels/actions.ts   setPlatformCodeAction(fd)
 *       form fields: storeId, channelId (hidden), platform ('' | 'grab' | 'foodpanda'), code
 *       redirects to /settings/sales-channels with `store` = the posted storeId (the same store stays open), ok or error banner
 *       the SHARED updateSalesChannelAction keeps ignoring any `platform` / `code` a manager posts
 *   apps/erp/src/app/loans/actions.ts                      updateLoanRepaymentAmountAction(fd)
 *       form fields: loanId (hidden), repaymentAmount ('' clears)
 *       redirects to /loans/<id> with an ok or error banner
 * The actions hold no gate of their own (the domain function authorizes): a manager's post ends in an error banner and no write.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

const h = vi.hoisted(() => ({ actor: null as null | { personId: string; orgId: string } }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => h.actor),
  requireSession: vi.fn(async () => ({ actor: h.actor, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01') })),
}));

import { APP_ROLE, closeDb, transaction, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { createLoan } from '@shareat/domain';
import { captureRedirect, outcomeOf, resetJar } from '../helpers/flash-jar';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});
beforeEach(() => {
  resetJar();
});

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}
async function person(orgId: string, role: string, name: string, stores: string[]) {
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
  for (const s of stores) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
  return { personId: p!.id, orgId } as Actor;
}

async function fixture(hint: string) {
  const code = uid(`t511a-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const mkStore = async (name: string) => {
    const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('st')}, ${name}) returning id`;
    return s!.id;
  };
  const storeA = await mkStore('Store A');
  const storeB = await mkStore('Store B');
  const admin = await person(orgId, 'admin', 'Admin', [storeA, storeB]);
  const manager = await person(orgId, 'manager', 'Manager', [storeA, storeB]);
  const mkChannel = async (storeId: string, name: string) => {
    const [c] = await sql<{ id: string }[]>`
      insert into sales_channels (org_id, store_id, name, is_remitted_daily) values (${orgId}, ${storeId}, ${name}, true) returning id`;
    return c!.id;
  };
  const chA = await mkChannel(storeA, 'Foodpanda');
  const chB = await mkChannel(storeB, 'Foodpanda B');
  const loan = await asOrg(orgId, (tx) =>
    createLoan(tx, admin, {
      storeId: storeA, lenderName: 'Grab', name: 'Grab loan', principalAmount: '50000.00', interestRate: '2', ratePeriod: 'month',
      interestMethod: 'straight', paymentFrequency: 'daily', termPeriods: 90, startDate: '2026-05-11',
    }),
  );
  return { orgId, storeA, storeB, chA, chB, loanId: loan.id, admin, manager };
}
type Fx = Awaited<ReturnType<typeof fixture>>;

async function channelRow(id: string) {
  const [r] = await sql<{ platform: string | null; platform_store_code: string | null; name: string }[]>`
    select platform, platform_store_code, name from sales_channels where id = ${id}`;
  return r!;
}
async function loanAmount(id: string) {
  const [r] = await sql<{ a: string | null }[]>`select repayment_amount::text as a from loans where id = ${id}`;
  return r!.a;
}
const form = (o: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(o)) fd.set(k, v);
  return fd;
};

const CHANNELS_PATH = '/settings/sales-channels';

async function postChannel(who: Actor, fd: FormData) {
  h.actor = who;
  const mod = await import('../../src/app/settings/sales-channels/actions');
  const action = (mod as unknown as Record<string, (f: FormData) => Promise<void>>).setPlatformCodeAction;
  expect(typeof action, 'setPlatformCodeAction must be exported from settings/sales-channels/actions.ts').toBe('function');
  return outcomeOf(await captureRedirect(() => action!(fd)));
}
async function postShared(who: Actor, fd: FormData) {
  h.actor = who;
  const mod = await import('../../src/app/settings/sales-channels/actions');
  return outcomeOf(await captureRedirect(() => mod.updateSalesChannelAction(fd)));
}
async function postLoan(who: Actor, fd: FormData) {
  h.actor = who;
  const mod = await import('../../src/app/loans/actions');
  const action = (mod as unknown as Record<string, (f: FormData) => Promise<void>>).updateLoanRepaymentAmountAction;
  expect(typeof action, 'updateLoanRepaymentAmountAction must be exported from loans/actions.ts').toBe('function');
  return outcomeOf(await captureRedirect(() => action!(fd)));
}

describe('T-511 S2b - setPlatformCodeAction (settings/sales-channels)', () => {
  it('an admin saves a Foodpanda code: ok banner, back to the same store, the row is written', async () => {
    const f: Fx = await fixture('pc-ok');
    const o = await postChannel(f.admin, form({ storeId: f.storeA, channelId: f.chA, platform: 'foodpanda', code: 'act123' }));
    expect(o.path).toBe(CHANNELS_PATH);
    expect(o.nav.get('store'), 'the same store stays open').toBe(f.storeA);
    expect(o.flash.error, 'no error banner').toBeUndefined();
    expect(o.flash.ok, 'an ok banner').toBeTruthy();
    expect(await channelRow(f.chA)).toMatchObject({ platform: 'foodpanda', platform_store_code: 'act123' });
  });

  it('an admin saves a Grab UUID', async () => {
    const f = await fixture('pc-grab');
    const uuid = randomUUID();
    const o = await postChannel(f.admin, form({ storeId: f.storeA, channelId: f.chA, platform: 'grab', code: uuid }));
    expect(o.flash.error).toBeUndefined();
    expect(await channelRow(f.chA)).toMatchObject({ platform: 'grab', platform_store_code: uuid });
  });

  it('keeps the store that was open: a save for store B redirects back with store = B', async () => {
    const f = await fixture('pc-store');
    const o = await postChannel(f.admin, form({ storeId: f.storeB, channelId: f.chB, platform: 'foodpanda', code: 'stb123' }));
    expect(o.nav.get('store')).toBe(f.storeB);
    expect(o.flash.ok).toBeTruthy();
  });

  it('a code another channel already holds: error banner naming the holder, same store open, nothing written', async () => {
    const f = await fixture('pc-dup');
    await postChannel(f.admin, form({ storeId: f.storeA, channelId: f.chA, platform: 'foodpanda', code: 'dup123' }));
    resetJar();
    const o = await postChannel(f.admin, form({ storeId: f.storeB, channelId: f.chB, platform: 'foodpanda', code: 'DUP123' }));
    expect(o.path).toBe(CHANNELS_PATH);
    expect(o.nav.get('store')).toBe(f.storeB);
    expect(o.flash.ok).toBeUndefined();
    expect(o.flash.error ?? '').toMatch(/already used by Store A Foodpanda/);
    expect(await channelRow(f.chB)).toMatchObject({ platform: null, platform_store_code: null });
  });

  it('a manager posting the form is refused: error banner, same store open, nothing written', async () => {
    const f = await fixture('pc-mgr');
    const o = await postChannel(f.manager, form({ storeId: f.storeA, channelId: f.chA, platform: 'foodpanda', code: 'mgr123' }));
    expect(o.path).toBe(CHANNELS_PATH);
    expect(o.nav.get('store')).toBe(f.storeA);
    expect(o.flash.ok).toBeUndefined();
    expect((o.flash.error ?? '').length, 'an error banner').toBeGreaterThan(5);
    expect(await channelRow(f.chA)).toMatchObject({ platform: null, platform_store_code: null });
  });

  it.each([
    ['a code of the wrong shape for the platform', { platform: 'grab', code: 'abc123' }],
    ['a tab-only code', { platform: 'foodpanda', code: '\t\t' }],
    ['a platform without a code', { platform: 'foodpanda', code: '' }],
    ['a code without a platform', { platform: '', code: 'abc123' }],
    ['a platform that is not Grab or Foodpanda', { platform: 'ubereats', code: 'abc123' }],
  ])('refuses %s with an error banner and writes nothing', async (_label, fields) => {
    const f = await fixture('pc-bad');
    const o = await postChannel(f.admin, form({ storeId: f.storeA, channelId: f.chA, ...fields }));
    expect(o.flash.ok).toBeUndefined();
    expect((o.flash.error ?? '').length).toBeGreaterThan(5);
    expect(o.nav.get('store')).toBe(f.storeA);
    expect(await channelRow(f.chA)).toMatchObject({ platform: null, platform_store_code: null });
  });

  it('a blank platform and blank code clear the channel: ok banner, both columns null', async () => {
    const f = await fixture('pc-clear');
    await postChannel(f.admin, form({ storeId: f.storeA, channelId: f.chA, platform: 'foodpanda', code: 'clr123' }));
    resetJar();
    const o = await postChannel(f.admin, form({ storeId: f.storeA, channelId: f.chA, platform: '', code: '' }));
    expect(o.flash.error).toBeUndefined();
    expect(o.flash.ok).toBeTruthy();
    expect(await channelRow(f.chA)).toMatchObject({ platform: null, platform_store_code: null });
  });

  it('saving the value that is already stored is not an error', async () => {
    const f = await fixture('pc-same');
    await postChannel(f.admin, form({ storeId: f.storeA, channelId: f.chA, platform: 'foodpanda', code: 'same12' }));
    resetJar();
    const o = await postChannel(f.admin, form({ storeId: f.storeA, channelId: f.chA, platform: 'foodpanda', code: 'same12' }));
    expect(o.flash.error).toBeUndefined();
    expect(await channelRow(f.chA)).toMatchObject({ platform: 'foodpanda', platform_store_code: 'same12' });
  });

  it('the typed code never rides the redirect address (it is not in the URL)', async () => {
    const f = await fixture('pc-url');
    h.actor = f.admin;
    const mod = (await import('../../src/app/settings/sales-channels/actions')) as unknown as Record<string, (fd: FormData) => Promise<void>>;
    expect(typeof mod.setPlatformCodeAction).toBe('function');
    const sig = await captureRedirect(() => mod.setPlatformCodeAction!(form({ storeId: f.storeA, channelId: f.chA, platform: 'foodpanda', code: 'secret9' })));
    expect(sig.url).not.toContain('secret9');
  });
});

describe('T-511 S2b - the shared update form still ignores platform fields', () => {
  const base = (f: Fx, extra: Record<string, string> = {}) =>
    form({ storeId: f.storeA, channelId: f.chA, name: 'Renamed channel', isRemittedDaily: 'true', receivableAccountCode: '', wastageTypeMode: 'tracked', ...extra });

  it('a manager posting the shared form WITH platform and code fields: the rename saves, the platform columns stay null', async () => {
    const f = await fixture('shared-mgr');
    const o = await postShared(f.manager, base(f, { platform: 'grab', code: randomUUID() }));
    expect(o.flash.error).toBeUndefined();
    expect(await channelRow(f.chA)).toMatchObject({ name: 'Renamed channel', platform: null, platform_store_code: null });
  });

  it('even an admin posting them to the shared form does not set the code (only the separate form does)', async () => {
    const f = await fixture('shared-admin');
    await postShared(f.admin, base(f, { platform: 'foodpanda', code: 'sneak1', platformStoreCode: 'sneak1' }));
    expect(await channelRow(f.chA)).toMatchObject({ platform: null, platform_store_code: null });
  });

  it('the shared form does not wipe a code the admin set: renaming keeps platform and code', async () => {
    const f = await fixture('shared-keep');
    await postChannel(f.admin, form({ storeId: f.storeA, channelId: f.chA, platform: 'foodpanda', code: 'keep12' }));
    resetJar();
    await postShared(f.manager, base(f));
    expect(await channelRow(f.chA)).toMatchObject({ name: 'Renamed channel', platform: 'foodpanda', platform_store_code: 'keep12' });
  });
});

describe('T-511 S2b - updateLoanRepaymentAmountAction (loans)', () => {
  it('an admin saves 1771.88: ok banner on the loan page, the amount is stored', async () => {
    const f = await fixture('ln-ok');
    const o = await postLoan(f.admin, form({ loanId: f.loanId, repaymentAmount: '1771.88' }));
    expect(o.path).toBe(`/loans/${f.loanId}`);
    expect(o.flash.error).toBeUndefined();
    expect(o.flash.ok).toBeTruthy();
    expect(await loanAmount(f.loanId)).toBe('1771.88');
  });

  it.each([
    ['zero', '0'],
    ['negative', '-5'],
    ['text', 'abc'],
    ['three decimals', '12.345'],
    ['scientific notation', '1e3'],
  ])('refuses %s with an error banner on the loan page and writes nothing', async (_label, typed) => {
    const f = await fixture('ln-bad');
    const o = await postLoan(f.admin, form({ loanId: f.loanId, repaymentAmount: typed }));
    expect(o.path).toBe(`/loans/${f.loanId}`);
    expect(o.flash.ok).toBeUndefined();
    expect((o.flash.error ?? '').length).toBeGreaterThan(5);
    expect(await loanAmount(f.loanId)).toBeNull();
  });

  it('a manager posting the form is refused: error banner, nothing written', async () => {
    const f = await fixture('ln-mgr');
    const o = await postLoan(f.manager, form({ loanId: f.loanId, repaymentAmount: '1771.88' }));
    expect(o.path).toBe(`/loans/${f.loanId}`);
    expect(o.flash.ok).toBeUndefined();
    expect((o.flash.error ?? '').length).toBeGreaterThan(5);
    expect(await loanAmount(f.loanId)).toBeNull();
  });

  it('a blank box clears the amount: ok banner, the column is null', async () => {
    const f = await fixture('ln-clear');
    await postLoan(f.admin, form({ loanId: f.loanId, repaymentAmount: '900' }));
    resetJar();
    const o = await postLoan(f.admin, form({ loanId: f.loanId, repaymentAmount: '' }));
    expect(o.flash.error).toBeUndefined();
    expect(o.flash.ok).toBeTruthy();
    expect(await loanAmount(f.loanId)).toBeNull();
  });

  it('a loan that does not exist (a stale form) ends in an error banner, not a crash', async () => {
    const f = await fixture('ln-ghost');
    const o = await postLoan(f.admin, form({ loanId: randomUUID(), repaymentAmount: '100' }));
    expect(o.flash.ok).toBeUndefined();
    expect((o.flash.error ?? '').length).toBeGreaterThan(5);
  });
});
