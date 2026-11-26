/**
 * T-644 S3 - the pure half of the birthday-song prompt: the shapes the server actions answer with, the three fixed decline reasons, the "HH:MM" time, which
 * request is asked next, what the prompt looks like (dialog or banner), and the poller's single-flight rule. No React, no clock, no network: every dependency
 * arrives in an argument. docs/tasks/644-lobby-in-erp-pos.md, S3. Ported as REQUIREMENTS from apps/pos (BirthdayPrompt.tsx, birthdayPresets.ts, lobbyBirthday.ts);
 * the state rules themselves live in `packages/domain/src/lobby/birthday.ts`.
 */
import { createPollGuard, type LobbyResult } from './logic';

/** The only decline reasons the cashier can send (no free typing). The domain takes any trimmed 1..80 characters; the server action refuses anything not on this list. */
export const BIRTHDAY_DECLINE_PRESETS: readonly string[] = ['Too busy right now', 'Not available today', 'We cannot play it at this time'];
export const BAD_BIRTHDAY = 'Choose a birthday request from the list.';
export const BAD_BIRTHDAY_REASON = 'Choose a reason to decline.';

/** One open request, JSON-safe (times are ISO strings). Never a phone, a hash or a hand-off link. */
export interface BirthdayView {
  requestId: string;
  code: string;
  displayName: string | null;
  standLabel: string | null;
  celebrantName: string | null;
  status: 'requested' | 'accepted';
  scheduledAt: string | null;
  createdAt: string;
}
export type BirthdayListResult = LobbyResult<{ birthdays: BirthdayView[] }>;

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
/** A strict ISO 8601 timestamp: the pattern, a real date, and (for the Z form) the same instant when written back. Anything else is null. */
export function strictIso(raw: unknown): Date | null {
  if (typeof raw !== 'string' || !ISO.test(raw)) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  if (raw.endsWith('Z') && d.toISOString().slice(0, 19) !== raw.slice(0, 19)) return null;
  return d;
}

/** "HH:MM" today (local); a time already gone today means tomorrow. */
export function timeToEpoch(hhmm: string, nowMs: number): number {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(nowMs);
  d.setHours(h ?? 0, m ?? 0, 0, 0);
  return d.getTime() < nowMs ? d.getTime() + 24 * 3_600_000 : d.getTime();
}

/** One request at a time, oldest first: the first still-`requested` one this tablet has not just answered (the list is already oldest first). */
export function nextToAnswer<T extends { requestId: string; status: string }>(rows: readonly T[], answered: readonly string[]): T | null {
  return rows.find((r) => r.status === 'requested' && !answered.includes(r.requestId)) ?? null;
}

/**
 * What the cashier sees for the request at the head of the line. A dialog normally; a bottom banner while the Orders seat / order sheet is open (a dialog would sit
 * on top of a half-built order) or after the cashier closed the dialog ("later"); tapping Answer on the banner opens the dialog (`open`) even over the sheet.
 */
export type PromptMode = 'auto' | 'open' | 'later';
export function promptView(i: { hasRequest: boolean; sheetOpen: boolean; mode: PromptMode }): 'none' | 'dialog' | 'banner' {
  if (!i.hasRequest) return 'none';
  if (i.mode === 'open') return 'dialog';
  return i.sheetOpen || i.mode === 'later' ? 'banner' : 'dialog';
}

/**
 * The poll's traffic rule, reused from the lobby line (`createPollGuard`): ONE list call in flight; a tick asked for meanwhile is remembered and re-run once.
 * After each answer it asks the scheduler to report the songs that played while offline (`flush`). A failed call keeps the last list (offline or server down:
 * the next tick tries again), so it is never shown as an error.
 */
export function createBirthdayPoller(deps: { list: () => Promise<BirthdayListResult>; apply: (rows: BirthdayView[]) => void; flush: () => Promise<void> }) {
  const guard = createPollGuard();
  const poll = async (): Promise<void> => {
    const seq = guard.begin();
    if (seq === null) return;
    try {
      const r = await deps.list();
      if (guard.accept(seq) && r.ok) deps.apply(r.birthdays);
    } catch {
      // keep the last answer
    }
    try {
      await deps.flush();
    } catch {
      // the scheduler keeps what it could not report and tries again on the next tick
    } finally {
      if (guard.end()) void poll();
    }
  };
  return { poll };
}
