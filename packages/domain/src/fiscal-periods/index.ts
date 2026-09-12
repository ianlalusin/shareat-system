/**
 * closePeriod — the ONE way to raise the wall migration `0003`'s trigger already enforces.
 * T-264 / DEF-284 slice 2. `docs/tasks/264-def-284-fiscal-period-lock.md`,
 * `docs/decisions/ADR-006-period-close.md`.
 *
 * ⛔ **This is the generic lock for ANY period — month or year alike.** The year-close journal
 * entry ADR-006 describes (one entry via `postEntry`, dated the following Jan 1, zeroing
 * income/expense into 3300, distinct `source_type`) is deliberately NOT built HERE — it was ruled
 * explicitly out of this function rather than half-built into a December special case. T-274 built
 * it as its own function, `closeYear` in `./close-year.ts`, re-exported below.
 *
 * ⭐ **Every gate here is enforced INSIDE this function, never trusted from the caller.** A
 * `ready === true` the UI already saw is a hint, not the authority — a close request for a
 * not-ready period must be refused even if a stale button somehow got clicked.
 */
import { fiscalPeriodsRepo, type Tx } from '@shareat/db';
import { authorize, type Actor } from '@shareat/auth';
import { closeReadiness } from '../findings';

export interface ClosePeriodInput {
  /** `'YYYY-MM'` — the same string `listFindings`/`closeReadiness`/`/findings`'s period selector
   *  already use. */
  readonly period: string;
}

export interface ClosePeriodResult {
  readonly periodId: string;
  readonly closedAt: Date;
}

/** `n` of `singular`/`plural`, English-only — this codebase's error sentences are read by a
 *  person deciding what to do next, so "3 draft expenses" beats "3 draft expense(s)". */
function pluralize(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/**
 * Closes `input.period` for `actor.orgId`: `status` `open` -> `closed`, `closed_at`/`closed_by`
 * both written. Throws, never returns a false-ish result, on any gate failing — see this module's
 * header for why every gate lives here rather than in the caller.
 *
 * Gate order (bible-adjacent discipline: cheapest and least ambiguous first):
 *   1. `authorize(actor, 'close_period')` — capability, then (for a manager) org-wide store scope.
 *   2. Unposted `expenses`/`deliveries` drafts dated in the period — actionable, named by count.
 *   3. `closeReadiness` — the SAME hard findings `/findings` already shows, re-run here so the
 *      screen's verdict is never trusted, only reproduced.
 *   4. No earlier period in the org still open — periods close in order.
 * Then, and only then, the write — one statement, `status`/`closed_at`/`closed_by` together, so
 * two admins racing to close the same period cannot produce two closes with different `closed_by`.
 */
export async function closePeriod(
  tx: Tx,
  actor: Actor,
  input: ClosePeriodInput,
): Promise<ClosePeriodResult> {
  await authorize(tx, actor, 'close_period', {});

  const drafts = await fiscalPeriodsRepo.unpostedDraftsInPeriod(tx, actor.orgId, input.period);
  if (drafts.length > 0) {
    const expenseCount = drafts.filter((d) => d.kind === 'expense').length;
    const deliveryCount = drafts.filter((d) => d.kind === 'delivery').length;
    const parts: string[] = [];
    if (expenseCount > 0) parts.push(pluralize(expenseCount, 'draft expense', 'draft expenses'));
    if (deliveryCount > 0) parts.push(pluralize(deliveryCount, 'draft delivery', 'draft deliveries'));
    throw new Error(
      `closePeriod: ${input.period} cannot close — ${parts.join(' and ')} still dated in it. ` +
        'Post or void them first.',
    );
  }

  const readiness = await closeReadiness(tx, actor.orgId, input.period);
  if (!readiness.ready) {
    const kinds = [...new Set(readiness.blocking.map((b) => b.kind))].join(', ');
    throw new Error(
      `closePeriod: ${input.period} is not ready to close — blocked by: ${kinds}.`,
    );
  }

  const earlierOpen = await fiscalPeriodsRepo.hasEarlierOpenPeriod(tx, actor.orgId, input.period);
  if (earlierOpen) {
    throw new Error(
      `closePeriod: an earlier period for this organisation is still open. Periods close in order.`,
    );
  }

  const closed = await fiscalPeriodsRepo.closePeriod(tx, actor.orgId, input.period, actor.personId);
  if (!closed) {
    throw new Error(
      `closePeriod: ${input.period} could not be closed — it does not exist, or is not open.`,
    );
  }
  return closed;
}

export { closeYear, type CloseYearInput, type CloseYearResult } from './close-year';
