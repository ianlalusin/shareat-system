import { requirePageAccess } from '../../../lib/page-access';
import { addShiftDays, toShiftDay } from '@shareat/domain';
import { updateAttendanceConfigAction } from './actions';
import { liveConfigFor, listStores } from './lib';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { EditableRecord } from '@/components/forms';
import { FormGrid } from '@/components/ui';
import { withFlash } from '@/lib/flash';

export const metadata = { title: 'Attendance & payroll settings — Shareat System' };
export const dynamic = 'force-dynamic';

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

  return (
    <Page density="table">
      <div>
        <h1 className="text-2xl font-semibold">Attendance & payroll settings</h1>
        <PageDescription>
          One store, one policy, effective from a chosen day. ⚠️ A change never rewrites a day
          already computed — it governs from the date below onward. See it reflected on{' '}
          <a href="/payroll" className="underline">
            /payroll
          </a>
          .
        </PageDescription>
      </div>

      <form className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-0 flex-1 flex-col gap-1">
          <span className={LABEL}>Store</span>
          <select name="store" defaultValue={storeId} className={`${FIELD} w-full`}>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className={BTN}>
          Switch
        </button>
      </form>

      {sp.error && <Banner tone="error">{sp.error}</Banner>}
      {sp.ok && <Banner tone="ok">{sp.ok}</Banner>}

      {!cfg ? (
        <p className="rounded border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
          This store has no attendance config yet.
        </p>
      ) : (
        <EditableRecord action={updateAttendanceConfigAction} label="attendance policy" hidden={{ storeId }}>
          <div className="space-y-6">
          <label className="flex flex-col gap-1">
            <span className={LABEL}>Effective from</span>
            <input
              name="effectiveFrom"
              type="date"
              required
              defaultValue={defaultEffectiveFrom}
              className={`${FIELD} w-full`}
            />
            <span className="text-xs text-neutral-500">
              ⛔ Must be after {cfg.effectiveFrom} (today&rsquo;s live policy) and cannot fall on or
              before a day already adjudicated.
            </span>
          </label>

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
                ['open', 'open — free clock in/out'],
                ['fixed', 'fixed — posted shift grid'],
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
                ['multiplier', 'multiplier — × the hourly-equivalent daily rate'],
                ['fixed', 'fixed — flat pesos / OT hour'],
              ]}
            />
            <NumField label="Overtime multiplier" name="overtimeMultiplier" defaultValue={cfg.overtimeMultiplier} hint="used when mode is multiplier" />
            <NumField
              label="Overtime fixed hourly (₱)"
              name="overtimeFixedHourly"
              defaultValue={cfg.overtimeFixedHourly ?? ''}
              hint="required when mode is fixed"
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
                ['record_only', 'record only — no money'],
                ['charge_per_minute', 'charge per minute — a real payslip deduction'],
                ['infraction', 'infraction — points only, no money'],
              ]}
            />
            <NumField label="Late charge / minute (₱)" name="lateChargePerMinute" defaultValue={cfg.lateChargePerMinute} hint="required when policy is charge_per_minute" />
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
                ['monthly', 'monthly'],
                ['semi_monthly', 'semi-monthly'],
                ['weekly', 'weekly'],
              ]}
            />
            <IntField label="Semi-monthly cutoff day" name="semiMonthlyCutoffDay" defaultValue={cfg.semiMonthlyCutoffDay} hint="used when period type is semi-monthly" />
            <SelectField
              label="Payout mode"
              name="payoutMode"
              defaultValue={cfg.payoutMode}
              options={[
                ['lag', 'lag — N days after period end'],
                ['fixed_days', 'fixed days — e.g. paid on the 10th & 25th'],
              ]}
            />
            <IntField label="Payout lag (days)" name="payoutLagDays" defaultValue={cfg.payoutLagDays} hint="used when payout mode is lag" />
            <TextField
              label="Payout days"
              name="payoutDays"
              defaultValue={cfg.payoutDays.join(',')}
              hint="Comma-separated day-of-month, required when payout mode is fixed_days. Semi-monthly: two different days, never more than 16 days from one payday to the next (the cutoff day changes this), e.g. 10,25 with cutoff 15."
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
      {hint && <span className="text-[11px] text-neutral-500">{hint}</span>}
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
      <input name={name} inputMode="decimal" defaultValue={defaultValue} className={`${FIELD} w-full`} />
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
      <input name={name} inputMode="numeric" defaultValue={defaultValue} className={`${FIELD} w-full`} />
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
      <input type="text" name={name} defaultValue={defaultValue} className={`${FIELD} w-full`} />
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
      <select name={name} defaultValue={defaultValue} className={`${FIELD} w-full`}>
        {options.map(([value, text]) => (
          <option key={value} value={value}>
            {text}
          </option>
        ))}
      </select>
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
        {hint && <span className="block text-[11px] text-neutral-500">{hint}</span>}
      </span>
    </label>
  );
}

function Banner({ tone, children }: { tone: 'error' | 'ok'; children: React.ReactNode }) {
  const cls =
    tone === 'error'
      ? 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-300'
      : 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300';
  return <div className={`rounded-lg border p-4 text-sm ${cls}`}>{children}</div>;
}

const FIELD =
  'rounded border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950';
const LABEL = 'text-xs font-medium text-neutral-600 dark:text-neutral-400';
const BTN =
  'rounded border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900';
