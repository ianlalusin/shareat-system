/** T-526 R3 - the drain's network function: one POST of the waiting events, mapped onto T-530a's SendOutcome. T-563: the batch names the pairing it was made under. */
import type { PosEvent, SendOutcome } from '@/lib/pos-device';

export function makePosSend(doFetch: typeof fetch): (events: PosEvent[]) => Promise<SendOutcome> {
  return async (events) => {
    // The drain hands over events of one pairing; one with none (made before T-563) is never posted.
    const pairingId = events[0]?.pairingId;
    if (!pairingId) return { kind: 'http', status: 400 };
    try {
      const res = await doFetch('/api/pos/events', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pairingId, events }),
      });
      if (res.status !== 200) {
        const code = ((await res.json().catch(() => null)) as { code?: unknown } | null)?.code;
        return typeof code === 'string' ? { kind: 'http', status: res.status, code } : { kind: 'http', status: res.status };
      }
      const body = (await res.json()) as { stateVersion: number; results: Extract<SendOutcome, { kind: 'ok' }>['results'] };
      return { kind: 'ok', stateVersion: body.stateVersion, results: body.results };
    } catch {
      return { kind: 'network' };
    }
  };
}
