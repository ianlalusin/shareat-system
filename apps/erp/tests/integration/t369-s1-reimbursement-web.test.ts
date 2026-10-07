import { config } from 'dotenv';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-369 S1 — the staff reimbursement payout SCREEN (DEF-198). `docs/tasks/369-unwired-money-screens.md`
 * §S1, tests T6 (web half) and T7, plus the web legs of N1/N2/N3 (the action reaches the domain's
 * gates and turns each refusal into a readable `?error=` banner).
 *
 * ⛔ TESTER, not BUILDER. Harness copied from `t362-supplier-terms-web.test.ts`: `RedirectSignal`,
 * `ACTOR_HOLDER`/`SESSION_HOLDER`, the `Page` stub. The REAL `requirePageAccess`, the REAL domain and
 * a REAL Postgres run underneath — only the session and `next/navigation` are doubled.
 *
 * ## The surface the spec leaves open, pinned here so the builder has one reading
 * `payReimbursementAction(formData)` reads these field names (they are `PayReimbursementInput`'s own):
 *   storeId · employeeId · amount · fromMoneyAccountId · on · payoutId · memo (optional)
 * and ends in `redirect('/expenses/reimbursements?…')` carrying `ok=<sentence>` or `error=<sentence>`
 * (`back()`, as `/inventory/production/[id]`). The page is `export default async function` taking
 * `{ searchParams: Promise<{ store?, ok?, error? }> }` and renders, per row, a hidden
 * `name="payoutId"` input holding a uuid minted at render (spec: "minted server-side at page render").
 * If the builder reads a different field name, that is a QUESTION to the tester, not a test edit.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

class RedirectSignal extends Error {
  constructor(public to: string) {
    super(`redirect:${to}`);
  }
}
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
  notFound: () => {
    throw new Error('notFound() called — fixture is broken');
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const ACTOR_HOLDER: { actor: { orgId: string; personId: string } | null } = { actor: null };
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => ACTOR_HOLDER.actor!),
  requireSession: vi.fn(async () => ({
    actor: ACTOR_HOLDER.actor!, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01'),
  })),
}));
vi.mock('@/components/shell/Page', () => ({
  Page: ({ children }: { children: unknown }) => children,
}));

import { transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { postEntry } from '../../../../packages/domain/src/ledger/post-entry';
import { ROUTE_CAPABILITY, capabilityForRoute, navHrefAllowed } from '../../src/lib/route-capability';
import { GROUPS } from '../../src/components/nav';
import { paramsOf, seedSearch } from '../helpers/flash-jar';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const ROUTE = '/expenses/reimbursements';

afterAll(async () => {
  const { closeDb } = await import('@shareat/db');
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
const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

async function person(orgId: string, name: string, role: 'manager' | 'admin' | 'staff', storeIds: string[]): Promise<string> {
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
  for (const storeId of storeIds) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
  return p!.id;
}
async function foundation(storeId: string, instrument: string, custodian: string): Promise<{ id: string; glCode: string }> {
  const [row] = await sql<{ id: string; gl_account_code: string }[]>`
    select id, gl_account_code from money_accounts
    where store_id = ${storeId} and instrument = ${instrument} and custodian = ${custodian} and is_foundation`;
  if (!row) throw new Error(`fixture: no foundation ${custodian} ${instrument} account at ${storeId}`);
  return { id: row.id, glCode: row.gl_account_code };
}

/** One org, Lipa + Malvar, manager (Lipa only), admin (both), staff (Lipa), Ana (owed). */
async function fixture(hint: string) {
  const code = uid(`t369w-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;
  const [lipa] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('lipa')}, 'Lipa') returning id`;
  const [malvar] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('malvar')}, 'Malvar') returning id`;
  const lipaId = lipa!.id;
  const malvarId = malvar!.id;
  const managerId = await person(orgId, 'Lipa Manager', 'manager', [lipaId]);
  const adminId = await person(orgId, 'Admin', 'admin', [lipaId, malvarId]);
  const staffId = await person(orgId, 'Lipa Staff', 'staff', [lipaId]);
  const anaId = await person(orgId, 'Ana Reyes', 'staff', [lipaId]);
  const lipaCash = await foundation(lipaId, 'cash', 'cashier');
  const malvarSafe = await foundation(malvarId, 'cash', 'office');
  const lipaFloat = await foundation(lipaId, 'cash', 'staff');
  for (const [storeId, acct] of [[lipaId, lipaCash], [malvarId, malvarSafe]] as const) {
    await asOrg(orgId, (tx) =>
      postEntry(tx, {
        orgId, entryDate: '2026-01-01', sourceType: 'manual_journal', sourceId: uid('fund'), idempotencyKey: uid('fund'),
        memo: 'fixture funding', postedBy: adminId,
        lines: [{ accountCode: acct.glCode, storeId, debit: '100000.00' }, { accountCode: '3900', storeId, credit: '100000.00' }],
      }),
    );
  }
  return {
    orgId, lipaId, malvarId, managerId, adminId, staffId, anaId, lipaCash, malvarSafe, lipaFloat,
    manager: actor(orgId, managerId), admin: actor(orgId, adminId), staff: actor(orgId, staffId),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function owe(f: Fixture, storeId: string, employeeId: string, amount: string): Promise<void> {
  await asOrg(f.orgId, (tx) =>
    postEntry(tx, {
      orgId: f.orgId, entryDate: '2026-01-05', sourceType: 'manual_journal', sourceId: uid('owe'), idempotencyKey: uid('owe'),
      memo: 'fixture reimbursable expense', postedBy: f.adminId,
      lines: [
        { accountCode: '6200', storeId, debit: amount },
        { accountCode: '2130', storeId, credit: amount, partyType: 'employee', partyId: employeeId },
      ],
    }),
  );
}
async function payoutEntryCount(orgId: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`select count(*)::text as n from journal_entries where org_id = ${orgId} and source_type = 'reimbursement_payout'`;
  return Number(row!.n);
}

/** Dynamic import that turns "the builder has not made this file yet" into a plain statement. */
async function load<T>(spec: () => Promise<T>, what: string): Promise<T> {
  try {
    return await spec();
  } catch (err) {
    throw new Error(`${what} does not exist yet (or fails to import): ${String((err as Error).message).split('\n')[0]}`);
  }
}
const loadPage = () => load(() => import('../../src/app/expenses/reimbursements/page'), 'apps/erp/src/app/expenses/reimbursements/page.tsx');
const loadActions = () => load(() => import('../../src/app/expenses/reimbursements/actions'), 'apps/erp/src/app/expenses/reimbursements/actions.ts');

async function renderPage(who: Actor, search: Record<string, string> = {}): Promise<string> {
  ACTOR_HOLDER.actor = who;
  const { default: Page } = await loadPage();
  const element = await Page({ searchParams: Promise.resolve(await seedSearch(search)) } as never);
  return renderToStaticMarkup(element as never);
}

async function expectRedirectTo(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    if (err instanceof RedirectSignal) return err.to;
    throw err;
  }
  throw new Error('expected the action to redirect');
}
const param = (to: string, k: string) => paramsOf(to).get(k);

function payForm(f: Fixture, o: { storeId?: string; employeeId?: string; amount: string; from: string; payoutId?: string }): FormData {
  const fd = new FormData();
  fd.set('storeId', o.storeId ?? f.lipaId);
  fd.set('employeeId', o.employeeId ?? f.anaId);
  fd.set('amount', o.amount);
  fd.set('fromMoneyAccountId', o.from);
  fd.set('on', '2026-01-16');
  fd.set('payoutId', o.payoutId ?? crypto.randomUUID());
  fd.set('memo', 'T-369 web');
  return fd;
}

// -----------------------------------------------------------------------------------------------
// T7 — the route is gated, in the nav, and the page shows what is owed
// -----------------------------------------------------------------------------------------------

describe('T7 — route, nav and page gate (record_ap_payment)', () => {
  it("ROUTE_CAPABILITY names '/expenses/reimbursements' -> record_ap_payment, and capabilityForRoute agrees", () => {
    expect(ROUTE_CAPABILITY[ROUTE]).toBe('record_ap_payment');
    expect(capabilityForRoute(ROUTE)).toBe('record_ap_payment');
  });

  it('nav: Reimbursements is listed under Expenses; a holder is offered it, a non-holder is not (the same map the page gate reads)', () => {
    const expenses = GROUPS.find((g) => g.links.some((l) => l.href === '/expenses'));
    expect(expenses, 'the Expenses nav group').toBeDefined();
    const link = expenses!.links.find((l) => l.href === ROUTE);
    expect(link, 'a Reimbursements link under Expenses').toBeDefined();
    expect(link!.label).toBe('Reimbursements');
    expect(navHrefAllowed(ROUTE, new Set(['record_ap_payment']))).toBe(true);
    expect(navHrefAllowed(ROUTE, new Set(['view_trial_balance']))).toBe(false);
  });

  it('a staff GET gets the page-access refusal and none of the data; a manager at the same store sees the owed row (positive control)', async () => {
    const f = await fixture('t7');
    await owe(f, f.lipaId, f.anaId, '650.00');

    const staffHtml = await renderPage(f.staff, { store: f.lipaId });
    expect(staffHtml).toMatch(/You do not have access to this screen/);
    expect(staffHtml, 'a refused page must not leak the row').not.toMatch(/Ana Reyes/);
    expect(staffHtml).not.toMatch(/650\.00/);

    const managerHtml = await renderPage(f.manager, { store: f.lipaId });
    expect(managerHtml).not.toMatch(/You do not have access to this screen/);
    expect(managerHtml).toMatch(/Ana Reyes/);
    expect(managerHtml).toMatch(/650\.00/);
  });

  it('the Pay form carries a server-minted payoutId (uuid) as a hidden field, and the field names the action reads', async () => {
    const f = await fixture('t7form');
    await owe(f, f.lipaId, f.anaId, '650.00');
    const html = await renderPage(f.manager, { store: f.lipaId });
    const hidden = html.match(/<input[^>]*name="payoutId"[^>]*>/);
    expect(hidden, `no hidden payoutId input in: ${html.slice(0, 1500)}`).not.toBeNull();
    expect(hidden![0]).toMatch(/type="hidden"/);
    expect(hidden![0]).toMatch(UUID);
    for (const name of ['storeId', 'employeeId', 'amount', 'fromMoneyAccountId', 'on']) {
      expect(html, `the form has no ${name} field`).toMatch(new RegExp(`name="${name}"`));
    }
  });

  it("the owed list is THIS store's: Ana owed 650 at Lipa only — Malvar's page shows the empty state, not her row (N2 on the screen)", async () => {
    const f = await fixture('t7n2');
    await owe(f, f.lipaId, f.anaId, '650.00');
    const html = await renderPage(f.admin, { store: f.malvarId });
    expect(html).toMatch(/Nobody is owed a reimbursement at this store\./);
    expect(html).not.toMatch(/Ana Reyes/);
  });

  it("the money-account select offers the store's active store accounts and no staff float", async () => {
    const f = await fixture('t7acct');
    await owe(f, f.lipaId, f.anaId, '650.00');
    const html = await renderPage(f.manager, { store: f.lipaId });
    expect(html).toMatch(new RegExp(`value="${f.lipaCash.id}"`));
    expect(html, 'a staff float is not a store account').not.toMatch(new RegExp(`value="${f.lipaFloat.id}"`));
    expect(html, "another store's account is not offered").not.toMatch(new RegExp(`value="${f.malvarSafe.id}"`));
  });
});

// -----------------------------------------------------------------------------------------------
// The action — positive control, T6 (✗), N1, N2, N3 as the person sees them
// -----------------------------------------------------------------------------------------------

describe('payReimbursementAction', () => {
  it('a manager pays 650: ok banner "Paid ₱650.00 to Ana Reyes. Still owed: ₱0.00."; exactly one entry (positive control)', async () => {
    const f = await fixture('act1');
    await owe(f, f.lipaId, f.anaId, '650.00');
    ACTOR_HOLDER.actor = f.manager;
    const { payReimbursementAction } = await loadActions();

    const to = await expectRedirectTo(() => payReimbursementAction(payForm(f, { amount: '650.00', from: f.lipaCash.id })));
    expect(to).toMatch(/^\/expenses\/reimbursements\?/);
    expect(param(to, 'error'), `refused: ${param(to, 'error')}`).toBeNull();
    expect(param(to, 'ok')).toMatch(/^Paid ₱650(\.00)? to Ana Reyes\. Still owed: ₱0(\.00)?\.$/);
    expect(await payoutEntryCount(f.orgId)).toBe(1);
  });

  it('T6 (✗): a staff member — even with a forged POST — gets the refusal banner and no entry; the banner carries no id', async () => {
    const f = await fixture('act6');
    await owe(f, f.lipaId, f.anaId, '650.00');
    ACTOR_HOLDER.actor = f.staff;
    const { payReimbursementAction } = await loadActions();

    const to = await expectRedirectTo(() => payReimbursementAction(payForm(f, { amount: '650.00', from: f.lipaCash.id })));
    const error = param(to, 'error');
    expect(error, 'a refusal banner').toBeTruthy();
    expect(param(to, 'ok')).toBeNull();
    expect(error).not.toMatch(UUID);
    expect(await payoutEntryCount(f.orgId)).toBe(0);
  });

  it("N1 on the screen: a Lipa manager naming Malvar's safe gets the refusal banner (no id); no entry — control: the admin posts the same form", async () => {
    const f = await fixture('actn1');
    await owe(f, f.lipaId, f.anaId, '650.00');
    const { payReimbursementAction } = await loadActions();

    ACTOR_HOLDER.actor = f.manager;
    const to = await expectRedirectTo(() => payReimbursementAction(payForm(f, { amount: '650.00', from: f.malvarSafe.id })));
    expect(param(to, 'error'), "a manager must not draw on another store's safe").toBeTruthy();
    expect(param(to, 'error')).not.toMatch(UUID);
    expect(await payoutEntryCount(f.orgId)).toBe(0);

    ACTOR_HOLDER.actor = f.admin;
    const ok = await expectRedirectTo(() => payReimbursementAction(payForm(f, { amount: '650.00', from: f.malvarSafe.id })));
    expect(param(ok, 'error')).toBeNull();
    expect(await payoutEntryCount(f.orgId)).toBe(1);
  });

  it('N2 on the screen: the admin naming Malvar for a liability that exists only at Lipa gets "no unpaid reimbursement at this store"; no entry', async () => {
    const f = await fixture('actn2');
    await owe(f, f.lipaId, f.anaId, '650.00');
    ACTOR_HOLDER.actor = f.admin;
    const { payReimbursementAction } = await loadActions();

    const to = await expectRedirectTo(() => payReimbursementAction(payForm(f, { storeId: f.malvarId, amount: '100.00', from: f.malvarSafe.id })));
    expect(param(to, 'error')).toBe('This employee has no unpaid reimbursement at this store.');
    expect(await payoutEntryCount(f.orgId)).toBe(0);
  });

  it('N3 on the screen: the same form submitted twice (a double click, one payoutId) posts ONCE and both submissions redirect ok', async () => {
    const f = await fixture('actn3');
    await owe(f, f.lipaId, f.anaId, '1000.00');
    ACTOR_HOLDER.actor = f.manager;
    const { payReimbursementAction } = await loadActions();
    const payoutId = crypto.randomUUID();

    const first = await expectRedirectTo(() => payReimbursementAction(payForm(f, { amount: '300.00', from: f.lipaCash.id, payoutId })));
    const second = await expectRedirectTo(() => payReimbursementAction(payForm(f, { amount: '300.00', from: f.lipaCash.id, payoutId })));
    expect(param(first, 'error')).toBeNull();
    expect(param(second, 'error'), `the double click was refused: ${param(second, 'error')}`).toBeNull();
    expect(await payoutEntryCount(f.orgId), 'one payout, not two').toBe(1);
  });

  it('an overpayment is refused with the sentence and no id, and nothing posts', async () => {
    const f = await fixture('actover');
    await owe(f, f.lipaId, f.anaId, '650.00');
    ACTOR_HOLDER.actor = f.manager;
    const { payReimbursementAction } = await loadActions();

    const to = await expectRedirectTo(() => payReimbursementAction(payForm(f, { amount: '5000.00', from: f.lipaCash.id })));
    expect(param(to, 'error')).toMatch(/more than the 650\.00 owed/);
    expect(param(to, 'error')).not.toMatch(UUID);
    expect(await payoutEntryCount(f.orgId)).toBe(0);
  });
});

// -----------------------------------------------------------------------------------------------
// S1 AUDIT legs (C, D) — added after the auditor's findings.
// -----------------------------------------------------------------------------------------------

describe("C — a Lipa-only manager is never shown Malvar's stores or rows", () => {
  it("the store picker lists Lipa only, and ?store=<Malvar id> shows no Malvar rows — control: the admin (both stores) sees Malvar's row at ?store=Malvar", async () => {
    const f = await fixture('auditC');
    await owe(f, f.malvarId, f.anaId, '100.00'); // Ana is owed at MALVAR ONLY — nothing at Lipa

    const plain = await renderPage(f.manager);
    const select = plain.match(/<select[^>]*name="store"[\s\S]*?<\/select>/);
    expect(select, 'a store picker').not.toBeNull();
    expect(select![0]).toContain(f.lipaId);
    expect(select![0], "Malvar's id is not offered").not.toContain(f.malvarId);
    expect(select![0], "Malvar's name is not offered").not.toMatch(/Malvar/);

    const forged = await renderPage(f.manager, { store: f.malvarId });
    expect(forged, "a forged ?store=<Malvar> must not render Malvar's row").not.toMatch(/Ana Reyes/);
    expect(forged).not.toMatch(/100\.00/);
    expect(forged).not.toContain(f.malvarId);
    expect(forged, 'it falls back to the viewer\'s own store, which owes nobody').toMatch(/Nobody is owed a reimbursement at this store\./);

    const adminHtml = await renderPage(f.admin, { store: f.malvarId });
    expect(adminHtml).toMatch(/Ana Reyes/);
    expect(adminHtml).toMatch(/100\.00/);
  });
});

describe('D — the overdraw warning reaches the screen', () => {
  it('paying 650 from a cashier drawer holding only 100: the payout posts, the redirect carries ok AND a warning, and the page shows the warning beside the confirmation', async () => {
    const f = await fixture('auditD');
    await owe(f, f.lipaId, f.anaId, '650.00');
    // Leave ₱100.00 in the drawer: DR expense / CR the drawer's GL for 99,900.
    await asOrg(f.orgId, (tx) =>
      postEntry(tx, {
        orgId: f.orgId, entryDate: '2026-01-02', sourceType: 'manual_journal', sourceId: uid('drain'), idempotencyKey: uid('drain'),
        memo: 'fixture: drain the drawer', postedBy: f.adminId,
        lines: [{ accountCode: '6200', storeId: f.lipaId, debit: '99900.00' }, { accountCode: f.lipaCash.glCode, storeId: f.lipaId, credit: '99900.00' }],
      }),
    );
    ACTOR_HOLDER.actor = f.manager;
    const { payReimbursementAction } = await loadActions();

    const to = await expectRedirectTo(() => payReimbursementAction(payForm(f, { amount: '650.00', from: f.lipaCash.id })));
    expect(param(to, 'error'), `refused: ${param(to, 'error')}`).toBeNull();
    expect(param(to, 'ok')).toMatch(/^Paid ₱650(\.00)? to Ana Reyes\./);
    const warning = param(to, 'warning');
    expect(warning, 'the checkDraw warning was dropped on the way to the banner').toBeTruthy();
    expect(warning).not.toMatch(UUID);
    expect(await payoutEntryCount(f.orgId), 'a warning is not a refusal — it posted').toBe(1);

    const html = await renderPage(f.manager, { store: f.lipaId, ok: param(to, 'ok')!, warning: warning! });
    expect(html).toContain(warning!.slice(0, 40).replace(/&/g, '&amp;').replace(/'/g, '&#x27;').replace(/"/g, '&quot;'));
  });

  it('positive control: a drawer with enough money posts with NO warning', async () => {
    const f = await fixture('auditDpc');
    await owe(f, f.lipaId, f.anaId, '650.00');
    ACTOR_HOLDER.actor = f.manager;
    const { payReimbursementAction } = await loadActions();
    const to = await expectRedirectTo(() => payReimbursementAction(payForm(f, { amount: '650.00', from: f.lipaCash.id })));
    expect(param(to, 'warning')).toBeNull();
    expect(param(to, 'ok')).toMatch(/^Paid/);
  });
});
