import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-369 S1 (DEF-198 + N1/N2/N3) — `payReimbursement`, the staff reimbursement payout.
 * `docs/tasks/369-unwired-money-screens.md` §S1, tests T1-T6 + T5b (T7 is the web file).
 *
 * ⛔ TESTER, not BUILDER. Every leg asserts the TARGET behaviour of the approved contract:
 *   payReimbursement(tx, actor, { storeId, employeeId, amount, fromMoneyAccountId, on, payoutId, memo? })
 *     -> { entryId, outstanding (AT that store), created, warning? }
 * and every refusal has a positive control that posts (T1 / the admin leg of T3). Fixture, harness
 * and the gated two-connection shape are copied from `t366-s1-cash-custody-locks.test.ts`
 * (`asOrg`, `deferred`, `trackPid`, `pollForWaitingBackend`, `runConcurrencyLeg`).
 *
 * `payoutId` is passed everywhere; today's function ignores it, so a leg that reds does so on the
 * assertion that matters (a row that should not exist, a refusal that should happen, a replay that
 * should return the same entry), never on a missing import.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import { payReimbursement } from '@shareat/domain';
import { postEntry } from '../../src/ledger/post-entry';

const sql = postgres(url, { max: 10 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const newPayoutId = () => crypto.randomUUID();

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
// Concurrency harness (verbatim shape from t366-s1-cash-custody-locks.test.ts)
// -----------------------------------------------------------------------------------------------

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** B reports its own backend pid first, so the poll is pinned to exactly B (a parallel file's lock
 * wait can neither add a row nor be mistaken for B waiting). */
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

async function pollForWaitingBackend(
  bPid: Promise<number>,
  waitEvents: string[],
  settleWatch: Promise<unknown>,
  timeoutMs = 5000,
): Promise<{ pid: number; query: string } | null> {
  const settled = settleWatch.then(() => true).catch(() => true);
  const poll = (async (): Promise<{ pid: number; query: string } | null> => {
    const pid = await Promise.race([bPid, settled.then(() => 0)]);
    if (!pid) return null;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const rows = await sql<{ pid: number; query: string }[]>`
        select pid, query from pg_stat_activity
        where datname = current_database() and pid = ${pid}
          and wait_event_type = 'Lock' and wait_event = any(${waitEvents})`;
      if (rows[0]) return rows[0];
      await new Promise((r) => setTimeout(r, 20));
    }
    return null;
  })();
  return Promise.race([poll, settled.then(() => null)]);
}

type Settled<T> = { status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown };

/** A holds `opA` open (lock taken, not committed); B runs `opB`; a third connection watches for B
 * blocking on `waitEvents`. Never a bare `Promise.all` race. */
async function runConcurrencyLeg<TA, TB>(
  orgId: string,
  opA: (tx: Tx) => Promise<TA>,
  opB: (tx: Tx) => Promise<TB>,
  waitEvents: string[],
): Promise<{ aResult: Settled<TA>; bResult: Settled<TB>; bWaited: boolean }> {
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
  }).then(
    (value) => ({ status: 'fulfilled', value }) as const,
    (reason) => ({ status: 'rejected', reason }) as const,
  );

  await aReady.promise;

  const trackedB = trackPid(opB);
  const bPromise: Promise<Settled<TB>> = asOrg(orgId, trackedB.op).then(
    (value) => ({ status: 'fulfilled', value }) as const,
    (reason) => ({ status: 'rejected', reason }) as const,
  );

  const waiting = await pollForWaitingBackend(trackedB.pid, waitEvents, bPromise, 5000);
  gate.resolve();

  const [aResult, bResult] = await Promise.all([aPromise, bPromise]);
  return { aResult, bResult, bWaited: !!waiting };
}

const ADVISORY = ['advisory'];

// -----------------------------------------------------------------------------------------------
// Fixture: one org, two stores (Lipa, Malvar), an open January 2026, and
//   manager — role manager, scoped to LIPA ONLY (holds record_ap_payment and transfer_funds there)
//   admin   — role admin, scoped to BOTH stores
//   staff   — role staff, scoped to Lipa (record_ap_payment ✗)
//   ana, ben — the people who are owed (staff at Lipa)
// Accounts are the stores' foundation accounts, each store funded with 100,000.00.
// -----------------------------------------------------------------------------------------------

