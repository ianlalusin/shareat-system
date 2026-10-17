'use server';

/**
 * Server actions for `/findings`. T-135.
 *
 * ⛔ **There is exactly one action, and it is not "resolve".** The only way a finding leaves the
 * feed is for its condition to stop being true. Acknowledging says *"I accept this for now"*, is
 * still counted, ages visibly, and expires after 30 days on its own.
 */
import { acknowledgeFinding, assertFieldRules, bookMissedMonth, closePeriod, createMissingClosedPeriod } from '@shareat/domain';
import { FINDINGS_MISSED_MONTH_RULES, FINDINGS_MISSING_PERIOD_RULES } from '@shareat/domain/field-rules';
import { withOrgPrincipal } from './lib';
import { requireActor } from '../../lib/session';
import { errorMessage } from '@/lib/constraint-messages';
import { redirectWithFlash } from '@/lib/flash';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

export async function acknowledgeFindingAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const period = str(formData, 'period');
  const findingKey = str(formData, 'findingKey');
  const note = str(formData, 'note');

  try {
    // ⚠️ The gate lives inside `acknowledgeFinding` (`close_period`, store-scoped when the finding
    // names a store), not here — a gate in a server action protects one caller.
    await withOrgPrincipal(actor.orgId, (tx) =>
      acknowledgeFinding(tx, actor, { findingKey, period, note: note || null }),
    );
  } catch (err) {
    return await redirectWithFlash('/findings', { period }, { error: errorMessage(err) });
  }
  return await redirectWithFlash(
    '/findings',
    { period },
    { ok: 'Accepted for now — it is still counted, and it will expire.' },
  );
}

/**
 * T-264 / DEF-284 slice 2 — the close action. ⛔ **`ready === true` on this page is a hint, never
 * the authority.** Every gate — the capability, the unposted-draft check, `closeReadiness`, the
 * earlier-period-open rule — is re-checked inside `closePeriod` itself, so a stale page or a
 * button clicked twice cannot close a period that is not actually closeable.
 */
export async function closePeriodAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const period = str(formData, 'period');

  try {
    await withOrgPrincipal(actor.orgId, (tx) => closePeriod(tx, actor, { period }));
  } catch (err) {
    return await redirectWithFlash('/findings', { period }, { error: errorMessage(err) });
  }
  return await redirectWithFlash('/findings', { period }, { ok: `${period} is closed.` });
}

/**
 * T-344 / DEF-422 §3.6 — fills one whole month, or the missing part of one, inside closed books.
 * ⛔ Every gate — the capability, the exact-missing-piece check, the close blockers — is
 * re-checked inside `createMissingClosedPeriod` itself; the button rendering only decides who
 * SEES the form (`heldCapabilities`), never who may submit it.
 */
export async function createMissingClosedPeriodAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const period = str(formData, 'period');
  const startsOn = str(formData, 'startsOn');
  const endsOn = str(formData, 'endsOn');
  const reason = str(formData, 'reason');

  let result: Awaited<ReturnType<typeof createMissingClosedPeriod>>;
  try {
    // T-440: the "why" box's rule is the one the form shows live (field-rules/findings.ts); the domain keeps its own backstop.
    assertFieldRules(FINDINGS_MISSING_PERIOD_RULES, formData);
    result = await withOrgPrincipal(actor.orgId, (tx) =>
      createMissingClosedPeriod(tx, actor, { startsOn, endsOn, reason }),
    );
  } catch (err) {
    return await redirectWithFlash('/findings', { period }, { error: errorMessage(err) });
  }
  return await redirectWithFlash(
    '/findings',
    { period },
    { ok: `${result.startsOn} to ${result.endsOn} is created as ${result.status}.` },
  );
}

/**
 * T-345 §3.5 — books one scheduled charge missed in a closed month into the current open month.
 * ⛔ Every gate — the capability, the subject's status, the schedule, the link — is re-checked
 * inside `bookMissedMonth` itself; the button rendering only decides who SEES the form.
 */
export async function bookMissedMonthAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const period = str(formData, 'period');
  const scheduleRaw = str(formData, 'schedule');
  const subjectId = str(formData, 'subjectId');
  const belongsToPeriod = str(formData, 'belongsToPeriod');
  const reason = str(formData, 'reason');

  // ⚠️ Audit finding (2026-09-26, DEF-417): validated here, in human terms, rather than cast — an
  // unvalidated cast would let a bogus value fall into `bookMissedMonth`'s amortisation branch and
  // surface a raw id in the "does not exist" refusal.
  if (scheduleRaw !== 'depreciation' && scheduleRaw !== 'amortisation') {
    return await redirectWithFlash(
      '/findings',
      { period },
      { error: 'That is not a schedule this screen knows how to book.' },
    );
  }
  const schedule = scheduleRaw as 'depreciation' | 'amortisation';

  try {
    assertFieldRules(FINDINGS_MISSED_MONTH_RULES, formData);
    await withOrgPrincipal(actor.orgId, (tx) =>
      bookMissedMonth(tx, actor, { schedule, subjectId, belongsToPeriod, reason }),
    );
  } catch (err) {
    return await redirectWithFlash('/findings', { period }, { error: errorMessage(err) });
  }
  return await redirectWithFlash('/findings', { period }, { ok: `${belongsToPeriod} is booked.` });
}
