import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T-511 S7b (BUILDER, 11 Nov 2026) - the REAL approve and book-charge server actions, run with no database. Mocked: the session, the transaction wrappers, the flash and the
 * two domain functions (their behaviour is in the integration tests). Not mocked: the action bodies, `errorMessage`, the refusal classes.
 *
 *  A1  approveDayAction(formData): fields `lineId`, optional `reason`, optional `confirmedDifference`. The domain gets the SESSION actor; success ends in ONE redirect with a plain
 *      `ok` and the stamp POSTED.
 *  A2  A refusal shows its OWN sentence in `error`. NEEDS_REASON is not an error: the redirect carries the nav key `ack` = `{short|over}-{difference}` and NO error and NO ok.
 *  A3  bookChargeAction(formData): field `otherLineId`; calls `bookPeriodCharge`; success `Charge booked.` with the stamp POSTED; a refusal shows its own sentence.
 */
const redirectWithFlash = vi.fn(async (..._a: unknown[]): Promise<never> => {
  throw new Error('redirected');
});
const approveDay = vi.fn();
const bookPeriodCharge = vi.fn();

vi.mock('@/lib/flash', () => ({ redirectWithFlash: (...a: unknown[]) => redirectWithFlash(...a) }));
vi.mock('../src/lib/session', () => ({
  requireActor: vi.fn(async () => ({ orgId: 'org-1', personId: 'p1' })),
  requireSession: vi.fn(async () => ({ actor: { orgId: 'org-1', personId: 'p1' } })),
}));
vi.mock('@shareat/db', async (orig) => ({
  ...(await orig<typeof import('@shareat/db')>()),
  withOrgPrincipal: vi.fn(async (_o: string, fn: (tx: unknown) => Promise<unknown>) => fn({})),
}));
vi.mock('../src/app/channel-settlements/lib', async (orig) => ({
  ...(await orig<object>()),
  withOrgPrincipal: vi.fn(async (_o: string, fn: (tx: unknown) => Promise<unknown>) => fn({})),
}));
vi.mock('@shareat/domain', async (orig) => ({
  ...(await orig<typeof import('@shareat/domain')>()),
  approveDay: (...a: unknown[]) => approveDay(...a),
  bookPeriodCharge: (...a: unknown[]) => bookPeriodCharge(...a),
}));

const LINE = '00000000-0000-4000-8000-0000000000a1';
const CHARGE = '00000000-0000-4000-8000-0000000000c1';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const form = (fields: Record<string, string>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};
const call = () => redirectWithFlash.mock.calls[0] as [string, Record<string, string>, { ok?: string; error?: string; stamp?: string } | undefined];

beforeAll(async () => {
  await import('../src/app/channel-settlements/review/actions');
}, 60_000);
beforeEach(() => {
  redirectWithFlash.mockClear();
  approveDay.mockReset();
  bookPeriodCharge.mockReset();
});

