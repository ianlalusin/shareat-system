/**
 * T-393 R7, I8 — a dead-man's switch ping (healthchecks.io shape): `/start`, the bare URL on success, `/fail` on failure.
 * A heartbeat that cannot be delivered is logged (redacted) and NEVER changes the exit code.
 */
import { redact } from './pg-tools';

export interface Heartbeat {
  start(): Promise<void>;
  ok(): Promise<void>;
  fail(reason: string): Promise<void>;
}

const TIMEOUT_MS = 10_000;

export function httpHeartbeat(url: string | undefined): Heartbeat {
  if (!url || url.trim() === '') {
    let said = false;
    const note = async () => {
      if (!said) {
        said = true;
        console.log('[heartbeat] no heartbeat configured');
      }
    };
    return { start: note, ok: note, fail: note };
  }
  const base = url.trim().replace(/\/+$/, '');
  async function ping(suffix: string, body?: string): Promise<void> {
    try {
      const res = await fetch(`${base}${suffix}`, {
        method: body === undefined ? 'GET' : 'POST',
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) console.log(redact(`[heartbeat] ${suffix || '/'} answered HTTP ${res.status}`));
    } catch (e) {
      console.log(redact(`[heartbeat] ${suffix || '/'} not delivered: ${e instanceof Error ? e.message : String(e)}`));
    }
  }
  return {
    start: () => ping('/start'),
    ok: () => ping(''),
    fail: (reason) => ping('/fail', redact(reason).replace(/\s+/g, ' ').slice(0, 500)),
  };
}
