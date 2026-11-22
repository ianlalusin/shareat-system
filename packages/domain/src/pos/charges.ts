/**
 * T-627 - store charges on an open table: a cashier puts one from the store's list (or a custom one) on the bill, and anyone takes it off. docs/tasks/627-pos-charges.md.
 *
 * Any signed-in POS person may add or remove one, no PIN (Ian, 22 Nov 2026: "anyone, like v1"); every add and remove is audited with who and when. A charge is only ever
 * written to an OPEN table (the lock and migration 0275's guard both refuse a paid or voided one). The arithmetic is `priceSession`'s, never here: charges come after
 * discounts and VAT, outside the VAT base. A preset's name and amount are copied onto the row, so retiring or changing the preset later never moves a table already billed.
 */
import { compare, money, toCentavos, ZERO } from '@shareat/core/money';
import { authorize, type Actor } from '@shareat/auth';
import { posV2Repo, type Tx } from '@shareat/db';
import { refuse, gone } from '../shared/refusal';
import { parseDecimalInput } from '../shared/money-input';
import { lockOpenSession } from './order';
import { audit, CHARGE_MAX_PER_TABLE, CHARGE_MAX_PER_TABLE_SENTENCE, CHARGE_UNIT_AMOUNT_MAX, CHARGE_UNIT_AMOUNT_MAX_SENTENCE, deviceTime, loadLiveCharges, recordedDifferently, requireContext, uuidInput, wholeNumber } from './shared';

export interface AddChargeInput {
  storeId: string;
  pairingId: string | null;
  chargeId: string;
  sessionId: string;
  /** A charge from the store's list. Absent = a custom charge: `name` and `unitAmount` are typed. */
  presetId?: string;
  name?: string;
  /** Custom only: pesos, two decimals. */
  unitAmount?: string;
  qty: number;
  addedAtDevice: string | Date;
}

const MAX_QTY = 1000;

/** What the row stores: the preset's own name and amount, or the custom input within its limits. */
async function resolveCharge(tx: Tx, actor: Actor, input: AddChargeInput): Promise<{ presetId: string | null; name: string; unitAmount: string; qty: number }> {
  const qty = wholeNumber(input.qty, { what: 'The quantity', min: 1, max: MAX_QTY });
  if (input.presetId !== undefined && input.presetId !== null) {
    const preset = await posV2Repo.getChargePreset(tx, actor.orgId, input.storeId, uuidInput(input.presetId, 'The charge'));
    if (!preset || preset.status !== 'active') throw refuse('pos: charge preset not available', 'That charge is not available at this store.');
    if (!preset.perUnit && qty !== 1) throw refuse('pos: charge is once per bill', `${preset.name} is charged once per bill.`);
    return { presetId: preset.id, name: preset.name, unitAmount: preset.amount, qty };
  }
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name.length < 1 || name.length > 40) throw refuse('pos: custom charge name length', 'A charge name must be 1 to 40 characters.');
  if (qty !== 1) throw refuse('pos: custom charge quantity', 'A custom charge is added once. Type the full amount.');
  const unitAmount = parseDecimalInput(String(input.unitAmount ?? ''), '14,2', 'pos: the charge amount', 'The charge amount');
  if (compare(money(unitAmount), ZERO) <= 0) throw refuse('pos: custom charge not positive', 'A charge must be more than 0.');
  if (compare(money(unitAmount), money(CHARGE_UNIT_AMOUNT_MAX)) > 0) throw refuse('pos: custom charge over the cap', CHARGE_UNIT_AMOUNT_MAX_SENTENCE);
  return { presetId: null, name, unitAmount, qty };
}

export async function addCharge(tx: Tx, actor: Actor, input: AddChargeInput): Promise<{ wrote: boolean }> {
  await authorize(tx, actor, 'record_sale', { storeId: input.storeId });
  const pairingId = await requireContext(tx, actor, input.storeId, input.pairingId, false);
  const chargeId = uuidInput(input.chargeId, 'The charge id');
  const sessionId = uuidInput(input.sessionId, 'The table id');
  const at = deviceTime(input.addedAtDevice, 'The time of the charge');

  const prior = await posV2Repo.getSessionCharge(tx, actor.orgId, input.storeId, chargeId);
  if (prior) {
    // A replay of the same charge is a no-op; the same id with other content is a conflict.
    const same =
      prior.sessionId === sessionId &&
      prior.qty === input.qty &&
      (input.presetId ? prior.presetId === input.presetId.toLowerCase() : prior.presetId === null && prior.name === String(input.name ?? '').trim() && toCentavos(money(prior.unitAmount)) === toCentavos(money(parseDecimalInput(String(input.unitAmount ?? ''), '14,2', 'pos: the charge amount', 'The charge amount'))));
    if (same) return { wrote: false };
    throw recordedDifferently();
  }
  const session = await lockOpenSession(tx, actor.orgId, input.storeId, sessionId);
  if ((await loadLiveCharges(tx, actor.orgId, input.storeId, session.id)).length >= CHARGE_MAX_PER_TABLE) throw refuse('pos: too many charges on a table', CHARGE_MAX_PER_TABLE_SENTENCE);
  const c = await resolveCharge(tx, actor, input);
  await posV2Repo.insertSessionCharge(tx, {
    id: chargeId, orgId: actor.orgId, storeId: input.storeId, sessionId: session.id, presetId: c.presetId, name: c.name, unitAmount: money(c.unitAmount), qty: c.qty, addedBy: actor.personId, addedAtDevice: at,
  });
  await audit(tx, actor, 'pos.charge_added', {
    storeId: input.storeId, entityId: chargeId, pairingId, at,
    after: { sessionId: session.id, name: c.name, unitAmount: c.unitAmount, qty: c.qty, presetId: c.presetId },
  });
  await posV2Repo.bumpStateVersion(tx, actor.orgId, input.storeId);
  return { wrote: true };
}

export async function removeCharge(tx: Tx, actor: Actor, input: { storeId: string; pairingId: string | null; chargeId: string; removedAtDevice: string | Date }): Promise<{ wrote: boolean }> {
  await authorize(tx, actor, 'record_sale', { storeId: input.storeId });
  const pairingId = await requireContext(tx, actor, input.storeId, input.pairingId, false);
  const at = deviceTime(input.removedAtDevice, 'The time of the removal');
  const c = await posV2Repo.getSessionCharge(tx, actor.orgId, input.storeId, uuidInput(input.chargeId, 'The charge id'));
  if (!c) throw gone('pos: charge not found', 'charge');
  if (c.status === 'removed') return { wrote: false };
  await lockOpenSession(tx, actor.orgId, input.storeId, c.sessionId);
  await posV2Repo.removeSessionCharges(tx, actor.orgId, input.storeId, [c.id], actor.personId, at);
  await audit(tx, actor, 'pos.charge_removed', {
    storeId: input.storeId, entityId: c.id, pairingId, at,
    before: { sessionId: c.sessionId, name: c.name, unitAmount: c.unitAmount, qty: c.qty },
  });
  await posV2Repo.bumpStateVersion(tx, actor.orgId, input.storeId);
  return { wrote: true };
}
