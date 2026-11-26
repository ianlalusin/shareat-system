import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-640 S1 - the AI hub's keys, models, caps and switches against real Postgres (docs/tasks/640-ai-hub.md tests 1, 2, 3, 5, 6).
 * The Test call, the fallback walk, the caps at call time and the privacy guard are in t640-ai-router.test.ts.
 * Every key below is made up for the test. Nothing here reaches the network.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - name must contain "_test".`);
}

import { APP_ROLE, aiHubRepo, closeDb, transaction, RefusalError, type Tx } from '@shareat/db';
import { AuthorizationError, SUPER_ADMIN_ONLY_CAPABILITIES, type Actor } from '@shareat/auth';
import { activateAiModel, deactivateAiModel, getAiHubView, moveAiModel, removeProviderKey, saveAiSettings, saveProviderKey, setAiModelOrder, setAiStoreSwitch, testAiModel, type TxRunner } from '@shareat/domain';
import { AI_DEFAULTS } from '../../src/ai/shared';

const sql = postgres(url, { max: 6 });
let seq = 0;
const uniq = (p: string) => `${p}-${Date.now()}-${++seq}`;
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const MASTER = { masterKey: Buffer.alloc(32, 7) };
const KEY_A = 'sk-test-AAAA0123456789abcdefghijklmnopqrstuv-A1B2';
const KEY_B = 'AIzaSyBBBB0123456789abcdefghijklmnopqrst-C3D4';

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
async function denied(p: Promise<unknown>): Promise<void> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, 'expected the permission refusal, got success').toBeInstanceOf(AuthorizationError);
}
/** A Postgres error code, looked for down the cause chain (drizzle wraps the driver's error). */
function pgCode(err: unknown): string | undefined {
  for (let e: unknown = err, i = 0; e && i < 5; i++, e = (e as { cause?: unknown }).cause) {
    const c = (e as { code?: string }).code;
    if (typeof c === 'string' && /^[0-9A-Z]{5}$/.test(c)) return c;
  }
  return undefined;
}

interface Fx {
  orgId: string;
  storeA: string;
  storeB: string;
  sup: Actor;
  admin: Actor;
  manager: Actor;
  staff: Actor;
  /** An owner: role admin plus every super-admin-only capability as an owner grant, as createFirstAdmin makes one. */
  owner: Actor;
  /** A manager somebody gave the capability to by mistake. */
  strayManager: Actor;
}

async function fixture(tag: string): Promise<Fx> {
  const code = uniq(`t640-${tag}`);
  const [o] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Test Org ${code}`}, ${code}) returning id`;
  const orgId = o!.id;
  const store = async (name: string) => (await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uniq('st')}, ${name}) returning id`)[0]!.id;
  const storeA = await store('Test Store A');
  const storeB = await store('Test Store B');
  const person = async (name: string, role: string): Promise<Actor> => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    return { personId: p!.id, orgId };
  };
  const sup = await person('Sue Super', 'super_admin');
  const admin = await person('Adam Admin', 'admin');
  const manager = await person('Mia Manager', 'manager');
  const staff = await person('Sam Staff', 'staff');
  const owner = await person('Olive Owner', 'admin');
  for (const g of SUPER_ADMIN_ONLY_CAPABILITIES) await sql`insert into person_grants (person_id, grant_name, grant_source) values (${owner.personId}, ${g}, 'owner')`;
  const strayManager = await person('Max Stray', 'manager');
  await sql`insert into person_grants (person_id, grant_name, grant_source) values (${strayManager.personId}, 'manage_ai_hub', 'grant')`;
  return { orgId, storeA, storeB, sup, admin, manager, staff, owner, strayManager };
}

/** What the audit log holds about the hub, as one string, so a leak of any piece of a key shows up. */
async function auditText(orgId: string): Promise<string> {
  const rows = await sql<{ action: string; before: unknown; after: unknown }[]>`select action, before, after from audit_log where org_id = ${orgId} and action like 'ai\\_%'`;
  return JSON.stringify(rows);
}
const pieces = (key: string) => Array.from({ length: key.length - 7 }, (_, i) => key.slice(i, i + 8));

