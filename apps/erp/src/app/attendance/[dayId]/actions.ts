'use server';

/**
 * Server actions for the attendance day review. T-195, closing **DEF-113**.
 *
 * ⛔ **These are the callers `recordAdjustment` never had.** Six adjustment kinds shipped with
 * T-158 and nothing in `apps/erp` invoked any of them, so no overtime could be approved, no
 * `needs_review` day could be resolved, and no day could be verified or voided.
 *
 * ⭐ **Every gate lives in the service, not here.** `recordAdjustment` authorizes
 * `manage_attendance`, refuses a frozen day, refuses self-adjudication (bible §7 rule 6) and
 * refuses an inverted anchor/early-out pair. A check in a server action protects one caller; these
 * actions deliberately add none of their own. ⚠️ The screen *shows* why a control is closed — that
 * is presentation, and it is never the enforcement.
 *
 * ⚠️ One action per kind rather than one generic action taking a `kind` from the form: the form
 * would then choose which decision was made, and "widening one op grants ALL" is a mistake this
 * codebase has already paid for once.
 *
 * T-352 / DEF-478 — the three minute fields are passed RAW and parsed inside `recordAdjustment`,
 * after its `authorize()` call, not here.
 */
import { redirect } from 'next/navigation';
import { recordAdjustment } from '@shareat/domain';
import { requireSession } from '../../../lib/session';
import { withOrgPrincipal } from '../lib';
import { errorMessage } from '@/lib/constraint-messages';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

function back(dayId: string, params: Record<string, string>): never {
  redirect(`/attendance/${dayId}?${new URLSearchParams(params).toString()}`);
}

type Kind = 'start_anchor' | 'early_out_approved' | 'half_day_override' | 'overtime_approved' | 'verify' | 'void';

/**
 * ⚠️ Returns the service's own message. These refusals are written to be read by a manager —
 * *"This day still has unresolved anomalies (missing_out). Settle them first"* — and rewording
 * them here would put a second, worse copy in front of the person who needs the first.
 */
async function decide(
  formData: FormData,
  build: (fd: FormData) => { kind: Kind } & Record<string, unknown>,
  ok: string,
): Promise<never> {
  const { actor, sessionId } = await requireSession();
  const dayId = str(formData, 'dayId');
  const employmentId = str(formData, 'employmentId');
  const shiftDay = str(formData, 'shiftDay');
  try {
    const payload = build(formData);
    await withOrgPrincipal(actor.orgId, (tx) =>
      recordAdjustment(tx, actor, {
        employmentId,
        shiftDay,
        sessionId,
        ...payload,
      } as Parameters<typeof recordAdjustment>[2]),
    );
  } catch (err) {
    back(dayId, { error: errorMessage(err) });
  }
  back(dayId, { ok });
}

/**
 * ⭐ **The gate DEF-109 exists to hold.** `null` means nobody decided and pays NOTHING; a typed
 * zero is a real decision and settles the day. The form therefore always sends a number — an
 * empty box is not "approve nothing", it is a manager who has not finished.
 */
export async function approveOvertimeAction(formData: FormData): Promise<void> {
  await decide(
    formData,
    (fd) => ({
      kind: 'overtime_approved',
      approvedOtMinutes: str(fd, 'approvedOtMinutes'),
    }),
    'Overtime decided. ⭐ It is paid by the next run — approved minutes only, capped at what was worked.',
  );
}

export async function setStartAnchorAction(formData: FormData): Promise<void> {
  await decide(
    formData,
    (fd) => ({
      kind: 'start_anchor',
      chosenAnchorMinute: str(fd, 'chosenAnchorMinute'),
    }),
    'Start recorded. ⚠️ The original tap is unchanged — this is the start the day is PAID from.',
  );
}

export async function approveEarlyOutAction(formData: FormData): Promise<void> {
  await decide(
    formData,
    (fd) => ({
      kind: 'early_out_approved',
      effectiveOutMinute: str(fd, 'effectiveOutMinute'),
    }),
    'Early out approved. The day is paid to that time rather than to the actual tap.',
  );
}

export async function overrideHalfDayAction(formData: FormData): Promise<void> {
  await decide(
    formData,
    (fd) => ({
      kind: 'half_day_override',
      isHalfDay: str(fd, 'isHalfDay') === 'true',
      reason: str(fd, 'reason'),
    }),
    'Half-day status set by override.',
  );
}

export async function verifyDayAction(formData: FormData): Promise<void> {
  await decide(
    formData,
    () => ({ kind: 'verify' }),
    'Day verified. ⭐ This is the only thing that can rescue a flagged day — payroll can now pay it.',
  );
}

export async function voidDayAction(formData: FormData): Promise<void> {
  await decide(
    formData,
    (fd) => ({ kind: 'void', reason: str(fd, 'reason') }),
    'Day voided. ⛔ It contributes nothing to payroll. The punches are untouched — the evidence survives the decision.',
  );
}
