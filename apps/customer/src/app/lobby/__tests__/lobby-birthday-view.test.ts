import { describe, expect, it } from 'vitest';
import { BIRTHDAY_NAME_MAX, birthdayScreenView, validateBirthdayName } from '@/app/lobby/lobby-view';
import { createFixtureLobbyData } from '@/data/fixture-lobby-data';
import type { LobbyBirthday } from '@/data/http-lobby-data';

/**
 * T-455 S6a: the pure rules behind /lobby/birthday (docs/tasks/455-customer-lobby.md 3.1: name optional, then waiting / "Accepted for 7:30 PM" /
 * "Sorry, not tonight: (reason)"). Each test names the mutant it kills.
 */
const b = (over: Partial<LobbyBirthday>): LobbyBirthday => ({ status: 'requested', celebrantName: null, scheduledAt: null, declineReason: null, ...over });

describe('validateBirthdayName', () => {
  it('blank is no name, a name is trimmed, 40 is the limit [kills: name required, untrimmed, off by one]', () => {
    expect(validateBirthdayName('')).toEqual({ ok: true, value: null });
    expect(validateBirthdayName('   ')).toEqual({ ok: true, value: null });
    expect(validateBirthdayName('  Ben ')).toEqual({ ok: true, value: 'Ben' });
    expect(validateBirthdayName('x'.repeat(BIRTHDAY_NAME_MAX)).ok).toBe(true);
    expect(validateBirthdayName('x'.repeat(BIRTHDAY_NAME_MAX + 1)).ok).toBe(false);
  });
});

describe('birthdayScreenView', () => {
  it('nothing asked, or a cancelled request, shows the form again [kills: a cancelled request stuck on the status]', () => {
    expect(birthdayScreenView(null).kind).toBe('form');
    expect(birthdayScreenView(b({ status: 'cancelled' })).kind).toBe('form');
  });

  it('requested waits for the cashier and can be cancelled', () => {
    expect(birthdayScreenView(b({}))).toMatchObject({ kind: 'waiting', message: 'Waiting for the cashier to answer.', canCancel: true, final: false });
  });

  it('accepted shows the time and can still be cancelled [kills: time missing, cancel hidden]', () => {
    const v = birthdayScreenView(b({ status: 'accepted', scheduledAt: new Date(2026, 10, 1, 19, 30).toISOString() }));
    expect(v.kind).toBe('accepted');
    expect(v.message).toMatch(/^Accepted for 7:30\sPM\.$/);
    expect(v.canCancel).toBe(true);
  });

  it('declined shows the reason in one sentence with one full stop, and stops the refresh [kills: reason dropped, double full stop, cancel offered after a decline]', () => {
    const v = birthdayScreenView(b({ status: 'declined', declineReason: 'Not tonight, the shop is full.' }));
    expect(v).toMatchObject({ kind: 'declined', message: 'Sorry, not tonight: Not tonight, the shop is full.', canCancel: false, final: true });
  });

  it('played and expired are final and cannot be cancelled [kills: cancel after play offered]', () => {
    for (const status of ['played', 'expired'] as const) {
      expect(birthdayScreenView(b({ status })), status).toMatchObject({ canCancel: false, final: true });
    }
  });
});

describe('the fixture follows the server rules', () => {
  it('one request per place; a cancelled one frees the slot; a cashier answer shows [kills: a second request allowed, answer not visible]', async () => {
    const d = createFixtureLobbyData({ now: () => 1_000_000 });
    expect((await d.birthday('LIPA')).ok).toBe(false);
    await d.checkIn({ storeCode: 'LIPA', displayName: 'Ana', partySize: 2, clientRequestId: 'r1' });
    expect(await d.birthday('LIPA')).toEqual({ ok: true, value: null });
    expect((await d.requestBirthday('LIPA', ' Ben ')).ok).toBe(true);
    const again = await d.requestBirthday('LIPA', null);
    expect(again).toMatchObject({ ok: false, status: 409 });
    d.demo.declineBirthday('Not tonight');
    expect(await d.birthday('LIPA')).toMatchObject({ ok: true, value: { status: 'declined', declineReason: 'Not tonight', celebrantName: 'Ben' } });
    expect(await d.cancelBirthday('LIPA')).toMatchObject({ ok: false, status: 409 });
  });
});
