import { requirePageAccess } from '../../../lib/page-access';
import { addShiftDays, toShiftDay } from '@shareat/domain';
import { addLeaveTypeAction, saveLeaveCapAction, setLeaveTypeActiveAction, updateAttendanceConfigAction } from './actions';
import { leaveSettingsFor, liveConfigFor, listStores } from './lib';
import { ACTION_LINK } from '@/components/action-link';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { CheckedForm, EditableRecord } from '@/components/forms';
import { SETTINGS_ATTENDANCE_POLICY_RULES, SETTINGS_LEAVE_CAP_RULES, SETTINGS_LEAVE_KIND_RULES, nativeAttrs } from '@shareat/domain/field-rules';
import { Button, Checkbox, DialogActions, Field, FlashBanner, FormGrid, FormModal, Input, Select } from '@/components/ui';
import { formatBusinessDayLong } from '@shareat/core/datetime';
import { withFlash } from '@/lib/flash';
import { typedFor } from '@/lib/keep-typing';
import { ATTENDANCE_POLICY } from './typed-forms';

export const metadata = { title: 'Attendance & payroll settings — Shareat System' };
export const dynamic = 'force-dynamic';

const OVERTIME_WORDS = { multiplier: 'Times the hourly rate', fixed: 'Flat pesos per hour' } as const;
const LATE_WORDS = { record_only: 'Recorded only, no money', charge_per_minute: 'Charged per minute', infraction: 'Points only, no money' } as const;
const PERIOD_WORDS = { monthly: 'Monthly', semi_monthly: 'Twice a month', weekly: 'Weekly' } as const;

/** T-589 B2: the live policy in words, shown while the card is locked. The edit form below still carries every field. */
function policySummary(cfg: NonNullable<Awaited<ReturnType<typeof liveConfigFor>>>) {
  const fixedPay = cfg.payoutMode === 'fixed_days';
  return [
    { label: 'Live since', value: formatBusinessDayLong(cfg.effectiveFrom) },
    { label: 'Required hours per shift', value: `${cfg.requiredHoursPerShift} h (half day ${cfg.halfDayHours} h)` },
    { label: 'Time mode', value: cfg.timeMode === 'open' ? 'Open, free clock in and out' : 'Fixed, posted shift grid' },
    { label: 'Overtime', value: cfg.overtimeMode === 'fixed' ? `${OVERTIME_WORDS.fixed}: ${cfg.overtimeFixedHourly ?? '-'}` : `${OVERTIME_WORDS.multiplier}: ${cfg.overtimeMultiplier}` },
    { label: 'Night differential', value: cfg.nightDiffEnabled ? `${cfg.nightDiffMultiplier} x, from ${cfg.nightDiffStartHour}:00 to ${cfg.nightDiffEndHour}:00` : 'Off' },
    { label: 'Holiday multipliers', value: `Regular ${cfg.holidayRegularMultiplier}, special non-working ${cfg.holidaySpecialNonWorkingMultiplier}, special working ${cfg.holidaySpecialWorkingMultiplier}` },
    { label: 'Late policy', value: `${LATE_WORDS[cfg.latePolicy]}${cfg.latePolicy === 'charge_per_minute' ? ` (${cfg.lateChargePerMinute} a minute)` : ''}, ${cfg.lateGraceMinutes} min grace` },
    { label: 'Pay periods', value: `${PERIOD_WORDS[cfg.payrollPeriodType]}${cfg.payrollPeriodType === 'semi_monthly' ? `, cut-off day ${cfg.semiMonthlyCutoffDay}` : ''}` },
    { label: 'Payout', value: fixedPay ? `On day ${cfg.payoutDays.join(' and ')} of the month` : `${cfg.payoutLagDays} days after the period ends` },
    { label: 'Auto clock-out', value: cfg.autoClockOutHour === null ? 'Never' : `${cfg.autoClockOutHour}:00` },
  ];
}

interface SearchParams {
  store?: string;
  ok?: string;
  error?: string;
}

/**
 * `/settings/attendance`. T-201.
 *
 * ⭐ This screen adds no new rule — every field here is already a column
 * `store_attendance_config` carries and `supersedeConfig` (T-155) already writes, transactionally,
 * authorized, refusing a backdate over adjudicated days. The gap this closes is that until today
 * the only way to change one was an engineer writing a migration — which happened twice this week
 * (T-197, DEF-119).
 */
