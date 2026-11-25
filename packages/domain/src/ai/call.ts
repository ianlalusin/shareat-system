/**
 * The one door every AI feature goes through. T-640 (docs/tasks/640-ai-hub.md). A feature (Ask ERP, later) calls `callAi`; nothing else in the system talks to a model.
 *
 * In order: the privacy guard cleans the payload; the company switch, the store switch, the monthly cap and the person's daily limit are checked (a plain sentence each when refused);
 * then the ACTIVE models are tried in priority order. A timeout, a rate limit, a server fault, a refused key or an unreadable answer moves to the next model; only a request our own code
 * got wrong stops the walk. EVERY attempt, answered or not, is written to `ai_calls` (which provider and model, tokens, cost in micro-pesos, time, tool calls, ok or the error code, and the
 * prompt's SHA-256, never its text). No database transaction is held open while a provider thinks.
 *
 * ⚠️ The cap is checked before a call starts, so the one call that crosses it still completes: the cap holds to within one call.
 * ⚠️ Authorization of the FEATURE (who may ask Ask ERP, say) is the feature's own `authorize()`; this door enforces switches, caps and limits, and takes whoever it is told asked.
 */
import { randomUUID } from 'node:crypto';
import { isAdministrative, type Actor } from '@shareat/auth';
import { accessRepo, aiHubRepo, type Tx } from '@shareat/db';
import {
  adapterFor,
  catalogueModel,
  costMicroPesos,
  errorCode,
  fetchHttpClient,
  triesNextProvider,
  type AiProvider,
  type AiProviderError,
  type ChatMessage,
  type ChatRequest,
  type ChatResult,
  type ModelPrice,
  type RedactionCounts,
  type ToolCall,
  type ToolDef,
} from '@shareat/ai';
import { gone, internalFault, refuse } from '../shared/refusal';
import { assertUnderCap, asProviderError, guarded, MAX_OUTPUT_TOKENS, openKey, reservationCost, settleUsage } from './engine';
import { percentOfCap, pesosText, requireMasterKey, settingsOrDefaults, usageLevel, MICRO, type HubDeps, type HubSettings, type TxRunner } from './shared';

export interface AiCallInput {
  /** A short lower-case name for the usage report, e.g. `ask_erp`. */
  feature: string;
  /** The store the question is about, if any: its switch is honoured. */
  storeId?: string | null;
  system?: string;
  messages: readonly ChatMessage[];
  tools?: readonly ToolDef[];
  maxOutputTokens: number;
}

export interface AiCallOutput {
  text: string;
  toolCalls: readonly ToolCall[];
  /** Which provider and model ANSWERED (the log names it too). */
  provider: AiProvider;
  model: string;
  tokensIn: number;
  tokensOut: number;
  costMicroPhp: number;
  /** For an administrator, once the month's spend has reached the warning share of the cap; otherwise null. */
  warning: string | null;
  /** How many strings the privacy guard replaced, by kind. Never the text removed. */
  redactions: RedactionCounts;
}

interface Planned {
  settings: HubSettings;
  models: { provider: AiProvider; model: string; price: ModelPrice; key: string }[];
  warning: string | null;
}

/**
 * Everything that must hold BEFORE a provider is called, decided in ONE transaction under the organisation's AI lock: the switches, the monthly cap, the person's daily limit, the
 * models and their keys, and then a RESERVATION row carrying the worst-case cost of this call. The lock is held until commit and the reservation is committed with it, so a second
 * call (another request, another server process) reads the first one's reservation: two calls at the edge of the cap cannot both pass, and the cap is overshot by at most one call.
 * The reservation stops counting the moment a real row of the same call exists (see `RESERVED_CODE`).
 */
