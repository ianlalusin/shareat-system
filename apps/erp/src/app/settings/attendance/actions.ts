'use server';

/**
 * Server action for `/settings/attendance`. T-201.
 *
 * ⛔ The gate is `authorize(tx, actor, 'manage_store_settings', …)` **inside** `supersedeConfig` —
 * this action does not re-check it. A gate here would protect only this one caller, and the
 * screen would be one new form away from a hole (bible §3, "the database enforces the rules").
 *
 * ⭐ One form, one submit, one `supersedeConfig` call — every field on the row changes together,
 * because the row itself is the unit `supersedeConfig` writes. See the task spec §2.2.
 *
 * T-352 / DEF-478 — every field is passed RAW and parsed inside `supersedeConfig`, after its
 * `authorize()` call, not here. Parsing before the gate let a non-holder's malformed field draw a
 * field sentence instead of the authorization refusal.
 */
import { redirect } from 'next/navigation';
import { supersedeConfig, type ConfigChangesInput } from '@shareat/domain';
import { requireActor } from '../../../lib/session';
import { errorMessage } from '../../../lib/constraint-messages';
import { withOrgPrincipal, parseIntList } from './lib';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

function bool(fd: FormData, key: string): boolean {
  return fd.get(key) === 'on';
}

function back(store: string, params: Record<string, string>): never {
  redirect(`/settings/attendance?${new URLSearchParams({ store, ...params }).toString()}`);
}

export async function updateAttendanceConfigAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const store = str(formData, 'storeId');
  const effectiveFrom = str(formData, 'effectiveFrom');

  const overtimeMode = (str(formData, 'overtimeMode') || 'multiplier') as 'multiplier' | 'fixed';
  const latePolicy = (str(formData, 'latePolicy') || 'record_only') as
    | 'record_only'
    | 'charge_per_minute'
    | 'infraction';
  const payrollPeriodType = (str(formData, 'payrollPeriodType') || 'semi_monthly') as
    | 'monthly'
    | 'semi_monthly'
    | 'weekly';
  const payoutMode = (str(formData, 'payoutMode') || 'lag') as 'lag' | 'fixed_days';
  const timeMode = (str(formData, 'timeMode') || 'open') as 'open' | 'fixed';

  try {
    const changes: ConfigChangesInput = {
      requiredHoursPerShift: str(formData, 'requiredHoursPerShift'),
      halfDayHours: str(formData, 'halfDayHours'),
      allowedShiftStartHours: parseIntList(str(formData, 'allowedShiftStartHours')),
      anchorWindowMinutes: str(formData, 'anchorWindowMinutes'),
      timeMode,
      defaultWorkHours: str(formData, 'defaultWorkHours'),
      defaultBreakHours: str(formData, 'defaultBreakHours'),
      breakEnabled: bool(formData, 'breakEnabled'),
      halfDayOnMissingTap: bool(formData, 'halfDayOnMissingTap'),

      credentialNfc: bool(formData, 'credentialNfc'),
      credentialFingerprint: bool(formData, 'credentialFingerprint'),
      credentialFace: bool(formData, 'credentialFace'),

      shortShiftHalfDayOt: bool(formData, 'shortShiftHalfDayOt'),
      nightDiffEnabled: bool(formData, 'nightDiffEnabled'),
      nightDiffStartHour: str(formData, 'nightDiffStartHour'),
      nightDiffEndHour: str(formData, 'nightDiffEndHour'),
      nightDiffMultiplier: str(formData, 'nightDiffMultiplier'),
      overtimeMode,
      overtimeMultiplier: str(formData, 'overtimeMultiplier'),
      // R6 — the mode choice stays here: it never throws, and a malformed rate in multiplier
      // mode is silently discarded today, unchanged by T-352.
      overtimeFixedHourly: overtimeMode === 'fixed' ? str(formData, 'overtimeFixedHourly') : null,

      holidayRegularMultiplier: str(formData, 'holidayRegularMultiplier'),
      holidaySpecialNonWorkingMultiplier: str(formData, 'holidaySpecialNonWorkingMultiplier'),
      holidaySpecialWorkingMultiplier: str(formData, 'holidaySpecialWorkingMultiplier'),

      latePolicy,
      lateChargePerMinute: str(formData, 'lateChargePerMinute'),
      lateInfractionPoints: str(formData, 'lateInfractionPoints'),
      lateGraceMinutes: str(formData, 'lateGraceMinutes'),
      earlyOutGraceMinutes: str(formData, 'earlyOutGraceMinutes'),
      undertimeGraceMinutes: str(formData, 'undertimeGraceMinutes'),

      payrollPeriodType,
      semiMonthlyCutoffDay: str(formData, 'semiMonthlyCutoffDay'),
      payoutMode,
      payoutLagDays: str(formData, 'payoutLagDays'),
      payoutDays: parseIntList(str(formData, 'payoutDays')),

      autoClockOutHour: str(formData, 'autoClockOutHour'),
      maxShiftHours: str(formData, 'maxShiftHours'),
    };

    await withOrgPrincipal(actor.orgId, (tx) =>
      supersedeConfig(tx, actor, {
        storeId: store,
        effectiveFrom,
        changes,
      }),
    );
  } catch (err) {
    back(store, { error: errorMessage(err) });
  }
  back(store, { ok: `Saved. The new policy takes effect from ${effectiveFrom}.` });
}
