/**
 * T-343 S5.0 (code-review CHANGES item 2, 2026-09-26) — the CLIENT-SAFE half of the domain
 * refusal producer API. `docs/tasks/343-def-417-human-readable-refusals.md` §S5 Design.
 *
 * No `@shareat/db` import: `internalFault`/`InternalFaultError` and `humanDate` are pure
 * classes/formatters a `'use client'` component may reach for directly (`humanDate` alongside
 * `formatBusinessDateTime`, PROJECT_BIBLE.md §6 landmine 26), and must not drag the server-only
 * `@shareat/db` import chain in with them. `./refusal.ts` (server-only) re-exports both from here.
 */
import { businessDayRange, formatBusinessDateTime, type BusinessDate } from '@shareat/core/datetime';

/**
 * An unreachable invariant — a state no user input can produce. `message` stays the raw
 * diagnostic; there is deliberately no `userMessage` field at all (Invariant 13).
 */
export class InternalFaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InternalFaultError';
  }
}

export function internalFault(raw: string): InternalFaultError {
  return new InternalFaultError(raw);
}

/** No second date formatter: the one already used everywhere, applied to a business date's own
 *  midnight instant. */
export function humanDate(d: BusinessDate): string {
  return formatBusinessDateTime(businessDayRange(d).start, { dateStyle: 'medium' });
}