async function person(orgId: string, name: string, role: 'manager' | 'admin' | 'staff', storeIds: string[]): Promise<string> {
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
  for (const storeId of storeIds) {
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
  }
  return p!.id;
}

interface Account { id: string; glCode: string }
async function foundation(storeId: string, instrument: string, custodian: string): Promise<Account> {
  const [row] = await sql<{ id: string; gl_account_code: string }[]>`
    select id, gl_account_code from money_accounts
    where store_id = ${storeId} and instrument = ${instrument} and custodian = ${custodian} and is_foundation`;
  if (!row) throw new Error(`fixture: no foundation ${custodian} ${instrument} account at store ${storeId}`);
  return { id: row.id, glCode: row.gl_account_code };
}

async function fixture(hint: string) {
  const code = uid(`t369s1-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;
  const [lipa] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('lipa')}, 'Lipa') returning id`;
  const [malvar] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('malvar')}, 'Malvar') returning id`;
  const lipaId = lipa!.id;
  const malvarId = malvar!.id;

  const managerId = await person(orgId, 'Lipa Manager', 'manager', [lipaId]);
  const adminId = await person(orgId, 'Admin', 'admin', [lipaId, malvarId]);
  const staffId = await person(orgId, 'Lipa Staff', 'staff', [lipaId]);
  const anaId = await person(orgId, 'Ana Reyes', 'staff', [lipaId]);
  const benId = await person(orgId, 'Ben Cruz', 'staff', [lipaId]);

  const lipaCash = await foundation(lipaId, 'cash', 'cashier');
  const lipaSafe = await foundation(lipaId, 'cash', 'office');
  const lipaFloat = await foundation(lipaId, 'cash', 'staff');
  const malvarSafe = await foundation(malvarId, 'cash', 'office');

  const f = {
    orgId, lipaId, malvarId,
    manager: actor(orgId, managerId), admin: actor(orgId, adminId), staff: actor(orgId, staffId),
    managerId, adminId, staffId, anaId, benId,
    lipaCash, lipaSafe, lipaFloat, malvarSafe,
  };

  // Fund every account we may pay from. Opening balance against 3900, as the sibling fixtures do.
  for (const [storeId, acct] of [[lipaId, lipaCash], [lipaId, lipaSafe], [malvarId, malvarSafe]] as const) {
    await asOrg(orgId, (tx) =>
      postEntry(tx, {
        orgId, entryDate: '2026-01-01', sourceType: 'manual_journal', sourceId: uid('fund'), idempotencyKey: uid('fund'),
        memo: 'fixture funding', postedBy: adminId,
        lines: [
          { accountCode: acct.glCode, storeId, debit: '100000.00' },
          { accountCode: '3900', storeId, credit: '100000.00' },
        ],
      }),
    );
  }
  return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** The store's liability to `employeeId`: DR an expense / CR 2130 (party = employee) — exactly the
 * line `routeExpense` writes for a `reimbursable` payment, without the expense/invoice scaffolding
 * this file does not test. */
async function owe(f: Fixture, storeId: string, employeeId: string, amount: string): Promise<void> {
  await asOrg(f.orgId, (tx) =>
    postEntry(tx, {
      orgId: f.orgId, entryDate: '2026-01-05', sourceType: 'manual_journal', sourceId: uid('owe'), idempotencyKey: uid('owe'),
      memo: 'fixture reimbursable expense', postedBy: f.adminId,
      lines: [
        { accountCode: '6200', storeId, debit: amount },
        { accountCode: '2130', storeId, credit: amount, partyType: 'employee', partyId: employeeId },
      ],
    }),
  );
}

/** Outstanding on 2130 for one person AT one store — read straight from the ledger. */
async function owedAt(orgId: string, storeId: string, employeeId: string): Promise<string> {
  const [row] = await sql<{ n: string }[]>`
    select coalesce(sum(jl.credit - jl.debit), 0)::numeric(14,2)::text as n
    from journal_lines jl join journal_entries je on je.id = jl.entry_id join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId} and je.status <> 'draft' and a.code = '2130'
      and jl.store_id = ${storeId} and jl.party_type = 'employee' and jl.party_id = ${employeeId}`;
  return row!.n;
}

async function payoutEntryCount(orgId: string, employeeId?: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n from journal_entries
    where org_id = ${orgId} and source_type = 'reimbursement_payout'
      and (${employeeId ?? null}::text is null or source_id = ${employeeId ?? null})`;
  return Number(row!.n);
}

