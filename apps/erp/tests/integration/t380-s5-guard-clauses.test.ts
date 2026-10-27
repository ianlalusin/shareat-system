import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * T-380 S5 - M9 and W-S5 (docs/tasks/380-no-typed-values-in-urls.md, S5).
 *
 * State on HEAD (S5 not built; the S5 actions still redirect with `?error=` / `?ok=`):
 *  - M9   RED on HEAD: `refundCreditAction` with a typed amount and no credit on file -> the domain returns
 *         `{ ok: false, reason: 'only 0.00 of credit is available - 1500.00 does not fit' }` (the guard clause after
 *         the call). That sentence quotes the typed amount and rides in `?error=`. After S5 it rides in the flash.
 *         Invariant legs (green on HEAD, must stay green): no journal entry, no `supplier_credit_refund` posted.
 *         Named mutants: the guard-clause `redirectWithFlash` loses its `await` (or `return`) -> the success redirect
 *         wins, `flash.ok` is set and `flash.error` is not -> M9 red (and G1b red); the `?error=` template stays -> red.
 *         REV-8: the invariant legs hold with or without the mutant (the domain already refused); the leg that proves
 *         R7 is `flash.error` set AND `flash.ok` unset, and that is what is asserted here.
 *  - W-S5 RED on HEAD: staff "add position" with a typed name -> the success banner `Position "<name>" added.` rides in
 *         `?ok=` and carries the name. After S5 it is in the flash only. The position row is written (green leg).
 *         Named mutant: the template `?ok=` stays in `backToRoster` -> W-S5 red. `store` is NAV and stays in the URL.
 *
 * `outcomeOf` has a URL fallback until S6, so a flash assertion alone would pass on HEAD; every red leg also reads the
 * raw redirect URL.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
const ACTOR_HOLDER: { actor: { orgId: string; personId: string } | null } = { actor: null };
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => ACTOR_HOLDER.actor!),
}));
vi.mock('@/lib/constraint-messages', async () => await import('../../src/lib/constraint-messages'));

import type { Actor } from '@shareat/auth';
import * as returnActions from '../../src/app/inventory/returns/actions';
import * as staffActions from '../../src/app/staff/actions';
import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { captureRedirect, outcomeOf, resetJar, type Outcome } from '../helpers/flash-jar';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

/** One org, one store, an admin over it, a supplier, and the store's office safe. */
async function fixture(hint: string) {
  const code = uid(`t380s5-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;
  const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('lipa')}, 'Lipa') returning id`;
  const storeId = s!.id;
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  const adminId = p!.id;
  await sql`insert into person_roles (person_id, org_id, role) values (${adminId}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${adminId}, ${storeId})`;
  const [sup] = await sql<{ id: string }[]>`insert into suppliers (org_id, name, created_by) values (${orgId}, 'Pork Co', ${adminId}) returning id`;
  const [safe] = await sql<{ id: string }[]>`select id from money_accounts where store_id = ${storeId} and instrument = 'cash' and custodian = 'office' and is_foundation`;
  return { orgId, storeId, supplierId: sup!.id, safeId: safe!.id, admin: actor(orgId, adminId) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function formOf(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

interface Seen {
  outcome: Outcome;
  /** The redirect target exactly as the action produced it. */
  raw: string;
}
async function run(who: Actor, fn: (fd: FormData) => Promise<void>, fd: FormData): Promise<Seen> {
  resetJar();
  ACTOR_HOLDER.actor = who;
  const signal = await captureRedirect(() => fn(fd));
  return { outcome: outcomeOf(signal), raw: signal.url };
}

const entryCount = async (orgId: string) =>
  Number((await sql<{ n: string }[]>`select count(*)::text as n from journal_entries where org_id = ${orgId}`)[0]!.n);

const refundCredit = (returnActions as unknown as { refundCreditAction: (fd: FormData) => Promise<void> }).refundCreditAction;
const addPosition = (staffActions as unknown as { upsertStorePositionAction: (fd: FormData) => Promise<void> }).upsertStorePositionAction;

describe('M9 - a refused supplier-credit refund (guard clause after the domain call) leaves the address clean (R7)', () => {
  it('refund 1500.00 with no credit: nothing posted, flash.error set and flash.ok not, the address holds no amount and no error text', async () => {
    const f: Fixture = await fixture('m9');
    const before = await entryCount(f.orgId);
    const seen = await run(f.admin, refundCredit, formOf({ requestId: crypto.randomUUID(), storeId: f.storeId, supplierId: f.supplierId, moneyAccountId: f.safeId, amount: '1500.00' }));

    expect(await entryCount(f.orgId), 'a journal entry was posted').toBe(before);
    expect(
      Number((await sql<{ n: string }[]>`select count(*)::text as n from journal_entries where org_id = ${f.orgId} and source_type = 'supplier_credit_refund'`)[0]!.n),
    ).toBe(0);

    expect(seen.outcome.path).toBe('/inventory/returns');
    expect(seen.outcome.flash.error, 'the person got no refusal').toContain('1500.00');
    expect(seen.outcome.flash.ok, 'the success banner won over the refusal (a dropped await)').toBeUndefined();
    expect(seen.raw, 'the typed amount is in the address').not.toContain('1500');
    expect(seen.raw, 'the refusal sentence is in the address').not.toMatch(/error=/);
    expect(seen.outcome.f, 'no flash token in the address').not.toBeNull();
    expect(new URL(seen.raw, 'http://flash.test').searchParams.get('store'), 'store is navigation and must stay').toBe(f.storeId);
  });
});

describe('W-S5 - staff "add position": the typed name is not in the address', () => {
  it('"Pa-load ni Boss": the position is written, the banner carries the name, the address does not', async () => {
    const f: Fixture = await fixture('ws5');
    const seen = await run(f.admin, addPosition, formOf({ storeId: f.storeId, name: 'Pa-load ni Boss' }));

    const rows = await sql<{ n: string }[]>`select count(*)::text as n from positions where org_id = ${f.orgId} and store_id = ${f.storeId} and name = 'Pa-load ni Boss'`;
    expect(Number(rows[0]!.n), 'the position was not written').toBe(1);

    expect(seen.outcome.path).toBe('/staff');
    expect(seen.outcome.flash.error).toBeUndefined();
    expect(seen.outcome.flash.ok, 'the person got no confirmation').toContain('Pa-load ni Boss');
    expect(seen.raw, 'the typed name is in the address').not.toMatch(/Pa-load|Pa%2Dload|Boss/i);
    expect(seen.raw, 'the banner is in the address').not.toMatch(/ok=/);
    expect(new URL(seen.raw, 'http://flash.test').searchParams.get('store')).toBe(f.storeId);
  });
});
