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
import { errorMessage, recordIfUnmappedConstraint } from '../../lib/constraint-messages';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
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
    // T-252 — DEF-246: measures which unmapped constraints are actually hit, before anyone
    // writes a hand-crafted sentence for one. Never blocks or changes this redirect.
    await recordIfUnmappedConstraint(err, { orgId: actor.orgId, storeId: store || null, actorPersonId: actor.personId });
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
    await recordIfUnmappedConstraint(err, { orgId: actor.orgId, storeId: store || null, actorPersonId: actor.personId });
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
    await recordIfUnmappedConstraint(err, { orgId: actor.orgId, storeId: store || null, actorPersonId: actor.personId });
    back({ store, error: errorMessage(err) });
  }
  back({
    store,
    ok: `Voided — ${out.reversed} entry(s) reversed and ${out.unfrozenDays} day(s) unfrozen, so the period is payable again.`,
  });
}
