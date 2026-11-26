/**
 * T-533 S2 - the store's stands and discount presets, written one at a time and audited. docs/tasks/533-pos-lipa-switch.md R2.
 *
 * Callers: the one-time load from v1 (`packages/etl/src/pos-v2/load-store-setup.ts`) and T-611 S3 (copy presets from another store, `store-copy.ts`) and T-622 (the ERP screen on `/admin/pos-tablets`: add, change, retire).
 * Every function is `(tx, actor, input)` and calls `authorize` FIRST: `manage_store_settings` (admin, manager) at the STORE.
 * Idempotent: the same input a second time writes nothing, audits nothing and does not bump `pos_stores.state_version`.
 * A stand is never resurrected: a retired number stays retired (retired numbers are never reused, T-523 R2).
 */
import { auditLogRepo, posStoreSetupRepo, posV2Repo, type Tx } from '@shareat/db';
import { authorize, type Actor } from '@shareat/auth';
import { compare, money, type Money } from '@shareat/core/money';
import { refuse } from '../shared/refusal';
import { CHARGE_UNIT_AMOUNT_MAX, CHARGE_UNIT_AMOUNT_MAX_SENTENCE, uuidInput, wholeNumber } from './shared';

const CAPABILITY = 'manage_store_settings' as const;

async function bump(tx: Tx, orgId: string, storeId: string): Promise<void> {
  if (await posV2Repo.getPosStore(tx, orgId, storeId)) await posV2Repo.bumpStateVersion(tx, orgId, storeId);
}

export type StandOutcome = 'created' | 'unchanged' | 'kept_retired';

/** `source` is the caller's own, written on the audit row: `'etl'` from the v1 loader (the default, its only caller before T-633), `'web'` from the Tables section. */
export async function upsertPosStand(
  tx: Tx,
  actor: Actor,
  input: { storeId: string; number: unknown },
  source: 'web' | 'etl' = 'etl',
): Promise<{ standId: string; outcome: StandOutcome }> {
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
    source,
  });
  await bump(tx, actor.orgId, storeId);
  return { standId: row.id, outcome: 'created' };
}

/** T-633: at most this many table numbers in one Add (a typo like "1-2000" is refused, not 2000 rows). */
export const TABLE_ADD_MAX = 200;
/** The range a table number may take: the `pos_stands_number_check` CHECK says the same. */
export const TABLE_NUMBER_MIN = 1;
export const TABLE_NUMBER_MAX = 999;

/**
 * T-633 (pure): what the manager typed in "Table numbers" -> the numbers to add, smallest first. One number ("5") or a range ("1-20"; an en dash and spaces
 * are fine). Refuses, in words: anything else, a range written backwards, a number outside 1 to 999, and more than `TABLE_ADD_MAX` at once.
 */
export function parseTableNumbers(raw: unknown): number[] {
  const text = typeof raw === 'string' ? raw.trim() : '';
  const m = /^(\d{1,4})(?:\s*[-–]\s*(\d{1,4}))?$/.exec(text);
  if (!m) throw refuse(`parseTableNumbers: "${text}"`, 'Type one table number, like 5, or a range, like 1-20.');
  // wholeNumber checks a whole number within 1 to 999 (NaN-safe, Number.isInteger) and owns the sentence; its result is not string-derived for the T-371 guard.
  const bounds = { what: 'A table number', min: TABLE_NUMBER_MIN, max: TABLE_NUMBER_MAX };
  const from = wholeNumber(Number(m[1]), bounds);
  const to = m[2] === undefined ? from : wholeNumber(Number(m[2]), bounds);
  if (to < from) throw refuse(`parseTableNumbers: reversed "${text}"`, `The range ${from}-${to} goes backwards. Put the smaller number first, like ${to}-${from}.`);
  const count = to - from + 1;
  if (count > TABLE_ADD_MAX) {
    throw refuse(`parseTableNumbers: ${count} at once`, `You can add at most ${TABLE_ADD_MAX} tables at a time. ${from}-${to} is ${count} tables.`);
  }
  return Array.from({ length: count }, (_, i) => from + i);
}

export interface AddTablesResult {
  readonly added: number;
  /** Already active at this store: nothing written. */
  readonly existed: number;
  /** Retired at this store: kept retired, never reused. */
  readonly retired: number;
}

/**
 * T-633: add one table number or a range at a store, from the Tables section. Authorize FIRST, then parse; every number goes through `upsertPosStand`
 * (which audits `pos.stand_added` with source 'web' and keeps a retired number retired). The caller runs this in ONE transaction, so a refusal adds none.
 */
export async function addPosStands(tx: Tx, actor: Actor, input: { storeId: string; numbers: unknown }): Promise<AddTablesResult> {
  const storeId = uuidInput(input.storeId, 'That store');
  await authorize(tx, actor, CAPABILITY, { storeId });
  const numbers = parseTableNumbers(input.numbers);
  let added = 0;
  let existed = 0;
  let retired = 0;
  for (const number of numbers) {
    const { outcome } = await upsertPosStand(tx, actor, { storeId, number }, 'web');
    if (outcome === 'created') added++;
    else if (outcome === 'unchanged') existed++;
    else retired++;
  }
  return { added, existed, retired };
}

