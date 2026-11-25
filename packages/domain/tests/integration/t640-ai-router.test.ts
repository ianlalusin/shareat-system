import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { createHash } from 'node:crypto';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-640 S2 - the Test call, the fallback walk, the monthly cap, the daily limit, the log and the privacy guard, against real Postgres and FAKE providers
 * (docs/tasks/640-ai-hub.md tests 3, 4, 5, 6, 7, 8). No real network: every provider is a scripted function. Every key and number below is made up.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - name must contain "_test".`);
}

import { APP_ROLE, aiHubRepo, closeDb, transaction, RefusalError, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import { AiProviderError, type HttpClient } from '@shareat/ai';
import { activateAiModel, callAi, getAiHubView, moveAiModel, saveAiSettings, saveProviderKey, setAiStoreSwitch, testAiModel, type TxRunner } from '@shareat/domain';

const sql = postgres(url, { max: 6 });
let seq = 0;
const uniq = (p: string) => `${p}-${Date.now()}-${++seq}`;
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const KEYS = { openai: 'sk-test-OOOO0123456789abcdefghijklmnopqrst-O1O2', google: 'AIzaSyGGGG0123456789abcdefghijklmnopqr-G1G2', anthropic: 'sk-ant-api03-AAAA0123456789abcdefghijklmnopqrstuv-A1A2' } as const;
type P = keyof typeof KEYS;

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}
const runnerFor = (orgId: string): TxRunner => <T,>(fn: (tx: Tx) => Promise<T>) => asOrg(orgId, fn);
async function sentenceOf(p: Promise<unknown>): Promise<string> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, 'expected a refusal, got success').not.toBeNull();
  expect(err instanceof RefusalError || err instanceof AuthorizationError, `expected a refusal, got ${String((err as Error)?.message)}`).toBe(true);
  const s = (err as RefusalError | AuthorizationError).userMessage;
  expect(s).toBeTruthy();
  return s as string;
}

// ---- the fake providers ------------------------------------------------------------------------------------------------------------------------
type Step = { status: number; body?: unknown } | 'timeout' | 'ok';
interface Seen {
  provider: P;
  headers: Record<string, string>;
  body: string;
  url: string;
}
function reply(provider: P, o: { text?: string; tokensIn?: number; tokensOut?: number; tool?: boolean } = {}): unknown {
  const text = o.text ?? 'ok';
  const [tin, tout] = [o.tokensIn ?? 100, o.tokensOut ?? 20];
  if (provider === 'openai') {
    return { choices: [{ message: { content: text, ...(o.tool ? { tool_calls: [{ id: 'c1', function: { name: 'ping', arguments: '{"value":"ok"}' } }] } : {}) } }], usage: { prompt_tokens: tin, completion_tokens: tout } };
  }
  if (provider === 'google') {
    return { candidates: [{ content: { parts: [{ text }, ...(o.tool ? [{ functionCall: { name: 'ping', args: { value: 'ok' } } }] : [])] } }], usageMetadata: { promptTokenCount: tin, candidatesTokenCount: tout } };
  }
  return { content: [{ type: 'text', text }, ...(o.tool ? [{ type: 'tool_use', id: 't1', name: 'ping', input: { value: 'ok' } }] : [])], usage: { input_tokens: tin, output_tokens: tout } };
}
function net() {
  const seen: Seen[] = [];
  const script: Record<P, (n: number) => Step> = { openai: () => 'ok', google: () => 'ok', anthropic: () => 'ok' };
  const replies: Record<P, unknown> = { openai: reply('openai'), google: reply('google'), anthropic: reply('anthropic') };
  const count: Record<P, number> = { openai: 0, google: 0, anthropic: 0 };
  const http: HttpClient = async (req) => {
    const provider: P = req.url.includes('openai') ? 'openai' : req.url.includes('googleapis') ? 'google' : 'anthropic';
    seen.push({ provider, headers: { ...req.headers }, body: req.body, url: req.url });
    const step = script[provider](++count[provider]);
    if (step === 'timeout') throw new AiProviderError('timeout');
    if (step === 'ok') return { status: 200, body: JSON.stringify(replies[provider]) };
    return { status: step.status, body: JSON.stringify(step.body ?? { error: { message: `Incorrect API key provided: ${KEYS[provider]}` } }) };
  };
  return { http, seen, script, replies, calls: (p: P) => seen.filter((s) => s.provider === p).length };
}

// ---- the world ---------------------------------------------------------------------------------------------------------------------------------
interface Fx {
  orgId: string;
  storeA: string;
  sup: Actor;
  admin: Actor;
  manager: Actor;
  staff: Actor;
  staff2: Actor;
}
async function fixture(tag: string): Promise<Fx> {
  const code = uniq(`t640r-${tag}`);
  const [o] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Test Org ${code}`}, ${code}) returning id`;
  const orgId = o!.id;
  const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uniq('st')}, 'Test Store A') returning id`;
  const person = async (name: string, role: string): Promise<Actor> => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    return { personId: p!.id, orgId };
  };
  return { orgId, storeA: s!.id, sup: await person('Sue Super', 'super_admin'), admin: await person('Adam Admin', 'admin'), manager: await person('Mia Manager', 'manager'), staff: await person('Sam Staff', 'staff'), staff2: await person('Sid Staff', 'staff') };
}

