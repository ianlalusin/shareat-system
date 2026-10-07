import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-369 S9 — `settleBetweenStoresAction` (apps/erp/src/app/money-transfers/actions.ts): the form's door to
 * `settleBetweenStores`. `docs/tasks/369-unwired-money-screens.md` §S9 ("the action's ✗ and the refusal sentences reaching `?error=`").
 *
 * ⛔ TESTER. The action does not exist yet, so every leg is red on HEAD for that reason (`settleBetweenStoresAction is not
 * exported`). ASSUMED (the spec leaves them open — say if the builder's differ and I will follow): the form fields are
 * `settlementId` (hidden uuid), `fromMoneyAccountId`, `toMoneyAccountId`, `amountOut`, `amountIn` (blank = amountOut),
 * `transferDate`, `reference`, `notes`; success redirects to `/money-transfers?ok=<something>` and a refusal to
 * `/money-transfers?error=<written sentence>` (no `ok=`), exactly as `createMoneyTransferAction` does.
 * The domain half (every refusal, the cap, the lock, idempotency) is `packages/domain/tests/integration/t369-s9-settle-between-stores.test.ts`.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
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
}));
const ACTOR_HOLDER: { actor: { orgId: string; personId: string } | null } = { actor: null };
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => ACTOR_HOLDER.actor!),
}));
// the actions file imports the bare `@/lib/constraint-messages` specifier the root vitest config does not resolve
vi.mock('@/lib/constraint-messages', async () => await import('../../src/lib/constraint-messages'));

