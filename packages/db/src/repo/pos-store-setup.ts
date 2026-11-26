/**
 * T-533 S2 - the SQL behind the one-time store setup load: stands, discount presets, the v1 link, and the four setup-gap reads.
 * docs/tasks/533-pos-lipa-switch.md R2. The domain (`packages/domain/src/pos/store-setup.ts`) decides every rule; these only read and write.
 * Every function takes the caller's transaction first and filters by org AND store; RLS is the backstop.
 */
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { chargeOptions, posChargePresets, posDiscountPresets, posStands, tableSessions, type ChargeOptionRow, type PosChargePresetRow, type PosDiscountPresetRow, type PosStandRow } from '../../schema/pos-v2';
import { posV1StoreLinks } from '../../schema/pos-v1';
import type { Money } from '@shareat/core/money';
import type { Tx } from '../client';

export async function getStandByNumber(tx: Tx, orgId: string, storeId: string, number: number): Promise<PosStandRow | undefined> {
  const [row] = await tx
    .select()
    .from(posStands)
    .where(and(eq(posStands.orgId, orgId), eq(posStands.storeId, storeId), eq(posStands.number, number)));
  return row;
}

export async function insertStand(tx: Tx, input: { orgId: string; storeId: string; number: number; createdBy: string }): Promise<PosStandRow> {
  const [row] = await tx.insert(posStands).values({ ...input, status: 'active' }).returning();
  return row!;
}

/** T-633: every stand of the store, active and retired, in number order (the Tables section lists both). */
export async function listStands(tx: Tx, orgId: string, storeId: string): Promise<PosStandRow[]> {
  return tx
    .select()
    .from(posStands)
    .where(and(eq(posStands.orgId, orgId), eq(posStands.storeId, storeId)))
    .orderBy(posStands.number);
}

/** T-633: retire an ACTIVE stand. False when it was already retired (nothing written). The number is never reused (the unique key covers retired rows). */
export async function retireStand(tx: Tx, orgId: string, storeId: string, standId: string): Promise<boolean> {
  const rows = await tx
    .update(posStands)
    .set({ status: 'retired', updatedAt: new Date() })
    .where(and(eq(posStands.id, standId), eq(posStands.orgId, orgId), eq(posStands.storeId, storeId), eq(posStands.status, 'active')))
    .returning({ id: posStands.id });
  return rows.length > 0;
}

/** T-633: does a table session at this stand still have an open bill? */
export async function standHasOpenSession(tx: Tx, orgId: string, storeId: string, standId: string): Promise<boolean> {
  const rows = await tx
    .select({ id: tableSessions.id })
    .from(tableSessions)
    .where(and(eq(tableSessions.orgId, orgId), eq(tableSessions.storeId, storeId), eq(tableSessions.standId, standId), eq(tableSessions.status, 'open')))
    .limit(1);
  return rows.length > 0;
}

/** The ACTIVE preset of this name (case-insensitive, the same key the unique index uses), or undefined. */
export async function getActivePresetByName(tx: Tx, orgId: string, storeId: string, name: string): Promise<PosDiscountPresetRow | undefined> {
  const [row] = await tx
    .select()
    .from(posDiscountPresets)
    .where(
      and(
        eq(posDiscountPresets.orgId, orgId),
        eq(posDiscountPresets.storeId, storeId),
        eq(posDiscountPresets.status, 'active'),
        sql`lower(${posDiscountPresets.name}) = lower(${name})`,
      ),
    );
  return row;
}

export async function insertPreset(
  tx: Tx,
  input: { orgId: string; storeId: string; name: string; valueType: 'percent' | 'fixed'; value: Money; createdBy: string },
): Promise<PosDiscountPresetRow> {
  const [row] = await tx
    .insert(posDiscountPresets)
    .values({ orgId: input.orgId, storeId: input.storeId, name: input.name, valueType: input.valueType, value: input.value, status: 'active', createdBy: input.createdBy })
    .returning();
  return row!;
}

export async function updatePresetValue(
  tx: Tx,
  orgId: string,
  storeId: string,
  presetId: string,
  set: { valueType: 'percent' | 'fixed'; value: Money },
): Promise<void> {
  await tx
    .update(posDiscountPresets)
    .set({ valueType: set.valueType, value: set.value, updatedAt: new Date() })
    .where(and(eq(posDiscountPresets.id, presetId), eq(posDiscountPresets.orgId, orgId), eq(posDiscountPresets.storeId, storeId)));
}