describe('approveDayAction', () => {
  it('success: the session actor, the line, no reason and no confirmed figure unless typed; the flash is plain words with the POSTED stamp; a person named in the form is ignored [kills: actor from the form; a code as the banner; a missing stamp]', async () => {
    approveDay.mockResolvedValueOnce({ settlementId: 's' });
    const { approveDayAction } = await import('../src/app/channel-settlements/review/actions');
    await approveDayAction(form({ lineId: LINE, personId: 'attacker', actorId: 'attacker', store: '00000000-0000-4000-8000-0000000000b2', platform: 'grab' })).catch(() => undefined);
    expect(approveDay).toHaveBeenCalledTimes(1);
    const [, actor, input] = approveDay.mock.calls[0] as [unknown, unknown, Record<string, unknown>];
    expect(actor).toEqual({ orgId: 'org-1', personId: 'p1' });
    expect(input).toEqual({ lineId: LINE });
    const [path, nav, flash] = call();
    expect(path).toBe('/channel-settlements/review');
    expect(nav).toEqual({ day: LINE, store: '00000000-0000-4000-8000-0000000000b2', platform: 'grab' });
    expect(flash?.error).toBeUndefined();
    expect(flash?.stamp).toBe('POSTED');
    expect(flash?.ok).toMatch(/\s/);
    expect(flash?.ok).toMatch(/booked/i);
    expect(flash?.ok).not.toMatch(UUID);
  });

  it('the typed reason and the figure the person confirmed reach the domain as typed [kills: the reason dropped; the confirmed figure invented by the action]', async () => {
    approveDay.mockResolvedValueOnce({ settlementId: 's' });
    const { approveDayAction } = await import('../src/app/channel-settlements/review/actions');
    await approveDayAction(form({ lineId: LINE, reason: 'The platform statement is right', confirmedDifference: '3000.00' })).catch(() => undefined);
    expect(approveDay.mock.calls[0]![2]).toEqual({ lineId: LINE, differenceReason: 'The platform statement is right', confirmedDifference: '3000.00' });
  });

  it('a refusal shows its OWN sentence, exactly, and no stamp [kills: the database sentence; a stamp on a failure]', async () => {
    const { refuse } = await import('@shareat/domain');
    approveDay.mockRejectedValueOnce(refuse('approveDay: blocked', 'A charge on the same statement has not been booked yet. Book it first, because the platform took it out of this payout.'));
    const { approveDayAction } = await import('../src/app/channel-settlements/review/actions');
    await approveDayAction(form({ lineId: LINE })).catch(() => undefined);
    expect(redirectWithFlash).toHaveBeenCalledTimes(1);
    expect(call()[2]).toEqual({ error: 'A charge on the same statement has not been booked yet. Book it first, because the platform took it out of this payout.' });
  });

  it('NEEDS_REASON is a question, not an error: the redirect carries ack=short-3000.00 (or over-) and NO banner at all [kills: an error banner on the question; the figure lost; the sign flipped]', async () => {
    const { SettlementIntakeRefusal } = await import('@shareat/domain');
    for (const [sign, difference] of [['short', '3000.00'], ['over', '1250.50']] as const) {
      redirectWithFlash.mockClear();
      approveDay.mockRejectedValueOnce(Object.assign(new SettlementIntakeRefusal('NEEDS_REASON', 'x', 'The payout is more than this day still owed. Type a reason.'), { difference, sign }));
      const { approveDayAction } = await import('../src/app/channel-settlements/review/actions');
      await approveDayAction(form({ lineId: LINE })).catch(() => undefined);
      expect(redirectWithFlash).toHaveBeenCalledTimes(1);
      const [path, nav, flash] = call();
      expect(path).toBe('/channel-settlements/review');
      expect(nav).toEqual({ day: LINE, ack: `${sign}-${difference}` });
      expect(flash).toBeUndefined();
    }
  });

  it('any OTHER refusal code is shown as its sentence and carries no ack [kills: every refusal turned into a reason question]', async () => {
    const { SettlementIntakeRefusal } = await import('@shareat/domain');
    approveDay.mockRejectedValueOnce(new SettlementIntakeRefusal('DAY_BLOCKED', 'x', 'Waiting for the sales day to be verified'));
    const { approveDayAction } = await import('../src/app/channel-settlements/review/actions');
    await approveDayAction(form({ lineId: LINE })).catch(() => undefined);
    const [, nav, flash] = call();
    expect(nav.ack).toBeUndefined();
    expect(flash?.error).toBe('Waiting for the sales day to be verified');
  });

  it('a permission refusal shows its own sentence [kills: a permission error shown as a crash]', async () => {
    const { AuthorizationError } = await import('@shareat/auth');
    approveDay.mockRejectedValueOnce(new AuthorizationError("approveDay: 'record_ar_collection' is not held", 'record_ar_collection', 'You do not have permission to approve settlement days for this store.'));
    const { approveDayAction } = await import('../src/app/channel-settlements/review/actions');
    await approveDayAction(form({ lineId: LINE })).catch(() => undefined);
    expect(call()[2]?.error).toBe('You do not have permission to approve settlement days for this store.');
  });
});