/**
 * T-633: retire a table number. Authorize FIRST (same capability, at the store). Refused while the table has an open bill (a seated party would lose its
 * table on the tablet). The row is kept (past sales name it) and the number is never reused; the snapshot stops carrying it. Retiring one already retired
 * writes nothing.
 */
export async function retirePosStand(tx: Tx, actor: Actor, input: { storeId: string; standId: string }): Promise<{ outcome: 'retired' | 'unchanged'; number: number }> {
  const storeId = uuidInput(input.storeId, 'That store');
  await authorize(tx, actor, CAPABILITY, { storeId });
  const standId = uuidInput(input.standId, 'That table');
  const stand = await posV2Repo.getStand(tx, actor.orgId, storeId, standId);
  if (!stand) throw refuse(`retirePosStand: stand ${standId} not at store ${storeId}`, 'That table does not exist at this store.');
  if (stand.status === 'retired') return { outcome: 'unchanged', number: stand.number };
  if (await posStoreSetupRepo.standHasOpenSession(tx, actor.orgId, storeId, standId)) {
    throw refuse(
      `retirePosStand: stand ${standId} has an open session`,
      `Table ${stand.number} has an open bill. Settle or void it on the tablet first, then retire the table.`,
    );
  }
  if (!(await posStoreSetupRepo.retireStand(tx, actor.orgId, storeId, standId))) return { outcome: 'unchanged', number: stand.number };
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'pos.stand_retired',
    storeId,
    entityId: standId,
    before: { number: stand.number, status: 'active' },
    after: { number: stand.number, status: 'retired' },
    source: 'web',
  });
  await bump(tx, actor.orgId, storeId);
  return { outcome: 'retired', number: stand.number };
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

/**
 * T-622: retire a named discount from the ERP screen. Authorize FIRST (same capability, at the store). The row is kept (past sales name it) and the
 * snapshot stops carrying it. Retiring one that is already retired writes nothing. A rename is retire + add: the name is the key.
 */
export async function retirePosDiscountPreset(tx: Tx, actor: Actor, input: { storeId: string; presetId: string }): Promise<{ outcome: 'retired' | 'unchanged' }> {
  const storeId = uuidInput(input.storeId, 'That store');
  await authorize(tx, actor, CAPABILITY, { storeId });
  const presetId = uuidInput(input.presetId, 'That discount');
  const existing = await posV2Repo.getPreset(tx, actor.orgId, storeId, presetId);
  if (!existing) throw refuse(`retirePosDiscountPreset: preset ${presetId} not at store ${storeId}`, 'That discount does not exist any more.');
  if (!(await posStoreSetupRepo.retirePreset(tx, actor.orgId, storeId, presetId))) return { outcome: 'unchanged' };
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'pos.discount_preset_retired',
    storeId,
    entityId: presetId,
    before: { name: existing.name, valueType: existing.valueType, value: existing.value },
    after: null,
    source: 'web',
  });
  await bump(tx, actor.orgId, storeId);
  return { outcome: 'retired' };
}

// ---------------------------------------------------------------------------------------------------------------------
// T-627 (docs/tasks/627-pos-charges.md): the rules of a named charge (leftover, an extra griller). Since T-634 (0287) the org owns the list
// (`charge-options.ts`); a store only switches a charge on or off.
// ---------------------------------------------------------------------------------------------------------------------
export interface CheckedChargePreset {
  readonly name: string;
  /** Two decimals, as the column stores it. */
  readonly amount: Money;
  readonly perUnit: boolean;
}

/** The rules of a charge, in words (pure). The database CHECKs say the same; this says it first. */
export function checkChargePreset(raw: { name: unknown; amount: unknown; perUnit?: unknown }): CheckedChargePreset {
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (name.length < 1 || name.length > 40) throw refuse('checkChargePreset: name length', 'A charge name must be 1 to 40 characters.');
  const text = typeof raw.amount === 'number' ? String(raw.amount) : typeof raw.amount === 'string' ? raw.amount.trim() : '';
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(text)) {
    throw refuse(`checkChargePreset: amount of "${name}"`, `The charge "${name}" needs an amount above 0 with at most two decimals.`);
  }
  const [whole, frac = ''] = text.split('.');
  const amount = money(`${BigInt(whole!)}.${frac.padEnd(2, '0')}`);
  if (amount === '0.00') throw refuse(`checkChargePreset: zero "${name}"`, `The charge "${name}" has an amount of 0. A charge must be more than 0.`);
  if (compare(amount, money(CHARGE_UNIT_AMOUNT_MAX)) > 0) throw refuse(`checkChargePreset: over the cap "${name}"`, CHARGE_UNIT_AMOUNT_MAX_SENTENCE);
  return { name, amount, perUnit: raw.perUnit === true || raw.perUnit === 'true' || raw.perUnit === 'on' };
}

// T-634 (0287): a store no longer adds or prices its own charges. The org master list and the store switch are in charge-options.ts; checkChargePreset above
// is still the one rule set of a charge (the master list uses it).