interface Line { code: string; debit: string; credit: string; store_id: string | null; party_type: string | null; party_id: string | null }
async function linesFor(entryId: string): Promise<Line[]> {
  return sql<Line[]>`
    select a.code, jl.debit::text, jl.credit::text, jl.store_id, jl.party_type, jl.party_id
    from journal_lines jl join accounts a on a.id = jl.account_id
    where jl.entry_id = ${entryId} order by jl.line_no`;
}

interface PayArgs { storeId: string; employeeId: string; amount: string; from: string; payoutId?: string; on?: string }
const pay = (f: Fixture, who: Actor, a: PayArgs) => (tx: Tx) =>
  payReimbursement(tx, who, {
    storeId: a.storeId, employeeId: a.employeeId, amount: a.amount, fromMoneyAccountId: a.from,
    on: a.on ?? '2026-01-16', payoutId: a.payoutId ?? newPayoutId(),
  });

/** The error a promise rejects with — fails the leg (on the target) if it resolves instead. */
async function rejection(p: Promise<unknown>, whatShouldHaveBeenRefused: string): Promise<{ message: string; userMessage?: string; err: unknown }> {
  try {
    await p;
  } catch (err) {
    const e = err as { message?: string; userMessage?: string };
    return { message: String(e.message ?? err), userMessage: e.userMessage, err };
  }
  throw new Error(`NOT REFUSED — ${whatShouldHaveBeenRefused} posted instead (the defect this leg targets)`);
}

// -----------------------------------------------------------------------------------------------
// T1 — the positive control for every refusal below
// -----------------------------------------------------------------------------------------------

describe('T1 — owed ₱650 at Lipa; the manager pays 650 from Lipa cash (positive control)', () => {
  it('one entry: DR 2130 650 party=employee store=Lipa, CR the account\'s GL 650; outstanding 0.00; created true', async () => {
    const f = await fixture('t1');
    await owe(f, f.lipaId, f.anaId, '650.00');

    const result = await asOrg(f.orgId, pay(f, f.manager, { storeId: f.lipaId, employeeId: f.anaId, amount: '650.00', from: f.lipaCash.id }));

    expect(await payoutEntryCount(f.orgId, f.anaId), 'exactly one payout entry').toBe(1);
    const lines = await linesFor(result.entryId);
    expect(lines).toHaveLength(2);
    const debit = lines.find((l) => Number(l.debit) > 0)!;
    const credit = lines.find((l) => Number(l.credit) > 0)!;
    expect(debit.code).toBe('2130');
    expect(debit.debit).toBe('650.00');
    expect(debit.party_type).toBe('employee');
    expect(debit.party_id).toBe(f.anaId);
    expect(debit.store_id).toBe(f.lipaId);
    expect(credit.code).toBe(f.lipaCash.glCode);
    expect(credit.credit).toBe('650.00');
    expect(credit.store_id).toBe(f.lipaId);
    expect(await owedAt(f.orgId, f.lipaId, f.anaId)).toBe('0.00');
    expect(result.outstanding, 'outstanding is AT that store, after the payment').toBe('0.00');
    expect(result.created, 'the contract returns created').toBe(true);
  });
});

// -----------------------------------------------------------------------------------------------
// T2 (N2) — the cap is the outstanding AT the paying store, not the organisation's
// -----------------------------------------------------------------------------------------------