describe('bookChargeAction', () => {
  it('success: the session actor and the charge; `Charge booked.` with the POSTED stamp; back to the day when one was open [kills: actor from the form; a missing stamp]', async () => {
    bookPeriodCharge.mockResolvedValueOnce({ posted: true });
    const { bookChargeAction } = await import('../src/app/channel-settlements/review/actions');
    await bookChargeAction(form({ otherLineId: CHARGE, lineId: LINE, personId: 'attacker' })).catch(() => undefined);
    const [, actor, input] = bookPeriodCharge.mock.calls[0] as [unknown, unknown, unknown];
    expect(actor).toEqual({ orgId: 'org-1', personId: 'p1' });
    expect(input).toEqual({ otherLineId: CHARGE });
    const [, nav, flash] = call();
    expect(nav).toEqual({ day: LINE });
    expect(flash).toEqual({ ok: 'Charge booked.', stamp: 'POSTED' });
  });

  it('from the section under the list there is no day to return to: no `day` in the address [kills: a junk day key]', async () => {
    bookPeriodCharge.mockResolvedValueOnce({ posted: true });
    const { bookChargeAction } = await import('../src/app/channel-settlements/review/actions');
    await bookChargeAction(form({ otherLineId: CHARGE, needs: '1' })).catch(() => undefined);
    expect(call()[1]).toEqual({ needs: '1' });
  });

  it('a refusal shows its own sentence [kills: the database sentence]', async () => {
    const { refuse } = await import('@shareat/domain');
    bookPeriodCharge.mockRejectedValueOnce(refuse('x', 'This file was replaced by a newer upload; book the charge from the newer file.'));
    const { bookChargeAction } = await import('../src/app/channel-settlements/review/actions');
    await bookChargeAction(form({ otherLineId: CHARGE })).catch(() => undefined);
    expect(call()[2]).toEqual({ error: 'This file was replaced by a newer upload; book the charge from the newer file.' });
  });

  it('a charge that was already booked says so in plain words, as an ok with NO stamp and no error [kills: "Charge booked." and a POSTED stamp on a press that booked nothing]', async () => {
    bookPeriodCharge.mockResolvedValueOnce({ posted: false });
    const { bookChargeAction } = await import('../src/app/channel-settlements/review/actions');
    await bookChargeAction(form({ otherLineId: CHARGE, lineId: LINE })).catch(() => undefined);
    expect(redirectWithFlash).toHaveBeenCalledTimes(1);
    expect(call()[2]).toEqual({ ok: 'This charge was already booked.' });
  });
});

describe('an id that is not an id never reaches the domain', () => {
  it('approveDayAction and bookChargeAction answer "That item could not be found." with no domain call [kills: a junk id sent to the books; a database error shown]', async () => {
    const { approveDayAction, bookChargeAction } = await import('../src/app/channel-settlements/review/actions');
    for (const bad of ['', 'not an id', '123', `${LINE}x`]) {
      redirectWithFlash.mockClear();
      await approveDayAction(form({ lineId: bad })).catch(() => undefined);
      expect(redirectWithFlash, `approve ${JSON.stringify(bad)}`).toHaveBeenCalledTimes(1);
      expect(call()[2], `approve ${JSON.stringify(bad)}`).toEqual({ error: 'That item could not be found.' });
      expect(call()[1].day, 'no junk day key').toBeUndefined();
      redirectWithFlash.mockClear();
      await bookChargeAction(form({ otherLineId: bad, lineId: LINE })).catch(() => undefined);
      expect(call()[2], `book ${JSON.stringify(bad)}`).toEqual({ error: 'That item could not be found.' });
    }
    expect(approveDay).not.toHaveBeenCalled();
    expect(bookPeriodCharge).not.toHaveBeenCalled();
  });

  it('a refused reason question keeps the day, the filters and the ack, with no banner and the reason text is not sent back [kills: the reason form vanishing after a second refusal; a refilled box]', async () => {
    const { SettlementIntakeRefusal } = await import('@shareat/domain');
    approveDay.mockRejectedValueOnce(Object.assign(new SettlementIntakeRefusal('NEEDS_REASON', 'x', 'Type a reason.'), { difference: '3000.00', sign: 'over' }));
    const { approveDayAction } = await import('../src/app/channel-settlements/review/actions');
    await approveDayAction(form({ lineId: LINE, reason: 'half a reason', confirmedDifference: '1.00', platform: 'foodpanda', needs: '1' })).catch(() => undefined);
    const [, nav, flash] = call();
    expect(nav).toEqual({ day: LINE, platform: 'foodpanda', needs: '1', ack: 'over-3000.00' });
    expect(flash).toBeUndefined();
    expect(JSON.stringify(redirectWithFlash.mock.calls[0])).not.toContain('half a reason');
  });
});
