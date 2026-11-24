/**
 * T-629 - a test helper for the many tests written before the payment-option master list: "a tender called X of kind K at this store" is now
 * "switch on the org's option called X (made here when the org has none)". The option is found by the same normalised name the app uses.
 */
import { posV1Repo, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { normalizePosV1Alias } from '../../../src/pos/v1-methods';

type SwitchOn = (tx: Tx, actor: Actor, input: { storeId: string; paymentOptionId: string; moneyAccountId?: string | null; posV1Alias?: string | null }) => Promise<{ id: string }>;

export async function createTenderByName(
  mod: { switchOnPaymentOption: SwitchOn },
  tx: Tx,
  actor: Actor,
  input: { storeId: string; name: string; kind: 'cash' | 'wallet'; moneyAccountId?: string | null; posV1Alias?: string | null },
): Promise<{ id: string }> {
  let option = await posV1Repo.findPaymentOptionByKey(tx, actor.orgId, normalizePosV1Alias(input.name));
  if (!option) {
    const { id } = await posV1Repo.insertPaymentOption(tx, { orgId: actor.orgId, name: input.name.trim(), kind: input.kind, sortOrder: 100 });
    option = (await posV1Repo.getPaymentOptionById(tx, actor.orgId, id))!;
  }
  // A test that passes the "wrong" kind for an existing option keeps that refusal: the option's kind rules, as in production.
  return mod.switchOnPaymentOption(tx, actor, { storeId: input.storeId, paymentOptionId: option.id, moneyAccountId: input.moneyAccountId, posV1Alias: input.posV1Alias });
}
