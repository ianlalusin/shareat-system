import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

/**
 * T-598 S8 - ERP pages and actions. Each block is one defect; the MUTANT line says what to put back to see it red.
 * Harness for the cash-flow render: the same doubles as `t589-def867-report-refusal.test.ts` (session, held capabilities, principal
 * transaction); the real page, real `reportScope`, real domain.
 */
const ACTOR = { orgId: 'org-1', personId: 'p-1' };
vi.mock('../src/lib/session', () => ({
  requireActor: vi.fn(async () => ACTOR),
  requireSession: vi.fn(async () => ({ actor: ACTOR, sessionId: 's1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01') })),
}));
vi.mock('@shareat/auth', async (orig) => {
  const actual = await orig<typeof import('@shareat/auth')>();
  return { ...actual, heldCapabilities: vi.fn(async () => new Set(['view_financial_reports'])), authorize: vi.fn(async () => undefined) };
});
vi.mock('@shareat/db', async (orig) => {
  const actual = await orig<typeof import('@shareat/db')>();
  return {
    ...actual,
    accessRepo: { ...actual.accessRepo, personCoversWholeOrg: vi.fn(async () => true), storeIdsForPerson: vi.fn(async () => []) },
    attendanceConfigRepo: { ...actual.attendanceConfigRepo, findLive: vi.fn(async () => undefined) }, // DEF-253: a store with no live policy
  };
});
vi.mock('../src/app/expenses/lib', async (orig) => {
  const actual = await orig<typeof import('../src/app/expenses/lib')>();
  const chain = { from: () => chain, where: () => chain, limit: async () => [{ name: 'Shareat', code: 'SHR' }], orderBy: async () => [] };
  return { ...actual, withOrgPrincipal: vi.fn(async (_org: string, fn: (tx: unknown) => Promise<unknown>) => fn({ select: () => chain })) };
});

import CashFlowPage from '../src/app/reports/cash-flow/page';
import { parseYearParam } from '../src/app/payroll/thirteenth-month/year';

const here = dirname(fileURLToPath(import.meta.url));
const src = (rel: string) => readFileSync(resolve(here, '..', 'src', rel), 'utf8');

describe('DEF-566 - /reports/cash-flow with a date the calendar does not have says so', () => {
  // MUTANT: delete the `isRealDate` check in app/reports/cash-flow/page.tsx -> getCashFlow throws "Invalid business date" and the page rejects.
  it('from=2026-02-30 renders one sentence, not the error page', async () => {
    const out = await CashFlowPage({ searchParams: Promise.resolve({ from: '2026-02-30' }) });
    const html = renderToStaticMarkup(out as never);
    expect(html).toContain('not both real calendar dates');
    expect(html).not.toMatch(/Invalid business date/);
  });
});

describe('DEF-468 - the 13th-month year is a year or it is refused by name', () => {
  // MUTANT: `Number(raw) || currentYear` back in parseYearParam (or in the page).
  it('absent means this year; a four-digit year is taken; blank and text are refused', () => {
    expect(parseYearParam(undefined, 2026)).toEqual({ year: 2026 });
    expect(parseYearParam('2025', 2026)).toEqual({ year: 2025 });
    for (const bad of ['', 'abc', '25', '20255', '1999', '2100', '2025.5']) {
      expect(parseYearParam(bad, 2026), `"${bad}"`).toEqual({ error: 'The year must be a four-digit year, for example 2026.' });
    }
  });
  it('the page uses it, not Number(sp.year)', () => {
    const page = src('app/payroll/thirteenth-month/page.tsx');
    expect(page).toMatch(/parseYearParam\(sp\.year/);
    expect(page).not.toMatch(/Number\(sp\.year\)/);
  });
});

describe('DEF-514 - the statutory register checks its dates with the core parser', () => {
  // MUTANT: the `/^\d{4}-\d{2}-\d{2}$/` regex back in statutory-discounts/page.tsx.
  it('no shape-only regex; parseBusinessDate is the check', () => {
    const page = src('app/statutory-discounts/page.tsx');
    expect(page).not.toMatch(/\\d\{4\}-\\d\{2\}-\\d\{2\}/);
    expect(page).toMatch(/parseBusinessDate\(v\)/);
    expect(page).toMatch(/isRealDate\(sp\.from\)/);
    expect(page).toMatch(/isRealDate\(sp\.to\)/);
  });
});

describe('DEF-635 - /setup uses the shared SubmitButton (the hook exists in the app`s React)', () => {
  // MUTANT: restore app/setup/SubmitButton.tsx and its import.
  it('the hand-rolled button is gone and the page imports the kit one', () => {
    expect(existsSync(resolve(here, '..', 'src/app/setup/SubmitButton.tsx'))).toBe(false);
    expect(src('app/setup/page.tsx')).toMatch(/from '@\/components\/feedback\/SubmitButton'/);
  });
});

describe('DEF-533 - the expenses screens gate on the lists the domain authorizes with', () => {
  // MUTANT: a literal ['create_expense'] list back in expenses/actions.ts (or a capability added to the domain list only: the screen follows it).
  it('actions.ts passes the domain constants and carries no literal capability list', () => {
    const actions = src('app/expenses/actions.ts');
    expect(actions).not.toMatch(/parseExpenseForm\([^)]*\[\s*'/);
    expect(actions.match(/CREATE_EXPENSE_CAPABILITIES/g)!.length).toBeGreaterThanOrEqual(3);
    expect(actions).toMatch(/RECORD_EXPENSE_FOR_INVOICE_CAPABILITIES/);
  });
  it('the domain authorizes through the very same constants', () => {
    const root = resolve(here, '..', '..', '..', 'packages', 'domain', 'src');
    const create = readFileSync(resolve(root, 'expenses', 'create.ts'), 'utf8');
    const ap = readFileSync(resolve(root, 'ap', 'index.ts'), 'utf8');
    expect(create).toMatch(/for \(const c of CREATE_EXPENSE_CAPABILITIES\) await authorize\(tx, actor, c,/);
    expect(create).not.toMatch(/authorize\(tx, actor, 'create_expense'/);
    expect(ap).toMatch(/\[RECORD_EXPENSE_FIRST_GATE, \.\.\.CREATE_EXPENSE_CAPABILITIES\]/);
    expect(ap).toMatch(/authorize\(trx, actor, RECORD_EXPENSE_FIRST_GATE,/);
  });
});

describe('DEF-253 - an attendance review with no policy says so', () => {
  // MUTANT: `{ from: today, to: today }` back in attendance/lib.ts defaultRange.
  it('defaultRange says noPolicy for a store with no live config (and still returns today)', async () => {
    const { defaultRange } = await import('../src/app/attendance/lib');
    expect(await defaultRange('org-1', 'store-1', '2026-03-05')).toEqual({ from: '2026-03-05', to: '2026-03-05', noPolicy: true });
  });
  it('the page shows a banner naming the settings page when defaultRange reports noPolicy', () => {
    const page = src('app/attendance/page.tsx');
    expect(page).toMatch(/fallback\.noPolicy/);
    expect(page).toMatch(/href="\/settings\/attendance"/);
    expect(src('app/attendance/lib.ts')).toMatch(/noPolicy: true/);
  });
});
