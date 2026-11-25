/**
 * The AI hub's admin side: provider keys, models, the priority order, the caps and the switches. T-640 (docs/tasks/640-ai-hub.md).
 *
 * Every function is gated by `authorizeHub` as its FIRST statement (the capability `manage_ai_hub`, super admin only, plus a role of admin or above), BEFORE any field check.
 * Every write is audited against its own entity, and no audit row, message or return value ever holds key material: only the provider and the last four characters.
 *
 *  - A key is encrypted (AES-256-GCM, master key from the server env) before it reaches the repo, and it is never read back to the browser.
 *  - A model comes from the list in code and becomes usable only after a Test call passes (`testAiModel`); a failed test never switches an active model off.
 *  - The Test call is in `./test-model.ts` and the real call path in `./call.ts`; both go through the privacy guard and write `ai_calls`.
 */
import type { Actor } from '@shareat/auth';
import { aiHubRepo, auditLogRepo, type Tx } from '@shareat/db';
import { AI_PROVIDERS, MODEL_CATALOGUE, PROVIDER_LABEL, catalogueModel, encryptSecret, keyContext, lastFour, type AiProvider } from '@shareat/ai';
import { AI_KEY_RULES, AI_SETTINGS_RULES } from '../field-rules/ai-hub';
import { assertFieldRules } from '../shared/field-rules-assert';
import { gone, refuse } from '../shared/refusal';
import {
  authorizeHub,
  masterKeyOf,
  MICRO,
  percentOfCap,
  pesosText,
  providerOf,
  rateText,
  requireMasterKey,
  settingsOrDefaults,
  usageLevel,
  type HubDeps,
  type HubSettings,
  type MasterKeyState,
  type UsageLevel,
} from './shared';

// -------------------------------------------------------------------------------------------------------------------
// The screen's read model
// -------------------------------------------------------------------------------------------------------------------
export interface AiProviderView {
  provider: AiProvider;
  label: string;
  hasKey: boolean;
  /** The last four characters of the key: the only part of it ever shown. */
  last4: string | null;
  setByName: string | null;
  updatedAt: Date | null;
}
export interface AiModelView {
  provider: AiProvider;
  providerLabel: string;
  model: string;
  label: string;
  centsPerMillionIn: number | null;
  centsPerMillionOut: number | null;
  hasKey: boolean;
  /** The LAST test: never run, passed, or failed. */
  test: 'never' | 'passed' | 'failed';
  testNote: string | null;
  testedAt: Date | null;
  latencyMs: number | null;
  toolCalling: boolean | null;
  active: boolean;
  priority: number | null;
  /** The last test passed, there is a key, it is on the list in code, and it is not on yet. */
  canActivate: boolean;
}
export interface AiUsageLine {
  label: string;
  calls: number;
  costText: string;
}
export interface AiHubView {
  masterKey: MasterKeyState;
  providers: AiProviderView[];
  models: AiModelView[];
  /** The active models, first choice first. */
  order: { provider: AiProvider; model: string; label: string; priority: number }[];
  settings: { enabled: boolean; monthlyCapPesos: number; dailyLimitPerPerson: number; pesosPerUsd: string; warnAtPercent: number; saved: boolean };
  stores: { storeId: string; name: string; code: string; enabled: boolean }[];
  usage: { level: UsageLevel; spentText: string; capText: string; percent: number; byFeature: AiUsageLine[]; byPerson: AiUsageLine[] };
}

const modelLabel = (provider: string, model: string): string => catalogueModel(provider, model)?.label ?? `${model} (no longer on the list)`;

