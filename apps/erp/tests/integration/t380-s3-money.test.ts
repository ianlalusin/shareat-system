import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-380 S3 - M5, M6 and the statutory-discounts nav round-trip (docs/tasks/380-no-typed-values-in-urls.md, S3).
 *
 * State on HEAD (S3 not built; every S3 action still redirects with `?error=` / `?ok=`):
 *  - SPEC DEFECT (report): the spec's M5 amount `'1,234.56'` is REFUSED by the domain (`is not a valid amount`: money input takes no
 *         thousands separator), so M5 uses `'1234.56'`. M6's `'1,0OO'` is still refused for the letter O as well as the comma.
 *  - M5   GREEN on HEAD, by design. It is the money invariant: the posted lines are exactly the typed amount and the
 *         page address holds no amount. Its job is to stay green through S3. Named mutant: the builder re-parses or
 *         reformats `amountOut` when moving the redirect (e.g. `Number(amountOut)`), so the lines differ -> M5 red.
 *  - M6   RED on HEAD: the refusal sentence quotes `"1,0OO"` and rides in `?error=`. Mutants: `money-transfers`
 *         keeps a template `?error=` -> M6 red (and G-S3 red); `redirectWithFlash` not awaited on the catch path ->
 *         falls through to the success redirect -> `flash.ok` set and M6 red.
 *  - M6b  RED on HEAD: the same refusal on the settle form (`settleBetweenStoresAction`), the sibling in that file.
 *  - S3-N RED on HEAD: statutory-discounts carries `from`/`to` back (REV-5). They are ISO-date NAV keys: they must come
 *         back byte-for-byte while the refusal sentence leaves the URL. Mutant: drop `from`/`to` from `nav` -> red;
 *         put `error` back in the template -> red.
 *
 * `outcomeOf` has an URL fallback until S6, so a flash assertion alone would pass on HEAD; every red leg therefore also
 * reads the raw redirect URL.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
const ACTOR_HOLDER: { actor: { orgId: string; personId: string } | null } = { actor: null };
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => ACTOR_HOLDER.actor!),
}));
vi.mock('@/lib/constraint-messages', async () => await import('../../src/lib/constraint-messages'));

import { transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import * as transferActions from '../../src/app/money-transfers/actions';
import * as statutoryActions from '../../src/app/statutory-discounts/actions';
import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { postEntry } from '../../../../packages/domain/src/ledger/post-entry';
import { captureRedirect, outcomeOf, resetJar, type Outcome } from '../helpers/flash-jar';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
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

/** Two stores, an admin over both, each safe funded with 100,000. */
async function fixture(hint: string) {
  const code = uid(`t380s3-${hint}`);
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
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  const adminId = p!.id;
  await sql`insert into person_roles (person_id, org_id, role) values (${adminId}, ${orgId}, 'admin')`;
  for (const s of [lipaId, malvarId]) await sql`insert into person_store_scope (person_id, store_id) values (${adminId}, ${s})`;
  for (const storeId of [lipaId, malvarId]) {
    await asOrg(orgId, (tx) =>
      postEntry(tx, {
        orgId, entryDate: '2026-01-01', sourceType: 'manual_journal', sourceId: uid('fund'), idempotencyKey: uid('fund'), memo: 'fixture funding', postedBy: adminId,
        lines: [{ accountCode: '1130', storeId, debit: '100000.00' }, { accountCode: '3900', storeId, credit: '100000.00' }],
      }),
    );
  }
  return { orgId, lipaId, malvarId, lipaSafe: await safeOf(lipaId), malvarSafe: await safeOf(malvarId), admin: actor(orgId, adminId) };
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

const counts = async (orgId: string) => ({
  entries: Number((await sql<{ n: string }[]>`select count(*)::text as n from journal_entries where org_id = ${orgId}`)[0]!.n),
  transfers: Number((await sql<{ n: string }[]>`select count(*)::text as n from money_transfers where org_id = ${orgId}`)[0]!.n),
});

/** Lines of every entry that is not the fixture funding, as [account code, debit, credit]. */
async function transferLines(orgId: string): Promise<Array<[string, string, string]>> {
  const rows = await sql<{ code: string; debit: string; credit: string }[]>`
    select a.code as code, jl.debit::text as debit, jl.credit::text as credit
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id
      join accounts a on a.id = jl.account_id
     where je.org_id = ${orgId} and je.source_type <> 'manual_journal'
     order by a.code, jl.debit desc`;
  return rows.map((r) => [r.code, r.debit, r.credit]);
}

const createTransfer = (transferActions as unknown as { createMoneyTransferAction: (fd: FormData) => Promise<void> }).createMoneyTransferAction;
const settle = (transferActions as unknown as { settleBetweenStoresAction: (fd: FormData) => Promise<void> }).settleBetweenStoresAction;
const recordDiscount = (statutoryActions as unknown as { recordStatutoryDiscountAction: (fd: FormData) => Promise<void> }).recordStatutoryDiscountAction;

const transferForm = (f: Fixture, amountOut: string) =>
  formOf({ fromMoneyAccountId: f.malvarSafe, toMoneyAccountId: f.lipaSafe, amountOut, amountIn: '', transferDate: '2026-01-16', reference: 'REF-1', notes: '' });

describe('M5 - a money transfer posts exactly the typed amount (I2)', () => {
  it('1234.56 posts 1234.56 on each leg, one entry, and the page address holds no amount', async () => {
    const f = await fixture('m5');
    const before = await counts(f.orgId);
    const seen = await run(f.admin, createTransfer, transferForm(f, '1234.56'));
    expect(seen.raw, 'refused').not.toMatch(/error=/);

    const after = await counts(f.orgId);
    expect(after.entries - before.entries).toBe(1);
    expect(after.transfers - before.transfers).toBe(1);
    expect(await transferLines(f.orgId)).toEqual([
      ['1130', '1234.56', '0.00'], // destination safe
      ['1130', '0.00', '1234.56'], // source safe
      ['1250', '1234.56', '0.00'], // in transit (the transfer's clearing leg)
      ['2150', '0.00', '1234.56'], // the matching clearing credit
    ]);

    expect(seen.outcome.path).toBe('/money-transfers');
    expect(seen.outcome.flash.ok).toBe('created');
    expect(seen.outcome.flash.error).toBeUndefined();
    for (const typed of ['1,234.56', '1%2C234.56', '1234.56', '123456', '₱', '%E2%82%B1']) {
      expect(seen.raw, `the amount "${typed}" is in the address`).not.toContain(typed);
    }
  });
});

describe('M6 - a refused amount leaves the address, and the refusal still quotes it to the person (B1)', () => {
  it('"1,0OO" (letter O): refused, nothing posted, flash.error quotes it, the address holds neither it nor any error text', async () => {
    const f = await fixture('m6');
    const before = await counts(f.orgId);
    const seen = await run(f.admin, createTransfer, transferForm(f, '1,0OO'));

    expect(await counts(f.orgId)).toEqual(before);
    expect(seen.outcome.flash.error, 'the person got no refusal').toContain('"1,0OO"');
    expect(seen.outcome.flash.ok).toBeUndefined();
    expect(seen.raw, 'the typed amount is in the address').not.toMatch(/1(,|%2C)0OO/);
    expect(seen.raw, 'the refusal sentence is in the address').not.toMatch(/error=/);
    expect(seen.outcome.f, 'no flash token in the address').not.toBeNull();
  });

  it('M6b: the same on the settle form (same file, other action)', async () => {
    const f = await fixture('m6b');
    const before = await counts(f.orgId);
    const seen = await run(
      f.admin,
      settle,
      formOf({ settlementId: crypto.randomUUID(), fromMoneyAccountId: f.malvarSafe, toMoneyAccountId: f.lipaSafe, amountOut: '1,0OO', amountIn: '', transferDate: '2026-01-16' }),
    );
    expect(await counts(f.orgId)).toEqual(before);
    expect(seen.outcome.flash.error).toContain('"1,0OO"');
    expect(seen.raw).not.toMatch(/1(,|%2C)0OO/);
    expect(seen.raw).not.toMatch(/error=/);
  });
});

describe('S3-N - statutory-discounts: from/to are navigation and come back byte for byte; the refusal does not', () => {
  it('a refused record (blank invoice number) returns to /statutory-discounts with exactly store, from, to and f', async () => {
    const f = await fixture('s3n');
    const before = await counts(f.orgId);
    const seen = await run(
      f.admin,
      recordDiscount,
      formOf({
        storeId: f.lipaId, from: '2026-01-05', to: '2026-01-20', businessDate: '2026-01-16', invoiceNumber: '', kind: 'senior',
        idNumber: 'SC-123', holderName: 'Pa-load ni Boss', grossAmount: '1,0OO', discountAmount: '10.00',
      }),
    );
    expect(await counts(f.orgId)).toEqual(before);

    const u = new URL(seen.raw, 'http://flash.test');
    expect(u.pathname).toBe('/statutory-discounts');
    expect([...u.searchParams.keys()].sort(), `the address carries more than navigation: ${seen.raw}`).toEqual(['f', 'from', 'store', 'to']);
    expect(u.searchParams.get('store')).toBe(f.lipaId);
    expect(u.searchParams.get('from')).toBe('2026-01-05');
    expect(u.searchParams.get('to')).toBe('2026-01-20');
    expect(seen.outcome.flash.error, 'the person got no refusal').toBeTruthy();
    expect(seen.raw).not.toContain('Pa-load');
  });
});
