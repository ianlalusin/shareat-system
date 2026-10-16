import { afterAll, describe, expect, it, vi } from 'vitest';

import type { Actor } from '@shareat/auth';
import { M, expectAbsent, expectPresent, render, session, sql, world } from './t435-fixture';

/**
 * T-435 S5 (TESTER) - /reports/ar-aging and its CSV export show customer names and balances only for the viewer's held stores,
 * where "held" means record_ar_collection (the same scope as the rest of T-435), not merely view_financial_reports. Bible row 353.
 * Red today: the report is scoped by view_financial_reports only, so V1 (reports, no AR role) reads every customer name and
 * balance at S1. A refusal may be a card, an empty report or a throw; what is pinned is that NO customer name or balance is in
 * the output. Mutants: drop the record_ar_collection narrowing (V1 leak); widen to every store (M1 sees X).
 */
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
vi.mock('../../src/lib/session', async () => (await import('./t435-fixture')).sessionMock());
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));

afterAll(async () => {
  const { closeDb } = await import('@shareat/db');
  await closeDb();
  await sql.end({ timeout: 5 });
});

const agingPage = () => import('../../src/app/reports/ar-aging/page');
const exportRoute = () => import('../../src/app/reports/ar-aging/export/route');

async function csvFor(actor: Actor, store?: string): Promise<string> {
  session.actor = actor;
  const { GET } = await exportRoute();
  const url = new URL('http://localhost/reports/ar-aging/export');
  url.searchParams.set('asOf', '2026-12-31');
  if (store) url.searchParams.set('store', store);
  try {
    return await (await GET(new Request(url))).text();
  } catch (e) {
    return `THROWN ${e instanceof Error ? e.message : String(e)}`;
  }
}
async function pageFor(actor: Actor, store?: string): Promise<string> {
  try {
    return await render(agingPage, actor, { search: { asOf: '2026-12-31', ...(store ? { store } : {}) } });
  } catch (e) {
    return `THROWN ${e instanceof Error ? e.message : String(e)}`;
  }
}

describe('T-435 S5 ar-aging - a manager of S1 sees S1 customers only (page and CSV)', () => {
  it('M1 page: Y at 1,000.00; no X, no 9,500.00 / 10,500.00 (also with a forged ?store=<S2>)', async () => {
    const w = await world();
    for (const store of [undefined, w.s2]) {
      const html = await pageFor(w.M1, store);
      expectPresent(html, 'M1 ar-aging', M.yName, M.owesS1);
      expectAbsent(html, 'M1 ar-aging', M.xName, M.owesS2, M.owesAll, M.s2Charge);
    }
  });
  it('M1 CSV: Y at 1,000.00; no X, no S2 amounts (also with a forged store)', async () => {
    const w = await world();
    for (const store of [undefined, w.s2]) {
      const csv = await csvFor(w.M1, store);
      expect(csv).toContain(M.yName);
      expect(csv).toContain('1,000.00');
      for (const n of [M.xName, '9,500.00', '10,500.00', '2,345.00']) expect(csv.includes(n), `CSV leaks ${n}`).toBe(false);
    }
  });
  it('A (every store) sees X and Y in the page and in the CSV (positive control)', async () => {
    const w = await world();
    expectPresent(await pageFor(w.A), 'A ar-aging', M.xName, M.yName);
    const csv = await csvFor(w.A);
    expect(csv).toContain(M.xName);
    expect(csv).toContain(M.yName);
  });
});

describe('T-435 S5 ar-aging - view_financial_reports alone is not a right to read customers', () => {
  it('V1 (reports at S1, no record_ar_collection) gets no customer name or balance on the page', async () => {
    const w = await world();
    expectAbsent(await pageFor(w.V1), 'V1 ar-aging', M.yName, M.xName, M.owesS1, M.owesS2, M.owesAll);
  });
  it('V1 gets no customer name or balance in the CSV', async () => {
    const w = await world();
    const csv = await csvFor(w.V1);
    for (const n of [M.yName, M.xName, '1,000.00', '9,500.00', '10,500.00']) expect(csv.includes(n), `CSV leaks ${n}`).toBe(false);
  });
});