export async function getAiHubView(tx: Tx, actor: Actor, deps: HubDeps = {}): Promise<AiHubView> {
  await authorizeHub(tx, actor);
  const keys = await aiHubRepo.listKeys(tx, actor.orgId);
  const stored = await aiHubRepo.listModels(tx, actor.orgId);
  const settingsRow = await aiHubRepo.getSettings(tx, actor.orgId);
  const stores = await aiHubRepo.listStoreSwitches(tx, actor.orgId);
  const spent = await aiHubRepo.spendThisMonthMicro(tx, actor.orgId);
  const byFeature = await aiHubRepo.usageByFeatureThisMonth(tx, actor.orgId);
  const byPerson = await aiHubRepo.usageByPersonThisMonth(tx, actor.orgId);
  const settings = settingsOrDefaults(settingsRow);
  const keyOf = new Map(keys.map((k) => [k.provider, k]));

  const providers: AiProviderView[] = AI_PROVIDERS.map((p) => {
    const k = keyOf.get(p);
    return { provider: p, label: PROVIDER_LABEL[p], hasKey: !!k, last4: k?.keyLast4 ?? null, setByName: k?.setByName ?? null, updatedAt: k ? (k.updatedAt ?? k.createdAt) : null };
  });

  const storedOf = new Map(stored.map((m) => [`${m.provider}/${m.model}`, m]));
  const listed = MODEL_CATALOGUE.map((c) => ({ provider: c.provider as AiProvider, model: c.model, price: c as { centsPerMillionIn: number; centsPerMillionOut: number } | null }));
  const unlisted = stored.filter((m) => !catalogueModel(m.provider, m.model)).map((m) => ({ provider: m.provider as AiProvider, model: m.model, price: null }));
  const models: AiModelView[] = [...listed, ...unlisted].map(({ provider, model, price }) => {
    const row = storedOf.get(`${provider}/${model}`);
    const hasKey = keyOf.has(provider);
    const test = row?.lastTestOk === true ? 'passed' : row?.lastTestOk === false ? 'failed' : 'never';
    return {
      provider,
      providerLabel: PROVIDER_LABEL[provider],
      model,
      label: modelLabel(provider, model),
      centsPerMillionIn: price?.centsPerMillionIn ?? null,
      centsPerMillionOut: price?.centsPerMillionOut ?? null,
      hasKey,
      test,
      testNote: row?.lastTestNote ?? null,
      testedAt: row?.lastTestAt ?? null,
      latencyMs: row?.lastTestLatencyMs ?? null,
      toolCalling: row?.toolCalling ?? null,
      active: row?.active ?? false,
      priority: row?.priority ?? null,
      canActivate: hasKey && !!price && test === 'passed' && !(row?.active ?? false),
    };
  });

  const order = stored
    .filter((m) => m.active && m.priority !== null)
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0) || a.id.localeCompare(b.id))
    .map((m) => ({ provider: m.provider as AiProvider, model: m.model, label: modelLabel(m.provider, m.model), priority: m.priority ?? 0 }));

  const line = (r: { label: string; calls: number; costMicroPhp: number }): AiUsageLine => ({ label: r.label, calls: r.calls, costText: pesosText(r.costMicroPhp) });
  return {
    masterKey: masterKeyOf(deps).state,
    providers,
    models,
    order,
    settings: {
      enabled: settings.enabled,
      monthlyCapPesos: settings.monthlyCapPesos,
      dailyLimitPerPerson: settings.dailyLimitPerPerson,
      pesosPerUsd: rateText(settings.pesosPerUsdHundredths),
      warnAtPercent: settings.warnAtPercent,
      saved: !!settingsRow,
    },
    stores: stores.map((s) => ({ storeId: s.storeId, name: s.storeName, code: s.storeCode, enabled: s.enabled })),
    usage: {
      level: usageLevel(spent, settings.monthlyCapPesos, settings.warnAtPercent),
      spentText: pesosText(spent),
      capText: pesosText(settings.monthlyCapPesos * MICRO),
      percent: percentOfCap(spent, settings.monthlyCapPesos),
      byFeature: byFeature.map(line),
      byPerson: byPerson.map(line),
    },
  };
}

// -------------------------------------------------------------------------------------------------------------------
// Keys
// -------------------------------------------------------------------------------------------------------------------

/** Saves a provider's key, new or replacing the old one (replacing means typing a new one: the old is never shown). Returns whether it replaced one. */
export async function saveProviderKey(tx: Tx, actor: Actor, input: { provider: string; key: string }, deps: HubDeps = {}): Promise<{ replaced: boolean }> {
  await authorizeHub(tx, actor);
  const provider = providerOf(input.provider);
  const key = assertFieldRules(AI_KEY_RULES, { key: input.key }).key ?? '';
  const master = requireMasterKey(deps);
  const before = await aiHubRepo.getKeyMeta(tx, actor.orgId, provider);
  const keyLast4 = lastFour(key);
  let saved: { id: string };
  try {
    saved = await aiHubRepo.upsertKey(tx, { orgId: actor.orgId, provider, keyEnvelope: encryptSecret(key, master, keyContext(actor.orgId, provider)), keyLast4, setBy: actor.personId });
  } catch {
    // ⛔ not the driver's error: its message carries the query and its parameters (the ciphertext), and error text reaches a log and a screen
    throw refuse('ai hub: saving the key failed', 'The key could not be saved just now. Try again; if it keeps failing, tell whoever looks after the system.');
  }
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'ai_key.saved',
    storeId: null,
    entityId: saved.id,
    before: before ? { provider, endsWith: before.keyLast4 } : null,
    after: { provider, endsWith: keyLast4, replaced: !!before },
    source: 'web',
  });
  return { replaced: !!before };
}