describe('T2 (N2) — Malvar cannot pay down Lipa\'s liability', () => {
  it('owed 650 at Lipa and 0 at Malvar: paying 100 with storeId = Malvar is refused ("no unpaid reimbursement at this store"); nothing posted — Mutant: drop the store filter -> posts, red', async () => {
    const f = await fixture('t2');
    await owe(f, f.lipaId, f.anaId, '650.00');

    const refused = await rejection(
      asOrg(f.orgId, pay(f, f.admin, { storeId: f.malvarId, employeeId: f.anaId, amount: '100.00', from: f.malvarSafe.id })),
      '₱100 at Malvar against a liability that exists only at Lipa',
    );
    expect(refused.userMessage).toBe('This employee has no unpaid reimbursement at this store.');
    expect(await payoutEntryCount(f.orgId), 'nothing was written').toBe(0);
    expect(await owedAt(f.orgId, f.lipaId, f.anaId), "Lipa's liability is untouched").toBe('650.00');
  });

  it('owed 650 at Lipa and 100 at Malvar: paying 200 at Malvar is refused as MORE than the 100.00 owed there (the org-wide 750 must not be the cap); paying 100 at Malvar posts — control', async () => {
    const f = await fixture('t2b');
    await owe(f, f.lipaId, f.anaId, '650.00');
    await owe(f, f.malvarId, f.anaId, '100.00');

    const refused = await rejection(
      asOrg(f.orgId, pay(f, f.admin, { storeId: f.malvarId, employeeId: f.anaId, amount: '200.00', from: f.malvarSafe.id })),
      '₱200 at Malvar against ₱100 owed at Malvar',
    );
    expect(refused.message).toMatch(/more than the 100\.00 owed/);
    expect(await payoutEntryCount(f.orgId)).toBe(0);

    const ok = await asOrg(f.orgId, pay(f, f.admin, { storeId: f.malvarId, employeeId: f.anaId, amount: '100.00', from: f.malvarSafe.id }));
    expect(ok.outstanding, 'outstanding at Malvar after paying it off').toBe('0.00');
    expect(await owedAt(f.orgId, f.malvarId, f.anaId)).toBe('0.00');
    expect(await owedAt(f.orgId, f.lipaId, f.anaId), "Lipa's 650 is untouched").toBe('650.00');
  });
});

// -----------------------------------------------------------------------------------------------
// T3 (N1) — drawing on another store's account needs transfer_funds THERE
// -----------------------------------------------------------------------------------------------

