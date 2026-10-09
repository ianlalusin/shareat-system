import { expect, vi } from 'vitest';

/**
 * T-389 S2 (TESTER) - settings/attendance: the 37-control attendance policy form keeps what was typed after a refused
 * save (DEF-617). Spec: docs/tasks/389-refused-save-keeps-typing.md. Legs and harness: t389-s2-common.ts.
 *
 * Form (record = the store id, a per-store singleton): updateAttendanceConfigAction. Refusal driven: an effective date
 * on or before the live policy's ("must take effect after the current one"), which the browser's own `required` cannot
 * pre-empt (a date is present). The form shape is t370-settings-attendance-web.test.ts's, plus two ticked boxes.
 *
 * CONTRACT PINNED HERE (spec silent; the builder matches):
 *  - form key `attendance.policy`; record = the store id; allow-list = every named control of the form EXCEPT the hidden
 *    storeId: effectiveFrom + the 28 text/number/select controls + overtimeFixedHourly + 7 checkboxes (breakEnabled,
 *    halfDayOnMissingTap, credentialNfc, credentialFingerprint, credentialFace, shortShiftHalfDayOt, nightDiffEnabled).
 *  - with no `__changed` (a no-JavaScript submit) every SUBMITTED allow-listed name is kept, so an unticked box (the
 *    browser sends nothing) is absent; with `__changed` an unticked changed box rides as [] (spec R5, S1's W2).
 *  - the nav key `store` rides the redirect (the action already sets it), so the same store reopens.
 */
const h = vi.hoisted(() => ({ actor: null as null | { personId: string; orgId: string } }));
const seen = vi.hoisted(() => ({ records: [] as Array<Record<string, unknown>> }));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => h.actor),
  requireSession: vi.fn(async () => ({ actor: h.actor, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01') })),
}));
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));
vi.mock('@/components/forms', async (orig) => {
  const real = await orig<typeof import('@/components/forms')>();
  const { createElement } = await import('react');
  return {
    ...real,
    EditableRecord: (p: Record<string, unknown>) => {
      seen.records.push(p);
      return createElement(real.EditableRecord as never, p as never);
    },
  };
});

import { seedAttendanceConfig } from '@shareat/domain';
import { asOrg, createHarness, fixture, LONG, sql, type BaseCtx, type FormCase } from './t389-s2-common';

const { runTypedLegs } = createHarness({ h, seen });

/** The values the user typed in; the browser sends them all. 7.77 / 3.33 are never a stored default. */
function typedBase(storeId: string): Record<string, string> {
  return {
    storeId,
    effectiveFrom: '2026-01-01', // on the live policy's own day: refused
    requiredHoursPerShift: '7.77',
    halfDayHours: '3.33',
    allowedShiftStartHours: '9,10,11,14,15,16,17,18',
    anchorWindowMinutes: '30',
    timeMode: 'open',
    defaultWorkHours: '8',
    defaultBreakHours: '1',
    breakEnabled: 'on',
    credentialNfc: 'on',
    overtimeMode: 'multiplier',
    overtimeMultiplier: '1.25',
    overtimeFixedHourly: '',
    nightDiffStartHour: '22',
    nightDiffEndHour: '6',
    nightDiffMultiplier: '1.10',
    holidayRegularMultiplier: '2.00',
    holidaySpecialNonWorkingMultiplier: '1.30',
    holidaySpecialWorkingMultiplier: '1.50',
    latePolicy: 'infraction',
    lateChargePerMinute: '0',
    lateInfractionPoints: '1',
    lateGraceMinutes: '0',
    earlyOutGraceMinutes: '0',
    undertimeGraceMinutes: '0',
    payrollPeriodType: 'semi_monthly',
    semiMonthlyCutoffDay: '15',
    payoutMode: 'fixed_days',
    payoutLagDays: '0',
    payoutDays: '10,25',
    autoClockOutHour: '',
    maxShiftHours: '16',
  };
}
const { storeId: _hidden, ...ALLOWED_VALUES } = typedBase('');
void _hidden;

const policy: FormCase<BaseCtx> = {
  label: 'settings attendance policy',
  form: 'attendance.policy',
  setup: async (hint) => {
    const f = await fixture(`att-${hint}`);
    await asOrg(f.orgId, (tx) => seedAttendanceConfig(tx, { orgId: f.orgId, storeId: f.storeId, effectiveFrom: '2026-01-01' }));
    return { f, record: f.storeId };
  },
  action: async () => (await import('../../src/app/settings/attendance/actions')).updateAttendanceConfigAction,
  page: async () => (await import('../../src/app/settings/attendance/page')).default as never,
  props: (_ctx, params) => ({ params: Promise.resolve({}) as never, searchParams: Promise.resolve(params) }),
  sel: (ctx) => ({ action: 'updateAttendanceConfigAction', hidden: { storeId: ctx.record } }),
  has: (ctx) => [`name="storeId" value="${ctx.record}"`, 'name="requiredHoursPerShift"'],
  hiddenNames: ['storeId'],
  refused: (ctx, over = {}) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries({ ...typedBase(ctx.record), ...over })) if (v !== null) fd.set(k, v as string);
    return fd;
  },
  refusal: /take effect after the current one/,
  fields: () => {
    expect(Object.keys(ALLOWED_VALUES), 'sanity: 32 submitted allow-listed names').toHaveLength(32);
    return { ...ALLOWED_VALUES };
  },
  changed: {
    list: 'requiredHoursPerShift,halfDayOnMissingTap,breakEnabled,latePolicy',
    fields: () => ({ requiredHoursPerShift: '7.77', halfDayOnMissingTap: [], breakEnabled: 'on', latePolicy: 'infraction' }),
  },
  notDrawn: ['7.77', '3.33'],
  stored: async (ctx, seg, m) => {
    const [row] = await sql<{ required_hours_per_shift: string; half_day_hours: string; late_policy: string; break_enabled: boolean; credential_nfc: boolean }[]>`
      select required_hours_per_shift, half_day_hours, late_policy, break_enabled, credential_nfc
        from store_attendance_config where store_id = ${ctx.record} and superseded_at is null`;
    expect(m.inputValue(seg, 'requiredHoursPerShift'), 'the stored hours are drawn').toBe(row!.required_hours_per_shift);
    expect(m.inputValue(seg, 'halfDayHours')).toBe(row!.half_day_hours);
    expect(m.selectedValue(seg, 'latePolicy')).toBe(row!.late_policy);
    expect(m.checkedValues(seg, 'breakEnabled').length, 'the stored box state, not the typed one').toBe(row!.break_enabled ? 1 : 0);
    expect(m.checkedValues(seg, 'credentialNfc').length).toBe(row!.credential_nfc ? 1 : 0);
  },
  tooLong: { allowedShiftStartHours: LONG },
  good: (ctx) => policy.refused(ctx, { effectiveFrom: '2026-06-01' }),
  ok: /Saved\. The new policy takes effect from 2026-06-01/,
};

runTypedLegs(policy);
