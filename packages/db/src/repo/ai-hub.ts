/**
 * The AI hub: provider keys, models, settings, store switches and the call log. T-640 (docs/tasks/640-ai-hub.md, migration 0284).
 *
 * SQL only, every read and write filtered by `org_id` (RLS backstops it). The domain (`packages/domain/src/ai`) owns every rule, sentence, capability and audit row.
 * Nothing here authorizes.
 *
 * ⛔ A key is never selected by a list. `listKeys` names its columns and does not include `key_envelope`; `getKeyEnvelope` is the ONE read of the ciphertext, and only
 * the domain (which holds the master key) opens it. Neither function logs.
 * ⛔ `insertCall` takes the prompt's SHA-256 and never any text. Month and day boundaries are Manila's, worked out in SQL from the database clock.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { aiCalls, aiModels, aiProviderKeys, aiSettings, aiStoreSwitches, type AiModelRow, type AiProviderName, type AiSettingsRow } from '../../schema/ai-hub';
import { persons } from '../../schema/persons';
import { stores } from '../../schema/stores';

// -------------------------------------------------------------------------------------------------------------------
// Keys
// -------------------------------------------------------------------------------------------------------------------
export interface KeyListRow {
  provider: AiProviderName;
  keyLast4: string;
  setByName: string;
  updatedAt: Date | null;
  createdAt: Date;
}

/** Every key of the org, WITHOUT the ciphertext: the provider, the last four characters, who set it and when. */
export async function listKeys(tx: Tx, orgId: string): Promise<KeyListRow[]> {
  return tx
    .select({ provider: aiProviderKeys.provider, keyLast4: aiProviderKeys.keyLast4, setByName: persons.displayName, updatedAt: aiProviderKeys.updatedAt, createdAt: aiProviderKeys.createdAt })
    .from(aiProviderKeys)
    .innerJoin(persons, eq(persons.id, aiProviderKeys.setBy))
    .where(eq(aiProviderKeys.orgId, orgId))
    .orderBy(asc(aiProviderKeys.provider));
}

/** The row's id and the last four characters (never the ciphertext). */
export async function getKeyMeta(tx: Tx, orgId: string, provider: AiProviderName): Promise<{ id: string; keyLast4: string } | null> {
  const [row] = await tx
    .select({ id: aiProviderKeys.id, keyLast4: aiProviderKeys.keyLast4 })
    .from(aiProviderKeys)
    .where(and(eq(aiProviderKeys.orgId, orgId), eq(aiProviderKeys.provider, provider)));
  return row ?? null;
}

/** The ONE read of the ciphertext. The caller decrypts it in memory and never returns it. */
export async function getKeyEnvelope(tx: Tx, orgId: string, provider: AiProviderName): Promise<string | null> {
  const [row] = await tx.select({ envelope: aiProviderKeys.keyEnvelope }).from(aiProviderKeys).where(and(eq(aiProviderKeys.orgId, orgId), eq(aiProviderKeys.provider, provider)));
  return row?.envelope ?? null;
}

export async function upsertKey(tx: Tx, input: { orgId: string; provider: AiProviderName; keyEnvelope: string; keyLast4: string; setBy: string }): Promise<{ id: string }> {
  const [row] = await tx
    .insert(aiProviderKeys)
    .values(input)
    .onConflictDoUpdate({
      target: [aiProviderKeys.orgId, aiProviderKeys.provider],
      set: { keyEnvelope: input.keyEnvelope, keyLast4: input.keyLast4, setBy: input.setBy, updatedAt: sql`now()` },
    })
    .returning({ id: aiProviderKeys.id });
  return { id: row!.id };
}

/** Removes a provider's key and, first, its models (a model cannot outlive its key). Returns whether a key was there and how many models went with it. */
export async function deleteKeyWithModels(tx: Tx, orgId: string, provider: AiProviderName): Promise<{ keyRemoved: boolean; modelsRemoved: number }> {
  const models = await tx.delete(aiModels).where(and(eq(aiModels.orgId, orgId), eq(aiModels.provider, provider))).returning({ id: aiModels.id });
  const keys = await tx.delete(aiProviderKeys).where(and(eq(aiProviderKeys.orgId, orgId), eq(aiProviderKeys.provider, provider))).returning({ id: aiProviderKeys.id });
  return { keyRemoved: keys.length > 0, modelsRemoved: models.length };
}

// -------------------------------------------------------------------------------------------------------------------
// Models
// -------------------------------------------------------------------------------------------------------------------
export type ModelRow = AiModelRow;

export async function listModels(tx: Tx, orgId: string): Promise<ModelRow[]> {
  return tx.select().from(aiModels).where(eq(aiModels.orgId, orgId)).orderBy(asc(aiModels.provider), asc(aiModels.model));
}

export async function getModel(tx: Tx, orgId: string, provider: AiProviderName, model: string): Promise<ModelRow | null> {
  const [row] = await tx.select().from(aiModels).where(and(eq(aiModels.orgId, orgId), eq(aiModels.provider, provider), eq(aiModels.model, model)));
  return row ?? null;
}

