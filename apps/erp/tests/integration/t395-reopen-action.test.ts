import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * T-395 S2, test 18 - `reopenPinSignInAction` (apps/erp/src/app/staff/actions.ts). docs/tasks/395-pin-sign-in-throttle.md
 * section Screen: the action takes the actor from the SESSION (never the form), uses the posted `storeId` only as the
 * resource, runs `withOrgPrincipal` + `reopenPinSignIn`, and flashes "PIN sign-in reopened at {store}." or the refusal.
 *
 * TESTER, not BUILDER. Real Postgres and the REAL auth/domain underneath; only the session, Next's navigation helpers and
 * the cookie jar (the T-380 jar, `../helpers/flash-jar*`) are doubled. Banners are read through `outcomeOf`.
 *
 * ## State at HEAD
 * `reopenPinSignInAction` is not exported from `staff/actions.ts`: every leg fails on the helper's explicit
 * "reopenPinSignInAction is not exported" error (MISSING FEATURE). The JUDGING assertions once it exists: A1's row, audit
 * and flash; A2's refusal with a forged actor in the form; A3's cross-store refusal; A4's no-op writes nothing.
 *
 * ## Pinned where the spec is silent (a question to the builder, never a test edit)
 *  - the form field is `storeId`; the action redirects to `/staff` carrying `store=<storeId>` as a nav key;
 *  - a refusal is a flash `error` (non-empty string) and NEVER an `ok`.
 *
 * ## Mutants
 *  - actor read from the form (`actorPersonId`/`personId` field): A2 goes red (the forged manager reopens it).
 *  - `storeId` used to pick the org or the actor's scope: A3 goes red.
 *  - `authorize` dropped in `reopenPinSignIn` (spec test 17) is also visible here: A2, A3.
 * The existing `no-client-supplied-actor` and `t342-no-null-tx-from-actions` guards stay green and are not edited.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

const h = vi.hoisted(() => ({ actor: null as null | { personId: string; orgId: string } }));

vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => h.actor),
  requireSession: vi.fn(async () => ({
    actor: h.actor, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01'),
  })),
}));
vi.mock('@/lib/constraint-messages', async () => await import('../../src/lib/constraint-messages'));

import { closeDb } from '@shareat/db';
import { captureRedirect, outcomeOf, resetJar } from '../helpers/flash-jar';

