import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-511 S2b (TESTER) - what each ROLE sees on the two admin-edit screens. Real Postgres, real `@shareat/auth`, real data reads,
 * real page components (only the session, the Page shell and next/navigation are mocked): the t350-s2-render.test.ts approach, which
 * is the only way to prove a per-store `can()` decision (a `heldCapabilities` mock can only say org-wide yes/no).
 * Spec: docs/tasks/511-settlement-upload-s2-spec.md "The two admin edits (2b)" item 3.
 *
 * Contract pinned here (the builder matches it):
 *   /settings/sales-channels   each ACTIVE channel card carries a SEPARATE form titled "Platform and store code":
 *       hidden storeId + channelId, a select named `platform` (options '' / grab / foodpanda, the stored one selected) and an input
 *       named `code` (the stored code as its value), a submit button. Drawn only for holders of edit_platform_store_code AT THAT
 *       STORE (a manager sees none; an admin scoped to store A sees none on store B). The shared edit form (the one carrying
 *       `wastageTypeMode`) carries NO `platform` or `code` control; the platform form carries none of the shared form's controls.
 *   /loans/[id]   the repayment amount (formatted, e.g. 1,771.88) and ONE edit form with an input named exactly `repaymentAmount`
 *       (value = the stored amount) plus hidden `loanId`, only for holders of edit_loan_repayment_amount at the loan's store.
 *       A manager (and anyone else) sees neither the figure nor the form anywhere in the HTML.
 *   LOADER DEFAULT-CLOSED (tester's decision, flag if wrong): `getDetail(orgId, id)` and `listRegister(orgId)` in loans/lib.ts keep
 *       their signatures and return NO repayment amount (null/undefined) - the page gets the amount for a holder through a separate
 *       path the builder chooses. So a page that forgets to hide cannot leak what it was never given.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

const h = vi.hoisted(() => ({ actor: null as null | { personId: string; orgId: string } }));
vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => h.actor),
  requireSession: vi.fn(async () => ({ actor: h.actor, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01') })),
}));
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));

import { APP_ROLE, closeDb, transaction, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { createLoan } from '@shareat/domain';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
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

const AMOUNT = '1771.88';
const CODE = 'rnd123';

async function fixture(hint: string) {
  const code = uid(`t511r-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const mkStore = async (name: string) => {
    const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('st')}, ${name}) returning id`;
    return s!.id;
  };
  const storeA = await mkStore('Store A');
  const storeB = await mkStore('Store B');
  const admin = await person(orgId, 'admin', 'Admin', [storeA, storeB]);
  const adminA = await person(orgId, 'admin', 'Admin A only', [storeA]);
  const manager = await person(orgId, 'manager', 'Manager', [storeA, storeB]);
  const mkChannel = async (storeId: string, name: string, platform: string | null, c: string | null) => {
    const [r] = await sql<{ id: string }[]>`
      insert into sales_channels (org_id, store_id, name, is_remitted_daily, platform, platform_store_code)
      values (${orgId}, ${storeId}, ${name}, true, ${platform}, ${c}) returning id`;
    return r!.id;
  };
  const chFp = await mkChannel(storeA, 'Foodpanda Lipa', 'foodpanda', CODE);
  const chWalk = await mkChannel(storeA, 'Walk-in Lipa', null, null);
  const chB = await mkChannel(storeB, 'Grab Malvar', null, null);
  const mkLoan = async (storeId: string, name: string) => {
    const l = await asOrg(orgId, (tx) =>
      createLoan(tx, admin, {
        storeId, lenderName: 'Grab', name, principalAmount: '50000.00', interestRate: '2', ratePeriod: 'month',
        interestMethod: 'straight', paymentFrequency: 'daily', termPeriods: 90, startDate: '2026-05-11',
      }),
    );
    await sql`update loans set repayment_amount = ${AMOUNT} where id = ${l.id}`;
    return l.id;
  };
  const loanA = await mkLoan(storeA, 'Grab loan Lipa');
  const loanB = await mkLoan(storeB, 'Grab loan Malvar');
  return { orgId, storeA, storeB, chFp, chWalk, chB, loanA, loanB, admin, adminA, manager };
}

// ---- markup helpers ---------------------------------------------------------------------------------------------------
const forms = (html: string) => html.match(/<form\b[\s\S]*?<\/form>/g) ?? [];
const withName = (seg: string, name: string) => new RegExp(`\\sname="${name}"`).test(seg);
const hiddenValue = (seg: string, name: string): string | null => {
  const m = new RegExp(`<input[^>]*\\sname="${name}"[^>]*>`).exec(seg)?.[0];
  return m ? (/\svalue="([^"]*)"/.exec(m)?.[1] ?? '') : null;
};
const textInputValue = (seg: string, name: string): string | null => {
  const m = new RegExp(`<input[^>]*\\sname="${name}"[^>]*>`).exec(seg)?.[0];
  return m ? (/\svalue="([^"]*)"/.exec(m)?.[1] ?? '') : null;
};
function selectedOption(seg: string, name: string): string | null {
  const m = new RegExp(`<select\\b[^>]*\\sname="${name}"[^>]*>([\\s\\S]*?)</select>`).exec(seg);
  if (!m) return null;
  const opts = m[1]!.match(/<option\b[^>]*>/g) ?? [];
  const pick = opts.find((o) => /\sselected(=|\s|>)/.test(o)) ?? opts[0];
  return pick ? (/\svalue="([^"]*)"/.exec(pick)?.[1] ?? '') : null;
}
const optionValues = (seg: string, name: string): string[] => {
  const m = new RegExp(`<select\\b[^>]*\\sname="${name}"[^>]*>([\\s\\S]*?)</select>`).exec(seg);
  return (m?.[1]!.match(/<option\b[^>]*>/g) ?? []).map((o) => /\svalue="([^"]*)"/.exec(o)?.[1] ?? '');
};
const platformForms = (html: string) => forms(html).filter((s) => withName(s, 'platform'));

