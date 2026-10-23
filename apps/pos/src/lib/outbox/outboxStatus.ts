/**
 * T-425 S5 - what the rest of the app needs to know about the ledger, kept in ONE small store (no React): how many sales are unsent and
 * worth how much (the 50,000 peso banner, the Settings warning, the update gate, the offline-period end rule) and how many rows a manager must
 * look at. It is read FROM the ledger; nothing here is a second source of truth. Whoever changes the ledger calls `notifyOutboxChanged()`.
 */
import { listEvents } from '@/lib/outbox/ledger';
import { listFailedEffectItems } from '@/lib/outbox/effects-store';

export interface OutboxStatus {
  /** false until the first read finished (a banner must not flash on an unread ledger). */
  loaded: boolean;
  unsentCount: number;
  unsentTotalCentavos: number;
  quarantined: number;
  rejected: number;
  stuck: number;
  failedEffects: number;
}

const INITIAL: OutboxStatus = { loaded: false, unsentCount: 0, unsentTotalCentavos: 0, quarantined: 0, rejected: 0, stuck: 0, failedEffects: 0 };

let state: OutboxStatus = INITIAL;
const listeners: (() => void)[] = [];
let reading = false;
let again = false;

export async function readOutboxStatus(): Promise<OutboxStatus> {
  const events = await listEvents();
  const failed = await listFailedEffectItems();
  const unsent = events.filter((e) => e.status === 'unsent' || e.status === 'stuck');
  return {
    loaded: true,
    unsentCount: unsent.length,
    unsentTotalCentavos: unsent.filter((e) => e.kind === 'sale').reduce((n, e) => n + e.totalCentavos, 0),
    quarantined: events.filter((e) => e.status === 'quarantined').length,
    rejected: events.filter((e) => e.status === 'rejected').length,
    stuck: events.filter((e) => e.status === 'stuck').length,
    failedEffects: failed.length,
  };
}

export const getOutboxStatus = (): OutboxStatus => state;
export const getInitialOutboxStatus = (): OutboxStatus => INITIAL;

export function subscribeOutboxStatus(listener: () => void): () => void {
  listeners.push(listener);
  return () => {
    const i = listeners.indexOf(listener);
    if (i >= 0) listeners.splice(i, 1);
  };
}

/** Re-reads the ledger (one read at a time; a change that arrives during a read triggers one more). Never throws. */
export async function refreshOutboxStatus(): Promise<void> {
  if (reading) {
    again = true;
    return;
  }
  reading = true;
  try {
    do {
      again = false;
      try {
        const next = await readOutboxStatus();
        const changed = JSON.stringify(next) !== JSON.stringify(state);
        state = next;
        if (changed) for (const l of [...listeners]) l();
      } catch (e) {
        console.warn('[outbox] could not read the ledger status', e);
      }
    } while (again);
  } finally {
    reading = false;
  }
}

/** Call after anything that changes the ledger or the effects store. */
export function notifyOutboxChanged(): void {
  void refreshOutboxStatus();
}
