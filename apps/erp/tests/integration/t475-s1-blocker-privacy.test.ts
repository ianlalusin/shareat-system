import { config } from 'dotenv';
import { renderToStaticMarkup } from 'react-dom/server';
import postgres from 'postgres';
import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * T-475 S1 (TESTER) - blocker detail is for people who may verify. On a pending invoice page, a viewer WITHOUT
 * verify_supplier_invoice at the store must see no blocker detail: no "holds ₱" drawer balance and no cash-request holder name
 * (the preview is gated on can(), the page falls back to the plain "can't verify" text). Control: the admin who may verify
 * sees the blocker naming the holder. MUTANTS: previewInvoiceDrafts run for every viewer; the gate on the page only hides the
 * form while the blocker text still renders.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} }),
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
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
// The blocker text is rendered in the browser by <RuleCheck>; what the SERVER hands it is its `facts` prop. Capture those.
const CAPTURED: Array<{ id: string; facts: unknown }> = [];
vi.mock('@/components/forms', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  RuleCheck: (props: { id: string; facts: unknown }) => {
    CAPTURED.push({ id: props.id, facts: props.facts });
    return null;
  },
}));
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));
vi.mock('@/lib/money-lines/load', async () => await import('../../src/lib/money-lines/load'));
vi.mock('@/components/money/MoneyLines', async () => await import('../../src/components/money/MoneyLines'));

import { closeDb } from '@shareat/db';
import { createCashRequest, decideCashRequest, releaseCashRequest } from '@shareat/domain';
import { ap475Fixture, asOrg, uid } from '../../../../packages/domain/tests/integration/_fixtures/t475-ap';

const sql = postgres(url, { max: 5 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

async function render(who: { orgId: string; personId: string }, invoiceId: string): Promise<string> {
  ACTOR_HOLDER.actor = who;
  CAPTURED.length = 0;
  const { default: Page } = await import('../../src/app/ap/invoices/[id]/page');
  return renderToStaticMarkup((await Page({ params: Promise.resolve({ id: invoiceId }), searchParams: Promise.resolve({}) } as never)) as never);
}

describe('T-475 S1 - a viewer who may not verify sees no blocker detail', () => {
  it('two drafts overdrawing a drawer: the verifier sees the drawer balance; floor staff see no balance and no cash-request holder name', async () => {
    const f = await ap475Fixture(sql, 'privacy');
    await sql`update persons set display_name = 'Zelda Holder' where id = ${f.adminId}`;
    const [staffFloat] = await sql<{ id: string }[]>`select id from money_accounts where store_id = ${f.storeId} and custodian = 'staff' and instrument = 'cash'`;
    const [office] = await sql<{ id: string }[]>`select id from money_accounts where store_id = ${f.storeId} and custodian = 'office' and instrument = 'cash'`;
    const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${f.orgId} limit 1`;
    await sql.begin(async (t) => {
      const [e] = await t<{ id: string }[]>`insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status) values (${f.orgId}, '2026-01-02', ${period!.id}, 'opening_balance', ${uid('open')}, 'draft') returning id`;
      const [target] = await t<{ id: string }[]>`select id from accounts where org_id = ${f.orgId} and code = '1130'`;
      const [equity] = await t<{ id: string }[]>`select id from accounts where org_id = ${f.orgId} and code = '3900'`;
      await t`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 1, ${target!.id}, ${f.storeId}, '1000.00', '0')`;
      await t`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 2, ${equity!.id}, ${f.storeId}, '0', '1000.00')`;
      await t`update journal_entries set status = 'posted' where id = ${e!.id}`;
    });
    const { id: requestId } = await asOrg(f.orgId, (tx) =>
      createCashRequest(tx, f.admin, { storeId: f.storeId, requestedFor: f.adminId, purpose: 'Market run', amount: '1000.00', on: '2026-01-05' }),
    );
    await asOrg(f.orgId, (tx) => decideCashRequest(tx, f.verifier, { requestId, decision: 'approve', amount: '1000.00', on: '2026-01-05' }));
    await asOrg(f.orgId, (tx) => releaseCashRequest(tx, f.verifier, { requestId, amount: '1000.00', fromMoneyAccountId: office!.id, on: '2026-01-05' }));
    const inv = await f.invoice({ status: 'pending' });
    // two 600 drafts on the office safe (holds 1000 after the 1000 float was released: 0 left): the pair overdraws it
    void staffFloat;
    const pay = [{ method: 'cash' as const, amount: '600.00', moneyAccountId: office!.id }];
    await f.draft(inv, { payments: pay });
    await f.draft(inv, { payments: pay });

    const verifierHtml = await render(f.verifier, inv);
    const verifierFacts = JSON.stringify(CAPTURED.map((c) => c.facts));
    expect(CAPTURED.length, 'control: the verify form mounts RuleChecks for the verifier').toBeGreaterThan(0);
    expect(verifierFacts, 'control: the verifier is given the drawer blocker').toMatch(/holds |is short/);

    const staffHtml = await render(f.staff, inv);
    expect(staffHtml, 'the page itself rendered for the viewer').toContain('Pending');
    const staffFacts = JSON.stringify(CAPTURED.map((c) => c.facts));
    for (const hay of [staffHtml, staffFacts]) {
      expect(hay).not.toContain('Zelda Holder');
      expect(hay).not.toMatch(/holds |is short|has ₱[\d,.]+ left/);
    }
  });
});