// ---------------------------------------------------------------------------------------------------------------------
describe('T-640 who may use the hub (test 2: authorize first, for every function)', () => {
  it('a super admin and an owner get in; an admin, a manager, staff and a manager holding a stray grant are refused on every function, even with bad input [kills: a missing authorize, assertFieldRules before authorize, the matrix cell wrong, the role check removed]', async () => {
    const f = await fixture('who');
    const run = (fn: (tx: Tx) => Promise<unknown>) => asOrg(f.orgId, fn);
    expect((await run((tx) => getAiHubView(tx, f.sup, MASTER))) as { masterKey: string }).toMatchObject({ masterKey: 'ok' });
    expect((await run((tx) => getAiHubView(tx, f.owner, MASTER))) as { masterKey: string }).toMatchObject({ masterKey: 'ok' });
    for (const who of [f.admin, f.manager, f.staff, f.strayManager]) {
      await denied(run((tx) => getAiHubView(tx, who, MASTER)));
      // bad input on purpose: the refusal must be "you may not", never "your key is too short" (the field sentence would confirm the screen's shape to someone who may not use it)
      await denied(run((tx) => saveProviderKey(tx, who, { provider: 'bogus', key: '' }, MASTER)));
      await denied(run((tx) => saveProviderKey(tx, who, { provider: 'openai', key: KEY_A }, MASTER)));
      await denied(run((tx) => removeProviderKey(tx, who, { provider: 'openai' })));
      await denied(run((tx) => activateAiModel(tx, who, { provider: 'openai', model: 'gpt-4o-mini' })));
      await denied(run((tx) => deactivateAiModel(tx, who, { provider: 'openai', model: 'gpt-4o-mini' })));
      await denied(run((tx) => moveAiModel(tx, who, { provider: 'openai', model: 'gpt-4o-mini', direction: 'up' })));
      await denied(run((tx) => setAiModelOrder(tx, who, { order: ['bogus'] }))); // bad list on purpose: the refusal is "you may not", never "the list changed"
      await denied(run((tx) => saveAiSettings(tx, who, { enabled: 'x', monthlyCapPesos: '', dailyLimitPerPerson: '', pesosPerUsd: '', warnAtPercent: '' })));
      await denied(run((tx) => setAiStoreSwitch(tx, who, { storeId: f.storeA, enabled: false })));
      await denied(testAiModel(runnerFor(f.orgId), who, { provider: 'openai', model: 'gpt-4o-mini' }, MASTER));
    }
    // none of the refused attempts wrote anything
    const [n] = await sql<{ n: number }[]>`select (select count(*) from ai_provider_keys where org_id = ${f.orgId}) + (select count(*) from ai_settings where org_id = ${f.orgId}) + (select count(*) from ai_store_switches where org_id = ${f.orgId}) + (select count(*) from ai_calls where org_id = ${f.orgId}) as n`;
    expect(Number(n!.n)).toBe(0);
  });

  it('the person-level refusal sentence names the rule in plain words [kills: a raw capability name on screen]', async () => {
    const f = await fixture('who-words');
    const s = await sentenceOf(asOrg(f.orgId, (tx) => getAiHubView(tx, f.strayManager, MASTER)));
    expect(s).toMatch(/super admin/i);
    expect(s).not.toMatch(/manage_ai_hub/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('T-640 keys (test 1: encrypted, never shown back, never logged)', () => {
  it('the stored value is not the key; only the provider and the last 4 characters come back; no audit row, view or message holds any piece of the key [kills: a plaintext column, a key in the audit payload, a key in the read model]', async () => {
    const f = await fixture('key');
    const r1 = await asOrg(f.orgId, (tx) => saveProviderKey(tx, f.sup, { provider: 'openai', key: ` ${KEY_A} ` }, MASTER));
    expect(r1.replaced).toBe(false);
    const [row] = await sql<{ key_envelope: string; key_last4: string }[]>`select key_envelope, key_last4 from ai_provider_keys where org_id = ${f.orgId} and provider = 'openai'`;
    expect(row!.key_last4).toBe('A1B2');
    expect(row!.key_envelope.startsWith('v1.')).toBe(true);
    for (const p of pieces(KEY_A)) expect(row!.key_envelope, p).not.toContain(p);

    const view = await asOrg(f.orgId, (tx) => getAiHubView(tx, f.sup, MASTER));
    const openai = view.providers.find((p) => p.provider === 'openai')!;
    expect(openai).toMatchObject({ hasKey: true, last4: 'A1B2', setByName: 'Sue Super' });
    const viewJson = JSON.stringify(view);
    for (const p of pieces(KEY_A)) expect(viewJson, p).not.toContain(p);
    expect(viewJson).not.toContain(row!.key_envelope);
    expect(viewJson).not.toContain('v1.');

    const audit = await auditText(f.orgId);
    expect(audit).toContain('ai_key.saved');
    for (const p of pieces(KEY_A)) expect(audit, p).not.toContain(p);
    expect(audit).not.toContain(row!.key_envelope);
    expect(audit).toContain('A1B2');
  });

  it('replacing a key means typing a new one: it says "replaced", the new last 4 show, the audit row shows old and new endings and no key [kills: a replace that keeps the old key, a replace with no audit]', async () => {
    const f = await fixture('key-replace');
    await asOrg(f.orgId, (tx) => saveProviderKey(tx, f.sup, { provider: 'google', key: KEY_B }, MASTER));
    const r = await asOrg(f.orgId, (tx) => saveProviderKey(tx, f.sup, { provider: 'google', key: KEY_A }, MASTER));
    expect(r.replaced).toBe(true);
    const view = await asOrg(f.orgId, (tx) => getAiHubView(tx, f.sup, MASTER));
    expect(view.providers.find((p) => p.provider === 'google')!.last4).toBe('A1B2');
    const rows = await sql<{ before: { endsWith?: string } | null; after: { endsWith: string; replaced: boolean } }[]>`select before, after from audit_log where org_id = ${f.orgId} and action = 'ai_key.saved' order by recorded_at, id`;
    expect(rows).toHaveLength(2);
    expect(rows[1]!.before).toMatchObject({ endsWith: 'C3D4' });
    expect(rows[1]!.after).toMatchObject({ endsWith: 'A1B2', replaced: true });
    const audit = await auditText(f.orgId);
    for (const k of [KEY_A, KEY_B]) for (const p of pieces(k)) expect(audit, p).not.toContain(p);
  });

  it('replacing a key puts that provider\'s models back to untested and off, closes the gap in the order, leaves other providers alone, and says so in the audit row [kills: a new key inheriting the old key\'s passed tests]', async () => {
    const f = await fixture('key-reset');
    await asOrg(f.orgId, (tx) => saveProviderKey(tx, f.sup, { provider: 'openai', key: KEY_A }, MASTER));
    await asOrg(f.orgId, (tx) => saveProviderKey(tx, f.sup, { provider: 'google', key: KEY_B }, MASTER));
    for (const [provider, model] of [['openai', 'gpt-4o-mini'], ['google', 'gemini-2.5-flash'], ['openai', 'gpt-4.1-mini']] as const) {
      await asOrg(f.orgId, (tx) => aiHubRepo.recordTest(tx, { orgId: f.orgId, provider, model, ok: true, toolCalling: true, latencyMs: 5, note: 'ok' }));
      await asOrg(f.orgId, (tx) => activateAiModel(tx, f.sup, { provider, model }));
    }
    const r = await asOrg(f.orgId, (tx) => saveProviderKey(tx, f.sup, { provider: 'openai', key: KEY_B + 'x' }, MASTER));
    expect(r).toEqual({ replaced: true, modelsReset: 2 });
    const view = await asOrg(f.orgId, (tx) => getAiHubView(tx, f.sup, MASTER));
    for (const m of view.models.filter((x) => x.provider === 'openai' && ['gpt-4o-mini', 'gpt-4.1-mini'].includes(x.model))) {
      expect(m, m.model).toMatchObject({ test: 'never', active: false, priority: null, toolCalling: null, testNote: null, canActivate: false });
    }
    expect(view.models.find((m) => m.model === 'gemini-2.5-flash')).toMatchObject({ test: 'passed', active: true, priority: 1 });
    expect(view.order.map((o) => `${o.priority}:${o.model}`)).toEqual(['1:gemini-2.5-flash']);
    expect(await sentenceOf(asOrg(f.orgId, (tx) => activateAiModel(tx, f.sup, { provider: 'openai', model: 'gpt-4o-mini' })))).toMatch(/did not pass/);
    const [row] = await sql<{ after: { modelsReset: number } }[]>`select after from audit_log where org_id = ${f.orgId} and action = 'ai_key.saved' order by recorded_at desc, id desc limit 1`;
    expect(row!.after.modelsReset).toBe(2);
    // the first save of a key resets nothing
    const g = await fixture('key-reset-first');
    expect((await asOrg(g.orgId, (tx) => saveProviderKey(tx, g.sup, { provider: 'openai', key: KEY_A }, MASTER))).modelsReset).toBe(0);
  });

  it('without the server master key nothing is stored and the refusal is a sentence [kills: storing a key unencrypted when the master key is absent]', async () => {
    const f = await fixture('key-nomaster');
    const missing = await sentenceOf(asOrg(f.orgId, (tx) => saveProviderKey(tx, f.sup, { provider: 'openai', key: KEY_A }, { masterKey: null })));
    expect(missing).toMatch(/AI_KEYS_MASTER_KEY/);
    expect(missing).toMatch(/not|no/i);
    const [n] = await sql<{ n: number }[]>`select count(*)::int as n from ai_provider_keys where org_id = ${f.orgId}`;
    expect(n!.n).toBe(0);
    const view = await asOrg(f.orgId, (tx) => getAiHubView(tx, f.sup, { masterKey: null }));
    expect(view.masterKey).toBe('missing');
  });

  it('a key must be one unbroken run of 20 to 400 characters; the sentence never repeats what was typed; an unknown provider is refused [kills: accepting a key with spaces, echoing the key]', async () => {
    const f = await fixture('key-rules');
    for (const bad of ['', '   ', 'short', 'has a space in it 0123456789abcdef', 'x'.repeat(401)]) {
      const s = await sentenceOf(asOrg(f.orgId, (tx) => saveProviderKey(tx, f.sup, { provider: 'openai', key: bad }, MASTER)));
      expect(s).toMatch(/whole key/i);
      if (bad.trim().length > 3) expect(s).not.toContain(bad.trim());
    }
    expect(await sentenceOf(asOrg(f.orgId, (tx) => saveProviderKey(tx, f.sup, { provider: 'deepseek', key: KEY_A }, MASTER)))).toMatch(/Anthropic, Google or OpenAI/);
  });

  it('another organisation cannot list or read a key (row security) [kills: a missing org filter or policy]', async () => {
    const f = await fixture('key-rls');
    const other = await fixture('key-rls-b');
    await asOrg(f.orgId, (tx) => saveProviderKey(tx, f.sup, { provider: 'openai', key: KEY_A }, MASTER));
    expect(await asOrg(other.orgId, (tx) => aiHubRepo.listKeys(tx, f.orgId))).toEqual([]);
    expect(await asOrg(other.orgId, (tx) => aiHubRepo.getKeyEnvelope(tx, f.orgId, 'openai'))).toBeNull();
  });

  it('removing a key removes that provider\'s models, closes the gap in the order, and is audited without key material [kills: a model outliving its key, a gap in the order]', async () => {
    const f = await fixture('key-remove');
    await asOrg(f.orgId, (tx) => saveProviderKey(tx, f.sup, { provider: 'openai', key: KEY_A }, MASTER));
    await asOrg(f.orgId, (tx) => saveProviderKey(tx, f.sup, { provider: 'google', key: KEY_B }, MASTER));
    for (const [provider, model] of [['openai', 'gpt-4o-mini'], ['google', 'gemini-2.5-flash'], ['openai', 'gpt-4.1-mini']] as const) {
      await asOrg(f.orgId, (tx) => aiHubRepo.recordTest(tx, { orgId: f.orgId, provider, model, ok: true, toolCalling: true, latencyMs: 5, note: 'ok' }));
      await asOrg(f.orgId, (tx) => activateAiModel(tx, f.sup, { provider, model }));
    }
    const r = await asOrg(f.orgId, (tx) => removeProviderKey(tx, f.sup, { provider: 'openai' }));
    expect(r.modelsRemoved).toBe(2);
    const left = await sql<{ provider: string; priority: number }[]>`select provider, priority from ai_models where org_id = ${f.orgId} order by priority`;
    expect(left).toEqual([{ provider: 'google', priority: 1 }]);
    expect((await asOrg(f.orgId, (tx) => getAiHubView(tx, f.sup, MASTER))).providers.find((p) => p.provider === 'openai')).toMatchObject({ hasKey: false, last4: null });
    const audit = await auditText(f.orgId);
    expect(audit).toContain('ai_key.removed');
    for (const p of pieces(KEY_A)) expect(audit, p).not.toContain(p);
    expect(await sentenceOf(asOrg(f.orgId, (tx) => removeProviderKey(tx, f.sup, { provider: 'openai' })))).toMatch(/could not be found/i);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('T-640 models (test 3: on only after a passing test; a failing test keeps the old model)', () => {
  async function withKey(tag: string) {
    const f = await fixture(tag);
    await asOrg(f.orgId, (tx) => saveProviderKey(tx, f.sup, { provider: 'openai', key: KEY_A }, MASTER));
    return f;
  }
  const pass = (f: Fx, model: string, toolCalling = true) =>
    asOrg(f.orgId, (tx) => aiHubRepo.recordTest(tx, { orgId: f.orgId, provider: 'openai', model, ok: true, toolCalling, latencyMs: 12, note: 'Passed in 12 ms.' }));
  const fail = (f: Fx, model: string) =>
    asOrg(f.orgId, (tx) => aiHubRepo.recordTest(tx, { orgId: f.orgId, provider: 'openai', model, ok: false, toolCalling: false, latencyMs: 3, note: 'The provider refused the key.' }));
  const on = (f: Fx, model: string) => asOrg(f.orgId, (tx) => activateAiModel(tx, f.sup, { provider: 'openai', model }));

  it('an untested model, a model whose last test failed, and a model not on the list cannot be switched on; one whose test passed can [kills: activation without a passing test]', async () => {
    const f = await withKey('model-gate');
    expect(await sentenceOf(on(f, 'gpt-4o-mini'))).toMatch(/Test/);
    await fail(f, 'gpt-4o-mini');
    expect(await sentenceOf(on(f, 'gpt-4o-mini'))).toMatch(/did not pass/);
    expect(await sentenceOf(on(f, 'gpt-made-up'))).toMatch(/not on the list/);
    await pass(f, 'gpt-4o-mini', false);
    await on(f, 'gpt-4o-mini');
    const view = await asOrg(f.orgId, (tx) => getAiHubView(tx, f.sup, MASTER));
    expect(view.models.find((m) => m.model === 'gpt-4o-mini')).toMatchObject({ active: true, priority: 1, toolCalling: false, test: 'passed' });
    expect(view.order.map((o) => o.model)).toEqual(['gpt-4o-mini']);
  });

  it('a failed test leaves the active model active, records the note, and keeps the earlier pass [kills: a failed test that switches the model off or erases what it knew]', async () => {
    const f = await withKey('model-keep');
    await pass(f, 'gpt-4.1-mini');
    await on(f, 'gpt-4.1-mini');
    await fail(f, 'gpt-4.1-mini');
    const view = await asOrg(f.orgId, (tx) => getAiHubView(tx, f.sup, MASTER));
    const m = view.models.find((x) => x.model === 'gpt-4.1-mini')!;
    expect(m).toMatchObject({ active: true, priority: 1, test: 'failed', testNote: 'The provider refused the key.', toolCalling: true });
    const [db] = await sql<{ passed_at: Date | null }[]>`select passed_at from ai_models where org_id = ${f.orgId} and model = 'gpt-4.1-mini'`;
    expect(db!.passed_at).not.toBeNull();
  });

  it('the database itself refuses an active model with no passing test, an active one with no priority, and a priority on an inactive one [kills: a rule that lives only in TypeScript]', async () => {
    const f = await withKey('model-check');
    await fail(f, 'gpt-4o-mini');
    const code = async (q: Promise<unknown>) => pgCode(await q.then(() => null, (e: unknown) => e));
    expect(await code(sql`update ai_models set active = true, priority = 1 where org_id = ${f.orgId} and model = 'gpt-4o-mini'`)).toBe('23514');
    await pass(f, 'gpt-4.1');
    expect(await code(sql`update ai_models set active = true where org_id = ${f.orgId} and model = 'gpt-4.1'`)).toBe('23514');
    expect(await code(sql`update ai_models set priority = 3 where org_id = ${f.orgId} and model = 'gpt-4.1'`)).toBe('23514');
  });

  it('the order: new models go last, Move changes it, off closes the gap [kills: an order that drifts or leaves a hole]', async () => {
    const f = await withKey('model-order');
    for (const m of ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4.1']) {
      await pass(f, m);
      await on(f, m);
    }
    const order = async () => (await asOrg(f.orgId, (tx) => getAiHubView(tx, f.sup, MASTER))).order.map((o) => `${o.priority}:${o.model}`);
    expect(await order()).toEqual(['1:gpt-4o-mini', '2:gpt-4.1-mini', '3:gpt-4.1']);
    await asOrg(f.orgId, (tx) => moveAiModel(tx, f.sup, { provider: 'openai', model: 'gpt-4.1', direction: 'up' }));
    expect(await order()).toEqual(['1:gpt-4o-mini', '2:gpt-4.1', '3:gpt-4.1-mini']);
    await asOrg(f.orgId, (tx) => moveAiModel(tx, f.sup, { provider: 'openai', model: 'gpt-4o-mini', direction: 'up' })); // already first: nothing changes
    expect(await order()).toEqual(['1:gpt-4o-mini', '2:gpt-4.1', '3:gpt-4.1-mini']);
    await asOrg(f.orgId, (tx) => deactivateAiModel(tx, f.sup, { provider: 'openai', model: 'gpt-4o-mini' }));
    expect(await order()).toEqual(['1:gpt-4.1', '2:gpt-4.1-mini']);
    expect(await sentenceOf(asOrg(f.orgId, (tx) => moveAiModel(tx, f.sup, { provider: 'openai', model: 'gpt-4o-mini', direction: 'up' })))).toMatch(/switched on/);
    expect(await sentenceOf(asOrg(f.orgId, (tx) => moveAiModel(tx, f.sup, { provider: 'openai', model: 'gpt-4.1', direction: 'sideways' })))).toMatch(/earlier or later/);
    const audit = await auditText(f.orgId);
    for (const a of ['ai_model.activated', 'ai_model.deactivated', 'ai_model.order_set']) expect(audit).toContain(a);
  });

  it('T-642 setAiModelOrder: saves the whole order in one go, refuses anything but exactly the active set, audits before and after, and writes nothing for the same order [kills: authorize removed, a list that drops or invents a place, a partial renumber, no audit row, an audit row for a no-op]', async () => {
    const f = await withKey('model-set-order');
    for (const m of ['gpt-4o-mini', 'gpt-4.1-mini']) {
      await pass(f, m);
      await on(f, m);
    }
    await pass(f, 'gpt-4.1'); // tested but left off: it is not part of the active set
    const order = async () => (await asOrg(f.orgId, (tx) => getAiHubView(tx, f.sup, MASTER))).order.map((o) => `${o.priority}:${o.model}`);
    const key = (m: string) => `openai/${m}`;
    const set = (who: Actor, list: string[]) => asOrg(f.orgId, (tx) => setAiModelOrder(tx, who, { order: list }));
    const audits = async () => sql<{ before: { order: string[] }; after: { order: string[] } }[]>`select before, after from audit_log where org_id = ${f.orgId} and action = 'ai_model.order_set'`;

    // the person-level refusal: only a super admin (or an owner) may; nothing moves
    for (const who of [f.admin, f.manager, f.staff, f.strayManager]) await denied(set(who, [key('gpt-4.1-mini'), key('gpt-4o-mini')]));
    expect(await order()).toEqual(['1:gpt-4o-mini', '2:gpt-4.1-mini']);

    // a list that is not exactly the active set is refused with a plain sentence and changes nothing: one missing, one extra (tested but off), a repeat, an unknown name, an empty list
    const same = [key('gpt-4o-mini'), key('gpt-4.1-mini')];
    for (const bad of [same.slice(1), [...same, key('gpt-4.1')], [same[0]!, same[0]!], [same[0]!, 'openai/not-a-model'], []]) {
      expect(await sentenceOf(set(f.sup, bad))).toMatch(/Reload the page/);
    }
    expect(await order()).toEqual(['1:gpt-4o-mini', '2:gpt-4.1-mini']);
    expect(await audits()).toHaveLength(0);

    // the whole order is saved at once (a full reversal), numbered 1..n with no gap
    const reversed = [...same].reverse();
    expect((await set(f.sup, reversed)).changed).toBe(true);
    expect(await order()).toEqual(['1:gpt-4.1-mini', '2:gpt-4o-mini']);
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.before.order).toEqual(same);
    expect(rows[0]!.after.order).toEqual(reversed);

    // the same order again: nothing changes and no second audit row
    expect((await set(f.sup, reversed)).changed).toBe(false);
    expect(await audits()).toHaveLength(1);
    // an owner may
    expect((await set(f.owner, same)).changed).toBe(true);
    expect(await order()).toEqual(['1:gpt-4o-mini', '2:gpt-4.1-mini']);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('T-640 caps and switches (test 5, the settings half)', () => {
  it('an organisation with no row gets the defaults in code, and those are the table\'s own defaults [kills: code and table disagreeing about 1000 / 30 / 58.00 / 80]', async () => {
    const f = await fixture('settings-defaults');
    const view = await asOrg(f.orgId, (tx) => getAiHubView(tx, f.sup, MASTER));
    expect(view.settings).toEqual({ enabled: true, monthlyCapPesos: 1000, dailyLimitPerPerson: 30, pesosPerUsd: '58.00', warnAtPercent: 80, saved: false });
    const [row] = await sql<{ enabled: boolean; monthly_cap_pesos: number; daily_limit_per_person: number; pesos_per_usd_hundredths: number; warn_at_percent: number }[]>`
      insert into ai_settings (org_id) values (${f.orgId}) returning enabled, monthly_cap_pesos, daily_limit_per_person, pesos_per_usd_hundredths, warn_at_percent`;
    expect({ enabled: row!.enabled, monthlyCapPesos: row!.monthly_cap_pesos, dailyLimitPerPerson: row!.daily_limit_per_person, pesosPerUsdHundredths: row!.pesos_per_usd_hundredths, warnAtPercent: row!.warn_at_percent }).toEqual({ ...AI_DEFAULTS });
  });

  it('saving changes the caps and is audited; saving the same again writes nothing [kills: a cap that does not save, an audit row per no-op]', async () => {
    const f = await fixture('settings-save');
    const input = { enabled: '1', monthlyCapPesos: '2,500', dailyLimitPerPerson: '12', pesosPerUsd: '57.5', warnAtPercent: '90' };
    expect((await asOrg(f.orgId, (tx) => saveAiSettings(tx, f.sup, input))).changed).toBe(true);
    const view = await asOrg(f.orgId, (tx) => getAiHubView(tx, f.sup, MASTER));
    expect(view.settings).toEqual({ enabled: true, monthlyCapPesos: 2500, dailyLimitPerPerson: 12, pesosPerUsd: '57.50', warnAtPercent: 90, saved: true });
    expect(view.usage.capText).toBe('2500.00');
    expect((await asOrg(f.orgId, (tx) => saveAiSettings(tx, f.sup, input))).changed).toBe(false);
    expect((await asOrg(f.orgId, (tx) => saveAiSettings(tx, f.sup, { ...input, enabled: '0' }))).changed).toBe(true);
    const rows = await sql<{ before: unknown; after: { enabled: boolean; monthlyCapPesos: number } }[]>`select before, after from audit_log where org_id = ${f.orgId} and action = 'ai_settings.changed' order by recorded_at, id`;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.before).toBeNull();
    expect(rows[1]!.after).toMatchObject({ enabled: false, monthlyCapPesos: 2500 });
  });

  it('out-of-range values are refused in sentences and nothing is written [kills: a cap past the table limit reaching the database as a raw error]', async () => {
    const f = await fixture('settings-bad');
    const ok = { enabled: '1', monthlyCapPesos: '1000', dailyLimitPerPerson: '30', pesosPerUsd: '58', warnAtPercent: '80' };
    expect(await sentenceOf(asOrg(f.orgId, (tx) => saveAiSettings(tx, f.sup, { ...ok, monthlyCapPesos: '1000001' })))).toMatch(/monthly cap/i);
    expect(await sentenceOf(asOrg(f.orgId, (tx) => saveAiSettings(tx, f.sup, { ...ok, monthlyCapPesos: '12.5' })))).toMatch(/monthly cap/i);
    expect(await sentenceOf(asOrg(f.orgId, (tx) => saveAiSettings(tx, f.sup, { ...ok, dailyLimitPerPerson: '-1' })))).toMatch(/daily limit/i);
    expect(await sentenceOf(asOrg(f.orgId, (tx) => saveAiSettings(tx, f.sup, { ...ok, pesosPerUsd: '9.99' })))).toMatch(/pesos/i);
    expect(await sentenceOf(asOrg(f.orgId, (tx) => saveAiSettings(tx, f.sup, { ...ok, pesosPerUsd: '300.50' })))).toMatch(/pesos/i);
    expect(await sentenceOf(asOrg(f.orgId, (tx) => saveAiSettings(tx, f.sup, { ...ok, warnAtPercent: '0' })))).toMatch(/warning/i);
    expect(await sentenceOf(asOrg(f.orgId, (tx) => saveAiSettings(tx, f.sup, { ...ok, enabled: 'maybe' })))).toMatch(/On or Off/);
    const [n] = await sql<{ n: number }[]>`select count(*)::int as n from ai_settings where org_id = ${f.orgId}`;
    expect(n!.n).toBe(0);
  });

  it('a store switch is saved and audited; a store of another organisation is refused [kills: a switch on a foreign store]', async () => {
    const f = await fixture('switch');
    const other = await fixture('switch-b');
    await asOrg(f.orgId, (tx) => setAiStoreSwitch(tx, f.sup, { storeId: f.storeA, enabled: false }));
    const view = await asOrg(f.orgId, (tx) => getAiHubView(tx, f.sup, MASTER));
    expect(view.stores.find((s) => s.storeId === f.storeA)!.enabled).toBe(false);
    expect(view.stores.find((s) => s.storeId === f.storeB)!.enabled).toBe(true);
    await asOrg(f.orgId, (tx) => setAiStoreSwitch(tx, f.sup, { storeId: f.storeA, enabled: true }));
    expect((await asOrg(f.orgId, (tx) => getAiHubView(tx, f.sup, MASTER))).stores.find((s) => s.storeId === f.storeA)!.enabled).toBe(true);
    expect(await sentenceOf(asOrg(f.orgId, (tx) => setAiStoreSwitch(tx, f.sup, { storeId: other.storeA, enabled: false })))).toMatch(/could not be found/i);
    const [n] = await sql<{ n: number }[]>`select count(*)::int as n from audit_log where org_id = ${f.orgId} and action = 'ai_store_switch.set'`;
    expect(n!.n).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('T-640 the call log is append-only and holds no prompt (test 6, the table half)', () => {
  const sha = 'a'.repeat(64);
  const base = (orgId: string, over: Record<string, unknown> = {}) => ({ orgId, feature: 'ask_erp', provider: 'openai', model: 'gpt-4o-mini', ok: true, sha, ...over });
  const insert = (o: ReturnType<typeof base>) =>
    asOrg(o.orgId, (tx) => tx.execute(dsql`insert into ai_calls (org_id, feature, provider, model, ok, error_code, prompt_sha256, group_ref) values (${o.orgId}, ${o.feature}, ${o.provider}, ${o.model}, ${o.ok}, ${(o as { errorCode?: string | null }).errorCode ?? null}, ${o.sha}, uuidv7())`));

  it('the app can insert and read a row but not change or delete one (42501) [kills: a grant of UPDATE or DELETE on ai_calls]', async () => {
    const f = await fixture('calls-append');
    await insert(base(f.orgId));
    await expect(asOrg(f.orgId, (tx) => tx.execute(dsql`update ai_calls set tokens_in = 5 where org_id = ${f.orgId}`))).rejects.toSatisfy((e: unknown) => pgCode(e) === '42501');
    await expect(asOrg(f.orgId, (tx) => tx.execute(dsql`delete from ai_calls where org_id = ${f.orgId}`))).rejects.toSatisfy((e: unknown) => pgCode(e) === '42501');
    const [n] = await sql<{ n: number }[]>`select count(*)::int as n from ai_calls where org_id = ${f.orgId}`;
    expect(n!.n).toBe(1);
  });

  it('a hash that is not 64 hex characters, a feature that is not a short lower-case name, an ok row with an error code and a failed row without one are refused (23514) [kills: storing text in the hash column, an inconsistent ok/error pair]', async () => {
    const f = await fixture('calls-checks');
    const code = async (p: Promise<unknown>) => pgCode(await p.then(() => null, (e: unknown) => e));
    expect(await code(insert(base(f.orgId, { sha: 'What is the TIN of Maria Santos?' })))).toBe('23514');
    expect(await code(insert(base(f.orgId, { sha: 'A'.repeat(64) })))).toBe('23514');
    expect(await code(insert(base(f.orgId, { feature: 'Ask ERP' })))).toBe('23514');
    expect(await code(insert(base(f.orgId, { errorCode: 'timeout' })))).toBe('23514');
    expect(await code(insert(base(f.orgId, { ok: false })))).toBe('23514');
    expect(await code(insert(base(f.orgId, { ok: false, errorCode: 'rate_limit_429' })))).toBeUndefined();
    expect(await code(insert(base(f.orgId, { provider: 'deepseek' })))).toBe('23514');
  });
});
