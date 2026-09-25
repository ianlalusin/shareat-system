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
import { closeReadiness, type Finding } from '../findings';

export interface ClosePeriodInput {
  /** `'YYYY-MM'` — the same string `listFindings`/`closeReadiness`/`/findings`'s period selector
   *  already use. */
  readonly period: string;
}

export interface ClosePeriodResult {
  readonly periodId: string;
  readonly closedAt: Date;
}

export interface CloseBlockersInput {
  readonly startsOn: string;
  readonly endsOn: string;
}

export interface CloseBlockers {
  readonly drafts: {
    readonly kind: 'expense' | 'delivery';
    readonly id: string;
    readonly dateOn: string;
    readonly counterpartyName: string | null;
  }[];
  readonly blocking: Finding[];
  readonly earlierOpen: boolean;
}

/**
 * T-344 §3.3, R1.5 — the three checks `closePeriod` and the admin "fill a missing month" action
 * (`./holes.ts`) both need over an arbitrary `[startsOn, endsOn]` range: unposted drafts, hard
 * findings for the containing month, and an earlier period still open. Extracted from
 * `closePeriod`'s own checks 2-4 below so the two callers cannot drift apart (RULES §6 item 3) —
 * each still builds its OWN message from this data, so `closePeriod`'s stay byte-for-byte (F14).
 *
 * ⚠️ For a part-month piece, readiness is checked on the WHOLE containing month — conservative
 * (it may over-refuse), but it never lets activity through that a check keyed on the exact days
 * would have missed.
 */
export async function closeBlockers(tx: Tx, orgId: string, input: CloseBlockersInput): Promise<CloseBlockers> {
  const drafts = await fiscalPeriodsRepo.unpostedDraftsInRange(tx, orgId, input.startsOn, input.endsOn);
  const containingMonth = input.startsOn.slice(0, 7);
  const readiness = await closeReadiness(tx, orgId, containingMonth);
  const earlierOpen = await fiscalPeriodsRepo.hasEarlierOpenPeriodBefore(tx, orgId, input.startsOn);
  return { drafts, blocking: readiness.blocking, earlierOpen };
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

  const { startsOn, endsOn } = fiscalPeriodsRepo.periodBounds(input.period);
  const { drafts, blocking, earlierOpen } = await closeBlockers(tx, actor.orgId, { startsOn, endsOn });

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

  if (blocking.length > 0) {
    const kinds = [...new Set(blocking.map((b) => b.kind))].join(', ');
    throw new Error(
      `closePeriod: ${input.period} is not ready to close — blocked by: ${kinds}.`,
    );
  }

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
export {
  classifyHoles,
  createMissingClosedPeriod,
  type ClassifiedHolePiece,
  type ClassifyHolesResult,
  type CreateMissingClosedPeriodInput,
  type CreateMissingClosedPeriodResult,
  type HolePieceClass,
} from './holes';
