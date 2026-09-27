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
 */
import { redirect } from 'next/navigation';
import { supersedeConfig, parseShiftDay, refuse, type ConfigChanges } from '@shareat/domain';
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

function int(fd: FormData, key: string, fallback: number, label: string): number {
  const v = str(fd, key);
  if (v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw refuse(
      `updateAttendanceConfigAction: ${key} is not a number: ${JSON.stringify(v)}`,
      `${label} — "${v}" is not a number.`,
    );
  }
  return Math.trunc(n);
}

/** Blank means "not set", never `0` — `Number('')` is `0`, DEF-087's exact failure shape. */
function intOrNull(fd: FormData, key: string, label: string): number | null {
  const v = str(fd, key);
  if (v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw refuse(
      `updateAttendanceConfigAction: ${key} is not a number: ${JSON.stringify(v)}`,
      `${label} — "${v}" is not a number.`,
    );
  }
  return Math.trunc(n);
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
    const changes: ConfigChanges = {
      requiredHoursPerShift: str(formData, 'requiredHoursPerShift'),
      halfDayHours: str(formData, 'halfDayHours'),
      allowedShiftStartHours: parseIntList(str(formData, 'allowedShiftStartHours')),
      anchorWindowMinutes: int(formData, 'anchorWindowMinutes', 30, 'The anchor window'),
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
      nightDiffStartHour: int(formData, 'nightDiffStartHour', 22, 'The night diff start hour'),
      nightDiffEndHour: int(formData, 'nightDiffEndHour', 6, 'The night diff end hour'),
      nightDiffMultiplier: str(formData, 'nightDiffMultiplier'),
      overtimeMode,
      overtimeMultiplier: str(formData, 'overtimeMultiplier'),
      overtimeFixedHourly: overtimeMode === 'fixed' ? str(formData, 'overtimeFixedHourly') || null : null,

      holidayRegularMultiplier: str(formData, 'holidayRegularMultiplier'),
      holidaySpecialNonWorkingMultiplier: str(formData, 'holidaySpecialNonWorkingMultiplier'),
      holidaySpecialWorkingMultiplier: str(formData, 'holidaySpecialWorkingMultiplier'),

      latePolicy,
      lateChargePerMinute: str(formData, 'lateChargePerMinute') || '0',
      lateInfractionPoints: int(formData, 'lateInfractionPoints', 1, 'The late infraction points'),
      lateGraceMinutes: int(formData, 'lateGraceMinutes', 0, 'The late grace minutes'),
      earlyOutGraceMinutes: int(formData, 'earlyOutGraceMinutes', 0, 'The early-out grace minutes'),
      undertimeGraceMinutes: int(formData, 'undertimeGraceMinutes', 0, 'The undertime grace minutes'),

      payrollPeriodType,
      semiMonthlyCutoffDay: int(formData, 'semiMonthlyCutoffDay', 15, 'The semi-monthly cutoff day'),
      payoutMode,
      payoutLagDays: int(formData, 'payoutLagDays', 0, 'The payout lag days'),
      payoutDays: parseIntList(str(formData, 'payoutDays')),

      autoClockOutHour: intOrNull(formData, 'autoClockOutHour', 'The auto clock-out hour'),
      maxShiftHours: int(formData, 'maxShiftHours', 16, 'The max shift hours'),
    };

    await withOrgPrincipal(actor.orgId, (tx) =>
      supersedeConfig(tx, actor, {
        storeId: store,
        effectiveFrom: parseShiftDay(effectiveFrom),
        changes,
      }),
    );
  } catch (err) {
    back(store, { error: errorMessage(err) });
  }
  back(store, { ok: `Saved. The new policy takes effect from ${effectiveFrom}.` });
}
