import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T-511 S5b (TESTER, 2026-11-05) - the REAL review server actions, run with no database: reject and reopen show a plain sentence on success, and a refused action shows
 * its OWN sentence (the refusal brand of PR #147), never "The database refused that change". docs/tasks/511-settlement-upload-s5-spec.md "S5b" item 5 and "Tests".
 * Mocked: the session, the transaction wrappers (hand the callback an empty tx), the flash, and the domain's own review functions (their behaviour is in the
 * integration tests). Not mocked: the action bodies and `errorMessage`.
 *
 * RED today, for one reason: `apps/erp/src/app/channel-settlements/review/actions.ts` does not exist (the import below cannot resolve).
 *
 * CONTRACT (tester's choices; the builder must meet these or ask BOSS to change the tests):
 *  A1  `apps/erp/src/app/channel-settlements/review/actions.ts` ('use server') exports `rejectDayAction(formData)` (fields `lineId`, `reason`), `reopenDayAction(formData)`
 *      (field `lineId`) and `overrideLoanAllocationAction(formData)` (field `lineId` plus the allocation fields the form posts).
 *  A2  Each action reads the actor from the session ONLY (a form field naming a person is ignored), calls the domain function (`rejectDay`, `reopenDay`, `overrideLoanAllocation`
 *      from `@shareat/domain`) inside `withOrgPrincipal`, and ends in ONE `redirectWithFlash(<path>, <params>, <flash>)`: `{ ok: <sentence> }` on success, `{ error: errorMessage(err) }` in
 *      the catch (the success redirect sits AFTER the try: redirect-in-catch sweep).
 *  A3  The success sentence is plain words: it contains a space, no UUID, and is not a bare code. Reject: says the day was rejected. Reopen: says the day is waiting for a decision again.
 *  A4  A `RefusalError` from the domain reaches the flash as exactly its `userMessage`; an `AuthorizationError` as its `userMessage`.
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

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const LINE = '00000000-0000-4000-8000-0000000000a1';

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}
/** the flash object of the one redirect the action made */
const flashOf = (): { ok?: string; error?: string } => (redirectWithFlash.mock.calls[0]?.[2] ?? {}) as { ok?: string; error?: string };

beforeAll(async () => {
  await import('../src/app/channel-settlements/review/actions');
}, 60_000);
beforeEach(() => {
  redirectWithFlash.mockClear();
  rejectDay.mockReset();
  reopenDay.mockReset();
  overrideLoanAllocation.mockReset();
});