/** The active models, first choice first. Ties (which the screen never makes) break by id so the order is always the same. */
export async function listActiveModels(tx: Tx, orgId: string): Promise<ModelRow[]> {
  return tx.select().from(aiModels).where(and(eq(aiModels.orgId, orgId), eq(aiModels.active, true))).orderBy(asc(aiModels.priority), asc(aiModels.id));
}

export interface TestOutcome {
  orgId: string;
  provider: AiProviderName;
  model: string;
  ok: boolean;
  /** Only read when `ok`. */
  toolCalling: boolean;
  latencyMs: number;
  note: string;
}

/**
 * Records a Test call. A pass sets `passed_at` and the tool-calling fact; a fail records the note and leaves `passed_at`, `tool_calling` and `active` as they were
 * (a failed test never switches an active model off, and never makes an untested one usable).
 */
export async function recordTest(tx: Tx, t: TestOutcome): Promise<void> {
  const base = { lastTestOk: t.ok, lastTestAt: sql`now()`, lastTestLatencyMs: t.latencyMs, lastTestNote: t.note, updatedAt: sql`now()` };
  const onPass = t.ok ? { toolCalling: t.toolCalling, passedAt: sql`now()` } : {};
  await tx
    .insert(aiModels)
    .values({ orgId: t.orgId, provider: t.provider, model: t.model, lastTestOk: t.ok, lastTestAt: sql`now()`, lastTestLatencyMs: t.latencyMs, lastTestNote: t.note, ...(t.ok ? { toolCalling: t.toolCalling, passedAt: sql`now()` } : {}) })
    .onConflictDoUpdate({ target: [aiModels.orgId, aiModels.provider, aiModels.model], set: { ...base, ...onPass } });
}

export async function nextPriority(tx: Tx, orgId: string): Promise<number> {
  const [row] = await tx
    .select({ top: sql<number | null>`max(${aiModels.priority})` })
    .from(aiModels)
    .where(and(eq(aiModels.orgId, orgId), eq(aiModels.active, true)));
  return Number(row?.top ?? 0) + 1;
}

export async function setActive(tx: Tx, orgId: string, provider: AiProviderName, model: string, active: boolean, priority: number | null): Promise<void> {
  await tx
    .update(aiModels)
    .set({ active, priority: active ? priority : null, updatedAt: sql`now()` })
    .where(and(eq(aiModels.orgId, orgId), eq(aiModels.provider, provider), eq(aiModels.model, model)));
}

export async function setPriority(tx: Tx, orgId: string, provider: AiProviderName, model: string, priority: number): Promise<void> {
  await tx
    .update(aiModels)
    .set({ priority, updatedAt: sql`now()` })
    .where(and(eq(aiModels.orgId, orgId), eq(aiModels.provider, provider), eq(aiModels.model, model), eq(aiModels.active, true)));
}

// -------------------------------------------------------------------------------------------------------------------
// Settings and store switches
// -------------------------------------------------------------------------------------------------------------------
export type SettingsRow = AiSettingsRow;

export async function getSettings(tx: Tx, orgId: string): Promise<SettingsRow | null> {
  const [row] = await tx.select().from(aiSettings).where(eq(aiSettings.orgId, orgId));
  return row ?? null;
}

export interface SettingsValues {
  enabled: boolean;
  monthlyCapPesos: number;
  dailyLimitPerPerson: number;
  pesosPerUsdHundredths: number;
  warnAtPercent: number;
}

export async function upsertSettings(tx: Tx, orgId: string, values: SettingsValues, updatedBy: string): Promise<{ id: string }> {
  const [row] = await tx
    .insert(aiSettings)
    .values({ orgId, ...values, updatedAt: sql`now()`, updatedBy })
    .onConflictDoUpdate({ target: [aiSettings.orgId], set: { ...values, updatedAt: sql`now()`, updatedBy } })
    .returning({ id: aiSettings.id });
  return { id: row!.id };
}

export interface StoreSwitchRow {
  storeId: string;
  storeName: string;
  storeCode: string;
  enabled: boolean;
}

/** Every store of the org with its switch (no row means on). */
export async function listStoreSwitches(tx: Tx, orgId: string): Promise<StoreSwitchRow[]> {
  const rows = await tx
    .select({ storeId: stores.id, storeName: stores.name, storeCode: stores.code, enabled: aiStoreSwitches.enabled })
    .from(stores)
    .leftJoin(aiStoreSwitches, eq(aiStoreSwitches.storeId, stores.id))
    .where(eq(stores.orgId, orgId))
    .orderBy(asc(stores.name));
  return rows.map((r) => ({ storeId: r.storeId, storeName: r.storeName, storeCode: r.storeCode, enabled: r.enabled ?? true }));
}

