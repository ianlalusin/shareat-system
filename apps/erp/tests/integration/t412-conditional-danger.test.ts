import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * T-412 AUDIT ROUND H1 / H2 (TESTER) - the two CONDITIONAL danger buttons the first census missed (`variant={x ? 'danger' : ...}`):
 *   admin/stores/[id]      "Close this branch"  -> deactivateStoreAction   Tier R: retype the STORE's name
 *   admin/users/[personId] "In scope - remove"  -> setStoreScopeAction     Tier R: retype the PERSON's name
 * Both names are loaded by the server from the database (field `confirmName`, never a form-supplied name). Refusal sentence:
 * "Type the name exactly — '<name>' — to confirm."  The same actions' safe direction (reactivate / add scope) needs no name.
 *
 * MUTANTS: MC-1 drop retypeMatches from deactivateStoreAction -> C1 red; MC-2 drop it from the remove leg of setStoreScopeAction
 * -> C3 red; MC-3 require the name on the ADD leg too -> C5 red; MC-4 compare against a form-supplied name -> C2 / C4 red.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - name must contain "_test".`);
}

const h = vi.hoisted(() => ({ actor: null as null | { personId: string; orgId: string } }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => h.actor),
  requireSession: vi.fn(async () => ({ actor: h.actor, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01') })),
}));
vi.mock('@/lib/constraint-messages', async () => await import('../../src/lib/constraint-messages'));

import { closeDb } from '@shareat/db';
import { captureRedirect, outcomeOf, resetJar } from '../helpers/flash-jar';
import { moneyFixture } from '../../../../packages/domain/tests/integration/_fixtures/t402-s3-money';

const sql = postgres(url, { max: 4 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const sentence = (name: string) => `Type the name exactly — '${name}' — to confirm.`;

async function run(modulePath: string, name: string, fields: Record<string, string>, who: { personId: string; orgId: string }) {
  const mod = (await import(/* @vite-ignore */ modulePath)) as Record<string, unknown>;
  const fn = mod[name];
  if (typeof fn !== 'function') throw new Error(`MISSING EXPORT: ${modulePath} does not export ${name}.`);
  resetJar();
  h.actor = who;
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return outcomeOf(await captureRedirect(() => (fn as (f: FormData) => Promise<void>)(fd)));
}

async function fx(hint: string) {
  const f = await moneyFixture(sql, hint);
  const [st] = await sql<{ name: string }[]>`select name from stores where id = ${f.storeId}`;
  return { f, storeName: st!.name };
}
const isActive = async (storeId: string) => (await sql<{ a: boolean }[]>`select is_active as a from stores where id = ${storeId}`)[0]!.a;

describe('H1 deactivateStoreAction ("Close this branch") is Tier R: retype the store name', () => {
  const MOD = '../../src/app/admin/stores/actions';

  it('C1: no confirmName, a wrong name and a prefix are refused with the sentence naming the REAL store name; the store stays open (MC-1)', async () => {
    const { f, storeName } = await fx('h1-refuse');
    for (const typed of [undefined, 'Store', 'some other branch']) {
      const fields: Record<string, string> = { storeId: f.storeId, ...(typed === undefined ? {} : { confirmName: typed }) };
      const o = await run(MOD, 'deactivateStoreAction', fields, f.admin);
      expect(o.flash.error, `typed ${String(typed)}`).toBe(sentence(storeName));
      expect(await isActive(f.storeId), 'still open').toBe(true);
    }
  });

  it('C2: a name supplied BY THE FORM is not the expected name (forged expectedName / name fields change nothing) (MC-4)', async () => {
    const { f, storeName } = await fx('h1-forged');
    const o = await run(MOD, 'deactivateStoreAction', { storeId: f.storeId, confirmName: 'Beef', expectedName: 'Beef', name: 'Beef', storeName: 'Beef' }, f.admin);
    expect(o.flash.error).toBe(sentence(storeName));
    expect(await isActive(f.storeId)).toBe(true);
  });

  it('C1b: the real name, in any case and with stray spaces, closes the branch', async () => {
    const { f, storeName } = await fx('h1-ok');
    const o = await run(MOD, 'deactivateStoreAction', { storeId: f.storeId, confirmName: `  ${storeName.toUpperCase()}  ` }, f.admin);
    expect(o.flash.error).toBeUndefined();
    expect(await isActive(f.storeId)).toBe(false);
  });

  it('C1c: REOPENING is not a danger action: reactivateStoreAction needs no name', async () => {
    const { f } = await fx('h1-reopen');
    await sql`update stores set is_active = false where id = ${f.storeId}`;
    const o = await run(MOD, 'reactivateStoreAction', { storeId: f.storeId }, f.admin);
    expect(o.flash.error).toBeUndefined();
    expect(await isActive(f.storeId)).toBe(true);
  });
});

describe('H2 setStoreScopeAction remove ("In scope - remove") is Tier R: retype the PERSON name', () => {
  const MOD = '../../src/app/admin/users/actions';
  const inScope = async (personId: string, storeId: string) =>
    (await sql<{ n: number }[]>`select count(*)::int as n from person_store_scope where person_id = ${personId} and store_id = ${storeId}`)[0]!.n === 1;

  it('C3: removing scope with no name, a wrong name or a prefix is refused with the sentence naming the REAL person; the scope row stays (MC-2)', async () => {
    const { f } = await fx('h2-refuse');
    // the person whose scope is removed: the fixture's manager, display_name 'Manager'
    for (const typed of [undefined, 'Man', 'Somebody Else']) {
      const fields: Record<string, string> = { personId: f.managerId, storeId: f.storeId, granted: 'false', ...(typed === undefined ? {} : { confirmName: typed }) };
      const o = await run(MOD, 'setStoreScopeAction', fields, f.admin);
      expect(o.flash.error, `typed ${String(typed)}`).toBe(sentence('Manager'));
      expect(await inScope(f.managerId, f.storeId), 'scope row still there').toBe(true);
    }
  });

  it('C4: a person name supplied BY THE FORM is not the expected name (MC-4)', async () => {
    const { f } = await fx('h2-forged');
    const o = await run(MOD, 'setStoreScopeAction', { personId: f.managerId, storeId: f.storeId, granted: 'false', confirmName: 'Nobody', expectedName: 'Nobody', name: 'Nobody', personName: 'Nobody' }, f.admin);
    expect(o.flash.error).toBe(sentence('Manager'));
    expect(await inScope(f.managerId, f.storeId)).toBe(true);
  });

  it('C3b: the real name (any case, stray spaces) removes the scope row', async () => {
    const { f } = await fx('h2-ok');
    const o = await run(MOD, 'setStoreScopeAction', { personId: f.managerId, storeId: f.storeId, granted: 'false', confirmName: '  MANAGER ' }, f.admin);
    expect(o.flash.error).toBeUndefined();
    expect(await inScope(f.managerId, f.storeId)).toBe(false);
  });

  it('C5: ADDING scope is the safe direction and needs no name (MC-3)', async () => {
    const { f } = await fx('h2-add');
    await sql`delete from person_store_scope where person_id = ${f.staffId} and store_id = ${f.storeId}`;
    const o = await run(MOD, 'setStoreScopeAction', { personId: f.staffId, storeId: f.storeId, granted: 'true' }, f.admin);
    expect(o.flash.error).toBeUndefined();
    expect(await inScope(f.staffId, f.storeId)).toBe(true);
  });
});