export default async function AttendanceSettingsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await withFlash(searchParams);
  const { actor, refusal } = await requirePageAccess('/settings/attendance');
  // ⭐ T-288 — the READ gate. Ian, 2026-09-12: "do both hide the menu and gate the reads."
  if (refusal) return refusal;

  const stores = await listStores(actor.orgId);
  const storeId = sp.store || stores[0]?.id;
  if (!storeId) {
    return (
      <Page density="table" className="space-y-4">
        <h1 className="text-2xl font-semibold">Attendance & payroll settings</h1>
        <PageDescription>No store is set up yet.</PageDescription>
      </Page>
    );
  }

  const cfg = await liveConfigFor(actor.orgId, storeId);
  const defaultEffectiveFrom = addShiftDays(toShiftDay(), 1);
  const leave = await leaveSettingsFor(actor, storeId).catch(() => null);

  return (
    <Page density="table">
      <div>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          <a href="/settings" className={ACTION_LINK}>
            Settings
          </a>{' '}
          / Attendance & payroll
        </p>
        <h1 className="text-2xl font-semibold">Attendance & payroll settings</h1>
        <PageDescription>
          One policy per store, starting from a day you choose. A change never rewrites a day already
          worked. See the result on{' '}
          <a href="/payroll" className="underline">
            Payroll
          </a>
          .
        </PageDescription>
      </div>

      <form className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-0 flex-1 flex-col gap-1">
          <span className={LABEL}>Store</span>
          <Select name="store" defaultValue={storeId} className="w-full">
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </label>
        <Button type="submit" variant="secondary">
          Switch
        </Button>
      </form>

      <FlashBanner flash={sp} />

      {!cfg ? (
        <p className="rounded border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
          This store has no attendance config yet.
        </p>
      ) : (
        <EditableRecord action={updateAttendanceConfigAction} label="attendance policy" summary={policySummary(cfg)} hidden={{ storeId }} typed={typedFor(sp, ATTENDANCE_POLICY, storeId, actor.personId)} rules={SETTINGS_ATTENDANCE_POLICY_RULES}>
          <div className="space-y-6">
          <Field
            label="Effective from"
            rule={SETTINGS_ATTENDANCE_POLICY_RULES.effectiveFrom}
            hint={
              <>
                Must be after {formatBusinessDayLong(cfg.effectiveFrom)} (the policy in force now) and cannot fall on
                or before a day that is already settled.
              </>
            }
          >
            <Input
              {...nativeAttrs(SETTINGS_ATTENDANCE_POLICY_RULES.effectiveFrom)}
              type="date"
              defaultValue={defaultEffectiveFrom}
              className="w-full"
            />
          </Field>

          <Group title="Shift & capture">
            <NumField label="Required hours / shift" name="requiredHoursPerShift" defaultValue={cfg.requiredHoursPerShift} />
            <NumField label="Half-day hours" name="halfDayHours" defaultValue={cfg.halfDayHours} />
            <TextField
              label="Allowed shift-start hours"
              name="allowedShiftStartHours"
              defaultValue={cfg.allowedShiftStartHours.join(',')}
              hint="Comma-separated, 0–23, e.g. 9,10,11,14"
            />
            <IntField label="Anchor window (min)" name="anchorWindowMinutes" defaultValue={cfg.anchorWindowMinutes} />
            <SelectField
              label="Time mode"
              name="timeMode"
              defaultValue={cfg.timeMode}
              options={[
                ['open', 'Open: free clock in and out'],
                ['fixed', 'Fixed: posted shift grid'],
              ]}
            />
            <NumField label="Default work hours" name="defaultWorkHours" defaultValue={cfg.defaultWorkHours} />
            <NumField label="Default break hours" name="defaultBreakHours" defaultValue={cfg.defaultBreakHours} />
            <CheckField label="Break enabled" name="breakEnabled" defaultChecked={cfg.breakEnabled} />
            <CheckField
              label="Half day on missing tap"
              name="halfDayOnMissingTap"
              defaultChecked={cfg.halfDayOnMissingTap}
              hint="A forgotten tap-out pays a half day rather than the full shift"
            />
          </Group>

          <Group title="Clock-in credentials">
            <CheckField label="NFC" name="credentialNfc" defaultChecked={cfg.credentialNfc} />
            <CheckField label="Fingerprint" name="credentialFingerprint" defaultChecked={cfg.credentialFingerprint} />
            <CheckField label="Face" name="credentialFace" defaultChecked={cfg.credentialFace} />
          </Group>

          <Group title="Overtime & premiums">
            <CheckField
              label="Short-shift half-day OT"
              name="shortShiftHalfDayOt"
              defaultChecked={cfg.shortShiftHalfDayOt}
            />
            <SelectField
              label="Overtime mode"
              name="overtimeMode"
              defaultValue={cfg.overtimeMode}
              options={[
                ['multiplier', 'Multiplier: times the hourly rate'],
                ['fixed', 'Fixed: flat pesos per overtime hour'],
              ]}
            />
            <NumField label="Overtime multiplier" name="overtimeMultiplier" defaultValue={cfg.overtimeMultiplier} hint="Used when the mode is multiplier" />
            <NumField
              label="Overtime fixed hourly (₱)"
              name="overtimeFixedHourly"
              defaultValue={cfg.overtimeFixedHourly ?? ''}
              hint="Needed when the mode is fixed"
            />
            <CheckField label="Night differential enabled" name="nightDiffEnabled" defaultChecked={cfg.nightDiffEnabled} />
            <IntField label="Night diff start hour" name="nightDiffStartHour" defaultValue={cfg.nightDiffStartHour} />
            <IntField label="Night diff end hour" name="nightDiffEndHour" defaultValue={cfg.nightDiffEndHour} />
            <NumField label="Night diff multiplier" name="nightDiffMultiplier" defaultValue={cfg.nightDiffMultiplier} />
          </Group>

          <Group title="Holiday multipliers">
            <NumField label="Regular holiday" name="holidayRegularMultiplier" defaultValue={cfg.holidayRegularMultiplier} />
            <NumField label="Special non-working" name="holidaySpecialNonWorkingMultiplier" defaultValue={cfg.holidaySpecialNonWorkingMultiplier} />
            <NumField label="Special working" name="holidaySpecialWorkingMultiplier" defaultValue={cfg.holidaySpecialWorkingMultiplier} />
          </Group>

          <Group title="Late policy">
            <SelectField
              label="Late policy"
              name="latePolicy"
              defaultValue={cfg.latePolicy}
              options={[
                ['record_only', 'Record only: no money'],
                ['charge_per_minute', 'Charge per minute: deducted from the payslip'],
                ['infraction', 'Points only: no money'],
              ]}
            />
            <NumField label="Late charge / minute (₱)" name="lateChargePerMinute" defaultValue={cfg.lateChargePerMinute} hint="Needed when the late policy is charge per minute" />
            <IntField label="Late infraction points" name="lateInfractionPoints" defaultValue={cfg.lateInfractionPoints} />
            <IntField label="Late grace (min)" name="lateGraceMinutes" defaultValue={cfg.lateGraceMinutes} />
            <IntField label="Early-out grace (min)" name="earlyOutGraceMinutes" defaultValue={cfg.earlyOutGraceMinutes} />
            <IntField label="Undertime grace (min)" name="undertimeGraceMinutes" defaultValue={cfg.undertimeGraceMinutes} />
          </Group>

          <Group title="Pay periods">
            <SelectField
              label="Period type"
              name="payrollPeriodType"
              defaultValue={cfg.payrollPeriodType}
              options={[
                ['monthly', 'Monthly'],
                ['semi_monthly', 'Twice a month'],
                ['weekly', 'Weekly'],
              ]}
            />
            <IntField label="Semi-monthly cutoff day" name="semiMonthlyCutoffDay" defaultValue={cfg.semiMonthlyCutoffDay} hint="Used when pay periods are twice a month" />
            <SelectField
              label="Payout mode"
              name="payoutMode"
              defaultValue={cfg.payoutMode}
              options={[
                ['lag', 'A set number of days after the period ends'],
                ['fixed_days', 'Fixed days, for example the 10th and 25th'],
              ]}
            />
            <IntField label="Payout lag (days)" name="payoutLagDays" defaultValue={cfg.payoutLagDays} hint="Used when pay comes a set number of days after the period ends" />
            <TextField
              label="Payout days"
              name="payoutDays"
              defaultValue={cfg.payoutDays.join(',')}
              hint="Days of the month, separated by commas. Needed when pay is on fixed days. For twice a month, give two different days no more than 16 days apart, for example 10,25 with cut-off 15."
            />
          </Group>

          <Group title="Sweep & terminal">
            <IntField
              label="Auto clock-out hour"
              name="autoClockOutHour"
              defaultValue={cfg.autoClockOutHour ?? ''}
              hint="Blank = this store never auto-clears"
            />
            <IntField label="Max shift hours" name="maxShiftHours" defaultValue={cfg.maxShiftHours} />
          </Group>

          </div>
        </EditableRecord>
      )}

      {leave && (
        <section id={`store-${storeId}`} className="space-y-4">
          <h2 className="text-lg font-semibold">Leave limits</h2>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            How many days of each kind a person may take in a month and in a year. Empty means no limit. The most specific row wins.
            Maternity and paternity ignore these limits. A kind required by law cannot go below its legal days.
          </p>
          {leave.caps.length > 0 && (
            <ul className="space-y-1 text-sm">
              {leave.caps.map((c) => (
                <li key={c.id} className="flex flex-wrap justify-between gap-2 border-t border-surface-border py-2">
                  <span>
                    {leave.kinds.find((k) => k.code === c.leaveType)?.label ?? c.leaveType}
                    <span className="text-neutral-500">
                      {' · '}
                      {c.storeId ? 'this store' : 'whole business'}
                      {c.positionId ? ` · ${leave.positions.find((p) => p.id === c.positionId)?.name ?? 'a position'}` : ''}
                    </span>
                  </span>
                  <span className="tabular-nums">
                    {c.monthlyCap ?? 'no limit'} a month · {c.yearlyCap ?? 'no limit'} a year
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="flex justify-end">
          <FormModal trigger="+ Set leave limit" title="Set a leave limit" size="md">
          <CheckedForm rules={SETTINGS_LEAVE_CAP_RULES} action={saveLeaveCapAction} className="space-y-3">
            <input type="hidden" name="storeId" value={storeId} />
            <FormGrid>
              <Field label="Kind of leave">
                <Select name="leaveType" className="mt-1 w-full">
                  {leave.kinds
                    .filter((k) => k.active)
                    .map((k) => (
                      <option key={k.code} value={k.code}>
                        {k.label}
                      </option>
                    ))}
                </Select>
              </Field>
              <Field label="Applies to" hint="The whole business needs an administrator.">
                <Select name="scope" defaultValue="store" className="mt-1 w-full">
                  <option value="store">This store</option>
                  <option value="org">The whole business</option>
                </Select>
              </Field>
              <Field label="Only for position">
                <Select name="positionId" defaultValue="" className="mt-1 w-full">
                  <option value="">Any position</option>
                  {leave.positions.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Days per month" hint="Empty = no limit." rule={SETTINGS_LEAVE_CAP_RULES.monthlyCap}>
                <Input {...nativeAttrs(SETTINGS_LEAVE_CAP_RULES.monthlyCap)} className="mt-1 w-full" />
              </Field>
              <Field label="Days per year" hint="Empty = no limit." rule={SETTINGS_LEAVE_CAP_RULES.yearlyCap}>
                <Input {...nativeAttrs(SETTINGS_LEAVE_CAP_RULES.yearlyCap)} className="mt-1 w-full" />
              </Field>
            </FormGrid>
            <DialogActions>
              <Button type="submit" variant="primary">
                Save leave limit
              </Button>
            </DialogActions>
          </CheckedForm>
          </FormModal>
          </div>

          <h3 className="font-medium">Kinds of leave</h3>
          <ul className="space-y-2">
            {leave.kinds.map((k) => (
              <li key={k.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-surface-border p-3 text-sm">
                <span>
                  <strong>{k.label}</strong>
                  {' · '}
                  {k.paid ? 'paid' : 'unpaid by default'}
                  {k.drawsSil ? ' · uses Service Incentive Leave when paid' : ''}
                  {k.statutory ? ' · required by law' : ''}
                  {!k.active ? ' · retired' : ''}
                </span>
                {k.orgId !== null && (
                  <form action={setLeaveTypeActiveAction}>
                    <input type="hidden" name="storeId" value={storeId} />
                    <input type="hidden" name="id" value={k.id} />
                    <input type="hidden" name="active" value={k.active ? 'no' : 'yes'} />
                    <Button type="submit" variant="secondary">
                      {k.active ? 'Retire' : 'Restore'}
                    </Button>
                  </form>
                )}
              </li>
            ))}
          </ul>
          <div className="flex justify-end">
          <FormModal trigger="+ Add kind of leave" title="Add a kind of leave" description="Administrators only." size="md">
          <CheckedForm rules={SETTINGS_LEAVE_KIND_RULES} action={addLeaveTypeAction} className="space-y-3">
            <input type="hidden" name="storeId" value={storeId} />
            <FormGrid>
              <Field label="Name" rule={SETTINGS_LEAVE_KIND_RULES.label}>
                <Input {...nativeAttrs(SETTINGS_LEAVE_KIND_RULES.label)} className="mt-1 w-full" />
              </Field>
              <Field label="Short code" hint="Letters, digits, underscores. Cannot be changed." rule={SETTINGS_LEAVE_KIND_RULES.code}>
                <Input {...nativeAttrs(SETTINGS_LEAVE_KIND_RULES.code)} className="mt-1 w-full" />
              </Field>
              <Field label="Pay">
                <Select name="paid" defaultValue="unpaid" className="mt-1 w-full">
                  <option value="unpaid">Unpaid</option>
                  <option value="paid">Paid</option>
                </Select>
              </Field>
            </FormGrid>
            <Checkbox name="needsProof" label="Needs a certificate" />
            <DialogActions>
              <Button type="submit" variant="secondary">
                Add kind
              </Button>
            </DialogActions>
          </CheckedForm>
          </FormModal>
          </div>
        </section>
      )}
    </Page>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
      <h2 className="text-sm font-medium">{title}</h2>
      <FormGrid className="gap-3">{children}</FormGrid>
    </section>
  );
}

function FieldShell({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className={LABEL}>{label}</span>
      {children}
      {hint && <span className="text-xs text-neutral-500">{hint}</span>}
    </label>
  );
}

function NumField({
  label,
  name,
  defaultValue,
  hint,
}: {
  label: string;
  name: string;
  defaultValue: string;
  hint?: string;
}) {
  return (
    <FieldShell label={label} hint={hint}>
      <input name={name} inputMode="decimal" defaultValue={defaultValue} className={RAW_FIELD} />
    </FieldShell>
  );
}

function IntField({
  label,
  name,
  defaultValue,
  hint,
}: {
  label: string;
  name: string;
  defaultValue: number | string;
  hint?: string;
}) {
  return (
    <FieldShell label={label} hint={hint}>
      <input name={name} inputMode="numeric" defaultValue={defaultValue} className={RAW_FIELD} />
    </FieldShell>
  );
}

function TextField({
  label,
  name,
  defaultValue,
  hint,
}: {
  label: string;
  name: string;
  defaultValue: string;
  hint?: string;
}) {
  return (
    <FieldShell label={label} hint={hint}>
      <Input type="text" name={name} defaultValue={defaultValue} className="w-full" />
    </FieldShell>
  );
}

function SelectField({
  label,
  name,
  defaultValue,
  options,
  hint,
}: {
  label: string;
  name: string;
  defaultValue: string;
  options: [string, string][];
  hint?: string;
}) {
  return (
    <FieldShell label={label} hint={hint}>
      <Select name={name} defaultValue={defaultValue} className="w-full">
        {options.map(([value, text]) => (
          <option key={value} value={value}>
            {text}
          </option>
        ))}
      </Select>
    </FieldShell>
  );
}

function CheckField({
  label,
  name,
  defaultChecked,
  hint,
}: {
  label: string;
  name: string;
  defaultChecked: boolean;
  hint?: string;
}) {
  return (
    <label className="flex items-start gap-2 rounded border border-neutral-200 px-2.5 py-2 dark:border-neutral-800">
      <input type="checkbox" name={name} defaultChecked={defaultChecked} className="mt-0.5" />
      <span>
        <span className="block text-xs font-medium">{label}</span>
        {hint && <span className="block text-xs text-neutral-500">{hint}</span>}
      </span>
    </label>
  );
}

// Raw <input> kept: t343-s5-5w-number-boxes.test.ts reads the helper's element text, so it cannot become <Input>.
const RAW_FIELD =
  'w-full rounded-[10px] border border-field-border bg-field px-3 py-2 min-h-11 text-sm text-ink';
const LABEL = 'text-xs font-medium text-neutral-600 dark:text-neutral-400';
