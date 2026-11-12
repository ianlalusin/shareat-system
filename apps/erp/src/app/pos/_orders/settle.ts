/**
 * T-527 - no blink. When the outbox drops a sent event, the server's own list and that table's body have not caught up yet; for a moment the change
 * would vanish from the screen and then reappear. So a dropped event is kept in the view (still applied, with its sending dot) until BOTH have landed:
 * the /state poll has moved to a newer version than the one seen at the drop, AND that table's body was fetched for that newer version. An event that
 * changes nothing on the server (a duplicate, a refusal) never moves the version, so it lets go after a fixed time. Pure.
 */
import type { PosEvent } from '@/lib/pos-device';

/** A protocol rhythm (about three poll beats plus a read), not a business setting: how long a dropped event is shown at most. */
export const SETTLE_MAX_MS = 10_000;

export interface Settling {
  event: PosEvent;
  /** The table the event is about; null when it cannot be told (then only the time limit lets it go). */
  sessionId: string | null;
  /** The state version on screen when the outbox dropped it. */
  versionAtDrop: number | null;
  droppedAtMs: number;
}

/** The events that were in the outbox last time and are not now. */
export function droppedEvents(before: readonly PosEvent[], now: readonly PosEvent[]): PosEvent[] {
  const still = new Set(now.map((e) => e.seq));
  return before.filter((e) => !still.has(e.seq));
}

/** `landed[sessionId]` is the state version that table's last body was fetched for. */
export function stillSettling(list: readonly Settling[], c: { version: number | null; landed: Readonly<Record<string, number | null | undefined>>; nowMs: number }): Settling[] {
  return list.filter((s) => {
    if (c.nowMs - s.droppedAtMs >= SETTLE_MAX_MS) return false;
    const pollLanded = c.version !== null && c.version !== s.versionAtDrop;
    const bodyLanded = s.sessionId !== null && c.landed[s.sessionId] === c.version;
    return !(pollLanded && bodyLanded);
  });
}
