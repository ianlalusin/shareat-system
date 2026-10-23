import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T-464 - the ERP half of the POS tablet sign-in: docs/tasks/464-pos-tablet-sign-in.md s4 and Verification "The page renders correctly".
 *
 *   - /sign-in with NO cookie: today's page (terminal form + email form), no Employee ID box;
 *   - /sign-in with a LIVE pairing: ONLY Employee ID + PIN and the small "Manager sign-in" link; the email form is behind the link;
 *     nothing the browser could use to name an org or a store is in the markup;
 *   - /sign-in with a DEAD cookie (revoked / stale / forged): today's page again, and the cookie-forgetting control is mounted;
 *   - signInWithTabletPinAction reads ONLY staffCode and pin (and next) from the form; the pairing comes from the cookie, never the form;
 *     a success sets the session cookie and refreshes the pairing cookie; a dead pairing clears the cookie and says the flat sentence.
 *
 * The auth package and the heavy form components are mocked for the same reason sign-in-config-notice.test.ts gives (the import tree is
 * ~4.6 s cold). The real behaviour against Postgres is t464-tablet-sign-in.test.ts in packages/auth.
 */
const { H, calls } = vi.hoisted(() => ({
  H: {
    token: null as string | null,
    pairing: null as { pairingId: string; orgId: string; storeId: string; label: string } | null,
  },
  calls: {
    signInOnPairedTablet: vi.fn(),
    setSessionCookie: vi.fn(),
    setPosTabletCookie: vi.fn(),
    clearPosTabletCookie: vi.fn(),
  },
}));

// Partial mock: the real error classes and sentences (the sign-in message policy checks `instanceof AuthenticationError`), a faked pairing lookup and sign-in.
vi.mock('@shareat/auth', async (orig) => ({
  ...(await orig<typeof import('@shareat/auth')>()),
  resolvePosTablet: vi.fn(async () => H.pairing),
  signInOnPairedTablet: (...a: unknown[]) => calls.signInOnPairedTablet(...a),
}));
vi.mock('../src/lib/session', () => ({
  currentSession: vi.fn(async () => null),
  readPosTabletToken: vi.fn(async () => H.token),
  setSessionCookie: (...a: unknown[]) => calls.setSessionCookie(...a),
  setPosTabletCookie: (...a: unknown[]) => calls.setPosTabletCookie(...a),
  clearPosTabletCookie: (...a: unknown[]) => calls.clearPosTabletCookie(...a),
  clearSessionCookie: vi.fn(),
  readSessionToken: vi.fn(),
  setSetupIdentityCookie: vi.fn(),
}));
vi.mock('../src/lib/firebase-auth-admin', () => ({ verifyFirebaseIdToken: vi.fn() }));
vi.mock('../src/app/sign-in/lib', () => ({
  NOT_LINKED_MESSAGE: 'x',
  resolveVerifiedSignIn: vi.fn(),
  safeNext: (raw: string) => (/^\/(?![/\\])/.test(raw) ? raw : '/sales-days'),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error(`redirect:${to}`), { to });
  },
}));
vi.mock('../src/app/sign-in/TerminalSignInForm', () => ({ TerminalSignInForm: () => createElement('div', { 'data-terminal-form': '' }) }));
vi.mock('../src/app/sign-in/EmailSignInForm', () => ({ EmailSignInForm: () => createElement('div', { 'data-email-form': '' }) }));
vi.mock('../src/app/sign-in/ForgetDeadPairing', () => ({ ForgetDeadPairing: () => createElement('div', { 'data-forget-dead': '' }) }));
vi.mock('@/components/ui', async (orig) => ({ ...(await orig<typeof import('@/components/ui')>()), FlashBanner: () => null }));

import { AuthenticationError, TABLET_NOT_PAIRED } from '@shareat/auth';
import SignInPage from '../src/app/sign-in/page';
import { signInWithTabletPinAction } from '../src/app/sign-in/actions';

async function html(sp: Record<string, string> = {}): Promise<string> {
  const el = await SignInPage({ searchParams: Promise.resolve(sp) });
  return renderToStaticMarkup(el);
}

beforeEach(() => {
  H.token = null;
  H.pairing = null;
  Object.values(calls).forEach((m) => m.mockReset());
});