async function plan(tx: Tx, actor: Actor, input: AiCallInput, deps: HubDeps, req: ChatRequest, sha256: string, groupRef: string): Promise<Planned> {
  const settings = settingsOrDefaults(await aiHubRepo.getSettings(tx, actor.orgId));
  if (!settings.enabled) throw refuse('ai hub: AI is switched off for the organisation', 'AI features are switched off for the company. A super admin can switch them on in Settings > AI hub.');
  if (input.storeId) {
    if (!(await aiHubRepo.storeBelongsToOrg(tx, actor.orgId, input.storeId))) throw gone(`ai hub: store ${input.storeId} not in org`, 'store');
    if (!(await aiHubRepo.isStoreOn(tx, actor.orgId, input.storeId))) throw refuse('ai hub: AI is switched off for the store', 'AI features are switched off for this store.');
  }
  await aiHubRepo.lockOrgAiCap(tx, actor.orgId);
  const spent = await aiHubRepo.spendThisMonthMicro(tx, actor.orgId);
  assertUnderCap(settings, spent);
  const admin = isAdministrative((await accessRepo.activeRoleForPerson(tx, actor.personId, actor.orgId))?.role);
  if (!admin) {
    const used = await aiHubRepo.answeredToday(tx, actor.orgId, actor.personId);
    if (used >= settings.dailyLimitPerPerson) {
      throw refuse(
        'ai hub: the daily limit per person is reached',
        `You have used your ${settings.dailyLimitPerPerson} AI ${settings.dailyLimitPerPerson === 1 ? 'question' : 'questions'} for today. They start again tomorrow.`,
      );
    }
  }
  const listed = (await aiHubRepo.listActiveModels(tx, actor.orgId)).flatMap((m) => {
    const c = catalogueModel(m.provider, m.model);
    return c ? [{ provider: m.provider as AiProvider, model: m.model, price: c as ModelPrice }] : [];
  });
  if (listed.length === 0) throw refuse('ai hub: no active model', 'No AI model is switched on yet. A super admin can set one up in Settings > AI hub.');
  requireMasterKey(deps);
  const models: Planned['models'] = [];
  for (const m of listed) {
    const key = await openKey(tx, actor.orgId, m.provider, deps);
    if (key) models.push({ ...m, key });
  }
  const first = models[0];
  if (!first) throw refuse('ai hub: no active model has a readable key', 'No AI model can be used right now: its key is missing or cannot be opened. A super admin can fix it in Settings > AI hub.');
  await aiHubRepo.insertCall(tx, {
    orgId: actor.orgId,
    storeId: input.storeId ?? null,
    personId: actor.personId,
    feature: input.feature,
    provider: first.provider,
    model: first.model,
    tokensIn: 0,
    tokensOut: 0,
    costMicroPhp: reservationCost(req, models.map((m) => m.price), settings.pesosPerUsdHundredths),
    latencyMs: 0,
    toolCalls: 0,
    ok: false,
    errorCode: aiHubRepo.RESERVED_CODE,
    promptSha256: sha256,
    groupRef,
    tokensEstimated: true,
  });
  const warning =
    admin && usageLevel(spent, settings.monthlyCapPesos, settings.warnAtPercent) === 'warn'
      ? `AI spending this month is at ${percentOfCap(spent, settings.monthlyCapPesos)}% of the monthly cap (₱${pesosText(spent)} of ₱${pesosText(settings.monthlyCapPesos * MICRO)}).`
      : null;
  return { settings, models, warning };
}

export async function callAi(run: TxRunner, actor: Actor, input: AiCallInput, deps: HubDeps = {}): Promise<AiCallOutput> {
  if (!/^[a-z][a-z0-9_.]{0,59}$/.test(input.feature)) throw internalFault(`callAi: feature "${input.feature.slice(0, 30)}" is not a short lower-case name`);
  if (!Number.isInteger(input.maxOutputTokens) || input.maxOutputTokens < 1 || input.maxOutputTokens > MAX_OUTPUT_TOKENS) {
    throw internalFault(`callAi: maxOutputTokens ${String(input.maxOutputTokens)} is not a whole number from 1 to ${MAX_OUTPUT_TOKENS}`);
  }
  if (input.messages.length === 0) throw internalFault('callAi: no messages');

  // the privacy guard FIRST: nothing below ever sees the raw payload, and the hash is of what is actually sent
  const base: ChatRequest = { model: '', messages: input.messages, maxOutputTokens: input.maxOutputTokens, ...(input.system ? { system: input.system } : {}), ...(input.tools ? { tools: input.tools } : {}) };
  const g = guarded(base);

  const groupRef = randomUUID();
  const planned = await run((tx) => plan(tx, actor, input, deps, g.request, g.sha256, groupRef));
  const http = deps.http ?? fetchHttpClient;
  const kinds: string[] = [];
  let stop: AiProviderError | null = null;

  for (const m of planned.models) {
    const t0 = performance.now();
    let reply: ChatResult | null = null;
    let failure: AiProviderError | null = null;
    try {
      reply = await adapterFor(m.provider).chat({ ...g.request, model: m.model }, m.key, http);
    } catch (e) {
      failure = asProviderError(e);
    }
    const latencyMs = Math.round(performance.now() - t0);
    const usage = reply ? settleUsage(reply, g.request) : null;
    const costMicroPhp = usage ? costMicroPesos(usage, m.price, planned.settings.pesosPerUsdHundredths) : 0;
    await run((tx) =>
      aiHubRepo.insertCall(tx, {
        orgId: actor.orgId,
        storeId: input.storeId ?? null,
        personId: actor.personId,
        feature: input.feature,
        provider: m.provider,
        model: m.model,
        tokensIn: usage?.tokensIn ?? 0,
        tokensOut: usage?.tokensOut ?? 0,
        costMicroPhp,
        latencyMs,
        toolCalls: reply?.toolCalls.length ?? 0,
        ok: reply !== null,
        errorCode: failure ? errorCode(failure) : null,
        promptSha256: g.sha256,
        groupRef,
        tokensEstimated: usage?.estimated ?? false,
      }),
    );
    if (reply && usage) {
      return {
        text: reply.text,
        toolCalls: reply.toolCalls,
        provider: m.provider,
        model: m.model,
        tokensIn: usage.tokensIn,
        tokensOut: usage.tokensOut,
        costMicroPhp,
        warning: planned.warning,
        redactions: g.redactions,
      };
    }
    if (failure) {
      kinds.push(`${m.provider}:${failure.kind}`);
      if (!triesNextProvider(failure.kind)) {
        stop = failure;
        break;
      }
    }
  }

  if (stop) throw refuse(`ai hub: ${kinds.join(', ')}`, 'The AI service did not accept this request. Please tell whoever looks after the system.');
  throw refuse(`ai hub: every model failed (${kinds.join(', ')})`, 'The AI service is not answering right now. Try again in a moment.');
}
