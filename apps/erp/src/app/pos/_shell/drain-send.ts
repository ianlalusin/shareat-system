/** T-526 R3 - the drain's network function: one POST of the waiting events, mapped onto T-530a's SendOutcome. */
import type { PosEvent, SendOutcome } from '@/lib/pos-device';

export function makePosSend(doFetch: typeof fetch): (events: PosEvent[]) => Promise<SendOutcome> {
  return async (events) => {
    try {
      const res = await doFetch('/api/pos/events', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ events }),
      });
      if (res.status !== 200) return { kind: 'http', status: res.status };
      const body = (await res.json()) as { stateVersion: number; results: Extract<SendOutcome, { kind: 'ok' }>['results'] };
      return { kind: 'ok', stateVersion: body.stateVersion, results: body.results };
    } catch {
      return { kind: 'network' };
    }
  };
}
