import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-641 S1 - the tool loop (`callAiWithTools`) against real Postgres and a FAKE provider: every round is its own guarded, capped, logged `callAi`; the later rounds are not extra
 * questions against the daily limit; a runaway model is stopped; a refused or failing tool reaches the model as a sentence, never as an exception. No real network.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) throw new Error(`Refusing to run against ${redactDbUrl(url)} - name must contain "_test".`);

import { closeDb, RefusalError } from '@shareat/db';
import { callAi, callAiWithTools, saveAiSettings, type AiLoopInput } from '@shareat/domain';
import { MAX_TOOL_ROUNDS } from '../../src/ai/loop';
import { MASTER, asOrg, callRows, makeWorld, readyHub, runnerFor, scripted, toolTexts, type Turn, type World } from './t641-ask-world';

const sql = postgres(url, { max: 6 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const TOOLS = [{ name: 'costDrivers', description: 'Where the expense money went.', parameters: { type: 'object', properties: { period: { type: 'string' } } } }];
const settings = (over: Record<string, string> = {}) => ({ enabled: '1', monthlyCapPesos: '1000', dailyLimitPerPerson: '30', pesosPerUsd: '58', warnAtPercent: '80', ...over });

async function world(tag: string): Promise<World> {
  const w = await makeWorld(sql, tag);
  await readyHub(w);
  return w;
}
function loop(w: World, who: World['staff'], turns: Turn[], runTool: AiLoopInput['runTool'], over: Partial<AiLoopInput> = {}) {
  const s = scripted(turns);
  const run = callAiWithTools(runnerFor(w.orgId), who, { feature: 'ask_erp', messages: [{ role: 'user', content: 'What is our cost driver this month?' }], tools: TOOLS, maxOutputTokens: 300, runTool, ...over }, { masterKey: MASTER, http: s.http });
  return { s, run };
}
async function sentenceOf(p: Promise<unknown>): Promise<string> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err instanceof RefusalError, `expected a refusal, got ${String((err as Error | null)?.message)}`).toBe(true);
  return (err as RefusalError).userMessage as string;
}

