import { config } from 'dotenv';
import { renderToStaticMarkup } from 'react-dom/server';
import postgres from 'postgres';
import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * T-475 S2 (TESTER) - R14 on the approve card: a REFUSED approve keeps the closed-month override tick, reason and note for the SAME
 * person when the page reopens, and another person viewing the same expense sees none of it (the slot is bound to who typed it).
 * Form key `expense.approve` (EXPENSE_APPROVE), fields periodOverrideConfirm / periodOverrideReason / periodOverrideNote.
 * Refusal driven: a complete override on a closed month, but the draft sits on an unmapped category, so approveExpense refuses.
 * MUTANTS: the refusal drops the typing; the page ignores it; the slot is not bound to the actor; a good approve leaves typing behind.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
const h = vi.hoisted(() => ({ actor: null as null | { personId: string; orgId: string } }));
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => h.actor),
  requireSession: vi.fn(async () => ({ actor: h.actor, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01') })),
}));
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));
vi.mock('@/lib/money-lines/load', async () => await import('../../src/lib/money-lines/load'));

import { closeDb } from '@shareat/db';
import { ap475Fixture } from '../../../../packages/domain/tests/integration/_fixtures/t475-ap';
import { captureRedirect, outcomeOf, pageParamsOf, resetJar } from '../helpers/flash-jar';

const sql = postgres(url, { max: 5 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const NOTE = 'Bill arrived after month end';
type Who = { personId: string; orgId: string };

async function setup(hint: string) {
  const f = await ap475Fixture(sql, hint);
  const id = await f.draft(await f.invoice({ status: 'verified', on: '2026-01-10' }), { on: '2026-01-10', categoryId: await f.unmappedCategory() });
  await f.setPeriod('2026-01-01', 'closed');
  return { f, id };
}
async function refusedApprove(f: Awaited<ReturnType<typeof setup>>['f'], id: string) {
  resetJar();
  h.actor = f.admin;
  const { approveExpenseAction } = await import('../../src/app/expenses/actions');
  const fd = new FormData();
  for (const [k, v] of Object.entries({ storeId: f.storeId, expenseId: id, periodOverrideConfirm: 'on', periodOverrideReason: 'late_supplier_invoice', periodOverrideNote: NOTE })) fd.set(k, v);
  const signal = await captureRedirect(() => approveExpenseAction(fd));
  return { signal, error: outcomeOf(signal).flash.error };
}
async function render(who: Who, id: string, params: Record<string, string>): Promise<string> {
  h.actor = who;
  const { default: Page } = await import('../../src/app/expenses/[id]/page');
  return renderToStaticMarkup((await Page({ params: Promise.resolve({ id }), searchParams: Promise.resolve(params) })) as never);
}

describe('T-475 S2 / R14 - a refused approve keeps the override typing', () => {
  it('the refusal is a real refusal (control): the draft is still a draft and the error names the category', async () => {
    const { f, id } = await setup('r14ctl');
    const r = await refusedApprove(f, id);
    expect(r.error, `redirected to ${r.signal.url}`).toMatch(/ledger account|can't be posted/i);
    expect((await sql<{ status: string }[]>`select status from expenses where id = ${id}`)[0]!.status).toBe('draft');
  });

  it('the same person reopening the page sees the tick, reason and note still filled in; with no refusal they are empty (mutant: typing dropped / not drawn)', async () => {
    const { f, id } = await setup('r14same');
    const r = await refusedApprove(f, id);
    const html = await render(f.admin, id, pageParamsOf(r.signal.url));
    expect(html, 'control: the override control is on the page').toContain('data-closed-month-override');
    expect(html, 'the note is put back').toContain(NOTE);
    expect(html, 'the reason is put back').toMatch(/<option[^>]*value="late_supplier_invoice"[^>]*selected|<option[^>]*selected[^>]*value="late_supplier_invoice"/);
    expect(html, 'the tick is put back').toMatch(/<input[^>]*name="periodOverrideConfirm"[^>]*checked|<input[^>]*checked[^>]*name="periodOverrideConfirm"/);

    resetJar();
    const clean = await render(f.admin, id, {});
    expect(clean).not.toContain(NOTE);
  });

  it('another signed-in person given the same flash sees nothing typed (mutant: slot not bound to the actor)', async () => {
    const { f, id } = await setup('r14other');
    const r = await refusedApprove(f, id);
    const html = await render(f.verifier, id, pageParamsOf(r.signal.url));
    expect(html, 'control: the other admin also gets the override control').toContain('data-closed-month-override');
    expect(html).not.toContain(NOTE);
    expect(html).not.toMatch(/<input[^>]*name="periodOverrideConfirm"[^>]*checked/);
  });
});