import { transaction, moneyAccountsRepo, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { createMoneyTransfer } from '@shareat/domain';
import * as actions from '../../src/app/money-transfers/actions';
import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { postEntry } from '../../../../packages/domain/src/ledger/post-entry';
import { urlOf } from '../helpers/flash-jar';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

async function safeOf(storeId: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`select id from money_accounts where store_id = ${storeId} and instrument = 'cash' and custodian = 'office' and is_foundation`;
  return row!.id;
}

/** Lipa owes Malvar ₱650 (an ordinary Malvar -> Lipa transfer seeds it). admin = both stores, lipaMgr = Lipa only. */
async function fixture(hint: string) {
  const code = uid(`t369s9a-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;
  const store = async (name: string) => {
    const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(name.toLowerCase())}, ${name}) returning id`;
    return s!.id;
  };
  const lipaId = await store('Lipa');
  const malvarId = await store('Malvar');
  const mk = async (name: string, role: string, stores: string[]) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    for (const s of stores) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
    return p!.id;
  };
  const adminId = await mk('Admin', 'admin', [lipaId, malvarId]);
  const lipaMgrId = await mk('Lipa Manager', 'manager', [lipaId]);
  const lipaSafe = await safeOf(lipaId);
  const malvarSafe = await safeOf(malvarId);
  for (const [storeId, accountId] of [[lipaId, lipaSafe], [malvarId, malvarSafe]] as const) {
    void accountId;
    await asOrg(orgId, (tx) =>
      postEntry(tx, {
        orgId, entryDate: '2026-01-01', sourceType: 'manual_journal', sourceId: uid('fund'), idempotencyKey: uid('fund'), memo: 'fixture funding', postedBy: adminId,
        lines: [{ accountCode: '1130', storeId, debit: '100000.00' }, { accountCode: '3900', storeId, credit: '100000.00' }],
      }),
    );
  }
  const admin = actor(orgId, adminId);
  await asOrg(orgId, (tx) => createMoneyTransfer(tx, admin, { fromMoneyAccountId: malvarSafe, toMoneyAccountId: lipaSafe, amountOut: '650.00', amountIn: '650.00', transferDate: '2026-01-16' }));
  return { orgId, lipaId, malvarId, lipaSafe, malvarSafe, admin, lipaMgr: actor(orgId, lipaMgrId) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function form(f: Fixture, over: Record<string, string | undefined> = {}): FormData {
  const fd = new FormData();
  const fields: Record<string, string | undefined> = {
    settlementId: crypto.randomUUID(), fromMoneyAccountId: f.lipaSafe, toMoneyAccountId: f.malvarSafe,
    amountOut: '400.00', amountIn: '', transferDate: '2026-01-16', reference: '', notes: '', ...over,
  };
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) fd.set(k, v);
  return fd;
}

/** Runs the action as `who`; returns where it redirected (the action always redirects). */
async function submit(who: Actor, fd: FormData): Promise<URL> {
  const fn = (actions as unknown as { settleBetweenStoresAction?: (fd: FormData) => Promise<void> }).settleBetweenStoresAction;
  if (typeof fn !== 'function') throw new Error('settleBetweenStoresAction is not exported from apps/erp/src/app/money-transfers/actions.ts (it does not exist yet)');
  ACTOR_HOLDER.actor = who;
  try {
    await fn(fd);
  } catch (err) {
    if (err instanceof RedirectSignal) return urlOf(err.to);
    throw err;
  }
  throw new Error('the action returned without redirecting');
}

const counts = async (orgId: string) => ({
  entries: Number((await sql<{ n: string }[]>`select count(*)::text as n from journal_entries where org_id = ${orgId}`)[0]!.n),
  transfers: Number((await sql<{ n: string }[]>`select count(*)::text as n from money_transfers where org_id = ${orgId}`)[0]!.n),
});
const balance = (f: Fixture, accountId: string, glCode: string, storeId: string) =>
  asOrg(f.orgId, (tx) => moneyAccountsRepo.balanceOf(tx, f.orgId, { id: accountId, glAccountCode: glCode, storeId }));

describe('the settle action', () => {
  it('✓ the admin settles ₱400 of the ₱650: redirects to /money-transfers with ok= and no error=; one transfer row whose id IS the settlementId; the debt is ₱250', async () => {
    const f = await fixture('ok');
    const settlementId = crypto.randomUUID();
    const before = await counts(f.orgId);
    const lipaBefore = await balance(f, f.lipaSafe, '1130', f.lipaId);

    const to = await submit(f.admin, form(f, { settlementId }));

    expect(to.pathname).toBe('/money-transfers');
    expect(to.searchParams.get('error'), `refused: ${to.searchParams.get('error')}`).toBeNull();
    expect(to.searchParams.get('ok')).toBeTruthy();
    const after = await counts(f.orgId);
    expect(after.transfers - before.transfers).toBe(1);
    expect(after.entries - before.entries).toBe(1);
    const [row] = await sql<{ id: string }[]>`select id from money_transfers where id = ${settlementId}`;
    expect(row, 'the money_transfers row id is not the form settlementId').toBeDefined();
    expect(Number(lipaBefore) - Number(await balance(f, f.lipaSafe, '1130', f.lipaId)), "Lipa's safe").toBe(400);
  });

  it('✓ a double submit of the SAME form (same settlementId) is a no-op: one entry, one row, and still a success redirect', async () => {
    const f = await fixture('dbl');
    const settlementId = crypto.randomUUID(); // fresh per run: the row id is a global primary key
    const fd = () => form(f, { settlementId });
    await submit(f.admin, fd());
    const afterFirst = await counts(f.orgId);
    const to = await submit(f.admin, fd());
    expect(to.searchParams.get('error'), `the replay was refused: ${to.searchParams.get('error')}`).toBeNull();
    expect(await counts(f.orgId), 'a replay wrote a second entry or row').toEqual(afterFirst);
  });

  it('✗ more than owed: the refusal sentence reaches ?error= verbatim (no id), no ok=, and nothing is written — control: the ₱400 above', async () => {
    const f = await fixture('over');
    const before = await counts(f.orgId);
    const to = await submit(f.admin, form(f, { amountOut: '700.00' }));
    const said = to.searchParams.get('error');
    expect(said).toBe('Lipa owes Malvar ₱650.00, so ₱700.00 is more than the debt. Send the difference as an ordinary transfer.');
    expect(said).not.toMatch(UUID);
    expect(to.searchParams.get('ok')).toBeNull();
    expect(await counts(f.orgId)).toEqual(before);
  });

  it('✗ wrong direction (Malvar -> Lipa): the written sentence reaches ?error=, nothing written', async () => {
    const f = await fixture('dir');
    const before = await counts(f.orgId);
    const to = await submit(f.admin, form(f, { fromMoneyAccountId: f.malvarSafe, toMoneyAccountId: f.lipaSafe }));
    expect(to.searchParams.get('error')).toBe("Malvar doesn't owe Lipa — Lipa owes Malvar ₱650.00. Swap the accounts.");
    expect(await counts(f.orgId)).toEqual(before);
  });

  it('✗ the Lipa-only manager (✗ transfer_funds at Malvar): redirected with an authorisation sentence in ?error= (no id, no raw "AuthorizationError" text), nothing written — control: the admin settles (first test)', async () => {
    const f = await fixture('auth');
    const before = await counts(f.orgId);
    const to = await submit(f.lipaMgr, form(f));
    const said = to.searchParams.get('error');
    expect(said, 'no error reached the page').toBeTruthy();
    expect(said).not.toMatch(UUID);
    expect(said).not.toMatch(/AuthorizationError|undefined|\[object/);
    expect(to.searchParams.get('ok')).toBeNull();
    expect(await counts(f.orgId)).toEqual(before);
  });

  it('✗ a form missing its settlementId is refused in words (no id, no raw text), nothing written', async () => {
    const f = await fixture('noid');
    const before = await counts(f.orgId);
    const to = await submit(f.admin, form(f, { settlementId: undefined }));
    const said = to.searchParams.get('error');
    expect(said, 'a settlement with no reference was accepted').toBeTruthy();
    expect(said).not.toMatch(UUID);
    expect(to.searchParams.get('ok')).toBeNull();
    expect(await counts(f.orgId)).toEqual(before);
  });
});
