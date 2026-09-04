import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-125 — prepaid items and amortisation. `docs/tasks/125-prepaid-and-amortisation.md`.
 *
 * Covers all nine invariants of §7. The one worth reading first is **§7.8's per-month reversal**:
 * v1 has no equivalent, and it is nearly free here only because the balance is derived.
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
import { closeDb, prepaidRepo, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { AuthorizationError, assignRole, type Actor } from '@shareat/auth';
import {
  amortisePrepaidItem,
  confirmPrepaidTerm,
  createPrepaidItem,
  prepaidSchedule,
  reverseAmortisation,
  undoWriteOff,
  writeOffPrepaidItem,
} from '@shareat/domain';

const sql = postgres(url, { max: 5 });

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

async function newOrg(hint: string) {
  const code = uid(`pp-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id
  `;
  await seedChartOfAccounts(sql, org!.id);
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${org!.id}, ${uid(hint)}, ${`Store ${hint}`}) returning id
  `;
  // Two years of open periods — a 12-month policy has to be able to run to the end.
  for (const y of [2026, 2027]) {
    for (let m = 1; m <= 12; m++) {
      const start = `${y}-${String(m).padStart(2, '0')}-01`;
      const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
      await sql`
        insert into fiscal_periods (org_id, starts_on, ends_on, status)
        values (${org!.id}, ${start}, ${end}, 'open')
      `;
    }
  }
  return { orgId: org!.id, storeId: store!.id };
}

async function person(orgId: string, storeId: string, name: string, role?: string) {
  const [p] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id
  `;
  if (role) {
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
  }
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
  const adminId = await person(o.orgId, o.storeId, 'Admin', 'admin');
  return { ...o, adminId, admin: actor(o.orgId, adminId) };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** A ₱24,000, 12-month policy starting 2026-01-01 — the spec's own worked example. */
async function policy(f: Fixture, cost = '24000.00', months = 12) {
  return asOrg(f.orgId, (tx) =>
    createPrepaidItem(tx, f.admin, {
      storeId: f.storeId,
      name: 'Fire insurance 2026',
      category: 'insurance',
      coverageStartDate: '2026-01-01',
      coverageMonths: months,
      totalCost: cost,
    }),
  );
}

/** Sum of a code's movement across every posted entry for the org. */
async function netOf(orgId: string, code: string): Promise<string> {
  const [row] = await sql<{ total: string }[]>`
    select coalesce(sum(jl.debit - jl.credit), 0)::text as total
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId} and je.status <> 'draft' and a.code = ${code}
  `;
  return row!.total;
}

beforeAll(async () => {
  await sql`
    truncate table
      prepaid_items, money_transfers, money_accounts, sales_day_tenders, sales_day_channels,
      sales_days, sales_channels, expense_payments, expenses, expense_categories,
      person_grants, person_store_scope, person_roles,
      journal_lines, journal_entries, audit_log, fiscal_periods, accounts,
      person_identities, persons, stores, organizations
    restart identity cascade
  `;
});

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

// =========================================================================================
// Invariant 1 — nothing is stored
// =========================================================================================

describe('invariant 1 — amortised-to-date and remaining are NEVER stored', () => {
  it('⛔ the columns v1 has do not exist here', async () => {
    const cols = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_name = 'prepaid_items'
        and column_name in ('amortised_to_date', 'amortized_to_date', 'remaining',
                            'remaining_book_value', 'monthly_amortisation', 'monthly_amortization')
    `;
    // v1 kept the first two hand-incremented at every write site and, its own type admits, in
    // sync "by convention" — they drifted so far it ended up with two independent code paths
    // computing "total remaining prepaid" that never read from each other.
    expect(cols).toEqual([]);
  });

  it('⭐ the derived figure equals the ledger sum, exactly', async () => {
    const f = await fixture('derived');
    const item = await policy(f);
    await asOrg(f.orgId, (tx) =>
      amortisePrepaidItem(tx, f.admin, { prepaidItemId: item.id, asOfPeriod: '2026-03' }),
    );

    const derived = await asOrg(f.orgId, (tx) =>
      prepaidRepo.amortisedFromLedger(tx, f.orgId, item.id),
    );
    expect(derived).toBe('6000.00'); // three months of ₱2,000

    // ⚠️ And it agrees with 6750 — the same money seen from the P&L side. Two independent reads
    // of one fact is what "derived" has to mean.
    expect(await netOf(f.orgId, '6750')).toBe('6000.00');
  });

  it('⚠️ the PURCHASE debit is not mistaken for amortisation', async () => {
    const f = await fixture('purchase');
    const item = await policy(f);
    // A hand-posted purchase: DR 1400 / CR cash, exactly what T-122 writes when a category maps
    // to 1400. Without the source_type filter this would read as "already amortised".
    const [period] = await sql<{ id: string }[]>`
      select id from fiscal_periods where org_id = ${f.orgId} order by starts_on limit 1
    `;
    await sql.begin(async (tx) => {
      const [e] = await tx<{ id: string }[]>`
        insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
        values (${f.orgId}, '2026-01-01', ${period!.id}, 'expense', ${uid('exp')}, 'draft')
        returning id
      `;
      for (const [code, dr, cr] of [
        ['1400', '24000.00', '0'],
        ['1110', '0', '24000.00'],
      ] as const) {
        const [acct] = await tx<{ id: string }[]>`
          select id from accounts where org_id = ${f.orgId} and code = ${code}
        `;
        await tx`
          insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
          values (${e!.id}, ${code === '1400' ? 1 : 2}, ${acct!.id}, ${f.storeId}, ${dr}, ${cr})
        `;
      }
      await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
    });

    const derived = await asOrg(f.orgId, (tx) =>
      prepaidRepo.amortisedFromLedger(tx, f.orgId, item.id),
    );
    expect(derived).toBe('0'); // nothing released yet, despite ₱24,000 sitting in 1400
  });
});

// =========================================================================================
// Invariants 2, 3, 4 — idempotency, never past cost, coverage starts the schedule
// =========================================================================================

describe('invariant 2 — idempotent per (item, period)', () => {
  it('running the same month twice posts once', async () => {
    const f = await fixture('idem');
    const item = await policy(f);

    const first = await asOrg(f.orgId, (tx) =>
      amortisePrepaidItem(tx, f.admin, { prepaidItemId: item.id, asOfPeriod: '2026-02' }),
    );
    expect(first.posted).toEqual(['2026-01', '2026-02']);

    // ⭐ This IS the DEF-044 answer: catching up is running it again, not a repair script.
    const second = await asOrg(f.orgId, (tx) =>
      amortisePrepaidItem(tx, f.admin, { prepaidItemId: item.id, asOfPeriod: '2026-04' }),
    );
    expect(second.skipped).toEqual(['2026-01', '2026-02']);
    expect(second.posted).toEqual(['2026-03', '2026-04']);

    expect(await netOf(f.orgId, '6750')).toBe('8000.00'); // four months, not six
  });
});

describe('invariant 3 — never amortises past the cost', () => {
  it('⭐ an amount that does not divide evenly still sums to EXACTLY the cost', () => {
    // ₱10,000 over 12 months is ₱833.33 with ₱0.04 left over. v1 stored a pre-rounded
    // monthlyAmortization and used it as the basis for every period, so the rounding compounded.
    const schedule = prepaidSchedule({
      coverageStartDate: '2026-01-01',
      coverageMonths: 12,
      totalCost: '10000.00',
    });
    const total = schedule.reduce((s, p) => s + Number(p.amount), 0);
    expect(total.toFixed(2)).toBe('10000.00');
    // The remainder lands entirely on the LAST period — every earlier charge is identical, which
    // is what a reader expects of "straight line".
    expect(schedule[0]!.amount).toBe('833.33');
    expect(schedule[11]!.amount).toBe('833.37');
  });

  it('running past the end posts nothing extra', async () => {
    const f = await fixture('past');
    const item = await policy(f);
    await asOrg(f.orgId, (tx) =>
      amortisePrepaidItem(tx, f.admin, { prepaidItemId: item.id, asOfPeriod: '2027-06' }),
    );
    // Twelve months, and 1400 is back to zero from the amortisation side.
    expect(await netOf(f.orgId, '6750')).toBe('24000.00');

    const row = await asOrg(f.orgId, (tx) => prepaidRepo.getById(tx, f.orgId, item.id));
    expect(row!.status).toBe('fully_amortised');
  });
});

describe('invariant 4 — coverage starts the schedule', () => {
  it('a period before the coverage start owes nothing, across a year boundary', async () => {
    const f = await fixture('start');
    const item = await asOrg(f.orgId, (tx) =>
      createPrepaidItem(tx, f.admin, {
        storeId: f.storeId,
        name: 'Permit 2027',
        category: 'permits_and_licenses',
        coverageStartDate: '2027-01-01',
        coverageMonths: 12,
        totalCost: '12000.00',
      }),
    );
    // ⚠️ Lexicographic YYYY-MM compare, which is what makes this cross the year correctly —
    // '2026-12' < '2027-01' as strings and as dates.
    const r = await asOrg(f.orgId, (tx) =>
      amortisePrepaidItem(tx, f.admin, { prepaidItemId: item.id, asOfPeriod: '2026-12' }),
    );
    expect(r.posted).toEqual([]);
    expect(await netOf(f.orgId, '6750')).toBe('0');
  });
});

// =========================================================================================
// Invariant 5 — a terminated item stops
// =========================================================================================

describe('invariant 5 — a written-off or fully-amortised item stops amortising', () => {
  it('a written-off item is skipped silently, not refused', async () => {
    const f = await fixture('stopped');
    const item = await policy(f);
    await asOrg(f.orgId, (tx) =>
      amortisePrepaidItem(tx, f.admin, { prepaidItemId: item.id, asOfPeriod: '2026-03' }),
    );
    await asOrg(f.orgId, (tx) =>
      writeOffPrepaidItem(tx, f.admin, {
        prepaidItemId: item.id,
        writtenOffOn: '2026-04-15',
        reason: 'Policy cancelled',
      }),
    );

    // ⚠️ Not an error: the monthly run sweeps the whole register, and a refusal would turn a
    // normal state into noise that trains people to ignore the run's output.
    const r = await asOrg(f.orgId, (tx) =>
      amortisePrepaidItem(tx, f.admin, { prepaidItemId: item.id, asOfPeriod: '2026-08' }),
    );
    expect(r).toEqual({ posted: [], skipped: [] });
  });
});

// =========================================================================================
// Invariant 6 — the refund
// =========================================================================================

describe('invariant 6 — a refund never debits 6750, and cannot exceed what is left', () => {
  it('⭐ the spec\'s worked example: cancel at month 7 with ₱10,000 back', async () => {
    const f = await fixture('refund');
    const item = await policy(f); // ₱24,000 / 12 months
    await asOrg(f.orgId, (tx) =>
      amortisePrepaidItem(tx, f.admin, { prepaidItemId: item.id, asOfPeriod: '2026-06' }),
    );
    // Six months out = ₱12,000 released, ₱12,000 remaining.
    const r = await asOrg(f.orgId, (tx) =>
      writeOffPrepaidItem(tx, f.admin, {
        prepaidItemId: item.id,
        writtenOffOn: '2026-07-10',
        reason: 'Cancelled, partial refund',
        refundAmount: '10000.00',
        refundAccountCode: '1110',
      }),
    );
    expect(r).toMatchObject({ expensed: '2000.00', refunded: '10000.00' });

    const legs = await sql<{ code: string; debit: string; credit: string }[]>`
      select a.code, jl.debit::text, jl.credit::text
      from journal_lines jl join accounts a on a.id = jl.account_id
      where jl.entry_id = ${r.entryId} order by a.code
    `;
    expect(legs).toEqual([
      { code: '1110', debit: '10000.00', credit: '0.00' }, // cash back — balance sheet only
      { code: '1400', debit: '0.00', credit: '12000.00' }, // the whole remainder leaves 1400
      { code: '6750', debit: '2000.00', credit: '0.00' }, // ⚠️ ONLY the unrecovered part
    ]);

    // ⚠️ The double-count this prevents: booking ₱12,000 to 6750 AND ₱10,000 as income would
    // still BALANCE, which is why it needs a test rather than a comment.
    expect(await netOf(f.orgId, '6750')).toBe('14000.00'); // 12,000 released + 2,000 lost
  });

  it('⛔ refuses a refund larger than the unused balance', async () => {
    const f = await fixture('overrefund');
    const item = await policy(f);
    await asOrg(f.orgId, (tx) =>
      amortisePrepaidItem(tx, f.admin, { prepaidItemId: item.id, asOfPeriod: '2026-06' }),
    );
    await expect(
      asOrg(f.orgId, (tx) =>
        writeOffPrepaidItem(tx, f.admin, {
          prepaidItemId: item.id,
          writtenOffOn: '2026-07-10',
          reason: 'Too much back',
          refundAmount: '20000.00',
          refundAccountCode: '1110',
        }),
      ),
    ).rejects.toThrow(/income, not a refund/);
  });

  it('⛔ a refund with nowhere to land is refused', async () => {
    const f = await fixture('norefundacct');
    const item = await policy(f);
    await expect(
      asOrg(f.orgId, (tx) =>
        writeOffPrepaidItem(tx, f.admin, {
          prepaidItemId: item.id,
          writtenOffOn: '2026-02-10',
          reason: 'No account named',
          refundAmount: '500.00',
        }),
      ),
    ).rejects.toThrow(/which account it landed in/);
  });
});

describe('⭐ DEF-163 — undoWriteOff, the missing counterpart to reverseAmortisation', () => {
  it('reverses the write-off entry and restores the item to active', async () => {
    const f = await fixture('undo-writeoff');
    const item = await policy(f); // ₱24,000 / 12 months
    await asOrg(f.orgId, (tx) =>
      amortisePrepaidItem(tx, f.admin, { prepaidItemId: item.id, asOfPeriod: '2026-06' }),
    );
    // ⭐ Captured BEFORE the write-off, so the assertions below check RESTORATION rather than an
    // absolute figure — this fixture posts no purchase entry (no `sourceExpenseId`), so 1400's
    // net is a running credit total, not a "remaining balance", and only the before/after
    // comparison is meaningful.
    const balanceBeforeWriteOff = await netOf(f.orgId, '1400');
    const expenseBeforeWriteOff = await netOf(f.orgId, '6750');

    // Six months released (₱12,000), ₱12,000 remaining written off with no refund.
    await asOrg(f.orgId, (tx) =>
      writeOffPrepaidItem(tx, f.admin, {
        prepaidItemId: item.id,
        writtenOffOn: '2026-07-10',
        reason: 'Cancelled in error',
      }),
    );
    expect((await asOrg(f.orgId, (tx) => prepaidRepo.getById(tx, f.orgId, item.id)))!.status)
      .toBe('written_off');
    expect(await netOf(f.orgId, '1400')).not.toBe(balanceBeforeWriteOff);

    await asOrg(f.orgId, (tx) =>
      undoWriteOff(tx, f.admin, { prepaidItemId: item.id, reason: 'Wrong item — meant a different policy' }),
    );

    const after = await asOrg(f.orgId, (tx) => prepaidRepo.getById(tx, f.orgId, item.id));
    expect(after!.status).toBe('active');
    // The write-off's own entry (Dr 6750 / Cr 1400 for the remainder) is undone, so both
    // accounts are back to exactly what six months of amortisation alone left them at.
    expect(await netOf(f.orgId, '1400')).toBe(balanceBeforeWriteOff);
    expect(await netOf(f.orgId, '6750')).toBe(expenseBeforeWriteOff);

    // ⭐ And amortisation can resume — the whole point of restoring 'active' rather than leaving
    // a dead status behind.
    const resumed = await asOrg(f.orgId, (tx) =>
      amortisePrepaidItem(tx, f.admin, { prepaidItemId: item.id, asOfPeriod: '2026-07' }),
    );
    expect(resumed.posted).toEqual(['2026-07']);
  });

  it('⛔ refuses an item that was never written off', async () => {
    const f = await fixture('undo-notwrittenoff');
    const item = await policy(f);
    await expect(
      asOrg(f.orgId, (tx) => undoWriteOff(tx, f.admin, { prepaidItemId: item.id, reason: 'Nothing to undo' })),
    ).rejects.toThrow(/is active, not written_off/);
  });
});

// =========================================================================================
// Invariant 8 — ⭐ per-month reversal, the place v2 exceeds v1
// =========================================================================================

describe('invariant 8 — ⭐ ONE posted month can be reversed on its own', () => {
  it('reverses a single month, leaves the others, and lets it be re-run', async () => {
    const f = await fixture('revmonth');
    const item = await policy(f);
    await asOrg(f.orgId, (tx) =>
      amortisePrepaidItem(tx, f.admin, { prepaidItemId: item.id, asOfPeriod: '2026-03' }),
    );
    expect(await netOf(f.orgId, '6750')).toBe('6000.00');

    // ⭐ v1 has NO equivalent of this. Its only undo cascade-voids every leg including the
    // original purchase, so fixing one month means re-creating the item.
    await asOrg(f.orgId, (tx) =>
      reverseAmortisation(tx, f.admin, {
        prepaidItemId: item.id,
        period: '2026-02',
        reason: 'Posted against the wrong item',
      }),
    );

    // ⚠️ February is gone; January and March are untouched.
    expect(await netOf(f.orgId, '6750')).toBe('4000.00');
    const derived = await asOrg(f.orgId, (tx) =>
      prepaidRepo.amortisedFromLedger(tx, f.orgId, item.id),
    );
    // ⭐ And the register agrees WITHOUT anything being repaired — the figure is derived, so
    // reversing the entry IS the fix. In v1 this was expensive precisely because the stored
    // totals had to be walked back.
    expect(derived).toBe('4000.00');

    // The reversed month can be put back, because a reversed entry does not count as posted.
    const again = await asOrg(f.orgId, (tx) =>
      amortisePrepaidItem(tx, f.admin, { prepaidItemId: item.id, asOfPeriod: '2026-03' }),
    );
    expect(again.posted).toEqual(['2026-02']);
    expect(await netOf(f.orgId, '6750')).toBe('6000.00');
  });

  it('⛔ refuses a period that never posted, and refuses an empty reason', async () => {
    const f = await fixture('revmiss');
    const item = await policy(f);
    await asOrg(f.orgId, (tx) =>
      amortisePrepaidItem(tx, f.admin, { prepaidItemId: item.id, asOfPeriod: '2026-01' }),
    );
    await expect(
      asOrg(f.orgId, (tx) =>
        reverseAmortisation(tx, f.admin, { prepaidItemId: item.id, period: '2026-05', reason: 'x' }),
      ),
    ).rejects.toThrow(/nothing posted for 2026-05/);
    await expect(
      asOrg(f.orgId, (tx) =>
        reverseAmortisation(tx, f.admin, { prepaidItemId: item.id, period: '2026-01', reason: '  ' }),
      ),
    ).rejects.toThrow(/reason is required/);
  });

  it('⚠️ a fully-amortised item that loses a month becomes ACTIVE again', async () => {
    const f = await fixture('revfull');
    const item = await policy(f, '12000.00', 2);
    await asOrg(f.orgId, (tx) =>
      amortisePrepaidItem(tx, f.admin, { prepaidItemId: item.id, asOfPeriod: '2026-02' }),
    );
    expect((await asOrg(f.orgId, (tx) => prepaidRepo.getById(tx, f.orgId, item.id)))!.status).toBe(
      'fully_amortised',
    );

    await asOrg(f.orgId, (tx) =>
      reverseAmortisation(tx, f.admin, { prepaidItemId: item.id, period: '2026-02', reason: 'Wrong month' }),
    );
    // Otherwise the re-run would refuse it as finished and the month could never be put back.
    expect((await asOrg(f.orgId, (tx) => prepaidRepo.getById(tx, f.orgId, item.id)))!.status).toBe(
      'active',
    );
  });
});

// =========================================================================================
// The threshold, the review queue, and invariant 9 — denials
// =========================================================================================

describe('the threshold — ONE, shared with fixed assets (bible row 141)', () => {
  it('⛔ refuses below ₱5,000, saying what to do instead', async () => {
    const f = await fixture('threshold');
    await expect(
      asOrg(f.orgId, (tx) =>
        createPrepaidItem(tx, f.admin, {
          storeId: f.storeId,
          name: 'Small subscription',
          category: 'software_and_subscriptions',
          coverageStartDate: '2026-01-01',
          coverageMonths: 12,
          totalCost: '4999.99',
        }),
      ),
    ).rejects.toThrow(/below the capitalisation threshold/);
  });

  it('accepts AT the threshold, not one centavo below', async () => {
    const f = await fixture('atthreshold');
    await expect(
      asOrg(f.orgId, (tx) =>
        createPrepaidItem(tx, f.admin, {
          storeId: f.storeId,
          name: 'Exactly at it',
          category: 'other_prepaid',
          coverageStartDate: '2026-01-01',
          coverageMonths: 5,
          totalCost: '5000.00',
        }),
      ),
    ).resolves.toBeTruthy();
  });
});

describe('§11.2 — the review is a PLACE, and only a human clears it', () => {
  it('the counter counts, and confirming the term clears the flag', async () => {
    const f = await fixture('review');
    const guessed = await asOrg(f.orgId, (tx) =>
      createPrepaidItem(tx, f.admin, {
        storeId: f.storeId,
        name: 'Rent advance (term guessed)',
        category: 'rent_prepaid',
        coverageStartDate: '2026-01-01',
        coverageMonths: 12,
        totalCost: '60000.00',
        needsReview: true,
      }),
    );
    expect(await asOrg(f.orgId, (tx) => prepaidRepo.countNeedingReview(tx, f.orgId))).toBe(1);

    // ⭐ Only a human doing this clears it. Nothing expires the queue — a guessed default
    // silently becoming permanent is the failure this whole task is built against.
    await asOrg(f.orgId, (tx) =>
      confirmPrepaidTerm(tx, f.admin, {
        prepaidItemId: guessed.id,
        coverageMonths: 6,
        coverageStartDate: '2026-01-01',
      }),
    );
    expect(await asOrg(f.orgId, (tx) => prepaidRepo.countNeedingReview(tx, f.orgId))).toBe(0);
  });

  it('⛔ the term cannot be shortened below what has already been released', async () => {
    const f = await fixture('shorten');
    const item = await policy(f);
    await asOrg(f.orgId, (tx) =>
      amortisePrepaidItem(tx, f.admin, { prepaidItemId: item.id, asOfPeriod: '2026-04' }),
    );
    // Four months are out. Cutting the term to two would leave the item amortised past its own
    // cost — invariant 3 read backwards.
    await expect(
      asOrg(f.orgId, (tx) =>
        confirmPrepaidTerm(tx, f.admin, {
          prepaidItemId: item.id,
          coverageMonths: 2,
          coverageStartDate: '2026-01-01',
        }),
      ),
    ).rejects.toThrow(/already been released/);
  });
});

describe('invariant 9 — a denial test per capability', () => {
  it('⛔ a manager cannot create, amortise, reverse or write off', async () => {
    const f = await fixture('deny');
    await person(f.orgId, f.storeId, 'Admin2', 'admin'); // org HAS an admin, so no fallback
    const mgrId = await person(f.orgId, f.storeId, 'Manager', 'manager');
    const mgr = actor(f.orgId, mgrId);
    const item = await policy(f);

    await expect(
      asOrg(f.orgId, (tx) =>
        createPrepaidItem(tx, mgr, {
          storeId: f.storeId,
          name: 'Nope',
          category: 'insurance',
          coverageStartDate: '2026-01-01',
          coverageMonths: 12,
          totalCost: '24000.00',
        }),
      ),
    ).rejects.toThrow(AuthorizationError);

    await expect(
      asOrg(f.orgId, (tx) =>
        amortisePrepaidItem(tx, mgr, { prepaidItemId: item.id, asOfPeriod: '2026-02' }),
      ),
    ).rejects.toThrow(AuthorizationError);

    await expect(
      asOrg(f.orgId, (tx) =>
        writeOffPrepaidItem(tx, mgr, {
          prepaidItemId: item.id,
          writtenOffOn: '2026-02-01',
          reason: 'Nope',
        }),
      ),
    ).rejects.toThrow(AuthorizationError);

    await expect(
      asOrg(f.orgId, (tx) =>
        reverseAmortisation(tx, mgr, { prepaidItemId: item.id, period: '2026-01', reason: 'Nope' }),
      ),
    ).rejects.toThrow(AuthorizationError);
  });

  it('⛔ staff cannot either', async () => {
    const f = await fixture('denystaff');
    const staffId = await person(f.orgId, f.storeId, 'Staff', 'staff');
    await expect(
      asOrg(f.orgId, (tx) =>
        createPrepaidItem(tx, actor(f.orgId, staffId), {
          storeId: f.storeId,
          name: 'Nope',
          category: 'insurance',
          coverageStartDate: '2026-01-01',
          coverageMonths: 12,
          totalCost: '24000.00',
        }),
      ),
    ).rejects.toThrow(AuthorizationError);
  });

  it('⭐ but a manager APPOINTED into an admin-less org can — the set is derived', async () => {
    const f = await newOrg('adminless');
    const mgrId = await person(f.orgId, f.storeId, 'Lone Manager');
    const result = await asOrg(f.orgId, (tx) =>
      assignRole(tx, { personId: mgrId, orgId: f.orgId, role: 'manager', grantedBy: null }),
    );
    // ⭐ Both capabilities enrolled themselves. ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER is derived
    // from the matrix (admin-yes / manager-no), so making them admin-only added them with no edit
    // to any list. Nobody had to remember.
    expect(result.elevatedGrants).toContain('manage_prepaid_items');
    expect(result.elevatedGrants).toContain('run_amortisation');

    await expect(
      asOrg(f.orgId, (tx) =>
        createPrepaidItem(tx, actor(f.orgId, mgrId), {
          storeId: f.storeId,
          name: 'Allowed',
          category: 'insurance',
          coverageStartDate: '2026-01-01',
          coverageMonths: 12,
          totalCost: '24000.00',
        }),
      ),
    ).resolves.toBeTruthy();
  });
});