/** Removes a provider's key and, with it, that provider's models (a model cannot outlive its key). */
export async function removeProviderKey(tx: Tx, actor: Actor, input: { provider: string }): Promise<{ modelsRemoved: number }> {
  await authorizeHub(tx, actor);
  const provider = providerOf(input.provider);
  const before = await aiHubRepo.getKeyMeta(tx, actor.orgId, provider);
  if (!before) throw gone(`ai hub: no ${provider} key in org ${actor.orgId}`, `${PROVIDER_LABEL[provider]} key`);
  const r = await aiHubRepo.deleteKeyWithModels(tx, actor.orgId, provider);
  // models that were active leave a gap in the order: close it
  const stillActive = await aiHubRepo.listActiveModels(tx, actor.orgId);
  for (const [i, m] of stillActive.entries()) if (m.priority !== i + 1) await aiHubRepo.setPriority(tx, actor.orgId, m.provider, m.model, i + 1);
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'ai_key.removed',
    storeId: null,
    entityId: before.id,
    before: { provider, endsWith: before.keyLast4 },
    after: { provider, modelsRemoved: r.modelsRemoved },
    source: 'web',
  });
  return { modelsRemoved: r.modelsRemoved };
}

// -------------------------------------------------------------------------------------------------------------------
// Models: on, off, order
// -------------------------------------------------------------------------------------------------------------------
function listedModel(provider: AiProvider, model: string) {
  const c = catalogueModel(provider, model);
  if (!c) throw refuse(`ai hub: ${provider}/${model.slice(0, 40)} is not on the list`, 'That model is not on the list. Pick one from the list on the screen.');
  return c;
}

async function loadModel(tx: Tx, orgId: string, provider: AiProvider, model: string) {
  const row = await aiHubRepo.getModel(tx, orgId, provider, model);
  if (!row) throw refuse(`ai hub: ${provider}/${model} was never tested`, 'Run the Test on this model first. It can only be switched on after a test passes.');
  return row;
}

/** Switches a model on, last in the order. Refused unless its most recent Test passed. */
export async function activateAiModel(tx: Tx, actor: Actor, input: { provider: string; model: string }): Promise<void> {
  await authorizeHub(tx, actor);
  const provider = providerOf(input.provider);
  const listed = listedModel(provider, input.model);
  const row = await loadModel(tx, actor.orgId, provider, listed.model);
  if (row.active) return;
  if (row.lastTestOk !== true || row.passedAt === null) {
    throw refuse(
      `ai hub: ${provider}/${listed.model} last test did not pass`,
      'This model cannot be switched on: its last test did not pass. Fix the cause (the note under it says what went wrong) and run the Test again.',
    );
  }
  if (!(await aiHubRepo.getKeyMeta(tx, actor.orgId, provider))) throw refuse(`ai hub: no ${provider} key`, `Add the ${PROVIDER_LABEL[provider]} key first.`);
  const priority = await aiHubRepo.nextPriority(tx, actor.orgId);
  await aiHubRepo.setActive(tx, actor.orgId, provider, listed.model, true, priority);
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'ai_model.activated',
    storeId: null,
    entityId: row.id,
    before: { active: false },
    after: { active: true, provider, model: listed.model, priority },
    source: 'web',
  });
}

async function renumber(tx: Tx, orgId: string, ordered: { provider: AiProvider; model: string }[]): Promise<void> {
  for (const [i, m] of ordered.entries()) await aiHubRepo.setPriority(tx, orgId, m.provider, m.model, i + 1);
}

/** Switches a model off and closes the gap it leaves in the order. */
export async function deactivateAiModel(tx: Tx, actor: Actor, input: { provider: string; model: string }): Promise<void> {
  await authorizeHub(tx, actor);
  const provider = providerOf(input.provider);
  const row = await aiHubRepo.getModel(tx, actor.orgId, provider, input.model);
  if (!row) throw gone(`ai hub: model ${provider}/${input.model.slice(0, 40)} not in org`, 'model');
  if (!row.active) return;
  await aiHubRepo.setActive(tx, actor.orgId, provider, input.model, false, null);
  const rest = (await aiHubRepo.listActiveModels(tx, actor.orgId)).map((m) => ({ provider: m.provider as AiProvider, model: m.model }));
  await renumber(tx, actor.orgId, rest);
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'ai_model.deactivated',
    storeId: null,
    entityId: row.id,
    before: { active: true, priority: row.priority },
    after: { active: false, provider, model: input.model },
    source: 'web',
  });
}

