'use server';

/**
 * Server actions for `/payroll`. T-189.
 *
 * ⛔ Every gate is `authorize()` inside the service — `set_pay_rate` and `run_payroll`, both of
 * which deny a manager. A gate in a server action protects one caller.
 */
import { postPayRun, setPayRate, voidPayRun } from '@shareat/domain';
import { withOrgPrincipal } from './lib';
import { requireActor } from '../../lib/session';
import { errorMessage } from '../../lib/constraint-messages';
import { redirectWithFlash } from '@/lib/flash';
import { verifyAdminApproval } from '@shareat/auth';
import { loadDestructiveTarget, recordApproval } from '@/lib/destructive';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
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
    return await redirectWithFlash('/payroll', { store }, { error: errorMessage(err) });
  }
  return await redirectWithFlash(
    '/payroll',
    { store },
    { ok: 'Rate recorded. ⚠️ It applies from its effective date — earlier days keep the old rate.' },
  );
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
    return await redirectWithFlash('/payroll', { store, start, end }, { error: errorMessage(err) });
  }
  return await redirectWithFlash(
    '/payroll',
    { store },
    { stamp: 'POSTED', ok: `Posted ${out.payslips} payslip(s), ${out.totalNet} net. The days they paid are now frozen.` },
  );
}

export async function voidPayRunAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const store = str(formData, 'storeId');
  let out = { reversed: 0, unfrozenDays: 0 };
  try {
    // T-412 Tier P: an administrator's PIN, verified on the server against the RECORD's store (not the page's `storeId` field).
    const runId = str(formData, 'runId');
    const target = await loadDestructiveTarget(actor, 'pay_run', runId, ['run_payroll']);
    const approval = await verifyAdminApproval(null, { actor, storeId: target.storeId, pin: str(formData, 'adminPin'), capability: 'run_payroll' });
    out = await withOrgPrincipal(actor.orgId, async (tx) => {
      const voided = await voidPayRun(tx, actor, { runId, reason: str(formData, 'reason') });
      await recordApproval(tx, actor, approval, { capability: 'run_payroll', entityType: 'pay_run', entityId: runId, storeId: target.storeId });
      return voided;
    });
  } catch (err) {
    return await redirectWithFlash('/payroll', { store }, { error: errorMessage(err) });
  }
  return await redirectWithFlash(
    '/payroll',
    { store },
    {
      stamp: 'VOID',
      ok: `Voided — ${out.reversed} entry(s) reversed and ${out.unfrozenDays} day(s) unfrozen, so the period is payable again.`,
    },
  );
}