describe("T3 (N1) — a Lipa manager cannot pay out of Malvar's safe", () => {
  it('manager (Lipa only) paying 650 at Lipa from Malvar\'s safe -> AuthorizationError, nothing posted — Mutant: remove the cross-store authorize -> posts, red', async () => {
    const f = await fixture('t3');
    await owe(f, f.lipaId, f.anaId, '650.00');

    const refused = await rejection(
      asOrg(f.orgId, pay(f, f.manager, { storeId: f.lipaId, employeeId: f.anaId, amount: '650.00', from: f.malvarSafe.id })),
      "₱650 out of Malvar's safe by a manager with no rights at Malvar",
    );
    expect(refused.err).toBeInstanceOf(AuthorizationError);
    expect(await payoutEntryCount(f.orgId)).toBe(0);
    expect(await owedAt(f.orgId, f.lipaId, f.anaId), 'liability untouched').toBe('650.00');
  });

  it('positive control: an admin (holds transfer_funds at BOTH stores) posts the same payout', async () => {
    const f = await fixture('t3pc');
    await owe(f, f.lipaId, f.anaId, '650.00');

    const result = await asOrg(f.orgId, pay(f, f.admin, { storeId: f.lipaId, employeeId: f.anaId, amount: '650.00', from: f.malvarSafe.id }));
    expect(await payoutEntryCount(f.orgId, f.anaId)).toBe(1);
    expect(result.outstanding).toBe('0.00');
    // T-369 S8 (DEF-551): this is the exact cross-store case; the credit belongs to the safe that PAID, at ITS store, and the
    // two stores record what one owes the other. (Detail and mutants: t369-s8-cross-store-draw.test.ts T1.)
    const net = async (code: string, storeId: string) =>
      (await sql<{ n: string }[]>`
        select coalesce(sum(jl.debit - jl.credit), 0)::numeric(14,2)::text as n
        from journal_lines jl join journal_entries je on je.id = jl.entry_id join accounts a on a.id = jl.account_id
        where je.org_id = ${f.orgId} and je.status <> 'draft' and a.code = ${code} and jl.store_id = ${storeId}`)[0]!.n;
    const lines = await linesFor(result.entryId);
    const credit = lines.find((l) => l.code === '1130');
    expect(credit?.store_id, "the safe's credit sits at MALVAR (the safe's store), not at Lipa (DEF-551)").toBe(f.malvarId);
    expect(await net('1130', f.malvarId), "Malvar's safe: 100,000 funded − 650").toBe('99350.00');
    expect(await net('1110', f.lipaId), "Lipa's cash is untouched").toBe('100000.00');
    expect(await net('1250', f.malvarId), 'Malvar is owed 650 by Lipa').toBe('650.00');
    expect(await net('2150', f.lipaId), 'Lipa owes Malvar 650').toBe('-650.00');
    const ties = await sql<{ net: string }[]>`select (sum(debit) - sum(credit))::numeric(14,2)::text as net from journal_lines where entry_id = ${result.entryId} group by store_id`;
    for (const t of ties) expect(t.net, 'each store nets 0.00 within the entry').toBe('0.00');
  });

  it('same-store control: the manager paying from Lipa\'s own safe still posts (the new gate is only for another store\'s account)', async () => {
    const f = await fixture('t3same');
    await owe(f, f.lipaId, f.anaId, '650.00');
    const result = await asOrg(f.orgId, pay(f, f.manager, { storeId: f.lipaId, employeeId: f.anaId, amount: '650.00', from: f.lipaSafe.id }));
    expect(result.outstanding).toBe('0.00');
  });
});

// -----------------------------------------------------------------------------------------------
// T4 (N3) — two payouts in flight cannot both pass one cap
// -----------------------------------------------------------------------------------------------

describe('T4 (N3) — two payouts for one person are serialised', () => {
  it('owed 1,000: A pays 700, B pays 600 -> B is observed waiting on `advisory`; exactly one succeeds, the other gets the overpayment refusal; 2130 at Lipa is 300 or 400, never negative — Mutant: remove the lock -> -300, red', async () => {
    const f = await fixture('t4');
    await owe(f, f.lipaId, f.anaId, '1000.00');

    const { aResult, bResult, bWaited } = await runConcurrencyLeg(
      f.orgId,
      pay(f, f.manager, { storeId: f.lipaId, employeeId: f.anaId, amount: '700.00', from: f.lipaCash.id }),
      pay(f, f.manager, { storeId: f.lipaId, employeeId: f.anaId, amount: '600.00', from: f.lipaCash.id }),
      ADVISORY,
    );

    expect(bWaited, 'B never waited: no advisory lock').toBe(true);
    const outcomes = [aResult, bResult];
    expect(outcomes.filter((o) => o.status === 'fulfilled').length, 'exactly one fulfilled').toBe(1);
    const rejected = outcomes.find((o) => o.status === 'rejected') as Extract<Settled<unknown>, { status: 'rejected' }> | undefined;
    expect(rejected, 'exactly one rejected').toBeDefined();
    expect(String((rejected!.reason as Error).message)).toMatch(/more than the .* owed/);

    const left = Number(await owedAt(f.orgId, f.lipaId, f.anaId));
    expect([300, 400]).toContain(left);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(await payoutEntryCount(f.orgId, f.anaId), 'one payout entry').toBe(1);
  });

  it('positive control: two DIFFERENT people never contend — B (Ben) does not wait for A (Ana); both post', async () => {
    const f = await fixture('t4pc');
    await owe(f, f.lipaId, f.anaId, '1000.00');
    await owe(f, f.lipaId, f.benId, '1000.00');

    const { aResult, bResult, bWaited } = await runConcurrencyLeg(
      f.orgId,
      pay(f, f.manager, { storeId: f.lipaId, employeeId: f.anaId, amount: '700.00', from: f.lipaCash.id }),
      pay(f, f.manager, { storeId: f.lipaId, employeeId: f.benId, amount: '600.00', from: f.lipaCash.id }),
      ADVISORY,
    );

    expect(bWaited, 'a different payee must never block B').toBe(false);
    expect(aResult.status).toBe('fulfilled');
    expect(bResult.status).toBe('fulfilled');
    expect(await owedAt(f.orgId, f.lipaId, f.anaId)).toBe('300.00');
    expect(await owedAt(f.orgId, f.lipaId, f.benId)).toBe('400.00');
  });
});

