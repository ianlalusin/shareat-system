'use server';

/**
 * Server actions for `/payroll`. T-189.
 *
 * ⛔ Every gate is `authorize()` inside the service — `set_pay_rate` and `run_payroll`, both of
 * which deny a manager. A gate in a server action protects one caller.
 */
import { redirect } from 'next/navigation';
import { postPayRun, setPayRate, voidPayRun } from '@shareat/domain';
import { withOrgPrincipal } from './lib';
import { requireActor } from '../../lib/session';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

/** ⚠️ Only the WORDING is ours — re-checking these in TypeScript would be a second source of truth. */
const CONSTRAINT_MESSAGES: Record<string, string> = {
  pay_runs_no_overlapping_posted_period:
    'A posted run already covers part of that period. ⛔ Periods may not overlap — the overlap ' +
    'would be paid twice. Void the existing run first, or choose dates outside it.',
  pay_rates_employment_from_unique:
    'That job already has a rate starting on that date. Pick a different effective date, or ' +
    'supersede it from the day the new rate really begins.',
  pay_rates_amount_positive_check: 'A pay rate has to be more than zero.',
  payslips_run_employment_unique: 'That person already has a payslip in this run.',
  attendance_days_frozen_by_pay_run_fk: 'Those days belong to a pay run that still exists.',
};

function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  for (const [constraint, message] of Object.entries(CONSTRAINT_MESSAGES)) {
    if (raw.includes(constraint)) return message;
  }
  return raw.replace(/^[a-zA-Z][A-Za-z0-9_]*:\s*/, '');
}

function back(params: Record<string, string>): never {
  redirect(`/payroll?${new URLSearchParams(params).toString()}`);
}

export async function setPayRateAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const store = str(formData, 'storeId');
  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      setPayRate(tx, actor, {
        employmentId: str(formData, 'employmentId'),
        storeId: store,
        basis: (str(formData, 'basis') || 'daily') as 'daily' | 'hourly',
        amount: str(formData, 'amount'),
        effectiveFrom: str(formData, 'effectiveFrom'),
        note: str(formData, 'note') || null,
      }),
    );
  } catch (err) {
    back({ store, error: errorMessage(err) });
  }
  back({ store, ok: 'Rate recorded. ⚠️ It applies from its effective date — earlier days keep the old rate.' });
}

export async function postPayRunAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const store = str(formData, 'storeId');
  const start = str(formData, 'periodStart');
  const end = str(formData, 'periodEnd');
  let out = { payslips: 0, totalNet: '' };
  try {
    out = await withOrgPrincipal(actor.orgId, (tx) =>
      postPayRun(tx, actor, {
        storeId: store,
        periodStart: start,
        periodEnd: end,
        moneyAccountId: str(formData, 'moneyAccountId'),
        notes: str(formData, 'notes') || null,
      }),
    );
  } catch (err) {
    back({ store, start, end, error: errorMessage(err) });
  }
  back({
    store,
    ok: `Posted ${out.payslips} payslip(s), ${out.totalNet} net. The days they paid are now frozen.`,
  });
}

export async function voidPayRunAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const store = str(formData, 'storeId');
  let out = { reversed: 0, unfrozenDays: 0 };
  try {
    out = await withOrgPrincipal(actor.orgId, (tx) =>
      voidPayRun(tx, actor, { runId: str(formData, 'runId'), reason: str(formData, 'reason') }),
    );
  } catch (err) {
    back({ store, error: errorMessage(err) });
  }
  back({
    store,
    ok: `Voided — ${out.reversed} entry(s) reversed and ${out.unfrozenDays} day(s) unfrozen, so the period is payable again.`,
  });
}
