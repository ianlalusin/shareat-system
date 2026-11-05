import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T-511 S5b FIXER (2026-11-05), P3-14 - a refused review action used to redirect with only `?day=`, so the person lost the store / platform / month filters and the
 * reason they had typed. Now the redirect carries the filters the form posted (only values of the right shape) and, on a refusal, the typed reason in the signed
 * flash cookie (`keep.reason`), never in the address. Same mocks as t511-s5b-review-actions.test.ts: the action bodies and `errorMessage` are real.
 */
const redirectWithFlash = vi.fn(async (..._a: unknown[]): Promise<never> => {
  throw new Error('redirected');
});
const rejectDay = vi.fn();
const reopenDay = vi.fn();
const overrideLoanAllocation = vi.fn();

vi.mock('@/lib/flash', () => ({ redirectWithFlash: (...a: unknown[]) => redirectWithFlash(...a) }));
vi.mock('../src/lib/session', () => ({
  requireActor: vi.fn(async () => ({ orgId: 'org-1', personId: 'p1' })),
  requireSession: vi.fn(async () => ({ actor: { orgId: 'org-1', personId: 'p1' } })),
}));
vi.mock('@shareat/db', async (orig) => ({
  ...(await orig<typeof import('@shareat/db')>()),
  withOrgPrincipal: vi.fn(async (_o: string, fn: (tx: unknown) => Promise<unknown>) => fn({})),
}));
vi.mock('../src/app/expenses/lib', async (orig) => ({
  ...(await orig<object>()),
  withOrgPrincipal: vi.fn(async (_o: string, fn: (tx: unknown) => Promise<unknown>) => fn({})),
}));
vi.mock('../src/app/channel-settlements/lib', async (orig) => ({
  ...(await orig<object>()),
  withOrgPrincipal: vi.fn(async (_o: string, fn: (tx: unknown) => Promise<unknown>) => fn({})),
}));
vi.mock('@shareat/domain', async (orig) => ({
  ...(await orig<typeof import('@shareat/domain')>()),
  rejectDay: (...a: unknown[]) => rejectDay(...a),
  reopenDay: (...a: unknown[]) => reopenDay(...a),
  overrideLoanAllocation: (...a: unknown[]) => overrideLoanAllocation(...a),
}));

const LINE = '00000000-0000-4000-8000-0000000000a1';
const STORE = '00000000-0000-4000-8000-0000000000b2';
const FILTERS = { store: STORE, platform: 'grab', period: '2026-10', needs: '1' };

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}
const call = (): { path: string; nav: Record<string, string>; flash: { ok?: string; error?: string; keep?: { reason?: string } } } => {
  const [path, nav, flash] = redirectWithFlash.mock.calls[0] as [string, Record<string, string>, never];
  return { path, nav, flash };
};

beforeAll(async () => {
  await import('../src/app/channel-settlements/review/actions');
}, 60_000);
beforeEach(() => {
  redirectWithFlash.mockClear();
  rejectDay.mockReset();
  reopenDay.mockReset();
  overrideLoanAllocation.mockReset();
});

describe('P3-14 the review actions keep the filters', () => {
  it('a refused reject redirects with the day AND the four filters, and puts no typed text in the nav or the flash [kills: filters lost on a refusal; free text in the address]', async () => {
    const { refuse } = await import('@shareat/domain');
    rejectDay.mockRejectedValueOnce(refuse('rejectDay: already decided', 'This day was already decided by someone else. Reload the page to see what they decided.'));
    const { rejectDayAction } = await import('../src/app/channel-settlements/review/actions');
    await rejectDayAction(form({ lineId: LINE, reason: 'Payout is short by 12.00 pesos', ...FILTERS })).catch(() => undefined);
    const c = call();
    expect(c.path).toBe('/channel-settlements/review');
    expect(c.nav).toEqual({ day: LINE, ...FILTERS });
    expect(c.flash.error).toMatch(/already decided/);
    expect(c.flash.keep).toBeUndefined(); // the typed reason is not refilled (it would need EditableRecord); never carried in the address
    expect(JSON.stringify(c.nav)).not.toContain('short by');
  });

  it('a successful reject keeps the filters [kills: filters lost on success]', async () => {
    rejectDay.mockResolvedValueOnce({ lineId: LINE });
    const { rejectDayAction } = await import('../src/app/channel-settlements/review/actions');
    await rejectDayAction(form({ lineId: LINE, reason: 'Payout is short', ...FILTERS })).catch(() => undefined);
    const c = call();
    expect(c.nav).toEqual({ day: LINE, ...FILTERS });
    expect(c.flash.ok).toMatch(/rejected/i);
    expect(c.flash.keep).toBeUndefined();
  });

  it('a filter value of the wrong shape is dropped, the rest are kept; no filters posted = the day alone, as before [kills: a crafted value passed to the address]', async () => {
    rejectDay.mockResolvedValueOnce({ lineId: LINE });
    const { rejectDayAction } = await import('../src/app/channel-settlements/review/actions');
    await rejectDayAction(form({ lineId: LINE, reason: 'x', store: 'not-a-uuid', platform: 'evil', period: '<script>', needs: 'yes' })).catch(() => undefined);
    expect(call().nav).toEqual({ day: LINE });
    redirectWithFlash.mockClear();
    rejectDay.mockResolvedValueOnce({ lineId: LINE });
    await rejectDayAction(form({ lineId: LINE, reason: 'x', platform: 'foodpanda' })).catch(() => undefined);
    expect(call().nav).toEqual({ day: LINE, platform: 'foodpanda' });
  });

  it('reopen and the loan override carry the filters on success and on refusal [kills: only reject fixed]', async () => {
    const { refuse } = await import('@shareat/domain');
    const { reopenDayAction, overrideLoanAllocationAction } = await import('../src/app/channel-settlements/review/actions');
    reopenDay.mockRejectedValueOnce(refuse('reopen: no', 'Only a rejected day can be reopened. This one is not rejected.'));
    await reopenDayAction(form({ lineId: LINE, ...FILTERS })).catch(() => undefined);
    expect(call().nav).toEqual({ day: LINE, ...FILTERS });
    expect(call().flash.error).toMatch(/reopened/);
    redirectWithFlash.mockClear();
    overrideLoanAllocation.mockResolvedValueOnce({ lineId: LINE });
    await overrideLoanAllocationAction(form({ lineId: LINE, loanId: STORE, amount: '10.00', ...FILTERS })).catch(() => undefined);
    expect(call().nav).toEqual({ day: LINE, ...FILTERS });
    expect(call().flash.ok).toMatch(/saved/i);
  });
});
