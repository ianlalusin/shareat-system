'use server';

/**
 * Server actions for `/payroll/thirteenth-month`. T-191.
 *
 * ⛔ Every gate is `authorize()` inside the service (`run_payroll`) — same shape as
 * `payroll/actions.ts`. A gate in a server action protects one caller.
 */
import { post13thMonthRun, void13thMonthRun } from '@shareat/domain';
import { withOrgPrincipal } from './lib';
import { requireActor } from '../../../lib/session';
import { errorMessage } from '../../../lib/constraint-messages';
import { redirectWithFlash } from '@/lib/flash';
import { verifyAdminApproval } from '@shareat/auth';
import { loadDestructiveTarget, recordApproval } from '@/lib/destructive';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

export async function post13thMonthRunAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const store = str(formData, 'storeId');
  const year = str(formData, 'year');
  let out = { payouts: 0, totalNet: '' };
  try {
    out = await withOrgPrincipal(actor.orgId, (tx) =>
      post13thMonthRun(tx, actor, {
        storeId: store,
        year: Number(year),
        moneyAccountId: str(formData, 'moneyAccountId'),
        notes: str(formData, 'notes') || null,
      }),
    );
  } catch (err) {
    return await redirectWithFlash('/payroll/thirteenth-month', { store, year }, { error: errorMessage(err) });
  }
  return await redirectWithFlash(
    '/payroll/thirteenth-month',
    { store, year },
    { ok: `Posted ${out.payouts} payout(s), ${out.totalNet} net.` },
  );
}

export async function void13thMonthRunAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const store = str(formData, 'storeId');
  const year = str(formData, 'year');
  let out = { reversed: 0 };
  try {
    // T-412 Tier P: an administrator's PIN, verified on the server against the RECORD's store (not the page's `storeId` field).
    const runId = str(formData, 'runId');
    const target = await loadDestructiveTarget(actor, 'thirteenth_month_run', runId, ['run_payroll']);
    const approval = await verifyAdminApproval(null, { actor, storeId: target.storeId, pin: str(formData, 'adminPin'), capability: 'run_payroll' });
    out = await withOrgPrincipal(actor.orgId, async (tx) => {
      const voided = await void13thMonthRun(tx, actor, { runId, reason: str(formData, 'reason') });
      await recordApproval(tx, actor, approval, { capability: 'run_payroll', entityType: 'thirteenth_month_run', entityId: runId, storeId: target.storeId });
      return voided;
    });
  } catch (err) {
    return await redirectWithFlash('/payroll/thirteenth-month', { store, year }, { error: errorMessage(err) });
  }
  return await redirectWithFlash(
    '/payroll/thirteenth-month',
    { store, year },
    { ok: `Voided — ${out.reversed} entry(s) reversed. That year is payable again.` },
  );
}
