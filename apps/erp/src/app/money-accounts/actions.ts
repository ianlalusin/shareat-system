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
import { assertFieldRules, createMoneyAccount, renameMoneyAccount, retireMoneyAccount } from '@shareat/domain';
import { MONEY_ACCOUNT_CREATE_RULES, MONEY_ACCOUNT_RENAME_RULES } from '@shareat/domain/field-rules';
import type { Custodian, MoneyInstrument } from '@shareat/db';
import { withOrgPrincipal } from './lib';
import { requireActor } from '../../lib/session';
import { errorMessage } from '@/lib/constraint-messages';
import { redirectWithFlash } from '@/lib/flash';
import { keepTyping } from '@/lib/keep-typing';
import { MONEY_ACCOUNT_RENAME } from './typed-forms';
import { loadDestructiveTarget, retypeRefusalError } from '@/lib/destructive';
import { retypeMatches } from '@/lib/retype';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

export async function createMoneyAccountAction(formData: FormData): Promise<void> {
  const actor = await requireActor();

  try {
    assertFieldRules(MONEY_ACCOUNT_CREATE_RULES, formData);
    const storeId = str(formData, 'storeId');

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
    // T-412 Tier R: the person retypes the account's name; the server compares it with the name IT loads.
    const moneyAccountId = str(formData, 'moneyAccountId');
    const target = await loadDestructiveTarget(actor, 'money_account', moneyAccountId, ['manage_chart_of_accounts']);
    if (!retypeMatches(str(formData, 'confirmName'), target.name ?? '')) throw retypeRefusalError(target.name ?? '');
    await withOrgPrincipal(actor.orgId, (tx) =>
      retireMoneyAccount(tx, actor, { moneyAccountId }),
    );
  } catch (err) {
    return await redirectWithFlash('/money-accounts', {}, { error: errorMessage(err) });
  }

  return await redirectWithFlash('/money-accounts', {}, { ok: 'retired' });
}

export async function renameMoneyAccountAction(formData: FormData): Promise<void> {
  const actor = await requireActor();

  try {
    assertFieldRules(MONEY_ACCOUNT_RENAME_RULES, formData);
    await withOrgPrincipal(actor.orgId, (tx) =>
      renameMoneyAccount(tx, actor, {
        moneyAccountId: str(formData, 'moneyAccountId'),
        name: str(formData, 'name'),
        // ⚠️ Blank means "leave it alone", not "set it to zero" — zero is a real, strict setting.
        overdraftLimit: str(formData, 'overdraftLimit') || null,
      }),
    );
  } catch (err) {
    return await redirectWithFlash('/money-accounts', {}, { error: errorMessage(err), typed: keepTyping(formData, MONEY_ACCOUNT_RENAME, str(formData, 'moneyAccountId'), { actorId: actor.personId }) });
  }

  return await redirectWithFlash('/money-accounts', {}, { ok: 'renamed' });
}