/** True unless the store has a switch row set to off. A store that is not the org's has no row either, so it reads as on: the caller checks the store belongs to the org. */
export async function isStoreOn(tx: Tx, orgId: string, storeId: string): Promise<boolean> {
  const [row] = await tx.select({ enabled: aiStoreSwitches.enabled }).from(aiStoreSwitches).where(and(eq(aiStoreSwitches.orgId, orgId), eq(aiStoreSwitches.storeId, storeId)));
  return row?.enabled ?? true;
}

export async function upsertStoreSwitch(tx: Tx, orgId: string, storeId: string, enabled: boolean, updatedBy: string): Promise<{ id: string }> {
  const [row] = await tx
    .insert(aiStoreSwitches)
    .values({ orgId, storeId, enabled, updatedAt: sql`now()`, updatedBy })
    .onConflictDoUpdate({ target: [aiStoreSwitches.storeId], set: { enabled, updatedAt: sql`now()`, updatedBy } })
    .returning({ id: aiStoreSwitches.id });
  return { id: row!.id };
}

export async function storeBelongsToOrg(tx: Tx, orgId: string, storeId: string): Promise<boolean> {
  const [row] = await tx.select({ id: stores.id }).from(stores).where(and(eq(stores.orgId, orgId), eq(stores.id, storeId)));
  return !!row;
}

// -------------------------------------------------------------------------------------------------------------------
// The call log
// -------------------------------------------------------------------------------------------------------------------
export interface CallInsert {
  orgId: string;
  storeId: string | null;
  personId: string | null;
  feature: string;
  provider: AiProviderName;
  model: string;
  tokensIn: number;
  tokensOut: number;
  costMicroPhp: number;
  latencyMs: number;
  toolCalls: number;
  ok: boolean;
  errorCode: string | null;
  /** SHA-256 hex of the prompt as sent. The text itself is never passed to this layer. */
  promptSha256: string;
  groupRef: string;
}

export async function insertCall(tx: Tx, row: CallInsert): Promise<void> {
  await tx.insert(aiCalls).values(row);
}

/** The start of the current Manila calendar month, as an instant, for an SQL comparison. */
const MONTH_START = sql`(date_trunc('month', timezone('Asia/Manila', now())) at time zone 'Asia/Manila')`;
/** The start of the current Manila day, as an instant. */
const DAY_START = sql`(date_trunc('day', timezone('Asia/Manila', now())) at time zone 'Asia/Manila')`;

/** What this Manila month has cost so far, in micro-pesos (every attempt, the hub's own test calls included). */
export async function spendThisMonthMicro(tx: Tx, orgId: string): Promise<number> {
  const rows = (await tx.execute(
    sql`select coalesce(sum(cost_micro_php), 0)::text as total from ai_calls where org_id = ${orgId} and created_at >= ${MONTH_START}`,
  )) as unknown as { total: string }[];
  return Number(rows[0]?.total ?? 0);
}

/** Questions this person has had answered today (Manila). The hub's own test calls are not questions. */
export async function answeredToday(tx: Tx, orgId: string, personId: string): Promise<number> {
  const rows = (await tx.execute(
    sql`select count(*)::int as n from ai_calls where org_id = ${orgId} and person_id = ${personId} and ok and feature <> 'hub.test' and created_at >= ${DAY_START}`,
  )) as unknown as { n: number }[];
  return Number(rows[0]?.n ?? 0);
}

export interface UsageRow {
  key: string;
  label: string;
  calls: number;
  costMicroPhp: number;
}

/** This month's spend per feature, biggest first. */
export async function usageByFeatureThisMonth(tx: Tx, orgId: string): Promise<UsageRow[]> {
  const rows = (await tx.execute(
    sql`select feature as key, feature as label, count(*)::int as calls, coalesce(sum(cost_micro_php), 0)::text as cost
        from ai_calls where org_id = ${orgId} and created_at >= ${MONTH_START} group by feature order by sum(cost_micro_php) desc, feature`,
  )) as unknown as { key: string; label: string; calls: number; cost: string }[];
  return rows.map((r) => ({ key: r.key, label: r.label, calls: Number(r.calls), costMicroPhp: Number(r.cost) }));
}

/** This month's spend per person, biggest first. Calls with no person (a system job) are grouped as one row with no name. */
export async function usageByPersonThisMonth(tx: Tx, orgId: string): Promise<UsageRow[]> {
  const rows = (await tx.execute(
    sql`select coalesce(c.person_id::text, '-') as key, coalesce(p.display_name, 'System') as label, count(*)::int as calls, coalesce(sum(c.cost_micro_php), 0)::text as cost
        from ai_calls c left join persons p on p.id = c.person_id
        where c.org_id = ${orgId} and c.created_at >= ${MONTH_START}
        group by c.person_id, p.display_name order by sum(c.cost_micro_php) desc, 2`,
  )) as unknown as { key: string; label: string; calls: number; cost: string }[];
  return rows.map((r) => ({ key: r.key, label: r.label, calls: Number(r.calls), costMicroPhp: Number(r.cost) }));
}