/** Moves an active model one place earlier or later in the order the calls try them. The first is tried first. */
export async function moveAiModel(tx: Tx, actor: Actor, input: { provider: string; model: string; direction: string }): Promise<void> {
  await authorizeHub(tx, actor);
  const provider = providerOf(input.provider);
  if (input.direction !== 'up' && input.direction !== 'down') throw refuse(`ai hub: direction ${input.direction.slice(0, 10)}`, 'Choose earlier or later.');
  const active = (await aiHubRepo.listActiveModels(tx, actor.orgId)).map((m) => ({ id: m.id, provider: m.provider as AiProvider, model: m.model }));
  const at = active.findIndex((m) => m.provider === provider && m.model === input.model);
  if (at < 0) throw refuse(`ai hub: ${provider}/${input.model.slice(0, 40)} is not active`, 'Only a model that is switched on has a place in the order.');
  const to = input.direction === 'up' ? at - 1 : at + 1;
  if (to < 0 || to >= active.length) return;
  const before = active.map((m) => `${m.provider}/${m.model}`);
  const moved = [...active];
  const [one] = moved.splice(at, 1);
  moved.splice(to, 0, one!);
  await renumber(tx, actor.orgId, moved);
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'ai_model.order_set',
    storeId: null,
    entityId: one!.id,
    before: { order: before },
    after: { order: moved.map((m) => `${m.provider}/${m.model}`) },
    source: 'web',
  });
}

// -------------------------------------------------------------------------------------------------------------------
// Caps and switches
// -------------------------------------------------------------------------------------------------------------------
function hundredthsOf(text: string): number {
  const [whole = '0', frac = ''] = text.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

/** The company-wide switch, the monthly cap, the daily limit per person, the peso rate and the warning level. Nothing is written when nothing changed. */
export async function saveAiSettings(
  tx: Tx,
  actor: Actor,
  input: { enabled: string; monthlyCapPesos: string; dailyLimitPerPerson: string; pesosPerUsd: string; warnAtPercent: string },
): Promise<{ changed: boolean }> {
  await authorizeHub(tx, actor);
  if (input.enabled !== '1' && input.enabled !== '0') throw refuse(`ai hub: enabled ${input.enabled.slice(0, 10)}`, 'Choose On or Off.');
  const v = assertFieldRules(AI_SETTINGS_RULES, input);
  const next: HubSettings = {
    enabled: input.enabled === '1',
    monthlyCapPesos: Number(v.monthlyCapPesos),
    dailyLimitPerPerson: Number(v.dailyLimitPerPerson),
    pesosPerUsdHundredths: hundredthsOf(v.pesosPerUsd ?? ''),
    warnAtPercent: Number(v.warnAtPercent),
  };
  if (next.pesosPerUsdHundredths < 1000 || next.pesosPerUsdHundredths > 30000) {
    throw refuse('ai hub: peso rate out of 10.00 to 300.00', 'Enter how many pesos one US dollar costs, from 10 to 300, for example 58.00.');
  }
  const row = await aiHubRepo.getSettings(tx, actor.orgId);
  const before = settingsOrDefaults(row);
  const same = (Object.keys(next) as (keyof HubSettings)[]).every((k) => next[k] === before[k]);
  if (same && row) return { changed: false };
  const saved = await aiHubRepo.upsertSettings(tx, actor.orgId, next, actor.personId);
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'ai_settings.changed',
    storeId: null,
    entityId: saved.id,
    before: row ? { ...before } : null,
    after: { ...next },
    source: 'web',
  });
  return { changed: true };
}

/** One store's AI switch. A store with no switch is on. */
export async function setAiStoreSwitch(tx: Tx, actor: Actor, input: { storeId: string; enabled: boolean }): Promise<void> {
  await authorizeHub(tx, actor);
  if (!(await aiHubRepo.storeBelongsToOrg(tx, actor.orgId, input.storeId))) throw gone(`ai hub: store ${input.storeId} not in org`, 'store');
  const before = await aiHubRepo.isStoreOn(tx, actor.orgId, input.storeId);
  const saved = await aiHubRepo.upsertStoreSwitch(tx, actor.orgId, input.storeId, input.enabled, actor.personId);
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'ai_store_switch.set',
    storeId: null,
    entityId: saved.id,
    before: { enabled: before },
    after: { enabled: input.enabled, store: input.storeId },
    source: 'web',
  });
}
