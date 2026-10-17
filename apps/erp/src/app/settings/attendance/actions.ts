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
import { addLeaveType, assertFieldRules, setLeaveCap, setLeaveTypeActive, supersedeConfig, type ConfigChangesInput } from '@shareat/domain';
import { SETTINGS_LEAVE_CAP_RULES, SETTINGS_LEAVE_KIND_RULES } from '@shareat/domain/field-rules';
import { requireActor } from '../../../lib/session';
import { errorMessage } from '../../../lib/constraint-messages';
import { withOrgPrincipal } from './lib';
import { redirectWithFlash } from '@/lib/flash';
import { keepTyping } from '@/lib/keep-typing';
import { ATTENDANCE_POLICY } from './typed-forms';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

function bool(fd: FormData, key: string): boolean {
  return fd.get(key) === 'on';
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
      allowedShiftStartHours: str(formData, 'allowedShiftStartHours'),
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
      payoutDays: str(formData, 'payoutDays'),

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
    return await redirectWithFlash('/settings/attendance', { store: store }, { error: errorMessage(err), typed: keepTyping(formData, ATTENDANCE_POLICY, store, { actorId: actor.personId }) });
  }
  return await redirectWithFlash('/settings/attendance', { store: store }, { ok: `Saved. The new policy takes effect from ${effectiveFrom}.` });
}

// ---------------------------------------------------------------------------------------------
// T-436: leave limits and kinds. Every gate is in the domain (`setLeaveCap` authorizes manage_attendance at the store, or people
// admin for the business-wide default; a statutory limit cannot be lowered). These actions only turn the form into its input.

/** A cap the rule set already judged: a whole number of days, or null for "no limit". */
function capOf(checked: string | null): number | null {
  return checked === null ? null : Number(checked);
}

export async function saveLeaveCapAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const store = str(formData, 'storeId');
  try {
    // T-440: the caps' rule is the one the form shows live (field-rules/settings.ts); the domain keeps its own backstop for its other callers.
    const caps = assertFieldRules(SETTINGS_LEAVE_CAP_RULES, formData);
    await withOrgPrincipal(actor.orgId, (tx) =>
      setLeaveCap(tx, actor, {
        leaveType: str(formData, 'leaveType'),
        storeId: str(formData, 'scope') === 'org' ? null : store,
        positionId: str(formData, 'positionId') || null,
        monthlyCap: capOf(caps.monthlyCap ?? null),
        yearlyCap: capOf(caps.yearlyCap ?? null),
      }),
    );
  } catch (err) {
    return await redirectWithFlash('/settings/attendance', { store }, { error: errorMessage(err) });
  }
  return await redirectWithFlash('/settings/attendance', { store }, { ok: 'Leave limit saved.' });
}

export async function addLeaveTypeAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const store = str(formData, 'storeId');
  try {
    // T-440: the name and code rule is the one the form shows live (field-rules/settings.ts).
    const kind = assertFieldRules(SETTINGS_LEAVE_KIND_RULES, formData);
    await withOrgPrincipal(actor.orgId, (tx) =>
      addLeaveType(tx, actor, {
        code: kind.code ?? '',
        label: kind.label ?? '',
        paid: str(formData, 'paid') === 'paid',
        needsProof: bool(formData, 'needsProof'),
      }),
    );
  } catch (err) {
    return await redirectWithFlash('/settings/attendance', { store }, { error: errorMessage(err) });
  }
  return await redirectWithFlash('/settings/attendance', { store }, { ok: 'Kind of leave added.' });
}

export async function setLeaveTypeActiveAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const store = str(formData, 'storeId');
  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      setLeaveTypeActive(tx, actor, { id: str(formData, 'id'), active: str(formData, 'active') === 'yes' }),
    );
  } catch (err) {
    return await redirectWithFlash('/settings/attendance', { store }, { error: errorMessage(err) });
  }
  return await redirectWithFlash('/settings/attendance', { store }, { ok: 'Kind of leave updated.' });
}