/** Keys for the providers, a passing Test and a switched-on model each, in the order given. */
async function ready(f: Fx, n: ReturnType<typeof net>, models: [P, string][]): Promise<void> {
  const deps = { masterKey: Buffer.alloc(32, 7), http: n.http };
  for (const p of new Set(models.map((m) => m[0]))) await asOrg(f.orgId, (tx) => saveProviderKey(tx, f.sup, { provider: p, key: KEYS[p] }, deps));
  for (const [p, m] of models) {
    const r = await testAiModel(runnerFor(f.orgId), f.sup, { provider: p, model: m }, deps);
    expect(r.ok, `${p}/${m} test`).toBe(true);
    await asOrg(f.orgId, (tx) => activateAiModel(tx, f.sup, { provider: p, model: m }));
  }
}
const deps = (n: ReturnType<typeof net>) => ({ masterKey: Buffer.alloc(32, 7), http: n.http });
const ask = (f: Fx, n: ReturnType<typeof net>, who: Actor, over: Partial<Parameters<typeof callAi>[2]> = {}) =>
  callAi(runnerFor(f.orgId), who, { feature: 'ask_erp', messages: [{ role: 'user', content: 'What did we sell today?' }], maxOutputTokens: 200, ...over }, deps(n));
const calls = (orgId: string) => sql<{ provider: string; model: string; ok: boolean; error_code: string | null; feature: string; group_ref: string; cost_micro_php: string; tokens_in: number; tokens_out: number; tool_calls: number; prompt_sha256: string; store_id: string | null; person_id: string | null }[]>`
  select provider, model, ok, error_code, feature, group_ref, cost_micro_php::text, tokens_in, tokens_out, tool_calls, prompt_sha256, store_id, person_id from ai_calls where org_id = ${orgId} order by created_at, id`;
const MONTH_BEFORE = sql`(date_trunc('month', timezone('Asia/Manila', now())) at time zone 'Asia/Manila') - interval '1 day'`;
const DAY_BEFORE = sql`(date_trunc('day', timezone('Asia/Manila', now())) at time zone 'Asia/Manila') - interval '1 minute'`;
async function logRow(f: Fx, over: { person?: Actor; cost?: number; ok?: boolean; feature?: string; at?: 'now' | 'last_month' | 'yesterday' } = {}) {
  const person = over.person ?? f.manager;
  const ok = over.ok ?? true;
  const created = over.at === 'last_month' ? MONTH_BEFORE : over.at === 'yesterday' ? DAY_BEFORE : sql`now()`;
  await sql`insert into ai_calls (org_id, person_id, feature, provider, model, cost_micro_php, ok, error_code, prompt_sha256, group_ref, created_at)
            values (${f.orgId}, ${person.personId}, ${over.feature ?? 'ask_erp'}, 'openai', 'gpt-4o-mini', ${over.cost ?? 0}, ${ok}, ${ok ? null : 'server_500'}, ${'b'.repeat(64)}, uuidv7(), ${created})`;
}