// -----------------------------------------------------------------------------------------------
// T5 — the deterministic payoutId makes a replay a no-op
// -----------------------------------------------------------------------------------------------

describe('T5 — a replayed payoutId returns the same entry, once', () => {
  it('owed 650: pay 650 with payoutId P and commit; replay P -> the SAME entryId, created false, no refusal, one entry — Mutants: (i) a random key -> two entries or a refusal; (ii) the replay lookup after the cap check -> refused "no unpaid reimbursement"', async () => {
    const f = await fixture('t5');
    await owe(f, f.lipaId, f.anaId, '650.00');
    const payoutId = newPayoutId();
    const args = { storeId: f.lipaId, employeeId: f.anaId, amount: '650.00', from: f.lipaCash.id, payoutId };

    const first = await asOrg(f.orgId, pay(f, f.manager, args)); // committed on return
    expect(await owedAt(f.orgId, f.lipaId, f.anaId), 'fully paid after the first commit').toBe('0.00');

    // The replay is captured, not thrown, so the legs below report WHICH part of the contract failed.
    const replay = await asOrg(f.orgId, pay(f, f.manager, args)).then(
      (value) => ({ ok: true as const, value }),
      (err) => ({ ok: false as const, message: String((err as Error).message) }),
    );
    expect(replay.ok, `the replay was refused instead of returning the first entry: ${replay.ok ? '' : replay.message}`).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.entryId, 'the SAME entry').toBe(first.entryId);
    expect(replay.value.created, 'a replay is not a new posting').toBe(false);
    expect(replay.value.outstanding).toBe('0.00');
    expect(await payoutEntryCount(f.orgId, f.anaId), 'one entry, not two').toBe(1);
    expect(first.created, 'the original posting was created').toBe(true);
  });

  it('positive control: a DIFFERENT payoutId is a different payout — a second 100 against 1,000 owed posts a second entry', async () => {
    const f = await fixture('t5pc');
    await owe(f, f.lipaId, f.anaId, '1000.00');
    const one = await asOrg(f.orgId, pay(f, f.manager, { storeId: f.lipaId, employeeId: f.anaId, amount: '100.00', from: f.lipaCash.id, payoutId: newPayoutId() }));
    const two = await asOrg(f.orgId, pay(f, f.manager, { storeId: f.lipaId, employeeId: f.anaId, amount: '100.00', from: f.lipaCash.id, payoutId: newPayoutId() }));
    expect(two.entryId).not.toBe(one.entryId);
    expect(await payoutEntryCount(f.orgId, f.anaId)).toBe(2);
    expect(await owedAt(f.orgId, f.lipaId, f.anaId)).toBe('800.00');
  });

  it('a double submit INSIDE the replay window: the same payoutId twice, in sequence, still posts once', async () => {
    const f = await fixture('t5dbl');
    await owe(f, f.lipaId, f.anaId, '1000.00');
    const payoutId = newPayoutId();
    const args = { storeId: f.lipaId, employeeId: f.anaId, amount: '300.00', from: f.lipaCash.id, payoutId };
    const first = await asOrg(f.orgId, pay(f, f.manager, args));
    const second = await asOrg(f.orgId, pay(f, f.manager, args)).catch((e) => ({ refused: String((e as Error).message) }));
    expect('refused' in second ? second.refused : '', 'a double click must not be refused').toBe('');
    if ('entryId' in second) expect(second.entryId).toBe(first.entryId);
    expect(await owedAt(f.orgId, f.lipaId, f.anaId), 'paid 300 once, not twice').toBe('700.00');
  });
});