const sql = postgres(url, { max: 4 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

type ActionFn = (fd: FormData) => Promise<void>;
async function reopenAction(): Promise<ActionFn> {
  const mod = (await import('../../src/app/staff/actions')) as unknown as Record<string, unknown>;
  const fn = mod['reopenPinSignInAction'];
  if (typeof fn !== 'function') throw new Error('reopenPinSignInAction is not exported from staff/actions (T-395 S2 not built)');
  return fn as ActionFn;
}

async function fixture(hint: string) {
  const code = uid(`t395a-${hint}`);
  const [o] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = o!.id;
  const mkStore = async (n: string) =>
    (await sql<{ id: string; name: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(n)}, ${`Store ${n}`}) returning id, name`)[0]!;
  const A = await mkStore(`${hint}A`);
  const B = await mkStore(`${hint}B`);
  const mkPerson = async (name: string, role: string, storeId: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id, source) values (${p!.id}, ${storeId}, 'manual')`;
    return { personId: p!.id, orgId };
  };
  const manager = await mkPerson('Manager A', 'manager', A.id);
  const staff = await mkPerson('Staff A', 'staff', A.id);
  const otherManager = await mkPerson('Manager B', 'manager', B.id);
  for (const s of [A.id, B.id]) {
    await sql`insert into pin_attempt_throttle (org_id, store_id, fail_count, stopped_at) values (${orgId}, ${s}, 7, now() - interval '1 hour')`;
  }
  return { orgId, storeId: A.id, storeName: A.name, storeBId: B.id, manager, staff, otherManager };
}
type Fx = Awaited<ReturnType<typeof fixture>>;

const row = async (storeId: string) =>
  (await sql<{ stopped_at: Date | null; reopened_by: string | null; fail_count: number }[]>`
    select stopped_at, reopened_by, fail_count from pin_attempt_throttle where store_id = ${storeId}`)[0]!;
const auditCount = async (fx: Fx, storeId: string) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from audit_log where org_id = ${fx.orgId} and action = 'reopen_pin_sign_in' and entity_id = ${storeId}`)[0]!.n;

async function run(who: { personId: string; orgId: string }, fields: Record<string, string>) {
  resetJar();
  h.actor = who;
  const act = await reopenAction();
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  const signal = await captureRedirect(() => act(fd));
  return { signal, outcome: outcomeOf(signal) };
}

async function expectRefusedAndUnchanged(fx: Fx, outcome: ReturnType<typeof outcomeOf>, storeId: string) {
  expect(outcome.flash.ok, 'a refusal is never an ok banner').toBeUndefined();
  expect(typeof outcome.flash.error, 'a refusal is flashed as an error sentence').toBe('string');
  expect(outcome.flash.error!.length).toBeGreaterThan(0);
  expect(outcome.flash.error, 'the sentence carries no uuid').not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
  for (const id of [fx.storeId, fx.storeBId, fx.manager.personId, fx.staff.personId, fx.otherManager.personId]) {
    expect(outcome.flash.error, 'nor any store or person id').not.toContain(id);
  }
  const r = await row(storeId);
  expect(r.stopped_at, 'the store is still stopped').not.toBeNull();
  expect(r.reopened_by).toBeNull();
  expect(r.fail_count).toBe(7);
  expect(await auditCount(fx, storeId), 'no audit row on a refusal').toBe(0);
}

describe('T-395 S2 test 18 - reopenPinSignInAction', () => {
  it('A1: a manager at the store reopens it; flash "PIN sign-in reopened at {store}."; back to /staff with the store; one audit row for the SESSION actor', async () => {
    const fx = await fixture('a1');
    const { signal, outcome } = await run(fx.manager, { storeId: fx.storeId });
    expect(outcome.path).toBe('/staff');
    expect(outcome.nav.get('store'), 'the store travels as a nav key so the panel stays on it').toBe(fx.storeId);
    expect(outcome.flash.ok).toBe(`PIN sign-in reopened at ${fx.storeName}.`);
    expect(outcome.flash.error).toBeUndefined();
    expect(signal.url, 'the banner is in the flash cookie, not the address').not.toMatch(/[?&](ok|error)=/);
    const r = await row(fx.storeId);
    expect(r.stopped_at).toBeNull();
    expect(r.reopened_by).toBe(fx.manager.personId);
    expect(r.fail_count).toBe(0);
    expect(await auditCount(fx, fx.storeId)).toBe(1);
    expect((await row(fx.storeBId)).stopped_at, "the other store's stop is untouched").not.toBeNull();
  });

  it('A2 (negative): the actor comes from the session, not the form: a staff session posting a manager\'s ids is refused', async () => {
    const fx = await fixture('a2');
    const { outcome } = await run(fx.staff, {
      storeId: fx.storeId,
      actorPersonId: fx.manager.personId,
      personId: fx.manager.personId,
      orgId: fx.orgId,
      actor: fx.manager.personId,
    });
    await expectRefusedAndUnchanged(fx, outcome, fx.storeId);
  });

  it('A3 (negative): storeId is only the resource: a manager of store B posting store A is refused; their own store B works', async () => {
    const fx = await fixture('a3');
    const { outcome } = await run(fx.otherManager, { storeId: fx.storeId });
    await expectRefusedAndUnchanged(fx, outcome, fx.storeId);
    const own = await run(fx.otherManager, { storeId: fx.storeBId });
    expect(own.outcome.flash.error, 'control: the same manager reopens their own store').toBeUndefined();
    expect((await row(fx.storeBId)).stopped_at).toBeNull();
    expect(await auditCount(fx, fx.storeBId)).toBe(1);
  });

  it('A4: reopening a store that is not stopped changes nothing (no audit row, counters kept) and still returns to /staff', async () => {
    const fx = await fixture('a4');
    await sql`update pin_attempt_throttle set stopped_at = null where store_id = ${fx.storeId}`;
    const { outcome } = await run(fx.manager, { storeId: fx.storeId });
    expect(outcome.path, 'A4: reaches the action (red on HEAD: the action does not exist)').toBe('/staff');
    expect(await auditCount(fx, fx.storeId)).toBe(0);
    expect((await row(fx.storeId)).fail_count, 'a no-op does not zero tier 1').toBe(7);
  });

  it('A5: a malformed storeId is refused as a sentence (a flash error), not thrown out of the action', async () => {
    const fx = await fixture('a5');
    const { outcome } = await run(fx.manager, { storeId: 'not-a-uuid' });
    expect(outcome.flash.ok).toBeUndefined();
    expect(typeof outcome.flash.error).toBe('string');
    expect(outcome.flash.error).not.toMatch(/invalid input syntax|uuid/i);
    expect((await row(fx.storeId)).stopped_at, 'nothing reopened').not.toBeNull();
  });
});