/** Retire an ACTIVE preset (the row is kept: past sales name it). Returns whether a row changed. */
export async function retirePreset(tx: Tx, orgId: string, storeId: string, presetId: string): Promise<boolean> {
  const rows = await tx
    .update(posDiscountPresets)
    .set({ status: 'retired', updatedAt: new Date() })
    .where(and(eq(posDiscountPresets.id, presetId), eq(posDiscountPresets.orgId, orgId), eq(posDiscountPresets.storeId, storeId), eq(posDiscountPresets.status, 'active')))
    .returning({ id: posDiscountPresets.id });
  return rows.length > 0;
}

// ---- T-634 (0287): the org's master list of charges, and each store's switch for one -----------------------------------
// A store's `pos_charge_presets` row IS its switch (status active = on); its name, amount and per_unit are a mirror the 0287 trigger sets from the option.

/** Every option of the org, active and retired, in sort order then name. */
export async function listChargeOptions(tx: Tx, orgId: string): Promise<ChargeOptionRow[]> {
  return tx.select().from(chargeOptions).where(eq(chargeOptions.orgId, orgId)).orderBy(asc(chargeOptions.sortOrder), asc(chargeOptions.name), asc(chargeOptions.id));
}

/** One option of the org; `lock` takes it FOR UPDATE (an amount change or a retire decides on the current row). */
export async function getChargeOptionById(tx: Tx, orgId: string, id: string, lock = false): Promise<ChargeOptionRow | undefined> {
  const q = tx.select().from(chargeOptions).where(and(eq(chargeOptions.orgId, orgId), eq(chargeOptions.id, id)));
  const [row] = lock ? await q.for('update') : await q;
  return row;
}

/** The option whose a-z0-9 name key is `key` (the same expression as charge_options_org_name_unique), or undefined. */
export async function findChargeOptionByKey(tx: Tx, orgId: string, key: string): Promise<ChargeOptionRow | undefined> {
  const [row] = await tx
    .select()
    .from(chargeOptions)
    .where(and(eq(chargeOptions.orgId, orgId), sql`coalesce(nullif(regexp_replace(lower(${chargeOptions.name}), '[^a-z0-9]', '', 'g'), ''), lower(btrim(${chargeOptions.name}))) = ${key}`));
  return row;
}

export async function insertChargeOption(tx: Tx, input: { orgId: string; name: string; amount: Money; perUnit: boolean; sortOrder: number }): Promise<ChargeOptionRow> {
  const [row] = await tx.insert(chargeOptions).values({ ...input, status: 'active' }).returning();
  return row!;
}

/** The name is never changed (the 0287 guard refuses it): a rename is retire + add. */
export async function updateChargeOptionRow(tx: Tx, orgId: string, id: string, set: { amount?: Money; perUnit?: boolean; status?: 'active' | 'retired' }): Promise<void> {
  await tx
    .update(chargeOptions)
    .set({ ...set, updatedAt: new Date() })
    .where(and(eq(chargeOptions.orgId, orgId), eq(chargeOptions.id, id)));
}

/** The stores that have this option switched ON (an ACTIVE row), each once. */
export async function storesWithChargeOn(tx: Tx, orgId: string, chargeOptionId: string): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ storeId: posChargePresets.storeId })
    .from(posChargePresets)
    .where(and(eq(posChargePresets.orgId, orgId), eq(posChargePresets.chargeOptionId, chargeOptionId), eq(posChargePresets.status, 'active')));
  return rows.map((r) => r.storeId);
}

/** The store's newest row for this option (on or off), or undefined when the store never had it. Switching on again reuses it, so no duplicate is made. */
export async function latestChargeSwitch(tx: Tx, orgId: string, storeId: string, chargeOptionId: string): Promise<PosChargePresetRow | undefined> {
  const [row] = await tx
    .select()
    .from(posChargePresets)
    .where(and(eq(posChargePresets.orgId, orgId), eq(posChargePresets.storeId, storeId), eq(posChargePresets.chargeOptionId, chargeOptionId)))
    .orderBy(asc(posChargePresets.status), desc(posChargePresets.createdAt), desc(posChargePresets.id)) // active sorts before retired
    .limit(1)
    .for('update');
  return row;
}

/** A first switch-on at this store. name / amount / per_unit are passed for the column types; the 0287 trigger overwrites them from the option. */
export async function insertChargeSwitch(
  tx: Tx,
  input: { orgId: string; storeId: string; chargeOptionId: string; name: string; amount: Money; perUnit: boolean; createdBy: string },
): Promise<PosChargePresetRow> {
  const [row] = await tx.insert(posChargePresets).values({ ...input, status: 'active' }).returning();
  return row!;
}

/** Switch a store's row on or off. Returns whether a row changed. */
export async function setChargeSwitchStatus(tx: Tx, orgId: string, storeId: string, presetId: string, status: 'active' | 'retired'): Promise<boolean> {
  const rows = await tx
    .update(posChargePresets)
    .set({ status, updatedAt: new Date() })
    .where(
      and(
        eq(posChargePresets.id, presetId),
        eq(posChargePresets.orgId, orgId),
        eq(posChargePresets.storeId, storeId),
        eq(posChargePresets.status, status === 'active' ? 'retired' : 'active'),
      ),
    )
    .returning({ id: posChargePresets.id });
  return rows.length > 0;
}