// -----------------------------------------------------------------------------------------------
// T5b — the DOMAIN (not only the picker) refuses a retired account and a staff float
// -----------------------------------------------------------------------------------------------

describe('T5b — retired and staff-float accounts are refused by the domain', () => {
  it('an inactive account -> "That money account is retired."; nothing posted', async () => {
    const f = await fixture('t5b-retired');
    await owe(f, f.lipaId, f.anaId, '650.00');
    await sql`update money_accounts set is_active = false where id = ${f.lipaSafe.id}`;

    const refused = await rejection(
      asOrg(f.orgId, pay(f, f.manager, { storeId: f.lipaId, employeeId: f.anaId, amount: '650.00', from: f.lipaSafe.id })),
      "₱650 from a retired account",
    );
    expect(refused.userMessage).toBe('That money account is retired.');
    expect(await payoutEntryCount(f.orgId)).toBe(0);
  });

  it('a staff-float account -> "Pay from a store account, not a staff float."; nothing posted', async () => {
    const f = await fixture('t5b-float');
    await owe(f, f.lipaId, f.anaId, '650.00');

    const refused = await rejection(
      asOrg(f.orgId, pay(f, f.manager, { storeId: f.lipaId, employeeId: f.anaId, amount: '650.00', from: f.lipaFloat.id })),
      '₱650 from a staff float',
    );
    expect(refused.userMessage).toBe('Pay from a store account, not a staff float.');
    expect(await payoutEntryCount(f.orgId)).toBe(0);
  });

  it('positive control: the same payout from an active store account posts (T1)', async () => {
    const f = await fixture('t5b-pc');
    await owe(f, f.lipaId, f.anaId, '650.00');
    await sql`update money_accounts set is_active = false where id = ${f.lipaSafe.id}`; // the retired one is NOT the one used
    const result = await asOrg(f.orgId, pay(f, f.manager, { storeId: f.lipaId, employeeId: f.anaId, amount: '650.00', from: f.lipaCash.id }));
    expect(result.outstanding).toBe('0.00');
  });
});

// -----------------------------------------------------------------------------------------------
// T6 (✗) — staff cannot pay
// -----------------------------------------------------------------------------------------------

describe('T6 (✗) — a staff member at Lipa cannot pay a reimbursement', () => {
  it('AuthorizationError; no entry; the liability is untouched — positive control: the manager (T1) posts the same payout', async () => {
    const f = await fixture('t6');
    await owe(f, f.lipaId, f.anaId, '650.00');

    const refused = await rejection(
      asOrg(f.orgId, pay(f, f.staff, { storeId: f.lipaId, employeeId: f.anaId, amount: '650.00', from: f.lipaCash.id })),
      '₱650 by a staff member',
    );
    expect(refused.err).toBeInstanceOf(AuthorizationError);
    expect(await payoutEntryCount(f.orgId)).toBe(0);
    expect(await owedAt(f.orgId, f.lipaId, f.anaId)).toBe('650.00');

    const control = await asOrg(f.orgId, pay(f, f.manager, { storeId: f.lipaId, employeeId: f.anaId, amount: '650.00', from: f.lipaCash.id }));
    expect(control.outstanding).toBe('0.00');
  });
});

// -----------------------------------------------------------------------------------------------
// S1 AUDIT legs (A, B) — added after the auditor's findings. Each red leg asserts the TARGET: a
// refusal with a written sentence (no ids), and nothing posted.
// -----------------------------------------------------------------------------------------------

const UUID_SHAPE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

