'use server';

/**
 * Server actions for the money-accounts screen. ADR-010, bible rows 142–149.
 *
 * Thin adapters: parse `FormData`, call the domain, redirect. ⛔ **The admin-only rule is NOT
 * enforced here** — `createMoneyAccount` and `retireMoneyAccount` call `authorize()` themselves
 * (row 149). A gate in a server action protects one caller; a gate in the domain protects every
 * caller there will ever be.
 *
 * ⭐ The actor comes from `requireActor()`, never the form (T-138, bible §7.1).
 */
import { createMoneyAccount, renameMoneyAccount, retireMoneyAccount } from '@shareat/domain';
import type { Custodian, MoneyInstrument } from '@shareat/db';
import { withOrgPrincipal } from './lib';
import { requireActor } from '../../lib/session';
import { errorMessage } from '@/lib/constraint-messages';
import { redirectWithFlash } from '@/lib/flash';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

export async function createMoneyAccountAction(formData: FormData): Promise<void> {
  const actor = await requireActor();

  try {
    const storeId = str(formData, 'storeId');
    if (!storeId) throw new Error('Choose a store — money always sits somewhere.');

    await withOrgPrincipal(actor.orgId, (tx) =>
      createMoneyAccount(tx, actor, {
        storeId,
        name: str(formData, 'name'),
        instrument: str(formData, 'instrument') as MoneyInstrument,
        custodian: str(formData, 'custodian') as Custodian,
        notes: str(formData, 'notes') || null,
      }),
    );
  } catch (err) {
    return await redirectWithFlash('/money-accounts', {}, { error: errorMessage(err) });
  }

  return await redirectWithFlash('/money-accounts', {}, { ok: 'created' });
}

export async function retireMoneyAccountAction(formData: FormData): Promise<void> {
  const actor = await requireActor();

  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      retireMoneyAccount(tx, actor, { moneyAccountId: str(formData, 'moneyAccountId') }),
    );
  } catch (err) {
    return await redirectWithFlash('/money-accounts', {}, { error: errorMessage(err) });
  }

  return await redirectWithFlash('/money-accounts', {}, { ok: 'retired' });
}

export async function renameMoneyAccountAction(formData: FormData): Promise<void> {
  const actor = await requireActor();

  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      renameMoneyAccount(tx, actor, {
        moneyAccountId: str(formData, 'moneyAccountId'),
        name: str(formData, 'name'),
        // ⚠️ Blank means "leave it alone", not "set it to zero" — zero is a real, strict setting.
        overdraftLimit: str(formData, 'overdraftLimit') || null,
      }),
    );
  } catch (err) {
    return await redirectWithFlash('/money-accounts', {}, { error: errorMessage(err) });
  }

  return await redirectWithFlash('/money-accounts', {}, { ok: 'renamed' });
}
