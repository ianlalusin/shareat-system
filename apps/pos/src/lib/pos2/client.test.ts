import { afterEach, describe, expect, it, vi } from 'vitest';
const probe = vi.hoisted(() => vi.fn());
vi.mock('@/lib/firebase/client', () => ({ auth: { currentUser: { getIdToken: async () => 'synthetic-token' } } }));
vi.mock('@/lib/offline/browserDevice', () => ({ getBrowserDeviceId: () => 'synthetic-device' }));
vi.mock('@/hooks/useConnectivity', () => ({ getConnectivityStore: () => ({ reportNetworkError: probe }) }));
import { postPos2 } from './client';
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('POS mutation response uncertainty', () => {
  it('a lost response never claims that nothing changed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('synthetic response lost')));
    await expect(postPos2('conversions', { requestId: 'same-request' })).rejects.toMatchObject({
      status: 0,
      message: "Cannot confirm the POS server's response. Check the internet connection, then retry the same request or check the record before entering it again.",
    });
    expect(probe).toHaveBeenCalledOnce();
  });
  it('an unreadable successful response never claims that nothing changed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('unreadable', { status: 200 })));
    await expect(postPos2('conversions', {})).rejects.toMatchObject({
      message: "Could not confirm the result. Retry the same request or check the record before entering it again.",
    });
  });
  it('a definite business refusal keeps the server sentence', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, error: 'Choose the e-wallet.' }), { status: 400 })));
    await expect(postPos2('conversions', {})).rejects.toMatchObject({ status: 400, message: 'Choose the e-wallet.' });
  });
});