// ---------------------------------------------------------------------------------------------------------------------
describe('T-640 the Test call (test 3, test 8)', () => {
  it('a passing test records the pass and the tool fact, logs a hub.test call with tokens, cost and a hash, sends the key in a header only, and lets the model be switched on [kills: a test that records nothing, a key in the URL or body, no log row]', async () => {
    const f = await fixture('test-pass');
    const n = net();
    n.replies.openai = reply('openai', { tool: true, tokensIn: 1000, tokensOut: 200 });
    const d = deps(n);
    await asOrg(f.orgId, (tx) => saveProviderKey(tx, f.sup, { provider: 'openai', key: KEYS.openai }, d));
    const r = await testAiModel(runnerFor(f.orgId), f.sup, { provider: 'openai', model: 'gpt-4o-mini' }, d);
    expect(r).toMatchObject({ ok: true, toolCalling: true });
    expect(r.note).toMatch(/Passed in \d+ ms\. It can call tools/);
    expect(n.seen).toHaveLength(1);
    expect(n.seen[0]!.headers.authorization).toBe(`Bearer ${KEYS.openai}`);
    expect(n.seen[0]!.url).not.toContain(KEYS.openai);
    expect(n.seen[0]!.body).not.toContain(KEYS.openai);
    const log = await calls(f.orgId);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ feature: 'hub.test', provider: 'openai', model: 'gpt-4o-mini', ok: true, error_code: null, tokens_in: 1000, tokens_out: 200, tool_calls: 1, cost_micro_php: '15660', person_id: f.sup.personId, store_id: null });
    expect(log[0]!.prompt_sha256).toMatch(/^[0-9a-f]{64}$/);
    await asOrg(f.orgId, (tx) => activateAiModel(tx, f.sup, { provider: 'openai', model: 'gpt-4o-mini' }));
    const view = await asOrg(f.orgId, (tx) => getAiHubView(tx, f.sup, d));
    expect(view.models.find((m) => m.model === 'gpt-4o-mini')).toMatchObject({ test: 'passed', toolCalling: true, active: true, latencyMs: expect.any(Number) });
  });

  it('a model that answers in words and does not call the tool passes with tool_calling false [kills: tool_calling copied from a table instead of the reply]', async () => {
    const f = await fixture('test-notool');
    const n = net();
    n.replies.google = reply('google', { text: 'ok' });
    const d = deps(n);
    await asOrg(f.orgId, (tx) => saveProviderKey(tx, f.sup, { provider: 'google', key: KEYS.google }, d));
    const r = await testAiModel(runnerFor(f.orgId), f.sup, { provider: 'google', model: 'gemini-2.5-flash-lite' }, d);
    expect(r).toMatchObject({ ok: true, toolCalling: false });
    expect(n.seen[0]!.headers['x-goog-api-key']).toBe(KEYS.google);
    expect(n.seen[0]!.url).not.toContain(KEYS.google);
  });

  it('a failing test says what to do without echoing the provider, logs a failed call, and leaves an ACTIVE model active [kills: a failed test that switches off the working model, a provider reply on screen]', async () => {
    const f = await fixture('test-fail');
    const n = net();
    await ready(f, n, [['openai', 'gpt-4o-mini']]);
    n.script.openai = () => ({ status: 401 });
    const r = await testAiModel(runnerFor(f.orgId), f.sup, { provider: 'openai', model: 'gpt-4o-mini' }, deps(n));
    expect(r.ok).toBe(false);
    expect(r.note).toMatch(/refused the key/);
    expect(r.note).not.toContain('Incorrect API key');
    expect(r.note).not.toContain(KEYS.openai.slice(0, 12));
    const view = await asOrg(f.orgId, (tx) => getAiHubView(tx, f.sup, deps(n)));
    expect(view.models.find((m) => m.model === 'gpt-4o-mini')).toMatchObject({ active: true, test: 'failed', testNote: r.note });
    const log = await calls(f.orgId);
    expect(log.at(-1)).toMatchObject({ feature: 'hub.test', ok: false, error_code: 'auth_401', tokens_in: 0, cost_micro_php: '0' });
  });

  it('a model that never passed cannot be switched on, however many times a failed test is run [kills: activation without a passing test]', async () => {
    const f = await fixture('test-gate');
    const n = net();
    n.script.openai = () => ({ status: 500 });
    const d = deps(n);
    await asOrg(f.orgId, (tx) => saveProviderKey(tx, f.sup, { provider: 'openai', key: KEYS.openai }, d));
    expect((await testAiModel(runnerFor(f.orgId), f.sup, { provider: 'openai', model: 'gpt-4.1' }, d)).ok).toBe(false);
    expect(await sentenceOf(asOrg(f.orgId, (tx) => activateAiModel(tx, f.sup, { provider: 'openai', model: 'gpt-4.1' })))).toMatch(/did not pass/);
    n.script.openai = () => 'ok';
    expect((await testAiModel(runnerFor(f.orgId), f.sup, { provider: 'openai', model: 'gpt-4.1' }, d)).ok).toBe(true);
    await asOrg(f.orgId, (tx) => activateAiModel(tx, f.sup, { provider: 'openai', model: 'gpt-4.1' }));
  });

  it('testing needs the key and a model from the list, and says so [kills: a Test of a typed model name, a Test with no key]', async () => {
    const f = await fixture('test-prereq');
    const n = net();
    expect(await sentenceOf(testAiModel(runnerFor(f.orgId), f.sup, { provider: 'openai', model: 'gpt-4o-mini' }, deps(n)))).toMatch(/Add this provider/);
    await asOrg(f.orgId, (tx) => saveProviderKey(tx, f.sup, { provider: 'openai', key: KEYS.openai }, deps(n)));
    expect(await sentenceOf(testAiModel(runnerFor(f.orgId), f.sup, { provider: 'openai', model: 'gpt-9-turbo' }, deps(n)))).toMatch(/not on the list/);
    expect(await sentenceOf(testAiModel(runnerFor(f.orgId), f.sup, { provider: 'openai', model: 'gpt-4o-mini' }, { masterKey: null, http: n.http }))).toMatch(/AI_KEYS_MASTER_KEY/);
    expect(n.seen).toHaveLength(0);
  });

  it('a key stored under one server key cannot be opened under another, and the sentence tells the owner to type it again [kills: a stale key silently sent as garbage]', async () => {
    const f = await fixture('test-rotated');
    const n = net();
    await asOrg(f.orgId, (tx) => saveProviderKey(tx, f.sup, { provider: 'openai', key: KEYS.openai }, deps(n)));
    const s = await sentenceOf(testAiModel(runnerFor(f.orgId), f.sup, { provider: 'openai', model: 'gpt-4o-mini' }, { masterKey: Buffer.alloc(32, 9), http: n.http }));
    expect(s).toMatch(/type it again/);
    expect(n.seen).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('T-640 priority and fallback (test 4)', () => {
  it('the first model answers when it can; when it fails the next answers; the log names the answering provider and shares one group [kills: no fallback, a log that hides who answered]', async () => {
    const f = await fixture('walk');
    const n = net();
    n.replies.google = reply('google', { text: 'from google', tokensIn: 50, tokensOut: 10 });
    await ready(f, n, [['openai', 'gpt-4o-mini'], ['google', 'gemini-2.5-flash']]);
    const base = n.seen.length;

    const first = await ask(f, n, f.manager);
    expect(first).toMatchObject({ provider: 'openai', model: 'gpt-4o-mini', text: 'ok' });
    expect(n.calls('google')).toBe(1); // only its Test call

    n.script.openai = () => ({ status: 500 });
    const second = await ask(f, n, f.manager);
    expect(second).toMatchObject({ provider: 'google', model: 'gemini-2.5-flash', text: 'from google', tokensIn: 50, tokensOut: 10 });
    expect(n.seen.slice(base).map((s) => s.provider)).toEqual(['openai', 'openai', 'google']);

    const log = (await calls(f.orgId)).filter((r) => r.feature === 'ask_erp');
    expect(log.map((r) => `${r.provider}:${r.ok ? 'ok' : r.error_code}`)).toEqual(['openai:ok', 'openai:server_500', 'google:ok']);
    expect(log[1]!.group_ref).toBe(log[2]!.group_ref);
    expect(log[0]!.group_ref).not.toBe(log[1]!.group_ref);
    expect(log[1]).toMatchObject({ tokens_in: 0, cost_micro_php: '0' });
    expect(log[2]!.cost_micro_php).not.toBe('0');
  });

  it('a timeout, a rate limit and a refused key each move on; the order set on screen is the order tried [kills: a walk that stops on the first failure, a priority that is ignored]', async () => {
    const f = await fixture('walk-kinds');
    const n = net();
    await ready(f, n, [['openai', 'gpt-4o-mini'], ['google', 'gemini-2.5-flash'], ['anthropic', 'claude-haiku-5-5']]);
    n.script.openai = () => 'timeout';
    n.script.google = () => ({ status: 429 });
    const r = await ask(f, n, f.manager);
    expect(r.provider).toBe('anthropic');

    n.script.google = () => ({ status: 401 });
    n.script.openai = () => 'ok';
    // put anthropic first: the walk starts there and never reaches the others
    await asOrg(f.orgId, (tx) => moveAiModel(tx, f.sup, { provider: 'anthropic', model: 'claude-haiku-5-5', direction: 'up' }));
    await asOrg(f.orgId, (tx) => moveAiModel(tx, f.sup, { provider: 'anthropic', model: 'claude-haiku-5-5', direction: 'up' }));
    const before = { openai: n.calls('openai'), google: n.calls('google') };
    const r2 = await ask(f, n, f.manager);
    expect(r2.provider).toBe('anthropic');
    expect({ openai: n.calls('openai'), google: n.calls('google') }).toEqual(before);
  });

  it('a request the provider calls malformed STOPS the walk (it would fail everywhere) and says so; when every model fails there is a plain sentence and every attempt is logged [kills: retrying a bad request on every provider]', async () => {
    const f = await fixture('walk-stop');
    const n = net();
    await ready(f, n, [['openai', 'gpt-4o-mini'], ['google', 'gemini-2.5-flash']]);
    n.script.openai = () => ({ status: 400 });
    const g0 = n.calls('google');
    expect(await sentenceOf(ask(f, n, f.manager))).toMatch(/did not accept/);
    expect(n.calls('google')).toBe(g0);

    n.script.openai = () => ({ status: 503 });
    n.script.google = () => 'timeout';
    expect(await sentenceOf(ask(f, n, f.manager))).toMatch(/not answering/);
    const log = (await calls(f.orgId)).filter((r) => r.feature === 'ask_erp');
    expect(log.map((r) => `${r.provider}:${r.error_code}`)).toEqual(['openai:bad_request_400', 'openai:server_503', 'google:timeout']);
  });

  it('no active model, an organisation switch that is off, and a store switch that is off each refuse in a sentence and call nobody [kills: a call that ignores the switches]', async () => {
    const f = await fixture('switches');
    const n = net();
    expect(await sentenceOf(ask(f, n, f.manager))).toMatch(/No AI model is switched on/);
    await ready(f, n, [['openai', 'gpt-4o-mini']]);
    const seen0 = n.seen.length;
    const same = { monthlyCapPesos: '1000', dailyLimitPerPerson: '30', pesosPerUsd: '58', warnAtPercent: '80' };
    await asOrg(f.orgId, (tx) => saveAiSettings(tx, f.sup, { enabled: '0', ...same }));
    expect(await sentenceOf(ask(f, n, f.manager))).toMatch(/switched off for the company/);
    await asOrg(f.orgId, (tx) => saveAiSettings(tx, f.sup, { enabled: '1', ...same }));
    await asOrg(f.orgId, (tx) => setAiStoreSwitch(tx, f.sup, { storeId: f.storeA, enabled: false }));
    expect(await sentenceOf(ask(f, n, f.manager, { storeId: f.storeA }))).toMatch(/switched off for this store/);
    expect((await ask(f, n, f.manager)).provider).toBe('openai'); // no store named: not blocked by a store switch
    await asOrg(f.orgId, (tx) => setAiStoreSwitch(tx, f.sup, { storeId: f.storeA, enabled: true }));
    const done = await ask(f, n, f.manager, { storeId: f.storeA });
    expect(done.provider).toBe('openai');
    expect(n.seen.length).toBe(seen0 + 2);
    expect((await calls(f.orgId)).at(-1)!.store_id).toBe(f.storeA);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('T-640 the monthly cap and the daily limit (test 5)', () => {
  const same = { enabled: '1', dailyLimitPerPerson: '30', pesosPerUsd: '58', warnAtPercent: '80' };

  it('at the cap every call is refused in a sentence, no provider is called, and the Test call is refused too; last month\'s spend does not count [kills: a cap that does not refuse, a cap that never resets]', async () => {
    const f = await fixture('cap');
    const n = net();
    await ready(f, n, [['openai', 'gpt-4o-mini']]);
    await asOrg(f.orgId, (tx) => saveAiSettings(tx, f.sup, { ...same, monthlyCapPesos: '1' }));
    await logRow(f, { cost: 5_000_000, at: 'last_month' });
    const seen0 = n.seen.length;
    expect((await ask(f, n, f.manager)).provider).toBe('openai'); // last month's 5 pesos is not this month's

    await logRow(f, { cost: 1_000_000 });
    const s = await sentenceOf(ask(f, n, f.manager));
    expect(s).toMatch(/monthly AI spending cap \(₱1\) has been reached/);
    expect(s).toMatch(/1st of next month/);
    expect(await sentenceOf(testAiModel(runnerFor(f.orgId), f.sup, { provider: 'openai', model: 'gpt-4o-mini' }, deps(n)))).toMatch(/spending cap/);
    expect(n.seen.length).toBe(seen0 + 1);

    await asOrg(f.orgId, (tx) => saveAiSettings(tx, f.sup, { ...same, monthlyCapPesos: '10' })); // raising the cap reopens it at once
    expect((await ask(f, n, f.manager)).provider).toBe('openai');
    await asOrg(f.orgId, (tx) => saveAiSettings(tx, f.sup, { ...same, monthlyCapPesos: '0' }));
    expect(await sentenceOf(ask(f, n, f.manager))).toMatch(/cap/);
  });

  it('at 80% an administrator is warned and a cashier is not; the screen shows the level [kills: a warning that nobody sees, a warning shown to everyone]', async () => {
    const f = await fixture('warn');
    const n = net();
    await ready(f, n, [['openai', 'gpt-4o-mini']]);
    await asOrg(f.orgId, (tx) => saveAiSettings(tx, f.sup, { ...same, monthlyCapPesos: '10' }));
    await logRow(f, { cost: 7_900_000 });
    expect((await ask(f, n, f.admin)).warning).toBeNull(); // 79% + a call of ~0.02: still under
    await logRow(f, { cost: 100_000 });
    const adminSees = (await ask(f, n, f.admin)).warning;
    expect(adminSees).toMatch(/80%|8\d%/);
    expect(adminSees).toMatch(/monthly cap/);
    expect((await ask(f, n, f.staff)).warning).toBeNull();
    const view = await asOrg(f.orgId, (tx) => getAiHubView(tx, f.sup, deps(n)));
    expect(view.usage.level).toBe('warn');
    expect(view.usage.capText).toBe('10.00');
    expect(view.usage.percent).toBeGreaterThanOrEqual(80);
    expect(view.usage.byFeature.map((l) => l.label)).toContain('ask_erp');
    expect(view.usage.byPerson.length).toBeGreaterThan(0);
  });

  it('a person gets their daily limit of answered questions; failed attempts, the hub\'s own tests and yesterday do not count; another person is not affected; an administrator is exempt; 0 refuses everyone but administrators [kills: a limit that counts the wrong rows, no admin exemption]', async () => {
    const f = await fixture('daily');
    const n = net();
    await ready(f, n, [['openai', 'gpt-4o-mini']]);
    await asOrg(f.orgId, (tx) => saveAiSettings(tx, f.sup, { ...same, monthlyCapPesos: '1000', dailyLimitPerPerson: '2' }));
    await logRow(f, { person: f.manager, ok: false });
    await logRow(f, { person: f.manager, feature: 'hub.test' });
    await logRow(f, { person: f.manager, at: 'yesterday' });
    await logRow(f, { person: f.manager, at: 'yesterday' });
    await logRow(f, { person: f.manager, at: 'yesterday' });
    await ask(f, n, f.manager);
    await ask(f, n, f.manager);
    const s = await sentenceOf(ask(f, n, f.manager));
    expect(s).toMatch(/used your 2 AI questions for today/);
    expect((await ask(f, n, f.staff)).provider).toBe('openai');
    for (let i = 0; i < 4; i++) await ask(f, n, f.admin);
    for (let i = 0; i < 4; i++) await ask(f, n, f.sup);

    await asOrg(f.orgId, (tx) => saveAiSettings(tx, f.sup, { ...same, monthlyCapPesos: '1000', dailyLimitPerPerson: '0' }));
    expect(await sentenceOf(ask(f, n, f.staff2))).toMatch(/used your 0 AI questions/);
    expect((await ask(f, n, f.admin)).provider).toBe('openai');
  });

  it('the cost is worked out at the peso rate in force, from the provider\'s token counts and the price in code, and is stored as whole micro-pesos [kills: a hard-coded rate, a float cost]', async () => {
    const f = await fixture('cost');
    const n = net();
    await ready(f, n, [['openai', 'gpt-4o-mini']]);
    n.replies.openai = reply('openai', { tokensIn: 1000, tokensOut: 200 });
    const r1 = await ask(f, n, f.manager);
    expect(r1.costMicroPhp).toBe(15_660); // 27,000 cent-tokens x 58.00 / 10,000
    await asOrg(f.orgId, (tx) => saveAiSettings(tx, f.sup, { enabled: '1', monthlyCapPesos: '1000', dailyLimitPerPerson: '30', pesosPerUsd: '60', warnAtPercent: '80' }));
    const r2 = await ask(f, n, f.manager);
    expect(r2.costMicroPhp).toBe(16_200);
    const log = (await calls(f.orgId)).filter((r) => r.feature === 'ask_erp');
    expect(log.map((r) => r.cost_micro_php)).toEqual(['15660', '16200']);
    const view = await asOrg(f.orgId, (tx) => getAiHubView(tx, f.sup, deps(n)));
    expect(Number(view.usage.spentText)).toBeGreaterThanOrEqual(0.03); // 1,566 (the test) + 15,660 + 16,200 micro-pesos = 0.033
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('T-640 the log holds a hash, never the prompt; the guard cleans what leaves (tests 6 and 7)', () => {
  it('ai_calls stores the SHA-256 of the prompt as sent and no text; the provider received the scrubbed text, not the TIN or the key [kills: a prompt in the log, an unscrubbed payload, a hash of the raw text]', async () => {
    const f = await fixture('hash');
    const n = net();
    await ready(f, n, [['openai', 'gpt-4o-mini']]);
    const seen0 = n.seen.length;
    const typed = 'What did Lipa sell? Owner TIN 123-456-789, key sk-ant-api03-ZZZZ0123456789abcdefgh, PIN: 4821.';
    const out = await ask(f, n, f.manager, { messages: [{ role: 'user', content: typed }], system: 'You help the owner.' });
    expect(out.redactions).toMatchObject({ government_id: 1, key: 1, credential: 1 });
    const sent = n.seen.slice(seen0).map((s) => s.body).join('\n');
    for (const leak of ['123-456-789', 'sk-ant-api03', 'ZZZZ0123456789', '4821']) expect(sent, leak).not.toContain(leak);
    expect(sent).toContain('What did Lipa sell?');
    const cleaned = 'What did Lipa sell? Owner TIN [ID REMOVED], key [KEY REMOVED], PIN: [REMOVED].';
    const want = createHash('sha256').update(JSON.stringify({ system: 'You help the owner.', messages: [{ role: 'user', content: cleaned }], tools: [] })).digest('hex');
    const row = (await calls(f.orgId)).filter((r) => r.feature === 'ask_erp').at(-1)!;
    expect(row.prompt_sha256).toBe(want);
    const [dump] = await sql<{ t: string }[]>`select string_agg(row_to_json(c)::text, ' ') as t from ai_calls c where org_id = ${f.orgId}`;
    for (const text of ['Lipa', 'What did', '123-456-789', 'sk-ant', 'You help the owner']) expect(dump!.t, text).not.toContain(text);
  });

  it('a picture in the payload is refused before anything is sent or logged [kills: a receipt image reaching a provider]', async () => {
    const f = await fixture('picture');
    const n = net();
    await ready(f, n, [['openai', 'gpt-4o-mini']]);
    const seen0 = n.seen.length;
    const logs0 = (await calls(f.orgId)).length;
    expect(await sentenceOf(ask(f, n, f.manager, { messages: [{ role: 'user', content: 'read this data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ' }] }))).toMatch(/picture/);
    expect(n.seen.length).toBe(seen0);
    expect((await calls(f.orgId)).length).toBe(logs0);
  });

  it('a feature name that is not a short lower-case name, and an out-of-range answer length, are programming faults, not user sentences [kills: a free-text feature in the log]', async () => {
    const f = await fixture('inputs');
    const n = net();
    await expect(ask(f, n, f.manager, { feature: 'Ask ERP' })).rejects.toThrow(/feature/);
    await expect(ask(f, n, f.manager, { maxOutputTokens: 0 })).rejects.toThrow(/maxOutputTokens/);
    await expect(ask(f, n, f.manager, { maxOutputTokens: 100_000 })).rejects.toThrow(/maxOutputTokens/);
    await expect(ask(f, n, f.manager, { messages: [] })).rejects.toThrow(/no messages/);
  });

  it('the stored key never appears in the log, the screen model or any message across a whole session of calls and failures [kills: a key leaking anywhere]', async () => {
    const f = await fixture('noleak');
    const n = net();
    await ready(f, n, [['openai', 'gpt-4o-mini'], ['google', 'gemini-2.5-flash']]);
    n.script.openai = () => ({ status: 401 });
    const out = await ask(f, n, f.manager);
    const view = await asOrg(f.orgId, (tx) => getAiHubView(tx, f.sup, deps(n)));
    const [dump] = await sql<{ t: string }[]>`select string_agg(row_to_json(c)::text, ' ') as t from ai_calls c where org_id = ${f.orgId}`;
    const [audit] = await sql<{ t: string }[]>`select string_agg(row_to_json(a)::text, ' ') as t from audit_log a where org_id = ${f.orgId} and action like 'ai\\_%'`;
    const everything = [JSON.stringify(out), JSON.stringify(view), dump!.t, audit!.t].join('\n');
    for (const k of Object.values(KEYS)) for (let i = 0; i + 8 <= k.length; i += 3) expect(everything, k.slice(i, i + 8)).not.toContain(k.slice(i, i + 8));
  });
});
