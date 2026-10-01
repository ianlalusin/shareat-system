/**
 * The closed-month override, as the SCREENS use it. T-369 S5a (DEF-314).
 *
 * ⛔ Nothing here authorises anything: `postEntry` checks `override_period_lock` against the domain
 * function's own actor (I4). These helpers only decide what a form OFFERS and which of its fields are
 * worth forwarding, so an ordinary save never leaves audit noise.
 *
 * ⛔ I5 (Ian, 2026-09-30): never for stock. `tests/unit/t369-override-not-on-stock-screens.test.ts`
 * fails the build if anything under `inventory/`, `commissary/` or `trade/` imports this file.
 */
import { and, asc, eq } from 'drizzle-orm';
import { schema } from '@shareat/db';
import { PERIOD_OVERRIDE_REASONS, type PeriodOverrideReason } from '@shareat/db/schema';
import { withOrgPrincipal } from '../app/expenses/lib';

export interface ClosedMonth {
  startsOn: string;
  endsOn: string;
  /** "January 2026". */
  label: string;
}

const label = (startsOn: string) =>
  new Date(`${startsOn}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** Months an override can reach: `closed` ONLY. An open month needs none; a `locked` one cannot take it. */
export async function closedMonths(orgId: string): Promise<ClosedMonth[]> {
  const rows = await withOrgPrincipal(orgId, (tx) =>
    tx
      .select({ startsOn: schema.fiscalPeriods.startsOn, endsOn: schema.fiscalPeriods.endsOn })
      .from(schema.fiscalPeriods)
      .where(and(eq(schema.fiscalPeriods.orgId, orgId), eq(schema.fiscalPeriods.status, 'closed')))
      .orderBy(asc(schema.fiscalPeriods.startsOn)),
  );
  return rows.map((r) => ({ startsOn: r.startsOn, endsOn: r.endsOn, label: label(r.startsOn) }));
}

/** The closed month `date` (YYYY-MM-DD) falls in, if any. */
export function closedMonthOf(months: ClosedMonth[], date: string): ClosedMonth | undefined {
  return months.find((m) => date >= m.startsOn && date <= m.endsOn);
}

/**
 * The override a form asked for, or `undefined` when it did not ask properly: the confirm box has to
 * be ticked, the reason has to be one of the typed reasons, and "other" has to carry a note. Anything
 * weaker is dropped - the payout then meets the closed-month refusal rather than a half-made override.
 */
export function readPeriodOverride(fd: FormData): { reason: PeriodOverrideReason; note?: string } | undefined {
  if (fd.get('periodOverrideConfirm') !== 'on') return undefined;
  const reason = fd.get('periodOverrideReason');
  const found = PERIOD_OVERRIDE_REASONS.find((r) => r === reason);
  if (!found) return undefined;
  const raw = fd.get('periodOverrideNote');
  const note = typeof raw === 'string' ? raw.trim() : '';
  if (found === 'other' && !note) return undefined;
  return note ? { reason: found, note } : { reason: found };
}

/**
 * What is missing from an override form whose confirm box IS ticked, in a sentence - or `null` when it is
 * complete (or was never asked for). A ticked box with no reason, or "Other" with no note, is a person's
 * unfinished form, not a forged one: it is refused out loud rather than quietly dropped into the
 * closed-month refusal, which would read as if the override had not been seen.
 */
export function periodOverrideProblem(fd: FormData): string | null {
  if (fd.get('periodOverrideConfirm') !== 'on') return null;
  if (readPeriodOverride(fd)) return null;
  const reason = fd.get('periodOverrideReason');
  if (typeof reason !== 'string' || reason.trim() === '') {
    return 'Choose a reason for posting into the closed month, or untick the confirmation.';
  }
  // A reason that is not one of the typed ones cannot come from the form: it is forged, and is
  // dropped (the payout then meets the closed-month refusal) rather than answered helpfully.
  if (!PERIOD_OVERRIDE_REASONS.some((r) => r === reason)) return null;
  return 'Add a note saying why — it is required when the reason is “Other”.';
}