/** The option ids switched ON at a store. */
export async function chargeOptionsOnAt(tx: Tx, orgId: string, storeId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: posChargePresets.chargeOptionId })
    .from(posChargePresets)
    .where(and(eq(posChargePresets.orgId, orgId), eq(posChargePresets.storeId, storeId), eq(posChargePresets.status, 'active')));
  return rows.map((r) => r.id);
}

/** The store's POS id in v1 (Firestore store id) through its LIVE link, or undefined when the store is not linked. */
export async function getLivePosStoreId(tx: Tx, orgId: string, storeId: string): Promise<string | undefined> {
  const [row] = await tx
    .select({ posStoreId: posV1StoreLinks.posStoreId })
    .from(posV1StoreLinks)
    .where(and(eq(posV1StoreLinks.orgId, orgId), eq(posV1StoreLinks.storeId, storeId), isNull(posV1StoreLinks.unlinkedAt)));
  return row?.posStoreId;
}

// ---- the setup gaps (read only; the load reports them and never fixes them) ---------------------------------------------

/** Active tenders of the store with no `pos_v1_alias`: names, in name order. */
export async function listTendersWithoutAlias(tx: Tx, orgId: string, storeId: string): Promise<string[]> {
  const rows = await tx.execute<{ name: string }>(sql`
    select name from tenders
    where org_id = ${orgId} and store_id = ${storeId} and is_active and pos_v1_alias is null
    order by name`);
  return [...rows].map((r) => r.name);
}

/**
 * Active menu items the store sells (a live offer: the latest row per variant, channel and daypart is not withdrawn) that no
 * kitchen route sends to a station at this store. Names, in name order.
 */
export async function listItemsWithoutStation(tx: Tx, orgId: string, storeId: string): Promise<string[]> {
  const rows = await tx.execute<{ name: string }>(sql`
    select distinct i.name from menu_items i
    join menu_item_variants v on v.menu_item_id = i.id
    join (
      select distinct on (variant_id, channel, daypart_id) variant_id, withdrawn
      from menu_offers where org_id = ${orgId} and store_id = ${storeId}
      order by variant_id, channel, daypart_id, effective_from desc, id desc
    ) o on o.variant_id = v.id and not o.withdrawn
    where i.org_id = ${orgId} and i.status = 'active'
      and not exists (select 1 from kitchen_routes r where r.store_id = ${storeId} and r.menu_item_id = i.id)
    order by i.name`);
  return [...rows].map((r) => r.name);
}

/** Active package items the store sells whose variants name no active refill item. Names, in name order. */
export async function listPackagesWithoutRefills(tx: Tx, orgId: string, storeId: string): Promise<string[]> {
  const rows = await tx.execute<{ name: string }>(sql`
    select distinct i.name from menu_items i
    join menu_item_variants v on v.menu_item_id = i.id
    join (
      select distinct on (variant_id, channel, daypart_id) variant_id, withdrawn
      from menu_offers where org_id = ${orgId} and store_id = ${storeId}
      order by variant_id, channel, daypart_id, effective_from desc, id desc
    ) o on o.variant_id = v.id and not o.withdrawn
    where i.org_id = ${orgId} and i.status = 'active' and i.item_type = 'package'
      and not exists (
        select 1 from menu_item_variants pv
        join menu_package_refills pr on pr.package_variant_id = pv.id and pr.status = 'active'
        where pv.menu_item_id = i.id)
    order by i.name`);
  return [...rows].map((r) => r.name);
}

/**
 * Staff of the store (not resigned, terminated or inactive) with no live PIN for this store. Badge codes are always allocated
 * (`employments.staff_code` is NOT NULL and shape-checked), so a missing badge code cannot exist and is not read.
 * Returns `staff_code` and display name, in code order.
 */
export async function listStaffWithoutPin(tx: Tx, orgId: string, storeId: string): Promise<{ staffCode: string; displayName: string }[]> {
  const rows = await tx.execute<{ staff_code: string; display_name: string }>(sql`
    select e.staff_code, p.display_name from employments e
    join persons p on p.id = e.person_id
    where e.org_id = ${orgId} and e.store_id = ${storeId}
      and e.employment_status not in ('resigned','terminated','inactive')
      and not exists (
        select 1 from person_credentials c
        where c.person_id = e.person_id and c.kind = 'pin' and c.store_id = e.store_id and c.revoked_at is null)
    order by e.staff_code`);
  return [...rows].map((r) => ({ staffCode: r.staff_code, displayName: r.display_name }));
}

