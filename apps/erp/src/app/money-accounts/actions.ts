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
import { redirect } from 'next/navigation';
import { createMoneyAccount, retireMoneyAccount } from '@shareat/domain';
import type { Custodian, MoneyInstrument } from '@shareat/db';
import { withOrgPrincipal } from './lib';
import { requireActor } from '../../lib/session';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * The message a person should read.
 *
 * ⚠️ Domain errors are prefixed with the function that threw — `createMoneyTransfer: ...` — which
 * is exactly right in a log and useless on screen. Strips a leading camelCase identifier and its
 * colon, and nothing else: the sentence after it is already written for a human.
 */
function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^[a-z][A-Za-z0-9_]*:\s*/, '');
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
    redirect(`/money-accounts?error=${encodeURIComponent(errorMessage(err))}`);
  }

  redirect('/money-accounts?ok=created');
}

export async function retireMoneyAccountAction(formData: FormData): Promise<void> {
  const actor = await requireActor();

  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      retireMoneyAccount(tx, actor, { moneyAccountId: str(formData, 'moneyAccountId') }),
    );
  } catch (err) {
    redirect(`/money-accounts?error=${encodeURIComponent(errorMessage(err))}`);
  }

  redirect('/money-accounts?ok=retired');
}
