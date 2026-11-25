/**
 * The Test call. T-640. Before a model may be used, a super admin presses Test: one tiny prompt with one tool, sent with the stored key. It proves the key works, the model name is real
 * and the provider answers, and records whether the model called the tool (`tool_calling` is a fact from this reply, never a table someone typed).
 *
 * Three steps, so no database transaction is held open while the provider thinks: (1) check who may, the cap and open the key; (2) call the provider; (3) log the call and record the result.
 * A failed test records its note and changes nothing else: an active model stays active, an untested model stays unusable.
 */
import { randomUUID } from 'node:crypto';
import type { Actor } from '@shareat/auth';
import { aiHubRepo } from '@shareat/db';
import { adapterFor, catalogueModel, costMicroPesos, errorCode, fetchHttpClient, judgeTestReply, testRequest, type AiProvider, type ChatResult } from '@shareat/ai';
import { gone, refuse } from '../shared/refusal';
import { assertUnderCap, asProviderError, failureSentence, guarded, openKey, settleUsage } from './engine';
import { authorizeHub, providerOf, requireMasterKey, settingsOrDefaults, type HubDeps, type TxRunner } from './shared';

export interface TestModelResult {
  ok: boolean;
  toolCalling: boolean;
  latencyMs: number;
  /** A plain sentence for the screen: what happened, and what to do about it. */
  note: string;
}

export async function testAiModel(run: TxRunner, actor: Actor, input: { provider: string; model: string }, deps: HubDeps = {}): Promise<TestModelResult> {
  // 1. who, which model, the cap, the key
  const plan = await run(async (tx) => {
    await authorizeHub(tx, actor);
    const provider: AiProvider = providerOf(input.provider);
    const listed = catalogueModel(provider, input.model);
    if (!listed) throw refuse(`ai hub: ${provider}/${input.model.slice(0, 40)} is not on the list`, 'That model is not on the list. Pick one from the list on the screen.');
    requireMasterKey(deps);
    if (!(await aiHubRepo.getKeyMeta(tx, actor.orgId, provider))) throw refuse(`ai hub: no ${provider} key`, 'Add this provider’s key first, then test the model.');
    const settings = settingsOrDefaults(await aiHubRepo.getSettings(tx, actor.orgId));
    assertUnderCap(settings, await aiHubRepo.spendThisMonthMicro(tx, actor.orgId));
    const key = await openKey(tx, actor.orgId, provider, deps);
    if (!key) throw refuse(`ai hub: the ${provider} key could not be opened`, 'The stored key cannot be opened with the server’s key (the server key may have changed). Remove the key and type it again.');
    return { provider, listed, key, settings };
  });

  // 2. the call, through the privacy guard, with no transaction open
  const g = guarded(testRequest(plan.listed.model));
  const t0 = performance.now();
  let reply: ChatResult | null = null;
  let kind: ReturnType<typeof asProviderError> | null = null;
  try {
    reply = await adapterFor(plan.provider).chat(g.request, plan.key, deps.http ?? fetchHttpClient);
  } catch (e) {
    kind = asProviderError(e);
  }
  const latencyMs = Math.round(performance.now() - t0);
  const verdict = reply ? judgeTestReply(reply) : { passed: false, toolCalling: false };
  const ok = reply !== null && verdict.passed;
  const note = ok
    ? `Passed in ${latencyMs} ms. ${verdict.toolCalling ? 'It can call tools.' : 'It did not call the test tool, so treat it as plain answers only.'}`
    : kind
      ? failureSentence(kind.kind)
      : 'The model answered with nothing. Try the test again.';
  const usage = reply ? settleUsage(reply, g.request) : null;
  const cost = usage ? costMicroPesos(usage, plan.listed, plan.settings.pesosPerUsdHundredths) : 0;

  // 3. log it and record the outcome (re-checked: the key may have been removed meanwhile)
  await run(async (tx) => {
    await authorizeHub(tx, actor);
    if (!(await aiHubRepo.getKeyMeta(tx, actor.orgId, plan.provider))) throw gone(`ai hub: ${plan.provider} key removed during the test`, 'key');
    await aiHubRepo.insertCall(tx, {
      orgId: actor.orgId,
      storeId: null,
      personId: actor.personId,
      feature: 'hub.test',
      provider: plan.provider,
      model: plan.listed.model,
      tokensIn: usage?.tokensIn ?? 0,
      tokensOut: usage?.tokensOut ?? 0,
      costMicroPhp: cost,
      latencyMs,
      toolCalls: reply?.toolCalls.length ?? 0,
      ok,
      errorCode: ok ? null : kind ? errorCode(kind) : 'empty_reply',
      promptSha256: g.sha256,
      groupRef: randomUUID(),
      tokensEstimated: usage?.estimated ?? false,
    });
    await aiHubRepo.recordTest(tx, { orgId: actor.orgId, provider: plan.provider, model: plan.listed.model, ok, toolCalling: verdict.toolCalling, latencyMs, note });
  });
  return { ok, toolCalling: ok && verdict.toolCalling, latencyMs, note };
}