describe('/sign-in', () => {
  it('no cookie: today\'s page - the terminal form and the email form, and no Employee ID box', async () => {
    const out = await html();
    expect(out).toContain('data-terminal-form');
    expect(out).toContain('data-email-form');
    expect(out).not.toContain('name="staffCode"');
    expect(out, 'nothing to forget').not.toContain('data-forget-dead');
  });

  it('a LIVE pairing: only Employee ID + PIN and the small "Manager sign-in" link; the other forms are not shown; no tenancy id reaches the markup', async () => {
    H.token = 'A'.repeat(43);
    H.pairing = { pairingId: 'pairing-secret-1', orgId: 'org-secret-1', storeId: 'store-secret-1', label: 'Lipa counter' };
    const out = await html();
    expect(out).toContain('name="staffCode"');
    expect(out).toContain('name="pin"');
    expect(out).toContain('Employee ID');
    // the form refuses letters and a 4th digit itself (the server refuses them again): digits only, at most 3, a numeric keypad
    expect(out).toContain('pattern="[0-9]{1,3}"');
    expect(out).toContain('maxLength="3"');
    expect(out).toContain('inputMode="numeric"');
    expect(out).toContain('Lipa counter');
    expect(out).toContain('Manager sign-in');
    expect(out, 'mutant: the terminal form still shown').not.toContain('data-terminal-form');
    expect(out, 'the email form sits BEHIND the link').not.toContain('data-email-form');
    expect(out).not.toContain('data-forget-dead');
    for (const secret of ['org-secret-1', 'store-secret-1', 'pairing-secret-1', H.token]) expect(out, `T-304 invariant 9: ${secret}`).not.toContain(secret);
  });

  it('a DEAD cookie (revoked, 30 days unused or forged): today\'s page again, and the cookie is forgotten', async () => {
    H.token = 'B'.repeat(43);
    H.pairing = null;
    const out = await html();
    expect(out).toContain('data-terminal-form');
    expect(out).toContain('data-email-form');
    expect(out).not.toContain('name="staffCode"');
    expect(out, 'mutant: a dead cookie is left in the browser').toContain('data-forget-dead');
  });
});

describe('signInWithTabletPinAction', () => {
  const form = (o: Record<string, string>) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(o)) fd.set(k, v);
    return fd;
  };
  const redirectOf = async (fd: FormData): Promise<string> => {
    try {
      await signInWithTabletPinAction(fd);
    } catch (e) {
      return (e as { to: string }).to;
    }
    throw new Error('expected a redirect');
  };

  it('reads ONLY staffCode and pin from the form; the pairing is the cookie\'s; a success sets the session, refreshes the pairing cookie, and goes to next', async () => {
    H.token = 'C'.repeat(43);
    calls.signInOnPairedTablet.mockResolvedValue({ token: 'sess-token', expiresAt: new Date('2099-01-01'), sessionId: 's', personId: 'p', pairing: {} });
    const to = await redirectOf(
      form({ staffCode: '7', pin: '123456', next: '/till', cookieToken: 'FORGED', orgId: 'o', storeId: 's', pairingId: 'x', personId: 'y' }),
    );
    expect(to).toBe('/till');
    expect(calls.signInOnPairedTablet).toHaveBeenCalledTimes(1);
    expect(calls.signInOnPairedTablet.mock.calls[0]![1], 'mutant: a form field reaches the sign-in').toEqual({ cookieToken: 'C'.repeat(43), staffCode: '7', pin: '123456' });
    expect(calls.setSessionCookie).toHaveBeenCalledWith('sess-token', new Date('2099-01-01'));
    expect(calls.setPosTabletCookie).toHaveBeenCalledWith('C'.repeat(43));
    expect(calls.clearPosTabletCookie).not.toHaveBeenCalled();
  });

  it('no live pairing: the flat sentence on /sign-in, no session cookie, and the dead pairing cookie is cleared', async () => {
    H.token = null;
    calls.signInOnPairedTablet.mockRejectedValue(new AuthenticationError(TABLET_NOT_PAIRED));
    const to = await redirectOf(form({ staffCode: '7', pin: '123456' }));
    expect(to).toMatch(/^\/sign-in\?/);
    expect(decodeURIComponent(to)).toContain(TABLET_NOT_PAIRED);
    expect(calls.setSessionCookie).not.toHaveBeenCalled();
    expect(calls.clearPosTabletCookie, 'mutant: a dead cookie survives a refused submit').toHaveBeenCalledTimes(1);
  });

  it('a wrong Employee ID / PIN keeps the pairing cookie and says the flat sentence', async () => {
    H.token = 'D'.repeat(43);
    calls.signInOnPairedTablet.mockRejectedValue(new AuthenticationError('Sign-in failed: that Employee ID and PIN do not match.'));
    const to = await redirectOf(form({ staffCode: '7', pin: '000000', next: '/x' }));
    expect(decodeURIComponent(to)).toContain('Employee ID and PIN do not match');
    expect(calls.clearPosTabletCookie).not.toHaveBeenCalled();
  });
});