describe('T-641 the tool loop', () => {
  it('a tool round trip: the model asks, our function answers, the model answers in words; each round is a logged call and the result reaches the model [kills: a loop that never feeds the result back; one log row for two calls]', async () => {
    const w = await world('trip');
    const { s, run } = loop(w, w.manager, [{ calls: [{ tool: 'costDrivers', args: { period: 'this_month' } }] }, { text: 'Rent is the biggest cost.' }], async (c) => `{"seen":"${c.name}","total":"1,000.00"}`);
    const out = await run;
    expect(out.text).toBe('Rent is the biggest cost.');
    expect(out.rounds).toBe(2);
    expect(out.trace).toEqual([{ name: 'costDrivers', args: { period: 'this_month' }, result: '{"seen":"costDrivers","total":"1,000.00"}' }]);
    expect(s.count()).toBe(2);
    expect(toolTexts(s, 1)).toEqual(['{"seen":"costDrivers","total":"1,000.00"}']);
    expect(toolTexts(s, 0)).toEqual([]);
    const rows = await callRows(sql, w.orgId);
    expect(rows.filter((r) => r.feature === 'ask_erp.step' || r.feature === 'ask_erp').map((r) => [r.feature, r.ok, r.tool_calls])).toEqual([
      ['ask_erp', true, 1],
      ['ask_erp.step', true, 0],
    ]);
    expect(new Set(rows.map((r) => r.group_ref)).size).toBe(2);
    expect(out.tokensIn).toBe(200);
    expect(out.costMicroPhp).toBeGreaterThan(0);
  });

  it('the privacy guard covers a tool result: an e-mail address and a personal field never reach the next request [kills: a loop that sends tool results around the guard]', async () => {
    const w = await world('privacy');
    const { s, run } = loop(w, w.manager, [{ calls: [{ tool: 'costDrivers' }] }, { text: 'done' }], async () => JSON.stringify({ total: '5.00', netPay: '9,999.00', note: 'ask juan@example.com' }));
    const out = await run;
    const second = s.seen[1]!.raw;
    expect(second).toContain('5.00');
    expect(second).not.toContain('9,999.00');
    expect(second).not.toContain('juan@example.com');
    expect(Object.values(out.redactions).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });

  it('a tool that throws becomes one plain sentence for the model, and the thrown text is never sent [kills: an exception that aborts the question; a leaked internal message]', async () => {
    const w = await world('throws');
    const { s, run } = loop(w, w.manager, [{ calls: [{ tool: 'costDrivers' }] }, { text: 'I could not get that.' }], async () => {
      throw new Error('relation "secret_table" does not exist');
    });
    const out = await run;
    expect(out.text).toBe('I could not get that.');
    const sent = toolTexts(s, 1)[0]!;
    expect(sent).toMatch(/lookup failed/i);
    expect(s.seen[1]!.raw).not.toContain('secret_table');
  });

  it(`a model that never stops asking for tools is stopped after ${MAX_TOOL_ROUNDS} rounds, the tools run ${MAX_TOOL_ROUNDS} times, and the last call tells it to answer in words [kills: an unbounded loop; a cap off by one]`, async () => {
    const w = await world('runaway');
    let ran = 0;
    const { s, run } = loop(w, w.manager, [{ calls: [{ tool: 'costDrivers' }] }], async () => {
      ran += 1;
      return '{"ok":true}';
    });
    const out = await run;
    expect(ran).toBe(MAX_TOOL_ROUNDS);
    expect(s.count()).toBe(MAX_TOOL_ROUNDS + 1);
    expect(out.stopped).toBe(true);
    expect(out.rounds).toBe(MAX_TOOL_ROUNDS + 1);
    expect(out.text).toMatch(/could not finish/i);
    expect(s.seen[MAX_TOOL_ROUNDS]!.raw).toContain('used all the tool calls');
    expect(s.seen[0]!.raw).not.toContain('used all the tool calls');
  });

  it('several calls in one turn all run, in order, and their results come back together [kills: only the first call run]', async () => {
    const w = await world('multi');
    const order: string[] = [];
    const { s, run } = loop(w, w.manager, [{ calls: [{ tool: 'costDrivers', args: { period: 'a' } }, { tool: 'costDrivers', args: { period: 'b' } }] }, { text: 'ok' }], async (c) => {
      order.push(String(c.args.period));
      return `r-${String(c.args.period)}`;
    });
    await run;
    expect(order).toEqual(['a', 'b']);
    expect(toolTexts(s, 1)).toEqual(['r-a', 'r-b']);
  });

  it('a result that is too long is cut and says so [kills: an uncapped result sent to the provider]', async () => {
    const w = await world('long');
    const { s, run } = loop(w, w.manager, [{ calls: [{ tool: 'costDrivers' }] }, { text: 'ok' }], async () => 'x '.repeat(20_000));
    await run;
    const sent = toolTexts(s, 1)[0]!;
    expect(sent.length).toBeLessThan(13_000);
    expect(sent).toMatch(/was cut/);
  });
});

describe('T-641 the limits still apply to the loop', () => {
  it('a question is ONE question against the daily limit however many rounds it takes, a continuation is never refused by it, and the next question is [kills: every round counted as a question; a limit that cuts a question in half]', async () => {
    const w = await world('daily');
    await asOrg(w.orgId, (tx) => saveAiSettings(tx, w.sup, settings({ dailyLimitPerPerson: '1' })));
    const { run } = loop(w, w.staff, [{ calls: [{ tool: 'costDrivers' }] }, { calls: [{ tool: 'costDrivers' }] }, { text: 'three rounds, one question' }], async () => '{}');
    const out = await run;
    expect(out.rounds).toBe(3);
    const second = loop(w, w.staff, [{ text: 'again' }], async () => '{}');
    expect(await sentenceOf(second.run)).toMatch(/1 AI question for today/);
    // a person already at the limit can still finish a question already begun (round 2 of it), but not start one
    const noStart = scripted([{ text: 'x' }]);
    const deps = { masterKey: MASTER, http: noStart.http };
    const msgs = [{ role: 'user' as const, content: 'q' }];
    expect(await sentenceOf(callAi(runnerFor(w.orgId), w.staff, { feature: 'ask_erp', messages: msgs, maxOutputTokens: 50 }, deps))).toMatch(/AI question/);
    await expect(callAi(runnerFor(w.orgId), w.staff, { feature: 'ask_erp', messages: msgs, maxOutputTokens: 50, continuation: true }, deps)).resolves.toMatchObject({ text: 'x' });
    // the daily limit counts the person's own questions, not another person's
    const other = loop(w, w.staff2, [{ text: 'fine' }], async () => '{}');
    expect((await other.run).text).toBe('fine');
  });

  it('the monthly cap stops the NEXT round: a first round that crosses the cap is answered, its follow-up is refused in a sentence [kills: a cap checked once per question]', async () => {
    const w = await world('cap');
    await asOrg(w.orgId, (tx) => saveAiSettings(tx, w.sup, settings({ monthlyCapPesos: '1' })));
    // 20 million tokens in at gpt-4o-mini's price is far more than one peso
    const { run } = loop(w, w.manager, [{ calls: [{ tool: 'costDrivers' }], tokensIn: 20_000_000 }, { text: 'never reached' }], async () => '{}');
    expect(await sentenceOf(run)).toMatch(/monthly AI spending cap/);
    const rows = await callRows(sql, w.orgId);
    expect(rows.filter((r) => r.feature.startsWith('ask_erp')).map((r) => r.feature)).toEqual(['ask_erp']);
  });

  it('the company switch stops a question before any provider is called [kills: a loop that skips the switches]', async () => {
    const w = await world('off');
    await asOrg(w.orgId, (tx) => saveAiSettings(tx, w.sup, settings({ enabled: '0' })));
    const { s, run } = loop(w, w.manager, [{ text: 'x' }], async () => '{}');
    expect(await sentenceOf(run)).toMatch(/switched off/);
    expect(s.count()).toBe(0);
  });
});
