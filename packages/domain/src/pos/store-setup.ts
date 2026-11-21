/**
 * T-533 S2 - the store's stands and discount presets, written one at a time and audited. docs/tasks/533-pos-lipa-switch.md R2.
 *
 * Callers: the one-time load from v1 (`packages/etl/src/pos-v2/load-store-setup.ts`) and T-611 S3 (copy presets from another store, `store-copy.ts`); T-535 puts a screen on the presets.
 * Every function is `(tx, actor, input)` and calls `authorize` FIRST: `manage_store_settings` (admin, manager) at the STORE.
 * Idempotent: the same input a second time writes nothing, audits nothing and does not bump `pos_stores.state_version`.
 * A stand is never resurrected: a retired number stays retired (retired numbers are never reused, T-523 R2).
 */
import { auditLogRepo, posStoreSetupRepo, posV2Repo, type Tx } from '@shareat/db';
import { authorize, type Actor } from '@shareat/auth';
import { money, type Money } from '@shareat/core/money';
import { refuse } from '../shared/refusal';
import { uuidInput, wholeNumber } from './shared';

const CAPABILITY = 'manage_store_settings' as const;

async function bump(tx: Tx, orgId: string, storeId: string): Promise<void> {
  if (await posV2Repo.getPosStore(tx, orgId, storeId)) await posV2Repo.bumpStateVersion(tx, orgId, storeId);
}

export type StandOutcome = 'created' | 'unchanged' | 'kept_retired';

export async function upsertPosStand(tx: Tx, actor: Actor, input: { storeId: string; number: unknown }): Promise<{ standId: string; outcome: StandOutcome }> {
  const storeId = uuidInput(input.storeId, 'That store');
  await authorize(tx, actor, CAPABILITY, { storeId });
  const number = wholeNumber(input.number, { what: 'The stand number', min: 1, max: 999 });
  const existing = await posStoreSetupRepo.getStandByNumber(tx, actor.orgId, storeId, number);
  if (existing) return { standId: existing.id, outcome: existing.status === 'active' ? 'unchanged' : 'kept_retired' };
  const row = await posStoreSetupRepo.insertStand(tx, { orgId: actor.orgId, storeId, number, createdBy: actor.personId });
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'pos.stand_added',
    storeId,
    entityId: row.id,
    before: null,
    after: { number, status: 'active' },
    source: 'etl',
  });
  await bump(tx, actor.orgId, storeId);
  return { standId: row.id, outcome: 'created' };
}

export type PresetOutcome = 'created' | 'updated' | 'unchanged';
export interface PresetInput {
  readonly storeId: string;
  readonly name: unknown;
  readonly valueType: unknown;
  /** A number or a decimal string, never more than two decimals. */
  readonly value: unknown;
}
export interface CheckedPreset {
  readonly name: string;
  readonly valueType: 'percent' | 'fixed';
  /** Two decimals, as the column stores it. */
  readonly value: Money;
}

/** The rules of a preset, in words (pure). The database CHECKs say the same; this says it before the insert so the load can name the preset. */
export function checkPreset(raw: { name: unknown; valueType: unknown; value: unknown }): CheckedPreset {
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (name.length < 1 || name.length > 40) throw refuse('checkPreset: name length', 'A discount name must be 1 to 40 characters.');
  if (raw.valueType !== 'percent' && raw.valueType !== 'fixed') {
    throw refuse(`checkPreset: type of "${name}"`, `The discount "${name}" must be a percent or a fixed peso amount.`);
  }
  const text = typeof raw.value === 'number' ? String(raw.value) : typeof raw.value === 'string' ? raw.value.trim() : '';
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(text)) {
    throw refuse(`checkPreset: value of "${name}"`, `The discount "${name}" needs a value above 0 with at most two decimals.`);
  }
  const [whole, frac = ''] = text.split('.');
  const value = money(`${BigInt(whole!)}.${frac.padEnd(2, '0')}`);
  if (value === '0.00') throw refuse(`checkPreset: zero "${name}"`, `The discount "${name}" has a value of 0. A discount must be more than 0.`);
  if (raw.valueType === 'percent' && (BigInt(whole!) > 100n || (BigInt(whole!) === 100n && frac.replace(/0/g, '') !== ''))) {
    throw refuse(`checkPreset: percent over 100 "${name}"`, `The discount "${name}" is a percent over 100. A percent discount can be at most 100.`);
  }
  return { name, valueType: raw.valueType, value };
}

/** `source` is the caller's own, written on the audit rows (T-615): `'web'` from an admin screen action (the store copy), `'etl'` from the v1 loader. */
export async function upsertPosDiscountPreset(tx: Tx, actor: Actor, input: PresetInput, source: 'web' | 'etl'): Promise<{ presetId: string; outcome: PresetOutcome }> {
  const storeId = uuidInput(input.storeId, 'That store');
  await authorize(tx, actor, CAPABILITY, { storeId });
  const p = checkPreset(input);
  const existing = await posStoreSetupRepo.getActivePresetByName(tx, actor.orgId, storeId, p.name);
  if (!existing) {
    const row = await posStoreSetupRepo.insertPreset(tx, { orgId: actor.orgId, storeId, name: p.name, valueType: p.valueType, value: p.value, createdBy: actor.personId });
    await auditLogRepo.append(tx, actor.orgId, {
      actorPersonId: actor.personId,
      action: 'pos.discount_preset_set',
      storeId,
      entityId: row.id,
      before: null,
      after: { name: p.name, valueType: p.valueType, value: p.value },
      source,
    });
    await bump(tx, actor.orgId, storeId);
    return { presetId: row.id, outcome: 'created' };
  }
  if (existing.valueType === p.valueType && existing.value === p.value) return { presetId: existing.id, outcome: 'unchanged' };
  await posStoreSetupRepo.updatePresetValue(tx, actor.orgId, storeId, existing.id, { valueType: p.valueType, value: p.value });
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'pos.discount_preset_set',
    storeId,
    entityId: existing.id,
    before: { name: existing.name, valueType: existing.valueType, value: existing.value },
    after: { name: p.name, valueType: p.valueType, value: p.value },
    source,
  });
  await bump(tx, actor.orgId, storeId);
  return { presetId: existing.id, outcome: 'updated' };
}
