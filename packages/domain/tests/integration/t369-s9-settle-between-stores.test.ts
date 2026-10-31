import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-369 S9 (DEF-557; Ian Q6 (a), 2026-10-02) — "Settle between stores". `docs/tasks/369-unwired-money-screens.md` §S9, T1-T11.
 *
 * Today nothing clears 1250/2150: a Lipa -> Malvar transfer meant as repayment posts the ordinary cross-store pair (DR 1250 at
 * LIPA, CR 2150 at MALVAR), so both stores' balances GROW. `settleBetweenStores` (money-transfers/settle.ts, exported from the
 * domain index) posts the cash legs of a transfer PLUS the clearing pair (DR 2150 at the debtor, CR 1250 at the creditor, for
 * `amountIn`), capped by the pair's NET position and idempotent on `settlementId`.
 *
 * ⛔ TESTER. Every leg that needs the new function is red on HEAD because it does not exist (`settleBetweenStores is not
 * exported`); the T1 CONTRAST leg, the seeding transfer and T10/T11's repo reads pin what already works or what the spec names.
 * ASSUMED shapes (the spec leaves them open — say if the builder's differ and I will follow):
 *   settleBetweenStores(tx, actor, { settlementId, fromMoneyAccountId, toMoneyAccountId, amountOut, amountIn, transferDate, feeAccountCode?, reference?, notes? })
 *     -> { id, entryId, fee, owedAfter }  (id === settlementId)
 *   moneyTransfersRepo.interStorePosition(tx, orgId, debtorStoreId, creditorStoreId) -> { owedPerDebtor, owedPerCreditor } (strings)
 *   moneyTransfersRepo.interStorePositions(tx, orgId, storeIds) -> rows { debtorStoreId, creditorStoreId, owed } (one per ordered pair with a positive net)
 *   moneyTransfersRepo.listMoneyTransfers(...) rows gain `settles: boolean`.
 *
 * MUTANTS (each turns a NAMED test red; none is planted):
 *   (i)   the ordinary gross-up pair instead of the clearing pair        -> T1 (2150 at Lipa stays 650; the four lines differ)
 *   (ii)  drop the cap                                                   -> T3 "more than owed", T6 (the loser would post)
 *   (iii) drop the lock                                                  -> T6 (B does not wait on `advisory`, both succeed)
 *   (iv)  clear `amountOut` instead of `amountIn`                        -> T8 (660 cleared, 10 over: owed goes negative)
 *   (v)   authorize only the source store                                -> T4's Malvar-only leg (settles) and T7's destination void
 *   (vi)  read only the debtor's books                                   -> T9 (the one-sided credit is invisible, the settlement posts)
 *   (vii) replay lookup after the cap read                               -> T5's second call is refused as "nothing owed"
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, moneyAccountsRepo, moneyTransfersRepo, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import * as domain from '@shareat/domain';
import { createMoneyTransfer, listFindings, voidMoneyTransfer } from '@shareat/domain';
import { postEntry } from '../../src/ledger/post-entry';

const sql = postgres(url, { max: 6 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const DATE = '2026-01-16';

afterAll(async () => {
  await closeDb();
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
const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

// -----------------------------------------------------------------------------------------------
// Concurrency harness (shape of t369-s1-reimbursement-payout.test.ts:56-144 — gated, never a bare Promise.all race)
// -----------------------------------------------------------------------------------------------

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
function trackPid<T>(op: (tx: Tx) => Promise<T>): { op: (tx: Tx) => Promise<T>; pid: Promise<number> } {
  const pid = deferred<number>();
  return {
    pid: pid.promise,
    op: async (tx) => {
      const rows = await tx.execute(dsql`select pg_backend_pid() as pid`);
      pid.resolve(Number((rows as unknown as { pid: number }[])[0]?.pid));
      return op(tx);
    },
  };
}
async function pollForWaitingBackend(bPid: Promise<number>, waitEvents: string[], settleWatch: Promise<unknown>, timeoutMs = 5000): Promise<boolean> {
  const settled = settleWatch.then(() => true).catch(() => true);
  const poll = (async (): Promise<boolean> => {
    const pid = await Promise.race([bPid, settled.then(() => 0)]);
    if (!pid) return false;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const rows = await sql<{ pid: number }[]>`
        select pid from pg_stat_activity
        where datname = current_database() and pid = ${pid} and wait_event_type = 'Lock' and wait_event = any(${waitEvents})`;
      if (rows[0]) return true;
      await new Promise((r) => setTimeout(r, 20));
    }
    return false;
  })();
  return Promise.race([poll, settled.then(() => false)]);
}
type Settled<T> = { status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown };
async function runConcurrencyLeg<TA, TB>(orgId: string, opA: (tx: Tx) => Promise<TA>, opB: (tx: Tx) => Promise<TB>, waitEvents: string[]) {
  const aReady = deferred<void>();
  const gate = deferred<void>();
  const aPromise: Promise<Settled<TA>> = asOrg(orgId, async (tx) => {
    try {
      const value = await opA(tx);
      aReady.resolve();
      await gate.promise;
      return value;
    } catch (err) {
      aReady.resolve();
      throw err;
    }
  }).then((value) => ({ status: 'fulfilled', value }) as const, (reason) => ({ status: 'rejected', reason }) as const);
  await aReady.promise;
  const trackedB = trackPid(opB);
  const bPromise: Promise<Settled<TB>> = asOrg(orgId, trackedB.op).then((value) => ({ status: 'fulfilled', value }) as const, (reason) => ({ status: 'rejected', reason }) as const);
  const bWaited = await pollForWaitingBackend(trackedB.pid, waitEvents, bPromise, 5000);
  gate.resolve();
  const [aResult, bResult] = await Promise.all([aPromise, bPromise]);
  return { aResult, bResult, bWaited };
}
const ADVISORY = ['advisory'];

// -----------------------------------------------------------------------------------------------
// Fixture: Lipa, Malvar, Commissary — each with an office safe; Lipa also a cashier drawer; Lipa+Malvar office BANK accounts.
// admin = all three stores; lipaManager = Lipa only; malvarManager = Malvar only.
// -----------------------------------------------------------------------------------------------

interface Account { id: string; glCode: string; storeId: string }
async function foundation(storeId: string, instrument: string, custodian: string): Promise<Account> {
  const [row] = await sql<{ id: string; gl_account_code: string }[]>`
    select id, gl_account_code from money_accounts where store_id = ${storeId} and instrument = ${instrument} and custodian = ${custodian} and is_foundation`;
  if (!row) throw new Error(`fixture: no foundation ${custodian} ${instrument} at ${storeId}`);
  return { id: row.id, glCode: row.gl_account_code, storeId };
}
async function officeBank(orgId: string, storeId: string, name: string): Promise<Account> {
  const [row] = await sql<{ id: string }[]>`
    insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian)
    values (${orgId}, ${storeId}, ${name}, 'bank', '1140', 'office') returning id`;
  return { id: row!.id, glCode: '1140', storeId };
}

async function fixture(hint: string) {
  const code = uid(`t369s9-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;
  const store = async (name: string) => {
    const c = uid(name.toLowerCase());
    const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${c}, ${name}) returning id`;
    return { id: s!.id, code: c, name };
  };
  const lipa = await store('Lipa');
  const malvar = await store('Malvar');
  const comm = await store('Commissary');
  const mk = async (name: string, role: string, stores: string[]) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    for (const s of stores) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
    return p!.id;
  };
  const adminId = await mk('Admin', 'admin', [lipa.id, malvar.id, comm.id]);
  const lipaMgrId = await mk('Lipa Manager', 'manager', [lipa.id]);
  const malvarMgrId = await mk('Malvar Manager', 'manager', [malvar.id]);
  const acct = {
    lipaSafe: await foundation(lipa.id, 'cash', 'office'),
    malvarSafe: await foundation(malvar.id, 'cash', 'office'),
    commSafe: await foundation(comm.id, 'cash', 'office'),
    lipaCashier: await foundation(lipa.id, 'cash', 'cashier'),
    lipaBank: await officeBank(orgId, lipa.id, 'Lipa BDO office'),
    malvarBank: await officeBank(orgId, malvar.id, 'Malvar BDO office'),
  };
  const fund = async (a: Account, amount: string) =>
    asOrg(orgId, (tx) =>
      postEntry(tx, {
        orgId, entryDate: '2026-01-01', sourceType: 'manual_journal', sourceId: uid('fund'), idempotencyKey: uid('fund'), memo: 'fixture funding', postedBy: adminId,
        lines: [{ accountCode: a.glCode, storeId: a.storeId, debit: amount, ...(a.glCode === '1140' ? { partyType: 'money_account' as const, partyId: a.id } : {}) }, { accountCode: '3900', storeId: a.storeId, credit: amount }],
      }),
    );
  for (const a of Object.values(acct)) await fund(a, '100000.00');
  return {
    orgId, lipa, malvar, comm, ...acct,
    admin: actor(orgId, adminId), lipaMgr: actor(orgId, lipaMgrId), malvarMgr: actor(orgId, malvarMgrId), adminId,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** An ordinary cross-store transfer `from` -> `to` (works today). The SOURCE store gets DR 1250, the DESTINATION store CR 2150:
 *  so `from` -> `to` makes the DESTINATION owe the source. Seed with Malvar safe -> Lipa safe: Lipa owes Malvar. */
const transfer = (f: Fixture, from: Account, to: Account, amount: string, who: Actor = f.admin) =>
  asOrg(f.orgId, (tx) => createMoneyTransfer(tx, who, { requestId: crypto.randomUUID(), fromMoneyAccountId: from.id, toMoneyAccountId: to.id, amountOut: amount, amountIn: amount, transferDate: DATE }));
const seedDebt = (f: Fixture, amount = '650.00') => transfer(f, f.malvarSafe, f.lipaSafe, amount);

interface SettleInput { settlementId?: string; from: Account; to: Account; amountOut: string; amountIn?: string; date?: string }
type SettleFn = (tx: Tx, actor: Actor, input: Record<string, unknown>) => Promise<{ id: string; entryId: string; fee: string; owedAfter: string }>;
const settleFn = (): SettleFn => {
  const fn = (domain as unknown as { settleBetweenStores?: SettleFn }).settleBetweenStores;
  if (typeof fn !== 'function') throw new Error('settleBetweenStores is not exported from @shareat/domain (packages/domain/src/money-transfers/settle.ts does not exist yet)');
  return fn;
};
const settleInput = (i: SettleInput) => ({
  settlementId: i.settlementId ?? crypto.randomUUID(),
  fromMoneyAccountId: i.from.id, toMoneyAccountId: i.to.id,
  amountOut: i.amountOut, amountIn: i.amountIn ?? i.amountOut, transferDate: i.date ?? DATE,
});
const settleIn = (tx: Tx, who: Actor, i: SettleInput) => settleFn()(tx, who, settleInput(i));
const settle = (f: Fixture, who: Actor, i: SettleInput) => asOrg(f.orgId, (tx) => settleIn(tx, who, i));

/** `Lipa repays Malvar`: from = Lipa's account, to = Malvar's. */
const repay = (f: Fixture, amount: string, over: Partial<SettleInput> = {}, who: Actor = f.admin) =>
  settle(f, who, { from: f.lipaSafe, to: f.malvarSafe, amountOut: amount, ...over });

type PositionFn = (tx: Tx, orgId: string, debtorStoreId: string, creditorStoreId: string) => Promise<{ owedPerDebtor: string; owedPerCreditor: string }>;
const position = async (f: Fixture, debtor: string, creditor: string) => {
  const fn = (moneyTransfersRepo as unknown as { interStorePosition?: PositionFn }).interStorePosition;
  if (typeof fn !== 'function') throw new Error('moneyTransfersRepo.interStorePosition does not exist yet (packages/db/src/repo/money-transfers.ts)');
  return asOrg(f.orgId, (tx) => fn(tx, f.orgId, debtor, creditor));
};
const expectOwed = async (f: Fixture, debtor: string, creditor: string, amount: string, what: string) => {
  const p = await position(f, debtor, creditor);
  expect(Number(p.owedPerDebtor), `${what}: the DEBTOR's books`).toBe(Number(amount));
  expect(Number(p.owedPerCreditor), `${what}: the CREDITOR's books`).toBe(Number(amount));
};

const bal = (f: Fixture, a: Account) => asOrg(f.orgId, (tx) => moneyAccountsRepo.balanceOf(tx, f.orgId, { id: a.id, glAccountCode: a.glCode, storeId: a.storeId }));
interface Line { code: string; store_id: string | null; debit: string; credit: string; party_type: string | null; party_id: string | null }
async function linesFor(entryId: string): Promise<Line[]> {
  return sql<Line[]>`
    select a.code, jl.store_id, jl.debit::numeric(14,2)::text as debit, jl.credit::numeric(14,2)::text as credit, jl.party_type, jl.party_id
    from journal_lines jl join accounts a on a.id = jl.account_id where jl.entry_id = ${entryId} order by a.code, jl.line_no`;
}
const shape = (l: Line[]) => l.map((x) => `${x.code}|${x.store_id}|${x.debit}|${x.credit}|${x.party_type ?? ''}|${x.party_id ?? ''}`).sort();
async function expectEachStoreTies(entryId: string, what: string) {
  const rows = await sql<{ store_id: string | null; net: string }[]>`
    select store_id, (sum(debit) - sum(credit))::numeric(14,2)::text as net from journal_lines where entry_id = ${entryId} group by store_id`;
  for (const r of rows) expect(r.net, `${what}: store ${r.store_id} does not net to zero on its own`).toBe('0.00');
}
/** debit − credit of one account at one store with one party, over every non-draft entry of the org. */
async function pairNet(orgId: string, storeId: string, code: '1250' | '2150', partyCode: string): Promise<string> {
  const [r] = await sql<{ n: string }[]>`
    select coalesce(sum(jl.debit - jl.credit), 0)::numeric(14,2)::text as n
    from journal_lines jl join journal_entries je on je.id = jl.entry_id join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId} and je.status <> 'draft' and a.code = ${code} and jl.store_id = ${storeId} and jl.party_id = ${partyCode}`;
  return r!.n;
}
const counts = async (orgId: string) => ({
  entries: Number((await sql<{ n: string }[]>`select count(*)::text as n from journal_entries where org_id = ${orgId}`)[0]!.n),
  transfers: Number((await sql<{ n: string }[]>`select count(*)::text as n from money_transfers where org_id = ${orgId}`)[0]!.n),
});
async function rejection(p: Promise<unknown>, what: string): Promise<{ message: string; userMessage?: string; name: string; capability?: string }> {
  try {
    await p;
  } catch (err) {
    const e = err as { message?: string; userMessage?: string; name?: string; capability?: string };
    return { message: String(e.message ?? err), userMessage: e.userMessage, name: e.name ?? '', capability: e.capability };
  }
  throw new Error(`NOT REFUSED — ${what} posted instead`);
}
const reciprocal = (f: Fixture) =>
  asOrg(f.orgId, async (tx) => (await listFindings(tx, f.orgId, { period: '2026-01' })).findings.filter((x) => x.kind === 'dueFromDueToNotReciprocal'));

// -----------------------------------------------------------------------------------------------

describe('T1 — Lipa repays Malvar ₱650: the debt is CLEARED, not grossed up', () => {
  it('exactly the four lines; Lipa safe −650, Malvar safe +650; 2150 at Lipa (party Malvar) and 1250 at Malvar (party Lipa) back to 0.00; both position readings 0.00; every store nets 0.00; no reciprocal finding', async () => {
    const f = await fixture('t1');
    await seedDebt(f);
    await expectOwed(f, f.lipa.id, f.malvar.id, '650.00', 'fixture: after the seeding transfer');
    const before = { lipa: await bal(f, f.lipaSafe), malvar: await bal(f, f.malvarSafe) };

    const result = await repay(f, '650.00');
    expect(result.entryId).toBeTruthy();
    expect(Number(result.owedAfter)).toBe(0);

    expect(shape(await linesFor(result.entryId))).toEqual(
      shape([
        { code: '1130', store_id: f.malvar.id, debit: '650.00', credit: '0.00', party_type: null, party_id: null },
        { code: '1250', store_id: f.malvar.id, debit: '0.00', credit: '650.00', party_type: 'store', party_id: f.lipa.code },
        { code: '2150', store_id: f.lipa.id, debit: '650.00', credit: '0.00', party_type: 'store', party_id: f.malvar.code },
        { code: '1130', store_id: f.lipa.id, debit: '0.00', credit: '650.00', party_type: null, party_id: null },
      ]),
    );
    expect(Number(await bal(f, f.lipaSafe)) - Number(before.lipa)).toBe(-650);
    expect(Number(await bal(f, f.malvarSafe)) - Number(before.malvar)).toBe(650);
    expect(await pairNet(f.orgId, f.lipa.id, '2150', f.malvar.code), '2150 at Lipa (party Malvar)').toBe('0.00');
    expect(await pairNet(f.orgId, f.malvar.id, '1250', f.lipa.code), '1250 at Malvar (party Lipa)').toBe('0.00');
    await expectOwed(f, f.lipa.id, f.malvar.id, '0.00', 'after the settlement');
    await expectEachStoreTies(result.entryId, 'the settlement entry');
    expect(await reciprocal(f)).toEqual([]);
  });

  it('CONTRAST (green today — the defect S9 fixes): the same repayment through an ORDINARY transfer leaves 2150 at Lipa at 650 and ADDS 1250 at Lipa 650', async () => {
    const f = await fixture('t1c');
    await seedDebt(f);
    await transfer(f, f.lipaSafe, f.malvarSafe, '650.00');
    expect(await pairNet(f.orgId, f.lipa.id, '2150', f.malvar.code), 'Lipa still owes the original 650').toBe('-650.00');
    expect(await pairNet(f.orgId, f.lipa.id, '1250', f.malvar.code), 'and is now ALSO owed 650 by Malvar').toBe('650.00');
  });
});

describe('T2 — partial settlement', () => {
  it('400 -> 250 owed on both readings; 250 -> 0; then 0.01 more -> "owe each other nothing"', async () => {
    const f = await fixture('t2');
    await seedDebt(f);
    await repay(f, '400.00');
    await expectOwed(f, f.lipa.id, f.malvar.id, '250.00', 'after 400');
    await repay(f, '250.00');
    await expectOwed(f, f.lipa.id, f.malvar.id, '0.00', 'after 250');
    const more = await rejection(repay(f, '0.01'), 'a settlement of a cleared debt');
    expect(more.userMessage).toBe('Lipa and Malvar owe each other nothing.');
  });
});

describe('T3 — refusals: the sentence, no id, and nothing written (entries, transfer rows, balances unchanged)', () => {
  const cases: [string, (f: Fixture) => Promise<unknown>, string | RegExp, { seed?: boolean }?][] = [
    ['more than owed (700 of 650)', (f) => repay(f, '700.00'), 'Lipa owes Malvar ₱650.00, so ₱700.00 is more than the debt. Send the difference as an ordinary transfer.'],
    ['wrong direction (Malvar -> Lipa)', (f) => settle(f, f.admin, { from: f.malvarSafe, to: f.lipaSafe, amountOut: '100.00' }), "Malvar doesn't owe Lipa — Lipa owes Malvar ₱650.00. Swap the accounts."],
    ['same store', (f) => settle(f, f.admin, { from: f.lipaSafe, to: f.lipaBank, amountOut: '100.00' }), 'Both accounts belong to Lipa — there is nothing to settle between stores.'],
    ['a pair with no balance', (f) => settle(f, f.admin, { from: f.lipaSafe, to: f.commSafe, amountOut: '100.00' }), 'Lipa and Commissary owe each other nothing.'],
    ['a cashier account at the debtor end', (f) => settle(f, f.admin, { from: f.lipaCashier, to: f.malvarSafe, amountOut: '100.00' }), /office to office only/],
    ['a RETIRED account at the debtor end (source)', async (f) => { await sql`update money_accounts set is_active = false where id = ${f.lipaSafe.id}`; return settle(f, f.admin, { from: f.lipaSafe, to: f.malvarSafe, amountOut: '100.00' }); }, /is retired and cannot be the source of a transfer/],
    ['a RETIRED account at the creditor end (destination)', async (f) => { await sql`update money_accounts set is_active = false where id = ${f.malvarSafe.id}`; return settle(f, f.admin, { from: f.lipaSafe, to: f.malvarSafe, amountOut: '100.00' }); }, /is retired and cannot be the destination of a transfer/],
    ['amountIn above amountOut (income)', (f) => repay(f, '100.00', { amountIn: '110.00' }), /income/],
  ];
  for (const [name, run, expected] of cases) {
    it(`${name}`, async () => {
      const f = await fixture(`t3-${name.replace(/\W+/g, '')}`);
      await seedDebt(f);
      const before = { c: await counts(f.orgId), lipa: await bal(f, f.lipaSafe), malvar: await bal(f, f.malvarSafe) };
      const refused = await rejection(run(f), name);
      const said = refused.userMessage ?? refused.message;
      if (typeof expected === 'string') {
        expect(refused.userMessage, `raw text leaked: ${refused.message}`).toBe(expected);
        expect(said).not.toMatch(UUID);
      } else {
        expect(said).toMatch(expected);
      }
      expect(await counts(f.orgId), 'a refused settlement wrote an entry or a transfer row').toEqual(before.c);
      expect(await bal(f, f.lipaSafe)).toBe(before.lipa);
      expect(await bal(f, f.malvarSafe)).toBe(before.malvar);
      await expectOwed(f, f.lipa.id, f.malvar.id, '650.00', 'the debt after the refusal');
    });
  }
});

describe('T4 (✗) — a manager scoped to one of the two stores cannot settle', () => {
  it('the Lipa-only and the Malvar-only managers -> AuthorizationError, nothing posted — positive control: the admin settles (T1)', async () => {
    const f = await fixture('t4');
    await seedDebt(f);
    const before = await counts(f.orgId);
    for (const [label, who] of [['Lipa-only', f.lipaMgr], ['Malvar-only', f.malvarMgr]] as const) {
      const refused = await rejection(repay(f, '100.00', {}, who), `the ${label} manager settling`);
      expect(refused.name, `${label} manager`).toBe('AuthorizationError');
    }
    expect(await counts(f.orgId)).toEqual(before);
    await repay(f, '100.00'); // control
    await expectOwed(f, f.lipa.id, f.malvar.id, '550.00', 'after the admin\'s control settlement');
  });
});

describe('T5 — idempotency on settlementId', () => {
  it('the same settlementId and figures twice -> one entry, one row, the same ids, 0.00 owed; the same id with 300 instead of 650 -> the replay refusal and nothing changes', async () => {
    const f = await fixture('t5');
    await seedDebt(f);
    const settlementId = crypto.randomUUID();
    const first = await repay(f, '650.00', { settlementId });
    const afterFirst = await counts(f.orgId);
    const second = await repay(f, '650.00', { settlementId });
    expect(second.id).toBe(first.id);
    expect(second.entryId).toBe(first.entryId);
    expect(await counts(f.orgId), 'a replay wrote a second entry or row').toEqual(afterFirst);
    await expectOwed(f, f.lipa.id, f.malvar.id, '0.00', 'after the replay');

    const different = await rejection(repay(f, '300.00', { settlementId }), 'the same settlementId with other figures');
    expect(different.userMessage).toBe('This settlement was already recorded with different figures. Reload the page and try again.');
    expect(await counts(f.orgId)).toEqual(afterFirst);
  });
});

describe('T6 — concurrency on the unordered store pair', () => {
  it('owed 650: A settles 400 (tx held), B settles 400 with another id: B is seen waiting on `advisory`; exactly one succeeds, the other gets the more-than-owed refusal naming 250; 250 stays owed', async () => {
    const f = await fixture('t6');
    await seedDebt(f);
    const { aResult, bResult, bWaited } = await runConcurrencyLeg(
      f.orgId,
      (tx) => settleIn(tx, f.admin, { from: f.lipaSafe, to: f.malvarSafe, amountOut: '400.00' }),
      (tx) => settleIn(tx, f.admin, { from: f.lipaSafe, to: f.malvarSafe, amountOut: '400.00' }),
      ADVISORY,
    );
    expect(bWaited, 'B was never seen waiting on the pair lock').toBe(true);
    expect(aResult.status).toBe('fulfilled');
    expect(bResult.status).toBe('rejected');
    const said = String((bResult as { reason: { userMessage?: string; message?: string } }).reason.userMessage ?? '');
    expect(said).toBe('Lipa owes Malvar ₱250.00, so ₱400.00 is more than the debt. Send the difference as an ordinary transfer.');
    await expectOwed(f, f.lipa.id, f.malvar.id, '250.00', 'after the race');
  });

  it('a Lipa↔Commissary settlement does not block a Lipa↔Malvar one (the lock is per UNORDERED pair)', async () => {
    const f = await fixture('t6b');
    await seedDebt(f);
    await transfer(f, f.commSafe, f.lipaSafe, '300.00'); // Lipa owes Commissary 300
    const { aResult, bResult, bWaited } = await runConcurrencyLeg(
      f.orgId,
      (tx) => settleIn(tx, f.admin, { from: f.lipaSafe, to: f.malvarSafe, amountOut: '400.00' }),
      (tx) => settleIn(tx, f.admin, { from: f.lipaSafe, to: f.commSafe, amountOut: '300.00' }),
      ADVISORY,
    );
    expect(aResult.status).toBe('fulfilled');
    expect(bResult.status, 'the unrelated pair was blocked or refused').toBe('fulfilled');
    expect(bWaited, 'the unrelated pair waited on the lock').toBe(false);
  });
});

describe('T7 — void restores the debt; and a cross-store void needs BOTH stores (S9·N1)', () => {
  it('voidMoneyTransfer on T1: 650 owed again on both readings, the reversal lines carry the same party ids; settling again succeeds', async () => {
    const f = await fixture('t7');
    await seedDebt(f);
    const settled = await repay(f, '650.00');
    const voided = await asOrg(f.orgId, (tx) => voidMoneyTransfer(tx, f.admin, { moneyTransferId: settled.id, reason: 'Wrong day' }));
    await expectOwed(f, f.lipa.id, f.malvar.id, '650.00', 'after the void');
    const lines = await linesFor(voided.reversalEntryId);
    const byCode = (code: string) => lines.filter((l) => l.code === code);
    expect(byCode('2150').map((l) => [l.store_id, l.party_id])).toEqual([[f.lipa.id, f.malvar.code]]);
    expect(byCode('1250').map((l) => [l.store_id, l.party_id])).toEqual([[f.malvar.id, f.lipa.code]]);
    await repay(f, '650.00'); // settles again
    await expectOwed(f, f.lipa.id, f.malvar.id, '0.00', 'after settling again');
  });

  it("✗ S9·N1: the Lipa-only manager (holds the SOURCE store only) cannot void an ordinary cross-store transfer Lipa -> Malvar: AuthorizationError(transfer_funds), still posted — red on HEAD, where only the source store is authorized; control: the admin voids it", async () => {
    const f = await fixture('t7x');
    const ordinary = await transfer(f, f.lipaSafe, f.malvarSafe, '200.00'); // source Lipa, destination Malvar
    const refused = await rejection(asOrg(f.orgId, (tx) => voidMoneyTransfer(tx, f.lipaMgr, { moneyTransferId: ordinary.id, reason: 'Nope' })), 'the Lipa-only manager voiding a cross-store transfer');
    expect(refused.name).toBe('AuthorizationError');
    expect(refused.capability).toBe('transfer_funds');
    const [row] = await sql<{ status: string }[]>`select status from money_transfers where id = ${ordinary.id}`;
    expect(row!.status, 'a refused void changed the transfer').toBe('posted');
    await asOrg(f.orgId, (tx) => voidMoneyTransfer(tx, f.admin, { moneyTransferId: ordinary.id, reason: 'Wrong' }));
  });

  it("(pin, green today) the Malvar-only manager (holds the DESTINATION only) cannot void it either — the source-store gate already refuses; control: the admin voids", async () => {
    const f = await fixture('t7y');
    const ordinary = await transfer(f, f.lipaSafe, f.malvarSafe, '200.00');
    const refused = await rejection(asOrg(f.orgId, (tx) => voidMoneyTransfer(tx, f.malvarMgr, { moneyTransferId: ordinary.id, reason: 'Nope' })), 'the Malvar-only manager voiding a cross-store transfer');
    expect(refused.name).toBe('AuthorizationError');
    await asOrg(f.orgId, (tx) => voidMoneyTransfer(tx, f.admin, { moneyTransferId: ordinary.id, reason: 'Wrong' }));
  });

  it('✗ S9·N1 on a SETTLEMENT: the Lipa-only manager cannot void it (it needs the new function, so it is red on HEAD for that reason too)', async () => {
    const f = await fixture('t7z');
    await seedDebt(f);
    const settled = await repay(f, '300.00');
    const refused = await rejection(asOrg(f.orgId, (tx) => voidMoneyTransfer(tx, f.lipaMgr, { moneyTransferId: settled.id, reason: 'Nope' })), 'the Lipa-only manager voiding a settlement');
    expect(refused.name).toBe('AuthorizationError');
    await expectOwed(f, f.lipa.id, f.malvar.id, '350.00', 'the debt after the refused void');
  });
});

describe('T8 — a fee: the settlement clears what the creditor RECEIVED, not what the debtor sent', () => {
  it('amountOut 660 / amountIn 650 between two office bank accounts: 6870 10.00 at Lipa and exactly 650 cleared', async () => {
    const f = await fixture('t8');
    await seedDebt(f);
    const result = await settle(f, f.admin, { from: f.lipaBank, to: f.malvarBank, amountOut: '660.00', amountIn: '650.00' });
    const lines = await linesFor(result.entryId);
    const fee = lines.find((l) => l.code === '6870');
    expect(fee, 'no fee line').toBeDefined();
    expect([fee!.store_id, fee!.debit]).toEqual([f.lipa.id, '10.00']);
    expect(lines.find((l) => l.code === '2150')?.debit).toBe('650.00');
    expect(lines.find((l) => l.code === '1250')?.credit).toBe('650.00');
    await expectOwed(f, f.lipa.id, f.malvar.id, '0.00', 'after the fee settlement');
    await expectEachStoreTies(result.entryId, 'the fee settlement');
  });
});

describe('T9 — the two stores\' books disagree: refused rather than cleared against one side', () => {
  it('a one-sided 2150 credit at Lipa (party Malvar) -> "The two stores\' records … don\'t match"; nothing posted', async () => {
    const f = await fixture('t9');
    await seedDebt(f);
    await asOrg(f.orgId, (tx) =>
      postEntry(tx, {
        orgId: f.orgId, entryDate: '2026-01-10', sourceType: 'manual_journal', sourceId: uid('skew'), idempotencyKey: uid('skew'), memo: 'fixture one-sided due-to', postedBy: f.adminId,
        lines: [
          { accountCode: '6870', storeId: f.lipa.id, debit: '100.00' },
          { accountCode: '2150', storeId: f.lipa.id, credit: '100.00', partyType: 'store', partyId: f.malvar.code },
        ],
      }),
    );
    const before = await counts(f.orgId);
    const p = await position(f, f.lipa.id, f.malvar.id);
    expect(Number(p.owedPerDebtor), "fixture: the debtor's books say 750").toBe(750);
    expect(Number(p.owedPerCreditor), "fixture: the creditor's books say 650").toBe(650);
    const refused = await rejection(repay(f, '100.00'), 'a settlement against disagreeing books');
    expect(refused.userMessage).toBe("The two stores' records of what is owed don't match, so this can't be settled yet. Ask the accountant to check the stores' due-to and due-from balances.");
    expect(await counts(f.orgId)).toEqual(before);
  });
});

describe('T10/T11 — the panel source and the "settles" tag', () => {
  it('T10: interStorePositions lists Lipa -> Malvar 650.00 and omits the pairs that net to 0 (Lipa/Commissary settled in full)', async () => {
    const f = await fixture('t10');
    await seedDebt(f);
    await transfer(f, f.commSafe, f.lipaSafe, '300.00');
    await settle(f, f.admin, { from: f.lipaSafe, to: f.commSafe, amountOut: '300.00' });
    type PositionsFn = (tx: Tx, orgId: string, storeIds: string[]) => Promise<{ debtorStoreId: string; creditorStoreId: string; owed: string }[]>;
    const fn = (moneyTransfersRepo as unknown as { interStorePositions?: PositionsFn }).interStorePositions;
    if (typeof fn !== 'function') throw new Error('moneyTransfersRepo.interStorePositions does not exist yet');
    const rows = await asOrg(f.orgId, (tx) => fn(tx, f.orgId, [f.lipa.id, f.malvar.id, f.comm.id]));
    expect(rows.map((r) => [r.debtorStoreId, r.creditorStoreId, Number(r.owed)])).toEqual([[f.lipa.id, f.malvar.id, 650]]);
  });

  it('T11: listMoneyTransfers marks the settlement settles:true and the seeding transfer settles:false', async () => {
    const f = await fixture('t11');
    const seed = await seedDebt(f);
    const settled = await repay(f, '650.00');
    const rows = (await asOrg(f.orgId, (tx) => moneyTransfersRepo.listMoneyTransfers(tx, f.orgId, { limit: 50 }))) as unknown as { id: string; settles?: boolean }[];
    expect(rows.find((r) => r.id === settled.id)?.settles, 'the settlement is not tagged').toBe(true);
    expect(rows.find((r) => r.id === seed.id)?.settles, 'the ordinary transfer is tagged').toBe(false);
  });
});
