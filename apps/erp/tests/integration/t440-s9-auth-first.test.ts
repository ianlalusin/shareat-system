import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * T-440 S9a - behaviour skeletons for DEF-676 (authorization BEFORE field checks). Spec: docs/tasks/440-live-field-checks.md,
 * S9 "Behaviour tests". One case per class, each with an actor who holds NO capability (a plain staff member) posting a BAD
 * field:
 *
 *   (i-R) fixed-assets createAssetAction   - the action's own gate is later (createAsset authorizes inside the callback)
 *   (ii)  service-charge distributeAction  - single caller: the assert must move into the domain function
 *   (iii) customers createCustomerAction   - domain has other callers: action-level `can()` pre-check
 *
 * Each case expects: the AUTHORIZATION refusal (the very message the same person gets for a VALID form), never the field
 * sentence, and EXACTLY ONE denial event (`security.authorize_denied`, first denial of the Manila day = one audit row).
 * Red today = the field sentence came back (and, because authorize never ran, no denial was recorded).
 *
 * Mutants the slices must keep dead: assert before the gate (field sentence returns); pre-check on another capability
 * (the wrong/no denial is logged, or a holder is refused).
 *
 * Harness: the mocks and fixture style of t364-expense-form-authorise-first.test.ts. Runs on any `_test` database.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

class RedirectSignal extends Error {
  constructor(public to: string) {
    super(`redirect:${to}`);
  }
}
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
  notFound: () => {
    throw new Error('notFound() called - fixture is broken');
  },
}));

const ACTOR_HOLDER: { actor: { orgId: string; personId: string } | null } = { actor: null };
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => ACTOR_HOLDER.actor!),
  requireSession: vi.fn(async () => null),
}));

import { flushSecurityEvents } from '@shareat/auth';
import { paramsOf } from '../helpers/flash-jar';

const sql = postgres(url, { max: 3 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  const { closeDb } = await import('@shareat/db');
  await closeDb();
  await sql.end({ timeout: 5 });
});

/** A fresh org + store + one plain staff member (role staff, store scope, NO grants, NO position). */
async function fixture(hint: string) {
  const code = uid(`t440s9-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${'Plain Staff'}) returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, 'staff')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${store!.id})`;
  return { orgId, storeId: store!.id, staff: { orgId, personId: p!.id } };
}

async function errorOf(action: () => Promise<void>): Promise<string> {
  try {
    await action();
  } catch (err) {
    if (err instanceof RedirectSignal) {
      const e = paramsOf(err.to).get('error');
      expect(e, `the action redirected without an error: ${err.to}`).not.toBeNull();
      return e!;
    }
    throw err;
  }
  throw new Error('expected the action to redirect');
}

async function denialRows(orgId: string): Promise<number> {
  await flushSecurityEvents();
  const [r] = await sql<{ n: number }[]>`select count(*)::int as n from audit_log where org_id = ${orgId} and action = 'security.authorize_denied'`;
  return r!.n;
}

/**
 * The shared claim. `bad` posts the bad field, `valid` posts a valid form. Order matters: the bad post runs FIRST on a fresh
 * org, so its denial is the day's first (one audit row); the valid post afterwards is only the BASE for the message.
 */
async function expectAuthFirst(
  f: Awaited<ReturnType<typeof fixture>>,
  field: RegExp,
  bad: () => Promise<void>,
  valid: () => Promise<void>,
) {
  ACTOR_HOLDER.actor = f.staff;
  const got = await errorOf(bad);
  expect(got, `got the field sentence instead of the authorization refusal: ${JSON.stringify(got)}`).not.toMatch(field);
  expect(await denialRows(f.orgId), 'exactly one denial event for the bad post').toBe(1);
  const base = await errorOf(valid);
  expect(base, 'BASE (the same person, a VALID form) must itself be a refusal').toMatch(/may not|not allowed|permission|cannot|can.t/i);
  expect(got, 'a bad field must be refused exactly like a valid one').toBe(base);
}

describe('T-440 S9 behaviour - a caller without the capability is refused, not corrected (one case per class)', () => {
  it('(i-R) fixed-assets createAssetAction: bad cost + no capability => the authorization refusal, one denial', async () => {
    const f = await fixture('ira');
    const { createAssetAction } = await import('../../src/app/fixed-assets/actions');
    const form = (cost: string) => {
      const fd = new FormData();
      fd.set('storeId', f.storeId);
      fd.set('name', 'Walk-in chiller');
      fd.set('category', 'equipment');
      fd.set('acquiredOn', '2026-01-10');
      fd.set('cost', cost);
      return fd;
    };
    await expectAuthFirst(f, /cost|amount|valid|at least/i, () => createAssetAction(form('0')), () => createAssetAction(form('1500.00')));
  });

  it('(ii) service-charge distributeAction: bad amount + no capability => the authorization refusal, one denial', async () => {
    const f = await fixture('ii');
    const { distributeAction } = await import('../../src/app/service-charge/actions');
    const form = (amount: string) => {
      const fd = new FormData();
      fd.set('storeId', f.storeId);
      fd.set('moneyAccountId', '00000000-0000-4000-8000-000000000001');
      fd.set('amount', amount);
      fd.set('paidOn', '2026-01-10');
      return fd;
    };
    await expectAuthFirst(f, /amount|valid|at least|number/i, () => distributeAction(form('1,5')), () => distributeAction(form('500.00')));
  });

  it('(iii) customers createCustomerAction: blank name + no capability => the authorization refusal, one denial', async () => {
    const f = await fixture('iii');
    const { createCustomerAction } = await import('../../src/app/customers/actions');
    const form = (name: string) => {
      const fd = new FormData();
      fd.set('name', name);
      return fd;
    };
    await expectAuthFirst(f, /needs a name|recognise/i, () => createCustomerAction(form('')), () => createCustomerAction(form('Aling Nena Store')));
  });
});