describe('A — a blank, missing or malformed payoutId is refused, never used as a key', () => {
  it('payoutId "", "not-a-uuid" and omitted are each refused with a sentence (no id); nothing posts; the liability is untouched — positive control: T1 posts with a real uuid', async () => {
    const f = await fixture('auditA');
    await owe(f, f.lipaId, f.anaId, '650.00');

    for (const bad of ['', '   ', 'not-a-uuid', undefined]) {
      const call = asOrg(f.orgId, (tx) =>
        payReimbursement(tx, f.manager, {
          storeId: f.lipaId, employeeId: f.anaId, amount: '650.00', fromMoneyAccountId: f.lipaCash.id, on: '2026-01-16',
          ...(bad === undefined ? {} : { payoutId: bad }),
        } as never),
      );
      const refused = await rejection(call, `a payout with payoutId ${JSON.stringify(bad)}`);
      expect(refused.userMessage, `payoutId ${JSON.stringify(bad)}: no written sentence (raw: ${refused.message})`).toBeTruthy();
      expect(refused.userMessage).not.toMatch(UUID_SHAPE);
    }
    expect(await payoutEntryCount(f.orgId), 'nothing posted by any bad payoutId').toBe(0);
    expect(await owedAt(f.orgId, f.lipaId, f.anaId)).toBe('650.00');

    const control = await asOrg(f.orgId, pay(f, f.manager, { storeId: f.lipaId, employeeId: f.anaId, amount: '650.00', from: f.lipaCash.id }));
    expect(control.outstanding).toBe('0.00');
  });
});

describe('B — a replayed payoutId with CHANGED figures is refused, not silently replayed', () => {
  it('pay 300 with P, commit; resubmit P with amount 400 -> refused with a sentence; still exactly one entry of 300', async () => {
    const f = await fixture('auditB1');
    await owe(f, f.lipaId, f.anaId, '1000.00');
    const payoutId = newPayoutId();
    await asOrg(f.orgId, pay(f, f.manager, { storeId: f.lipaId, employeeId: f.anaId, amount: '300.00', from: f.lipaCash.id, payoutId }));

    const refused = await rejection(
      asOrg(f.orgId, pay(f, f.manager, { storeId: f.lipaId, employeeId: f.anaId, amount: '400.00', from: f.lipaCash.id, payoutId })),
      'a replay of the same payoutId with a different amount (it returned the first entry silently)',
    );
    expect(refused.userMessage, `no written sentence (raw: ${refused.message})`).toBeTruthy();
    expect(refused.userMessage).not.toMatch(UUID_SHAPE);
    expect(await payoutEntryCount(f.orgId, f.anaId), 'no second entry').toBe(1);
    expect(await owedAt(f.orgId, f.lipaId, f.anaId), 'only the original 300 was paid').toBe('700.00');
  });

  it('pay 300 from the cash drawer with P; resubmit P from the office safe -> refused; one entry', async () => {
    const f = await fixture('auditB2');
    await owe(f, f.lipaId, f.anaId, '1000.00');
    const payoutId = newPayoutId();
    await asOrg(f.orgId, pay(f, f.manager, { storeId: f.lipaId, employeeId: f.anaId, amount: '300.00', from: f.lipaCash.id, payoutId }));

    const refused = await rejection(
      asOrg(f.orgId, pay(f, f.manager, { storeId: f.lipaId, employeeId: f.anaId, amount: '300.00', from: f.lipaSafe.id, payoutId })),
      'a replay of the same payoutId from a different money account',
    );
    expect(refused.userMessage, `no written sentence (raw: ${refused.message})`).toBeTruthy();
    expect(refused.userMessage).not.toMatch(UUID_SHAPE);
    expect(await payoutEntryCount(f.orgId, f.anaId)).toBe(1);
  });

  it('positive control: the IDENTICAL replay still returns the same entryId with created:false (T5)', async () => {
    const f = await fixture('auditBpc');
    await owe(f, f.lipaId, f.anaId, '1000.00');
    const args = { storeId: f.lipaId, employeeId: f.anaId, amount: '300.00', from: f.lipaCash.id, payoutId: newPayoutId() };
    const first = await asOrg(f.orgId, pay(f, f.manager, args));
    const again = await asOrg(f.orgId, pay(f, f.manager, args));
    expect(again.entryId).toBe(first.entryId);
    expect(again.created).toBe(false);
    expect(await payoutEntryCount(f.orgId, f.anaId)).toBe(1);
  });
});