type Page = (props: never) => Promise<unknown>;
let ChannelsPage: Page;
let LoanPage: Page;
let LoansListPage: Page;
beforeAll(async () => {
  ChannelsPage = (await import('../../src/app/settings/sales-channels/page')).default as unknown as Page;
  LoanPage = (await import('../../src/app/loans/[id]/page')).default as unknown as Page;
  LoansListPage = (await import('../../src/app/loans/page')).default as unknown as Page;
}, 120_000);

async function renderChannels(who: Actor, storeId: string) {
  h.actor = who;
  return renderToStaticMarkup((await ChannelsPage({ searchParams: Promise.resolve({ store: storeId }) } as never)) as never);
}
async function renderLoan(who: Actor, id: string) {
  h.actor = who;
  return renderToStaticMarkup((await LoanPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) } as never)) as never);
}
async function renderLoansList(who: Actor) {
  h.actor = who;
  return renderToStaticMarkup((await LoansListPage({ searchParams: Promise.resolve({}) } as never)) as never);
}

describe('T-511 S2b - /settings/sales-channels: the "Platform and store code" form, by role and by store', () => {
  it('an admin sees one separate form per active channel, titled "Platform and store code", pre-filled with the stored platform and code', async () => {
    const f = await fixture('ch-admin');
    const html = await renderChannels(f.admin, f.storeA);
    expect(html, 'the page renders the channels at all').toContain('Foodpanda Lipa');
    expect((html.match(/Platform and store code/g) ?? []).length, 'one titled form per active channel (two in store A)').toBeGreaterThanOrEqual(2);

    const pf = platformForms(html);
    expect(pf, 'one platform form per active channel').toHaveLength(2);
    const fp = pf.find((s) => hiddenValue(s, 'channelId') === f.chFp)!;
    const walk = pf.find((s) => hiddenValue(s, 'channelId') === f.chWalk)!;
    expect(fp, 'the Foodpanda channel has its form').toBeTruthy();
    expect(walk, 'the Walk-in channel has its form').toBeTruthy();

    expect(hiddenValue(fp, 'storeId'), 'the same store stays open after a save').toBe(f.storeA);
    expect(optionValues(fp, 'platform')).toEqual(['', 'grab', 'foodpanda']);
    expect(selectedOption(fp, 'platform'), 'the stored platform is selected').toBe('foodpanda');
    expect(textInputValue(fp, 'code'), 'the stored code fills the box').toBe(CODE);
    expect(fp).toMatch(/<button\b[^>]*type="submit"/);

    expect(selectedOption(walk, 'platform'), 'a channel with no platform shows "none"').toBe('');
    expect(textInputValue(walk, 'code')).toBe('');
  });

  it('the platform form is SEPARATE: none of the shared edit form\'s controls are in it, and the shared form has no platform or code control', async () => {
    const f = await fixture('ch-sep');
    const html = await renderChannels(f.admin, f.storeA);
    const all = forms(html);
    const pf = platformForms(html);
    expect(pf.length).toBeGreaterThan(0);
    for (const s of pf) {
      expect(withName(s, 'wastageTypeMode'), 'no shared-form control inside the platform form').toBe(false);
      expect(withName(s, 'isRemittedDaily')).toBe(false);
      expect(withName(s, 'receivableAccountCode')).toBe(false);
    }
    const shared = all.filter((s) => withName(s, 'wastageTypeMode'));
    expect(shared.length, 'the shared edit forms (one per channel + the add form) are still there').toBeGreaterThanOrEqual(3);
    for (const s of shared) {
      expect(withName(s, 'platform'), 'the shared form must not carry a platform control').toBe(false);
      expect(withName(s, 'code'), 'the shared form must not carry a code control').toBe(false);
      expect(withName(s, 'platformStoreCode')).toBe(false);
    }
  });

  it('a manager (who holds manage_store_settings and sees the page) gets NO platform form and no platform or code control', async () => {
    const f = await fixture('ch-mgr');
    const html = await renderChannels(f.manager, f.storeA);
    expect(html, 'the manager still sees the channels').toContain('Foodpanda Lipa');
    expect(html).not.toContain('Platform and store code');
    expect(withName(html, 'platform')).toBe(false);
    expect(withName(html, 'code')).toBe(false);
  });

  it('per-store: an admin who holds the capability at store A only sees the form on store A and NOT on store B\'s channels', async () => {
    const f = await fixture('ch-scope');
    const atA = await renderChannels(f.adminA, f.storeA);
    expect(platformForms(atA).length, 'store A: forms drawn').toBe(2);
    const atB = await renderChannels(f.adminA, f.storeB);
    expect(atB, 'store B renders its channel').toContain('Grab Malvar');
    expect(atB).not.toContain('Platform and store code');
    expect(platformForms(atB)).toHaveLength(0);
  });
});

