'use server';

/**
 * Server action for the service-charge distribution screen. T-187 slice 1.
 *
 * ⛔ The gates live in the domain function, not here. `distributeServiceCharge` computes the
 * store's own cap from the ledger and refuses before any write — this action only shapes the
 * form and reports back what it said.
 */
import { redirect } from 'next/navigation';
// ⭐ Subpath import, not the `@shareat/domain` barrel — same pattern as `@shareat/domain/money-lines`
// and `@shareat/domain/money-input` (packages/domain/package.json). The barrel is the
// orchestrator's to wire; this is additive and does not touch it.
import { distributeServiceCharge } from '@shareat/domain/service-charge';
import { withOrgPrincipal } from './lib';
import { requireActor } from '../../lib/session';
import { errorMessage } from '@/lib/constraint-messages';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

function back(storeId: string, params: Record<string, string>): never {
  redirect(`/service-charge?${new URLSearchParams({ store: storeId, ...params }).toString()}`);
}

export async function distributeAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const storeId = str(formData, 'storeId');
  let created = false;
  let entryId = '';
  let warning: string | undefined;
  try {
    if (!storeId) throw new Error('Choose a store.');
    const result = await withOrgPrincipal(actor.orgId, (tx) =>
      distributeServiceCharge(tx, actor, {
        storeId,
        moneyAccountId: str(formData, 'moneyAccountId'),
        amount: str(formData, 'amount'),
        paidOn: str(formData, 'paidOn'),
      }),
    );
    created = result.created;
    entryId = result.entryId;
    warning = result.warning;
  } catch (err) {
    back(storeId, { error: errorMessage(err) });
  }
  // ⛔ AMENDMENT 2's replay guard makes a resubmitted store+payday a no-op on the LEDGER —
  // `created: false` means `postEntry` found the same idempotency key and posted NOTHING.
  // Reporting "Distributed" here would be true of an EARLIER call and false of this one: cash
  // would look discharged twice while the ledger only shows it once. Say so, and name the entry
  // that already exists — and stop there. §2 rules ONE aggregate entry per store per payday, so
  // there is no legitimate second one to route the operator toward; a hint about changing the
  // payday to "make it post" is the exact move that defeats the key this guard depends on.
  if (!created) {
    back(storeId, {
      error: `A distribution for this store on this payday already exists (entry ${entryId}). Nothing new was posted.`,
    });
  }
  // ⚠️ Surfaced, not swallowed — same convention as payLiability's action: the money account can
  // read short because `checkDraw` allows a cashier drawer to go negative with a warning rather
  // than a refusal (service-charge payouts are expected to come from office/wallet accounts, but
  // the warning is propagated unconditionally so this stays correct if that ever changes).
  back(storeId, {
    ok: `Distributed.${warning ? ` ⚠️ ${warning}` : ''} Who received what is processed and documented manually.`,
  });
}