describe('rejectDayAction', () => {
  it('success: the domain is called with the session actor and the typed reason (a person named in the form is ignored), and the flash says in plain words that the day was rejected [kills: actor from the form; a code as the banner]', async () => {
    rejectDay.mockResolvedValueOnce({ lineId: LINE });
    const { rejectDayAction } = await import('../src/app/channel-settlements/review/actions');
    await rejectDayAction(form({ lineId: LINE, reason: 'Payout does not match the statement', personId: 'attacker', actorId: 'attacker' })).catch(() => undefined);
    expect(rejectDay).toHaveBeenCalledTimes(1);
    const [, actor, input] = rejectDay.mock.calls[0] as [unknown, { personId: string; orgId: string }, { lineId: string; reason: string }];
    expect(actor).toEqual({ orgId: 'org-1', personId: 'p1' });
    expect(input).toEqual({ lineId: LINE, reason: 'Payout does not match the statement' });
    expect(redirectWithFlash).toHaveBeenCalledTimes(1);
    const flash = flashOf();
    expect(flash.error).toBeUndefined();
    expect(flash.ok).toMatch(/\s/);
    expect(flash.ok).toMatch(/reject/i);
    expect(flash.ok).not.toMatch(UUID);
  });

  it('a refusal shows its OWN sentence, exactly, and not the database sentence [kills: the generic "The database refused that change"]', async () => {
    const { refuse } = await import('@shareat/domain');
    rejectDay.mockRejectedValueOnce(refuse('rejectDay: already decided', 'This day was already decided by someone else. Reload the page to see what they decided.'));
    const { rejectDayAction } = await import('../src/app/channel-settlements/review/actions');
    await rejectDayAction(form({ lineId: LINE, reason: 'No' })).catch(() => undefined);
    expect(redirectWithFlash).toHaveBeenCalledTimes(1);
    expect(flashOf().ok).toBeUndefined();
    expect(flashOf().error).toBe('This day was already decided by someone else. Reload the page to see what they decided.');
    expect(flashOf().error).not.toMatch(/database refused/i);
  });

  it('a missing reason is the domain\'s refusal, shown as its own sentence: the action does not judge the box itself [kills: validation duplicated in the action]', async () => {
    const { refuse } = await import('@shareat/domain');
    rejectDay.mockRejectedValueOnce(refuse('rejectDay: reason', 'A rejection needs a reason.'));
    const { rejectDayAction } = await import('../src/app/channel-settlements/review/actions');
    await rejectDayAction(form({ lineId: LINE, reason: '' })).catch(() => undefined);
    expect(rejectDay).toHaveBeenCalledTimes(1);
    expect(rejectDay.mock.calls[0]![2]).toEqual({ lineId: LINE, reason: '' });
    expect(flashOf().error).toBe('A rejection needs a reason.');
  });

  it('a permission refusal shows its own sentence [kills: a permission error shown as a crash or a database message]', async () => {
    const { AuthorizationError } = await import('@shareat/auth');
    rejectDay.mockRejectedValueOnce(new AuthorizationError("rejectDay: 'record_ar_collection' is not held", 'record_ar_collection', 'You do not have permission to decide settlement days at this store.'));
    const { rejectDayAction } = await import('../src/app/channel-settlements/review/actions');
    await rejectDayAction(form({ lineId: LINE, reason: 'No' })).catch(() => undefined);
    expect(flashOf().error).toBe('You do not have permission to decide settlement days at this store.');
  });
});

describe('reopenDayAction', () => {
  it('success: the domain is called with the session actor and the line, the flash says in plain words that the day waits for a decision again [kills: actor from the form]', async () => {
    reopenDay.mockResolvedValueOnce({ lineId: LINE });
    const { reopenDayAction } = await import('../src/app/channel-settlements/review/actions');
    await reopenDayAction(form({ lineId: LINE, personId: 'attacker' })).catch(() => undefined);
    const [, actor, input] = reopenDay.mock.calls[0] as [unknown, { personId: string }, { lineId: string }];
    expect(actor.personId).toBe('p1');
    expect(input).toEqual({ lineId: LINE });
    expect(flashOf().ok).toMatch(/\s/);
    expect(flashOf().ok).toMatch(/waiting|pending|reopen|decision/i);
    expect(flashOf().ok).not.toMatch(UUID);
  });

  it('an admin-only refusal shows its own sentence [kills: the generic database sentence]', async () => {
    const { AuthorizationError } = await import('@shareat/auth');
    reopenDay.mockRejectedValueOnce(new AuthorizationError("reopenDay: not held", 'override_period_lock', 'Only an administrator can reopen a rejected day.'));
    const { reopenDayAction } = await import('../src/app/channel-settlements/review/actions');
    await reopenDayAction(form({ lineId: LINE })).catch(() => undefined);
    expect(flashOf().error).toBe('Only an administrator can reopen a rejected day.');
  });
});

describe('overrideLoanAllocationAction', () => {
  it('a refusal from the domain (the amounts do not add up) is shown as its own sentence, and nothing is sent twice [kills: a refusal swallowed]', async () => {
    const { refuse } = await import('@shareat/domain');
    overrideLoanAllocation.mockRejectedValueOnce(refuse('overrideLoanAllocation: sum', "The amounts must add up to the day's loan deductions."));
    const { overrideLoanAllocationAction } = await import('../src/app/channel-settlements/review/actions');
    await overrideLoanAllocationAction(form({ lineId: LINE })).catch(() => undefined);
    expect(overrideLoanAllocation).toHaveBeenCalledTimes(1);
    expect(redirectWithFlash).toHaveBeenCalledTimes(1);
    expect(flashOf().error).toBe("The amounts must add up to the day's loan deductions.");
  });
});