describe('T-511 S2b - /loans/[id]: the repayment amount and its form, by role and by store', () => {
  it('an admin sees the amount and ONE edit form: input named repaymentAmount (stored value), hidden loanId, no input named amount in it', async () => {
    const f = await fixture('ln-admin');
    const html = await renderLoan(f.admin, f.loanA);
    expect(html, 'the loan page renders').toContain('Grab loan Lipa');
    expect(html, 'the stored amount is shown').toMatch(/1,?771\.88/);

    const holders = forms(html).filter((s) => withName(s, 'repaymentAmount'));
    expect(holders, 'exactly one repayment form').toHaveLength(1);
    const form = holders[0]!;
    expect(hiddenValue(form, 'loanId')).toBe(f.loanA);
    expect(textInputValue(form, 'repaymentAmount'), 'the stored amount fills the box').toBe(AMOUNT);
    expect(withName(form, 'amount'), 'the input is named repaymentAmount, never amount (the number-box census locates name="amount" by order)').toBe(false);
    expect(form).toMatch(/<button\b[^>]*type="submit"/);
    // the existing forms keep their own `amount` inputs (draw + payment) and none of them is the repayment form
    const amountForms = forms(html).filter((s) => withName(s, 'amount'));
    expect(amountForms.length, 'draw and payment forms are still there').toBeGreaterThanOrEqual(1);
    for (const s of amountForms) expect(withName(s, 'repaymentAmount')).toBe(false);
  });

  it('a manager sees NEITHER the amount NOR the form anywhere in the page', async () => {
    const f = await fixture('ln-mgr');
    const html = await renderLoan(f.manager, f.loanA);
    expect(html, 'the manager still sees the loan').toContain('Grab loan Lipa');
    expect(withName(html, 'repaymentAmount')).toBe(false);
    expect(html).not.toMatch(/1,?771\.88/);
    expect(html.toLowerCase()).not.toContain('repayment amount');
  });

  it('per-store: an admin holding the capability at store A only sees the amount and form on store A\'s loan and neither on store B\'s', async () => {
    const f = await fixture('ln-scope');
    const atA = await renderLoan(f.adminA, f.loanA);
    expect(withName(atA, 'repaymentAmount')).toBe(true);
    expect(atA).toMatch(/1,?771\.88/);
    const atB = await renderLoan(f.adminA, f.loanB);
    expect(atB).toContain('Grab loan Malvar');
    expect(withName(atB, 'repaymentAmount')).toBe(false);
    expect(atB).not.toMatch(/1,?771\.88/);
  });

  it('the loans LIST never shows the repayment amount to a manager', async () => {
    const f = await fixture('ln-list');
    const html = await renderLoansList(f.manager);
    expect(html, 'the manager sees the register').toContain('Grab loan Lipa');
    expect(html).not.toMatch(/1,?771\.88/);
    expect(withName(html, 'repaymentAmount')).toBe(false);
  });
});

describe('T-511 S2b - the loans loaders hand the page NO repayment amount by default (default-closed; the page adds it for a holder)', () => {
  it('getDetail(orgId, id) returns the loan with repaymentAmount null or undefined even though one is stored', async () => {
    const f = await fixture('ld-detail');
    const { getDetail } = await import('../../src/app/loans/lib');
    const d = await getDetail(f.orgId, f.loanA);
    expect(d, 'the loan loads').not.toBeNull();
    expect((d as unknown as { repaymentAmount?: string | null }).repaymentAmount ?? null, 'the stored 1771.88 must not ride the default loader').toBeNull();
    expect(JSON.stringify(d)).not.toContain(AMOUNT);
  });

  it('listRegister(orgId) rows carry no repayment amount either', async () => {
    const f = await fixture('ld-list');
    const { listRegister } = await import('../../src/app/loans/lib');
    const rows = await listRegister(f.orgId);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const r of rows) expect((r as unknown as { repaymentAmount?: string | null }).repaymentAmount ?? null).toBeNull();
    expect(JSON.stringify(rows)).not.toContain(AMOUNT);
  });
});

describe('T-511 S2b - sanity: a random id is not a loan', () => {
  it('rendering a loan that does not exist is the existing notFound, unchanged', async () => {
    const f = await fixture('ln-ghost');
    await expect(renderLoan(f.admin, randomUUID())).rejects.toThrow(/NEXT_NOT_FOUND/);
  });
});
