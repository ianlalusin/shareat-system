'use server';

/**
 * Server actions for `/payroll/thirteenth-month`. T-191.
 *
 * ⛔ Every gate is `authorize()` inside the service (`run_payroll`) — same shape as
 * `payroll/actions.ts`. A gate in a server action protects one caller.
 */
import { redirect } from 'next/navigation';
import { post13thMonthRun, void13thMonthRun } from '@shareat/domain';
import { withOrgPrincipal } from './lib';
import { requireActor } from '../../../lib/session';
import { errorMessage } from '../../../lib/constraint-messages';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

function back(params: Record<string, string>): never {
  redirect(`/payroll/thirteenth-month?${new URLSearchParams(params).toString()}`);
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
    back({ store, year, error: errorMessage(err) });
  }
  back({
    store,
    year,
    ok: `Posted ${out.payouts} payout(s), ${out.totalNet} net.`,
  });
}

export async function void13thMonthRunAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const store = str(formData, 'storeId');
  const year = str(formData, 'year');
  let out = { reversed: 0 };
  try {
    out = await withOrgPrincipal(actor.orgId, (tx) =>
      void13thMonthRun(tx, actor, { runId: str(formData, 'runId'), reason: str(formData, 'reason') }),
    );
  } catch (err) {
    back({ store, year, error: errorMessage(err) });
  }
  back({
    store,
    year,
    ok: `Voided — ${out.reversed} entry(s) reversed. That year is payable again.`,
  });
}
