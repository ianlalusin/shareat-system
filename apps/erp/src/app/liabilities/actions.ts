'use server';

/**
 * Server actions for the liability screens. T-128.
 *
 * ⛔ The gates live in the services, not here. A gate in a server action protects one caller.
 */
import { redirect } from 'next/navigation';
import {
  chargeLiability,
  createLiability,
  payLiability,
  retireLiability,
  reverseLiabilityEntry,
} from '@shareat/domain';
import type { LiabilityCategory } from '@shareat/db/schema';
import { withOrgPrincipal } from './lib';
import { requireActor } from '../../lib/session';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

/** Strips the throwing function's name — right for a log, useless on screen. */
function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^[a-z][A-Za-z0-9_]*:\s*/, '');
}

function back(path: string, params: Record<string, string>): never {
  redirect(`${path}?${new URLSearchParams(params).toString()}`);
}

export async function createLiabilityAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  let id = '';
  try {
    const storeId = str(formData, 'storeId');
    if (!storeId) throw new Error('Choose a store.');
    const created = await withOrgPrincipal(actor.orgId, (tx) =>
      createLiability(tx, actor, {
        storeId,
        name: str(formData, 'name'),
        category: (str(formData, 'category') || 'other') as LiabilityCategory,
        description: str(formData, 'description') || null,
        dueOn: str(formData, 'dueOn') || null,
        notes: str(formData, 'notes') || null,
      }),
    );
    id = created.id;
  } catch (err) {
    back('/liabilities', { error: errorMessage(err) });
  }
  back(`/liabilities/${id}`, {
    ok: 'Recorded. ⚠️ Nothing is owed yet — charge it to put the obligation on the books.',
  });
}

export async function chargeAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const id = str(formData, 'liabilityId');
  let message = '';
  try {
    const result = await withOrgPrincipal(actor.orgId, (tx) =>
      chargeLiability(tx, actor, {
        liabilityId: id,
        amount: str(formData, 'amount'),
        againstAccountCode: str(formData, 'againstAccountCode'),
        on: str(formData, 'on'),
        memo: str(formData, 'memo') || undefined,
      }),
    );
    message = `Charged. ₱${result.outstanding} now owed.`;
  } catch (err) {
    back(`/liabilities/${id}`, { error: errorMessage(err) });
  }
  back(`/liabilities/${id}`, { ok: message });
}

export async function payAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const id = str(formData, 'liabilityId');
  let message = '';
  try {
    const result = await withOrgPrincipal(actor.orgId, (tx) =>
      payLiability(tx, actor, {
        liabilityId: id,
        amount: str(formData, 'amount'),
        fromMoneyAccountId: str(formData, 'fromMoneyAccountId'),
        on: str(formData, 'on'),
        memo: str(formData, 'memo') || undefined,
      }),
    );
    // ⭐ Reports the LEDGER's answer, not the form's arithmetic.
    message = result.settled
      ? 'Paid. That settles it — the balance is zero.'
      : `Paid. ₱${result.outstanding} still owed.`;
    // ⚠️ Surfaced, not swallowed: a cashier account can read short because its count is unverified.
    if (result.warning) message += ` ⚠️ ${result.warning}`;
  } catch (err) {
    back(`/liabilities/${id}`, { error: errorMessage(err) });
  }
  back(`/liabilities/${id}`, { ok: message });
}

export async function reverseAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const id = str(formData, 'liabilityId');
  try {
    const reason = str(formData, 'reason');
    if (!reason) throw new Error('Say why this is being reversed.');
    await withOrgPrincipal(actor.orgId, (tx) =>
      reverseLiabilityEntry(tx, actor, {
        liabilityId: id,
        entryId: str(formData, 'entryId'),
        reason,
      }),
    );
  } catch (err) {
    back(`/liabilities/${id}`, { error: errorMessage(err) });
  }
  back(`/liabilities/${id}`, {
    ok: 'Reversed. Both entries stay on the ledger and net to nothing.',
  });
}

export async function retireAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const id = str(formData, 'liabilityId');
  try {
    await withOrgPrincipal(actor.orgId, (tx) => retireLiability(tx, actor, { liabilityId: id }));
  } catch (err) {
    back(`/liabilities/${id}`, { error: errorMessage(err) });
  }
  back('/liabilities', { });
}
