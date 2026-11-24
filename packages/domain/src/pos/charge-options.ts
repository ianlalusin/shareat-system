/**
 * T-634 (migration 0278) - the org's MASTER LIST of charges (Leftover, Extra griller...), and each store's switch for one. `docs/tasks/634-central-charges.md`.
 * The shape is T-629's payment options (`payment-options.ts`): one list per org; a store switches an option on by holding an ACTIVE `pos_charge_presets` row; the
 * option owns the NAME, the AMOUNT and PER UNIT of every store row (a 0278 trigger mirrors them), so the snapshot, the tablet and the sale read the store row unchanged.
 *
 * Capabilities, `authorize()` the first statement of every write, every write audited:
 * - the master list: `manage_menu`, ORG scope (admin and super admin; a store manager and a cashier are refused). A charge is part of what the brand sells and at
 *   what price, which is what `manage_menu` governs (the brand's menu master, org-wide). `manage_chart_of_accounts` (T-629's) is about where money is booked, not
 *   prices; `set_menu_price` is store-scoped, the opposite of "uniform across the brand".
 * - a store's switch: `manage_store_settings` at the STORE (as Discounts, T-622).
 *
 * A changed amount reaches the next charge added at every store. A charge already on a table, or on a receipt, keeps the amount it was added at: `charges.ts`
 * copies the name and unit amount into `table_session_charges` when it is added, and `sale.ts` copies those rows onto the receipt.
 * A rename is retire + add (the 0278 guard freezes the name), as T-627 had it.
 */
import { auditLogRepo, posStoreSetupRepo, posV2Repo, type Tx } from '@shareat/db';
import { authorize, type Actor } from '@shareat/auth';
import { money } from '@shareat/core/money';
import { gone, refuse } from '../shared/refusal';
import { checkChargePreset } from './store-setup';
import { uuidInput } from './shared';

const MASTER = 'manage_menu' as const;
const STORE = 'manage_store_settings' as const;

/** The a-z0-9 key of a name (the same expression as `charge_options_org_name_unique`), so "Extra-griller" is "Extra griller". */
export function chargeKey(name: string): string {
  const k = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  return k === '' ? name.trim().toLowerCase() : k;
}

async function bump(tx: Tx, orgId: string, storeId: string): Promise<void> {
  if (await posV2Repo.getPosStore(tx, orgId, storeId)) await posV2Repo.bumpStateVersion(tx, orgId, storeId);
}

function constraintOf(err: unknown): string | undefined {
  for (let e: unknown = err, i = 0; e && i < 4; i++, e = (e as { cause?: unknown }).cause) {
    const x = e as { code?: string; constraint_name?: string };
    if (x.code === '23505' && x.constraint_name) return x.constraint_name;
  }
  return undefined;
}

export async function createChargeOption(tx: Tx, actor: Actor, input: { name: unknown; amount: unknown; perUnit?: unknown }): Promise<{ id: string }> {
  await authorize(tx, actor, MASTER, {});
  const c = checkChargePreset(input);
  const same = await posStoreSetupRepo.findChargeOptionByKey(tx, actor.orgId, chargeKey(c.name));
  if (same) throw refuse(`charge options: "${c.name}" matches option ${same.id}`, `There is already a charge called "${same.name}".`);
  const all = await posStoreSetupRepo.listChargeOptions(tx, actor.orgId);
  const sortOrder = all.reduce((m, o) => Math.max(m, o.sortOrder), 0) + 10;
  let id: string;
  try {
    ({ id } = await posStoreSetupRepo.insertChargeOption(tx, { orgId: actor.orgId, name: c.name, amount: c.amount, perUnit: c.perUnit, sortOrder }));
  } catch (err) {
    if (constraintOf(err) === 'charge_options_org_name_unique') throw refuse('charge options: charge_options_org_name_unique', `There is already a charge called "${c.name}".`);
    throw err;
  }
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'charge_option.created',
    storeId: null,
    entityId: id,
    before: null,
    after: { name: c.name, amount: c.amount, perUnit: c.perUnit },
    source: 'web',
  });
  return { id };
}

async function loadLocked(tx: Tx, actor: Actor, raw: unknown) {
  const id = uuidInput(raw, 'That charge');
  const row = await posStoreSetupRepo.getChargeOptionById(tx, actor.orgId, id, true);
  if (!row) throw gone(`charge options: option ${id} not in org`, 'charge');
  return row;
}

