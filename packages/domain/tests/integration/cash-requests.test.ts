import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-144 — cash requests. Bible row 159.
 *
 * ⭐ The test that carries the design is *"the float nets to zero"*. Every other guarantee here —
 * who holds it, what is still out, whether it is closed — falls out of that one balance being
 * right, which is why nothing is stored.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(
    `Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`,
  );
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { cashRequestsRepo, closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import {
  cancelCashRequest,
  createCashRequest,
  decideCashRequest,
  releaseCashRequest,
  settleCashRequest,
} from '@shareat/domain';

const sql = postgres(url, { max: 5 });

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

async function newOrg(hint: string) {
  const code = uid(`cr-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id
  `;
  await seedChartOfAccounts(sql, org!.id);
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${org!.id}, ${uid(hint)}, ${`Store ${hint}`}) returning id
  `;
  await sql`
    insert into fiscal_periods (org_id, starts_on, ends_on, status)
    values (${org!.id}, '2026-01-01', '2026-01-31', 'open')
  `;
  return { orgId: org!.id, storeId: store!.id };
}

async function person(orgId: string, storeId: string, name: string, role: string) {
  const [p] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id
  `;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
  return p!.id;
}

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

async function fixture(hint: string) {
  const o = await newOrg(hint);
  const managerId = await person(o.orgId, o.storeId, 'Manager', 'manager');
  const staffId = await person(o.orgId, o.storeId, 'Ana', 'staff');
  const [till] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${o.storeId}
      and instrument = 'cash' and custodian = 'cashier' and is_foundation
  `;
  return {
    ...o,
    managerId,
    staffId,
    manager: actor(o.orgId, managerId),
    staff: actor(o.orgId, staffId),
    till: till!.id,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** A request approved and released for `amount`. */
async function released(f: Fixture, amount = '2000.00') {
  const req = await asOrg(f.orgId, (tx) =>
    createCashRequest(tx, f.staff, {
      storeId: f.storeId,
      requestedFor: f.staffId,
      purpose: 'Market run',
      amount,
      on: '2026-01-05',
    }),
  );
  await asOrg(f.orgId, (tx) =>
    decideCashRequest(tx, f.manager, { requestId: req.id, decision: 'approve', amount, on: '2026-01-05' }),
  );
  await asOrg(f.orgId, (tx) =>
    releaseCashRequest(tx, f.manager, {
      requestId: req.id,
      amount,
      fromMoneyAccountId: f.till,
      on: '2026-01-05',
    }),
  );
  return req.id;
}

async function floatOf(f: Fixture, id: string) {
  return asOrg(f.orgId, (tx) => cashRequestsRepo.floatPositionOf(tx, f.orgId, id));
}

beforeAll(async () => {
  await sql`
    truncate table
      cash_requests, loans, stored_files, remittance_variances, remittance_allocations,
      remittance_lines, remittances, scheduler_runs, prepaid_items, money_transfers,
      money_accounts, expense_payments, expenses, expense_categories, person_grants,
      person_store_scope, person_roles, journal_lines, journal_entries, audit_log,
      fiscal_periods, accounts, person_identities, persons, stores, organizations
    restart identity cascade
  `;
});

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('⚠️ the REQUEST posts nothing — only the release does', () => {
  it('asking for money is not a financial event (bible §16.10)', async () => {
    const f = await fixture('noop');
    const req = await asOrg(f.orgId, (tx) =>
      createCashRequest(tx, f.staff, {
        storeId: f.storeId,
        requestedFor: f.staffId,
        purpose: 'Market run',
        amount: '2000.00',
        on: '2026-01-05',
      }),
    );
    const [n] = await sql<{ c: number }[]>`
      select count(*)::int c from journal_entries where source_id = ${req.id}
    `;
    // Posting here would show a float in someone's hands before anyone handed it over.
    expect(n!.c).toBe(0);
  });
});

describe('the postings — POSTING-PATTERNS.md §Cash request', () => {
  it('release: DR 1120 with the REQUEST as party, CR the till', async () => {
    const f = await fixture('release');
    const id = await released(f);

    const legs = await sql<{ code: string; debit: string; credit: string; party_type: string | null }[]>`
      select a.code, jl.debit::text, jl.credit::text, jl.party_type
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id
      join accounts a on a.id = jl.account_id
      where je.source_id = ${id} and je.source_type = 'cash_request_release'
      order by a.code
    `;
    expect(legs).toEqual([
      { code: '1110', debit: '0.00', credit: '2000.00', party_type: null },
      // ⭐ v1 leaves 1120 party-free, so two people holding floats at one store are one
      // indistinguishable balance. The party is the REQUEST — the third time this reasoning
      // applies, after the wallet (row 142) and the loan (row 158).
      { code: '1120', debit: '2000.00', credit: '0.00', party_type: 'cash_request' },
    ]);
    expect((await floatOf(f, id)).outstanding).toBe('2000.00');
  });

  it('⭐ two people can hold floats at once, and the ledger tells them apart', async () => {
    const f = await fixture('two');
    const benId = await person(f.orgId, f.storeId, 'Ben', 'staff');
    const anaReq = await released(f, '2000.00');

    const benReq = await asOrg(f.orgId, (tx) =>
      createCashRequest(tx, f.manager, {
        storeId: f.storeId,
        requestedFor: benId,
        purpose: 'Permit fee',
        amount: '3000.00',
        on: '2026-01-06',
      }),
    );
    await asOrg(f.orgId, (tx) =>
      decideCashRequest(tx, f.manager, { requestId: benReq.id, decision: 'approve', amount: '3000.00' }),
    );
    await asOrg(f.orgId, (tx) =>
      releaseCashRequest(tx, f.manager, {
        requestId: benReq.id, amount: '3000.00', fromMoneyAccountId: f.till, on: '2026-01-06',
      }),
    );

    // ⛔ Without a party this is one ₱5,000 balance at 1120, and splitting it means going back to
    // the request documents — which is the join v1 avoids by storing `remainingAmount` on each one.
    expect((await floatOf(f, anaReq)).outstanding).toBe('2000.00');
    expect((await floatOf(f, benReq.id)).outstanding).toBe('3000.00');
  });
});

describe('⭐ the float NETS TO ZERO when the request closes', () => {
  it('spent, returned and short together account for every peso', async () => {
    const f = await fixture('nets');
    const id = await released(f, '2000.00');

    // ₱1,400 spent on the errand. T-122 posts this leg; here it is posted directly against the
    // request, which is what an expense with this cashRequestId resolves to.
    const [period] = await sql<{ id: string }[]>`
      select id from fiscal_periods where org_id = ${f.orgId} limit 1
    `;
    await sql.begin(async (tx) => {
      const [e] = await tx<{ id: string }[]>`
        insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
        values (${f.orgId}, '2026-01-07', ${period!.id}, 'expense', ${uid('exp')}, 'draft') returning id
      `;
      const [exp] = await tx<{ id: string }[]>`select id from accounts where org_id = ${f.orgId} and code = '6160'`;
      const [flt] = await tx<{ id: string }[]>`select id from accounts where org_id = ${f.orgId} and code = '1120'`;
      await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
               values (${e!.id}, 1, ${exp!.id}, ${f.storeId}, '1400.00', '0')`;
      await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit, party_type, party_id)
               values (${e!.id}, 2, ${flt!.id}, ${f.storeId}, '0', '1400.00', 'cash_request', ${id})`;
      await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
    });

    expect((await floatOf(f, id)).outstanding).toBe('600.00');

    // ₱500 handed back, ₱100 unaccounted for.
    const settled = await asOrg(f.orgId, (tx) =>
      settleCashRequest(tx, f.manager, {
        requestId: id,
        returnedAmount: '500.00',
        shortAmount: '100.00',
        shortReason: 'Lost a receipt and the change',
        toMoneyAccountId: f.till,
        on: '2026-01-08',
      }),
    );

    // ⭐ THE CLAIM. Released 2,000 = spent 1,400 + returned 500 + short 100, and 1120 is empty.
    expect(settled.outstanding).toBe('0.00');
    expect(settled.liquidated).toBe(true);

    const pos = await floatOf(f, id);
    expect(pos).toMatchObject({
      released: '2000.00',
      spent: '1400.00',
      returned: '500.00',
      short: '100.00',
      outstanding: '0.00',
    });

    // ⭐ And the shortage is a receivable from ANA, named on the line — 1230 is party-requiring,
    // which is why a float shortage can never be charged to nobody.
    const [adv] = await sql<{ debit: string; party_id: string }[]>`
      select jl.debit::text, jl.party_id from journal_lines jl
      join accounts a on a.id = jl.account_id
      where a.code = '1230' and a.org_id = ${f.orgId}
    `;
    expect(adv).toMatchObject({ debit: '100.00', party_id: f.staffId });

    const row = await asOrg(f.orgId, (tx) => cashRequestsRepo.getById(tx, f.orgId, id));
    expect(row!.status).toBe('liquidated');
  });

  it('⭐ the release reduces the cashier’s day, so remittance already sees it', async () => {
    const f = await fixture('remit');
    await released(f, '2000.00');
    // Ian: "out = ... cash request released by cashier." Nothing was added to make this true —
    // the end-day report asks the ledger what the cashier holds rather than listing document types.
    const [row] = await sql<{ net: string }[]>`
      select coalesce(sum(jl.debit - jl.credit), 0)::text as net
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id
      join accounts a on a.id = jl.account_id
      where je.org_id = ${f.orgId} and a.code = '1110' and je.entry_date = '2026-01-05'
        and je.status <> 'draft'
    `;
    expect(row!.net).toBe('-2000.00');
  });
});

describe('the refusals', () => {
  it('⛔ cannot release more than was approved', async () => {
    const f = await fixture('overrelease');
    const req = await asOrg(f.orgId, (tx) =>
      createCashRequest(tx, f.staff, {
        storeId: f.storeId, requestedFor: f.staffId, purpose: 'Run', amount: '2000.00', on: '2026-01-05',
      }),
    );
    await asOrg(f.orgId, (tx) =>
      decideCashRequest(tx, f.manager, { requestId: req.id, decision: 'approve', amount: '1500.00' }),
    );
    // The approval is the authority for the amount; releasing more would make it decorative.
    await expect(
      asOrg(f.orgId, (tx) =>
        releaseCashRequest(tx, f.manager, {
          requestId: req.id, amount: '2000.00', fromMoneyAccountId: f.till, on: '2026-01-05',
        }),
      ),
    ).rejects.toThrow(/more than the 1500.00 approved/);
  });

  it('⛔ cannot settle more than is still held', async () => {
    const f = await fixture('oversettle');
    const id = await released(f, '2000.00');
    await expect(
      asOrg(f.orgId, (tx) =>
        settleCashRequest(tx, f.manager, {
          requestId: id, returnedAmount: '2500.00', toMoneyAccountId: f.till, on: '2026-01-08',
        }),
      ),
    ).rejects.toThrow(/more than the 2000.00 still held/);
  });

  it('⛔ a shortage needs a reason', async () => {
    const f = await fixture('noreason');
    const id = await released(f, '2000.00');
    await expect(
      asOrg(f.orgId, (tx) =>
        settleCashRequest(tx, f.manager, { requestId: id, shortAmount: '100.00', on: '2026-01-08' }),
      ),
    ).rejects.toThrow(/needs a reason/);
  });

  it('⛔ staff can ASK but not approve — two decisions, not one', async () => {
    const f = await fixture('deny');
    const req = await asOrg(f.orgId, (tx) =>
      createCashRequest(tx, f.staff, {
        storeId: f.storeId, requestedFor: f.staffId, purpose: 'Run', amount: '500.00', on: '2026-01-05',
      }),
    );
    // Asking for money and agreeing to hand it over must not be one person's unilateral act.
    await expect(
      asOrg(f.orgId, (tx) =>
        decideCashRequest(tx, f.staff, { requestId: req.id, decision: 'approve', amount: '500.00' }),
      ),
    ).rejects.toThrow(AuthorizationError);
  });

  it('⛔ a decision cannot be revisited once made', async () => {
    const f = await fixture('locked');
    const req = await asOrg(f.orgId, (tx) =>
      createCashRequest(tx, f.staff, {
        storeId: f.storeId, requestedFor: f.staffId, purpose: 'Run', amount: '500.00', on: '2026-01-05',
      }),
    );
    await asOrg(f.orgId, (tx) =>
      decideCashRequest(tx, f.manager, { requestId: req.id, decision: 'approve', amount: '500.00' }),
    );
    // v1's `decisionLocked`, as behaviour rather than a column.
    await expect(
      asOrg(f.orgId, (tx) =>
        decideCashRequest(tx, f.manager, { requestId: req.id, decision: 'reject', reason: 'Changed my mind' }),
      ),
    ).rejects.toThrow(/already approved/);
  });

  it('⛔ funding from another store is refused, and says why', async () => {
    const f = await fixture('crossstore');
    const [other] = await sql<{ id: string }[]>`
      insert into stores (org_id, code, name) values (${f.orgId}, ${uid('other')}, 'Other') returning id
    `;
    const [farTill] = await sql<{ id: string }[]>`
      select id from money_accounts where store_id = ${other!.id}
        and instrument = 'cash' and custodian = 'office' and is_foundation
    `;
    const req = await asOrg(f.orgId, (tx) =>
      createCashRequest(tx, f.manager, {
        storeId: f.storeId, requestedFor: f.staffId, purpose: 'Run', amount: '500.00', on: '2026-01-05',
      }),
    );
    await asOrg(f.orgId, (tx) =>
      decideCashRequest(tx, f.manager, { requestId: req.id, decision: 'approve', amount: '500.00' }),
    );
    // ⚠️ Ian's scenario — Malvar's office funding a Lipa float — is the named next slice. It needs
    // the 1250/2150 pair, which exists and is tested, but is not wired here.
    await expect(
      asOrg(f.orgId, (tx) =>
        releaseCashRequest(tx, f.manager, {
          requestId: req.id, amount: '500.00', fromMoneyAccountId: farTill!.id, on: '2026-01-05',
        }),
      ),
    ).rejects.toThrow(/another store is not built yet/);
  });
});

describe('withdrawing a request', () => {
  it('an unapproved request can be withdrawn, and the request is the only thing that changes', async () => {
    const f = await fixture('cancel');
    const req = await asOrg(f.orgId, (tx) =>
      createCashRequest(tx, f.staff, {
        storeId: f.storeId, requestedFor: f.staffId, purpose: 'Run', amount: '500.00', on: '2026-01-05',
      }),
    );
    // ⭐ The requester withdraws their OWN ask — `create_expense`, not `approve_expense`. Staff can
    // do this; if only a manager could, dead requests would sit in the queue forever.
    await asOrg(f.orgId, (tx) => cancelCashRequest(tx, f.staff, { requestId: req.id, reason: 'Not needed' }));

    const row = await asOrg(f.orgId, (tx) => cashRequestsRepo.getById(tx, f.orgId, req.id));
    expect(row!.status).toBe('cancelled');

    // ⭐ Nothing posted. Asking for money is not a financial event, so un-asking cannot be one either.
    const [entries] = await sql<{ n: string }[]>`
      select count(*)::text as n from journal_entries
      where org_id = ${f.orgId} and source_id = ${req.id}
    `;
    expect(entries!.n).toBe('0');
  });

  it('⚠️ withdrawing an APPROVED request clears the approval rather than keeping it', async () => {
    const f = await fixture('cancelapproved');
    const req = await asOrg(f.orgId, (tx) =>
      createCashRequest(tx, f.staff, {
        storeId: f.storeId, requestedFor: f.staffId, purpose: 'Run', amount: '500.00', on: '2026-01-05',
      }),
    );
    await asOrg(f.orgId, (tx) =>
      decideCashRequest(tx, f.manager, { requestId: req.id, decision: 'approve', amount: '500.00' }),
    );
    await asOrg(f.orgId, (tx) => cancelCashRequest(tx, f.staff, { requestId: req.id }));

    const row = await asOrg(f.orgId, (tx) => cashRequestsRepo.getById(tx, f.orgId, req.id));
    expect(row!.status).toBe('cancelled');
    // Leaving the amount behind would read as "approved for ₱500" in every list that shows it.
    expect(row!.approvedAmount).toBeNull();
    expect(row!.approvedBy).toBeNull();
  });

  it('⛔ a RELEASED request cannot be withdrawn — the money is in someone’s hands', async () => {
    const f = await fixture('cancelreleased');
    const id = await released(f, '2000.00');
    // Cancelling here would erase a float that physically exists. That is a return, and it posts.
    await expect(
      asOrg(f.orgId, (tx) => cancelCashRequest(tx, f.manager, { requestId: id })),
    ).rejects.toThrow(/only one that has not been released/);
  });
});

describe('⛔ DEF-159 — a second float cannot be released while the first is unliquidated', () => {
  it('refuses to release a new request for a person who already holds one', async () => {
    const f = await fixture('def159-blocked');
    await released(f, '1000.00');

    const second = await asOrg(f.orgId, (tx) =>
      createCashRequest(tx, f.staff, {
        storeId: f.storeId, requestedFor: f.staffId, purpose: 'A second errand', amount: '500.00', on: '2026-01-06',
      }),
    );
    await asOrg(f.orgId, (tx) =>
      decideCashRequest(tx, f.manager, { requestId: second.id, decision: 'approve', amount: '500.00', on: '2026-01-06' }),
    );
    await expect(
      asOrg(f.orgId, (tx) =>
        releaseCashRequest(tx, f.manager, {
          requestId: second.id, amount: '500.00', fromMoneyAccountId: f.till, on: '2026-01-06',
        }),
      ),
    ).rejects.toThrow(/already holds an unliquidated float/);
  });

  it('releases fine once the first float is liquidated', async () => {
    const f = await fixture('def159-cleared');
    const first = await released(f, '1000.00');
    await asOrg(f.orgId, (tx) =>
      settleCashRequest(tx, f.manager, {
        requestId: first, returnedAmount: '1000.00', toMoneyAccountId: f.till, on: '2026-01-06',
      }),
    );

    const second = await asOrg(f.orgId, (tx) =>
      createCashRequest(tx, f.staff, {
        storeId: f.storeId, requestedFor: f.staffId, purpose: 'A second errand', amount: '500.00', on: '2026-01-07',
      }),
    );
    await asOrg(f.orgId, (tx) =>
      decideCashRequest(tx, f.manager, { requestId: second.id, decision: 'approve', amount: '500.00', on: '2026-01-07' }),
    );
    const released2 = await asOrg(f.orgId, (tx) =>
      releaseCashRequest(tx, f.manager, {
        requestId: second.id, amount: '500.00', fromMoneyAccountId: f.till, on: '2026-01-07',
      }),
    );
    expect(released2.entryId).toBeTruthy();
  });

  it('does not block a DIFFERENT person from releasing their own float', async () => {
    const f = await fixture('def159-otherperson');
    await released(f, '1000.00'); // f.staffId's float, still open

    const otherStaffId = await person(f.orgId, f.storeId, 'Ben', 'staff');
    const other = actor(f.orgId, otherStaffId);
    const req = await asOrg(f.orgId, (tx) =>
      createCashRequest(tx, other, {
        storeId: f.storeId, requestedFor: otherStaffId, purpose: 'Different errand', amount: '300.00', on: '2026-01-06',
      }),
    );
    await asOrg(f.orgId, (tx) =>
      decideCashRequest(tx, f.manager, { requestId: req.id, decision: 'approve', amount: '300.00', on: '2026-01-06' }),
    );
    const result = await asOrg(f.orgId, (tx) =>
      releaseCashRequest(tx, f.manager, {
        requestId: req.id, amount: '300.00', fromMoneyAccountId: f.till, on: '2026-01-06',
      }),
    );
    expect(result.entryId).toBeTruthy();
  });
});

describe('DEF-272 — a sub-centavo amount is refused with a written sentence, not driver text', () => {
  it('createCashRequest refuses "0.004" — Number(x)>0 passed it, Postgres would round it to 0.00 and cash_requests_amount_positive_check would refuse the row', async () => {
    const f = await fixture('def272-create');
    await expect(
      asOrg(f.orgId, (tx) =>
        createCashRequest(tx, f.staff, {
          storeId: f.storeId, requestedFor: f.staffId, purpose: 'Run', amount: '0.004', on: '2026-01-05',
        }),
      ),
    ).rejects.toThrow(/createCashRequest: the amount.*"0\.004"/);
  });

  it('createCashRequest refuses "1.234" too — the "quieter" defect DEF-272 also corrects for: three decimal places silently rounded away', async () => {
    const f = await fixture('def272-precision');
    await expect(
      asOrg(f.orgId, (tx) =>
        createCashRequest(tx, f.staff, {
          storeId: f.storeId, requestedFor: f.staffId, purpose: 'Run', amount: '1.234', on: '2026-01-05',
        }),
      ),
    ).rejects.toThrow(/"1\.234"/);
  });

  it('an ordinary amount still works, and the EXACT parsed value is what reaches the row', async () => {
    const f = await fixture('def272-happy');
    const req = await asOrg(f.orgId, (tx) =>
      createCashRequest(tx, f.staff, {
        storeId: f.storeId, requestedFor: f.staffId, purpose: 'Run', amount: '0.01', on: '2026-01-05',
      }),
    );
    const row = await asOrg(f.orgId, (tx) => cashRequestsRepo.getById(tx, f.orgId, req.id));
    expect(row!.requestedAmount).toBe('0.01');
  });

  it('decideCashRequest (approve) refuses "0.004" the same way', async () => {
    const f = await fixture('def272-approve');
    const req = await asOrg(f.orgId, (tx) =>
      createCashRequest(tx, f.staff, {
        storeId: f.storeId, requestedFor: f.staffId, purpose: 'Run', amount: '500.00', on: '2026-01-05',
      }),
    );
    await expect(
      asOrg(f.orgId, (tx) =>
        decideCashRequest(tx, f.manager, { requestId: req.id, decision: 'approve', amount: '0.004' }),
      ),
    ).rejects.toThrow(/decideCashRequest: the approved amount.*"0\.004"/);
  });

  // ⭐ Found by reading releaseCashRequest fully, NOT by the mechanical shape scanner — its guard is
  // `Number(input.amount) > Number(req.approvedAmount ?? 0)`, a comparison against another value,
  // not against a literal `0`, so it never matched the scanner's `Number(x) <op> 0` shape at all.
  // See money-positivity-guard.test.ts's header for this stated as a permanent blind spot.
  it('releaseCashRequest refuses "0.004" too — would otherwise post a 0.00/0.00 pair and trip journal_lines_exactly_one_side_check', async () => {
    const f = await fixture('def272-release');
    const req = await asOrg(f.orgId, (tx) =>
      createCashRequest(tx, f.staff, {
        storeId: f.storeId, requestedFor: f.staffId, purpose: 'Run', amount: '500.00', on: '2026-01-05',
      }),
    );
    await asOrg(f.orgId, (tx) =>
      decideCashRequest(tx, f.manager, { requestId: req.id, decision: 'approve', amount: '500.00' }),
    );
    await expect(
      asOrg(f.orgId, (tx) =>
        releaseCashRequest(tx, f.manager, {
          requestId: req.id, amount: '0.004', fromMoneyAccountId: f.till, on: '2026-01-05',
        }),
      ),
    ).rejects.toThrow(/releaseCashRequest: the amount.*"0\.004"/);
  });
});