/** Change the amount (and per unit) for EVERY store from now on: the 0278 trigger copies it onto each store row; each store that has it on gets a new snapshot. */
export async function updateChargeOption(
  tx: Tx,
  actor: Actor,
  input: { chargeOptionId: unknown; amount: unknown; perUnit?: unknown },
): Promise<{ outcome: 'updated' | 'unchanged'; storesOn: number }> {
  await authorize(tx, actor, MASTER, {});
  const before = await loadLocked(tx, actor, input.chargeOptionId);
  const c = checkChargePreset({ name: before.name, amount: input.amount, perUnit: input.perUnit === undefined ? before.perUnit : input.perUnit });
  const stores = await posStoreSetupRepo.storesWithChargeOn(tx, actor.orgId, before.id);
  if (c.amount === before.amount && c.perUnit === before.perUnit) return { outcome: 'unchanged', storesOn: stores.length };
  await posStoreSetupRepo.updateChargeOptionRow(tx, actor.orgId, before.id, { amount: c.amount, perUnit: c.perUnit });
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'charge_option.updated',
    storeId: null,
    entityId: before.id,
    before: { name: before.name, amount: before.amount, perUnit: before.perUnit },
    after: { name: before.name, amount: c.amount, perUnit: c.perUnit, storesOn: stores.length },
    source: 'web',
  });
  for (const storeId of stores) await bump(tx, actor.orgId, storeId);
  return { outcome: 'updated', storesOn: stores.length };
}

/** Retire is refused while any store has the charge switched on; bringing it back needs nothing (no store has it on after a retire). */
export async function setChargeOptionStatus(tx: Tx, actor: Actor, input: { chargeOptionId: unknown; status: unknown }): Promise<{ outcome: 'changed' | 'unchanged' }> {
  await authorize(tx, actor, MASTER, {});
  if (input.status !== 'active' && input.status !== 'retired') throw refuse(`charge options: unknown status ${String(input.status)}`, 'Choose active or retired.');
  const status = input.status;
  const before = await loadLocked(tx, actor, input.chargeOptionId);
  if (before.status === status) return { outcome: 'unchanged' };
  // a boolean, so the audit `action:` line below holds only dotted action names (t402-s1a scans for any quoted word on that line)
  const retiring = status === 'retired';
  if (retiring) {
    const on = (await posStoreSetupRepo.storesWithChargeOn(tx, actor.orgId, before.id)).length;
    if (on > 0) {
      throw refuse(
        `charge options: ${before.id} retire while on at ${on} store(s)`,
        `${before.name} is switched on at ${on} ${on === 1 ? 'store' : 'stores'}. Switch it off there first, then retire it.`,
      );
    }
  }
  await posStoreSetupRepo.updateChargeOptionRow(tx, actor.orgId, before.id, { status });
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: retiring ? 'charge_option.retired' : 'charge_option.reactivated',
    storeId: null,
    entityId: before.id,
    before: { status: before.status },
    after: { status },
    source: 'web',
  });
  return { outcome: 'changed' };
}

/**
 * A store switches a charge on or off. On: the store's newest row for the option is switched on again, or a first row is made (the trigger fills its name,
 * amount and per unit from the option); a retired charge cannot be switched on. Off: the row is kept (past bills point at it) and the tablet stops showing it.
 * A repeat writes nothing.
 */
export async function setStoreCharge(tx: Tx, actor: Actor, input: { storeId: unknown; chargeOptionId: unknown; on: boolean }): Promise<{ outcome: 'on' | 'off' | 'unchanged'; name: string }> {
  const storeId = uuidInput(input.storeId, 'That store');
  await authorize(tx, actor, STORE, { storeId });
  const optionId = uuidInput(input.chargeOptionId, 'That charge');
  const option = await posStoreSetupRepo.getChargeOptionById(tx, actor.orgId, optionId);
  if (!option) throw gone(`charge options: option ${optionId} not in org`, 'charge');
  const row = await posStoreSetupRepo.latestChargeSwitch(tx, actor.orgId, storeId, option.id);
  const isOn = row?.status === 'active';
  if (isOn === input.on) return { outcome: 'unchanged', name: option.name };
  if (input.on && option.status === 'retired') {
    throw refuse(`charge options: switch on retired ${option.id}`, `${option.name} is retired for all stores, so it cannot be switched on. Bring it back in the list above first.`);
  }
  let presetId: string;
  if (input.on && !row) {
    presetId = (
      await posStoreSetupRepo.insertChargeSwitch(tx, {
        orgId: actor.orgId,
        storeId,
        chargeOptionId: option.id,
        name: option.name,
        amount: money(option.amount),
        perUnit: option.perUnit,
        createdBy: actor.personId,
      })
    ).id;
  } else {
    presetId = row!.id;
    await posStoreSetupRepo.setChargeSwitchStatus(tx, actor.orgId, storeId, presetId, input.on ? 'active' : 'retired');
  }
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: input.on ? 'pos.charge_preset_set' : 'pos.charge_preset_retired',
    storeId,
    entityId: presetId,
    before: input.on ? null : { name: option.name, amount: option.amount, perUnit: option.perUnit },
    after: input.on ? { name: option.name, amount: option.amount, perUnit: option.perUnit, chargeOptionId: option.id } : null,
    source: 'web',
  });
  await bump(tx, actor.orgId, storeId);
  return { outcome: input.on ? 'on' : 'off', name: option.name };
}
