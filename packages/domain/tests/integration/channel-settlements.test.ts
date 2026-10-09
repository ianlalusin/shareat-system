import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-150 — channel settlement. `docs/tasks/150-channel-settlement.md`.
 *
 * ⭐ The test that carries the design is the NEGATIVE platform fee: a promo-heavy day genuinely
 * returns money, and v1 shipped a bug by assuming a deduction is always positive. Everything else
 * here is the identity holding under each shape it can take.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { closeDb, channelSettlementsRepo, loansRepo, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { forceVerifiedSql } from './_fixtures/sales-day-flow';
import {
  previewChannelSettlement,
  recordChannelSettlement,
  setChannelPayoutDestination,
  voidChannelSettlement,
} from '@shareat/domain';
import { postEntry } from '../../src/ledger/post-entry';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

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
  const code = uid(`cs-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  await sql`
    insert into fiscal_periods (org_id, starts_on, ends_on, status) values
      (${orgId}, '2026-01-01', '2026-01-31', 'open'), (${orgId}, '2026-02-01', '2026-02-28', 'open')`;

  const mkStore = async (label: string) => {
    const [s] = await sql<{ id: string }[]>`
      insert into stores (org_id, code, name) values (${orgId}, ${uid(label)}, ${`Store ${label}`}) returning id`;
    return s!.id;
  };
  const storeId = await mkStore('malvar');
  const otherStoreId = await mkStore('lipa');

  const [p] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Manager') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, 'manager')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${otherStoreId})`;

  const [bank] = await sql<{ id: string }[]>`
    insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian)
    values (${orgId}, ${storeId}, 'Payout wallet', 'bank', '1140', 'office') returning id`;

  const [channel] = await sql<{ id: string }[]>`
    insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code,
                                destination_money_account_id)
    values (${orgId}, ${storeId}, ${`Foodpanda ${uid('c')}`}, false, '1220', ${bank!.id})
    returning id`;

  const [day] = await sql<{ id: string }[]>`
    insert into sales_days (org_id, store_id, business_date, total_sales, unli_sales, ala_carte_sales, created_by)
    values (${orgId}, ${storeId}, '2026-01-10', 0, 0, 0, ${p!.id}) returning id`;

  return {
    orgId, storeId, otherStoreId, bankId: bank!.id,
    channelId: channel!.id, salesDayId: day!.id,
    manager: actor(orgId, p!.id), personId: p!.id,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Raise the receivable a verified channel-day would have raised. */
async function raiseReceivable(f: Fixture, amount: string, date = '2026-01-10') {
  await asOrg(f.orgId, (tx) =>
    postEntry(tx, {
      orgId: f.orgId,
      entryDate: date,
      sourceType: 'sales_day',
      sourceId: f.salesDayId,
      idempotencyKey: `sales_day:${f.salesDayId}:${amount}:${date}`,
      memo: 'Channel day',
      postedBy: f.personId,
      lines: [
        { accountCode: '1220', storeId: f.storeId, debit: amount, partyType: 'channel', partyId: f.channelId },
        { accountCode: '4150', storeId: f.storeId, credit: amount },
      ],
    }),
  );
}

async function legsOf(entryId: string) {
  return sql<{ code: string; debit: string; credit: string; store_id: string; party_id: string | null }[]>`
    select a.code, jl.debit::text, jl.credit::text, jl.store_id, jl.party_id
    from journal_lines jl join accounts a on a.id = jl.account_id
    where jl.entry_id = ${entryId} order by a.code`;
}

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('channel settlement clears what nothing has ever cleared', () => {
  it('⭐ the plain settlement: fees to real accounts, receivable to exactly zero', async () => {
    const f = await fixture('plain');
    await raiseReceivable(f, '100000.00');
    const r = await asOrg(f.orgId, (tx) =>
      recordChannelSettlement(tx, f.manager, {
        storeId: f.storeId, channelId: f.channelId, salesDayId: f.salesDayId,
        businessDate: '2026-01-10', grossAmount: '100000.00', netDeposited: '79500.00',
        deductions: { commission: '20000.00', withholdingTax: '500.00' },
        settledOn: '2026-01-15',
      }),
    );
    const legs = await legsOf(r.entryId);
    expect(Number(legs.find((l) => l.code === '1140')!.debit)).toBe(79500);
    expect(Number(legs.find((l) => l.code === '6400')!.debit)).toBe(20000);
    // ⭐ Withholding tax is an EXPENSE, not an asset — the credit cannot be realised (spec §7).
    expect(Number(legs.find((l) => l.code === '6800')!.debit)).toBe(500);
    expect(Number(legs.find((l) => l.code === '1220')!.credit)).toBe(100000);

    // ⭐ And 1220 for this channel is EXACTLY zero, not near zero.
    const outstanding = await asOrg(f.orgId, (tx) =>
      channelSettlementsRepo.outstandingFor(tx, f.orgId, f.channelId),
    );
    expect(Number(outstanding)).toBe(0);
  });

  it('⭐ a NEGATIVE platform fee survives end to end — the promo day v1 got wrong', async () => {
    const f = await fixture('promo');
    await raiseReceivable(f, '50000.00');
    const r = await asOrg(f.orgId, (tx) =>
      recordChannelSettlement(tx, f.manager, {
        storeId: f.storeId, channelId: f.channelId, salesDayId: f.salesDayId,
        businessDate: '2026-01-10', grossAmount: '50000.00', netDeposited: '43000.00',
        // The platform charged 8,000 commission and handed back 1,000 of promo funding.
        deductions: { commission: '8000.00', platformFee: '-1000.00' },
        settledOn: '2026-01-15',
      }),
    );
    const legs = await legsOf(r.entryId);
    const fees = legs.filter((l) => l.code === '6400');
    // The credit leg is the point: nothing clamped it to zero.
    expect(fees.some((l) => Number(l.credit) === 1000)).toBe(true);
    expect(fees.some((l) => Number(l.debit) === 8000)).toBe(true);
    const outstanding = await asOrg(f.orgId, (tx) =>
      channelSettlementsRepo.outstandingFor(tx, f.orgId, f.channelId),
    );
    expect(Number(outstanding)).toBe(0);
  });

  it('a below-tolerance shortfall sweeps to 6420 so the receivable still clears exactly', async () => {
    const f = await fixture('short');
    await raiseReceivable(f, '10000.00');
    const r = await asOrg(f.orgId, (tx) =>
      recordChannelSettlement(tx, f.manager, {
        storeId: f.storeId, channelId: f.channelId, salesDayId: f.salesDayId,
        businessDate: '2026-01-10', grossAmount: '10000.00', netDeposited: '9960.00',
        settledOn: '2026-01-15',
      }),
    );
    expect(r.variance).toBe('40.00');
    const legs = await legsOf(r.entryId);
    expect(Number(legs.find((l) => l.code === '6420')!.debit)).toBe(40);
  });

  it('⛔ an above-tolerance shortfall is refused — reconcile, do not sweep', async () => {
    const f = await fixture('bigshort');
    await raiseReceivable(f, '10000.00');
    await expect(
      asOrg(f.orgId, (tx) =>
        recordChannelSettlement(tx, f.manager, {
          storeId: f.storeId, channelId: f.channelId, salesDayId: f.salesDayId,
          businessDate: '2026-01-10', grossAmount: '10000.00', netDeposited: '5000.00',
          settledOn: '2026-01-15',
        }),
      ),
    ).rejects.toThrow(/past the/);
  });

  it('⛔ an above-tolerance GAIN needs recognizeGain — a typo must not become revenue', async () => {
    const f = await fixture('gain');
    await raiseReceivable(f, '10000.00');
    const args = {
      storeId: f.storeId, channelId: f.channelId, salesDayId: f.salesDayId,
      businessDate: '2026-01-10', grossAmount: '10000.00', netDeposited: '13000.00',
      settledOn: '2026-01-15',
    };
    await expect(
      asOrg(f.orgId, (tx) => recordChannelSettlement(tx, f.manager, args)),
    ).rejects.toThrow(/recognizeGain/);

    const r = await asOrg(f.orgId, (tx) =>
      recordChannelSettlement(tx, f.manager, { ...args, recognizeGain: true }),
    );
    expect(Number(r.settlementGain)).toBe(3000);
    const legs = await legsOf(r.entryId);
    expect(Number(legs.find((l) => l.code === '7100')!.credit)).toBe(3000);
  });

  it('a same-store loan deduction reduces 2400', async () => {
    const f = await fixture('loan');
    await raiseReceivable(f, '20000.00');
    const [loan] = await sql<{ id: string }[]>`
      insert into loans (org_id, store_id, lender_name, name, principal_amount, interest_rate,
                         rate_period, interest_method, payment_frequency, term_periods, start_date, created_by)
      values (${f.orgId}, ${f.storeId}, 'Grab', 'Grab advance', 5000, 0,
              'month', 'straight', 'monthly', 6, '2026-01-01', ${f.personId}) returning id`;
    const r = await asOrg(f.orgId, (tx) =>
      recordChannelSettlement(tx, f.manager, {
        storeId: f.storeId, channelId: f.channelId, salesDayId: f.salesDayId,
        businessDate: '2026-01-10', grossAmount: '20000.00', netDeposited: '18000.00',
        loan: { loanId: loan!.id, amount: '2000.00' },
        settledOn: '2026-01-15',
      }),
    );
    const legs = await legsOf(r.entryId);
    expect(Number(legs.find((l) => l.code === '2400')!.debit)).toBe(2000);
  });

  it('⭐ a CROSS-STORE loan deduction leaves 1250 and 2150 equal and opposite', async () => {
    const f = await fixture('crossloan');
    await raiseReceivable(f, '20000.00');
    const [loan] = await sql<{ id: string }[]>`
      insert into loans (org_id, store_id, lender_name, name, principal_amount, interest_rate,
                         rate_period, interest_method, payment_frequency, term_periods, start_date, created_by)
      values (${f.orgId}, ${f.otherStoreId}, 'Grab', 'Grab advance', 5000, 0,
              'month', 'straight', 'monthly', 6, '2026-01-01', ${f.personId}) returning id`;
    const r = await asOrg(f.orgId, (tx) =>
      recordChannelSettlement(tx, f.manager, {
        storeId: f.storeId, channelId: f.channelId, salesDayId: f.salesDayId,
        businessDate: '2026-01-10', grossAmount: '20000.00', netDeposited: '18000.00',
        loan: { loanId: loan!.id, amount: '2000.00', ownerStoreId: f.otherStoreId },
        settledOn: '2026-01-15',
      }),
    );
    const legs = await legsOf(r.entryId);
    // The paying store is owed; the owning store owes and its loan falls.
    expect(Number(legs.find((l) => l.code === '1250')!.debit)).toBe(2000);
    expect(Number(legs.find((l) => l.code === '2150')!.credit)).toBe(2000);
    expect(Number(legs.find((l) => l.code === '2400')!.debit)).toBe(2000);

    const [net] = await sql<{ due_from: string; due_to: string }[]>`
      select
        coalesce(sum(case when a.code = '1250' then jl.debit - jl.credit end), 0)::text as due_from,
        coalesce(sum(case when a.code = '2150' then jl.credit - jl.debit end), 0)::text as due_to
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id
      join accounts a on a.id = jl.account_id
      where je.org_id = ${f.orgId} and je.status <> 'draft'`;
    expect(Number(net!.due_from)).toBe(Number(net!.due_to));
  });

  it('⛔ a second settlement for the same channel-day is refused, not duplicated', async () => {
    const f = await fixture('dupe');
    await raiseReceivable(f, '10000.00');
    const args = {
      storeId: f.storeId, channelId: f.channelId, salesDayId: f.salesDayId,
      businessDate: '2026-01-10', grossAmount: '10000.00', netDeposited: '10000.00',
      settledOn: '2026-01-15',
    };
    await asOrg(f.orgId, (tx) => recordChannelSettlement(tx, f.manager, args));
    await raiseReceivable(f, '10000.00', '2026-01-11');
    await expect(
      asOrg(f.orgId, (tx) => recordChannelSettlement(tx, f.manager, args)),
    ).rejects.toThrow(/already has a posted settlement/);
  });

  it('void reverses every leg and puts the receivable back', async () => {
    const f = await fixture('void');
    await raiseReceivable(f, '10000.00');
    const r = await asOrg(f.orgId, (tx) =>
      recordChannelSettlement(tx, f.manager, {
        storeId: f.storeId, channelId: f.channelId, salesDayId: f.salesDayId,
        businessDate: '2026-01-10', grossAmount: '10000.00', netDeposited: '9000.00',
        deductions: { commission: '1000.00' }, settledOn: '2026-01-15',
      }),
    );
    await asOrg(f.orgId, (tx) =>
      voidChannelSettlement(tx, f.manager, { settlementId: r.settlementId, reason: 'Wrong payout file.' }),
    );
    const outstanding = await asOrg(f.orgId, (tx) =>
      channelSettlementsRepo.outstandingFor(tx, f.orgId, f.channelId),
    );
    // Back to the full receivable — the void restored it rather than deleting anything.
    expect(Number(outstanding)).toBe(10000);
  });

  it('⛔ fees exceeding the payout is a refusal, not a negative deposit', async () => {
    const f = await fixture('negdep');
    await raiseReceivable(f, '1000.00');
    await expect(
      asOrg(f.orgId, (tx) =>
        recordChannelSettlement(tx, f.manager, {
          storeId: f.storeId, channelId: f.channelId, salesDayId: f.salesDayId,
          businessDate: '2026-01-10', grossAmount: '1000.00', netDeposited: '-100.00',
          deductions: { commission: '1100.00' }, settledOn: '2026-01-15',
        }),
      ),
    ).rejects.toThrow(/not a negative deposit/);
  });

  it('⛔ a channel with nothing outstanding cannot be settled', async () => {
    const f = await fixture('nothing');
    await expect(
      asOrg(f.orgId, (tx) =>
        recordChannelSettlement(tx, f.manager, {
          storeId: f.storeId, channelId: f.channelId, salesDayId: f.salesDayId,
          businessDate: '2026-01-10', grossAmount: '1000.00', netDeposited: '1000.00',
          settledOn: '2026-01-15',
        }),
      ),
    ).rejects.toThrow(/nothing outstanding/);
  });

  it('⛔ a settlement into a closed period is refused, like every other posting', async () => {
    const f = await fixture('closed');
    await raiseReceivable(f, '10000.00');
    await sql`update fiscal_periods set status = 'closed' where org_id = ${f.orgId} and starts_on = '2026-01-01'`;
    await expect(
      asOrg(f.orgId, (tx) =>
        recordChannelSettlement(tx, f.manager, {
          storeId: f.storeId, channelId: f.channelId, salesDayId: f.salesDayId,
          businessDate: '2026-01-10', grossAmount: '10000.00', netDeposited: '10000.00',
          settledOn: '2026-01-15',
        }),
      ),
    ).rejects.toThrow();
  });
});

/**
 * DEF-137 — the screen. Everything below exists because `recordChannelSettlement` had no caller
 * outside this file for five days, and the first real one found four things the engine's own
 * tests had arranged around.
 */
describe('DEF-137 — what the screen needed, and what wiring it found', () => {
  it('⭐ the preview is the SAME arithmetic the posting runs — variance, gain and tolerance agree', async () => {
    const f = await fixture('preview');
    await raiseReceivable(f, '10000.00');
    const args = {
      storeId: f.storeId, channelId: f.channelId, businessDate: '2026-01-10',
      grossAmount: '10000.00', netDeposited: '9960.00',
    };

    const p = await asOrg(f.orgId, (tx) => previewChannelSettlement(tx, f.manager, args));
    expect(p.blockers).toEqual([]);
    expect(p.outstanding).toBe('10000.00');
    expect(p.outstandingCleared).toBe('10000.00');
    expect(p.variance).toBe('40.00');
    expect(p.settlementGain).toBe('0.00');
    expect(p.tolerance).toBe('1000.00');
    expect(p.destinationAccountName).toBe('Payout wallet');

    // ⭐ The point of the whole preview: the number shown before posting is the number posted.
    const r = await asOrg(f.orgId, (tx) =>
      recordChannelSettlement(tx, f.manager, { ...args, salesDayId: f.salesDayId, settledOn: '2026-01-15' }),
    );
    expect(r.variance).toBe(p.variance);
    expect(r.settlementGain).toBe(p.settlementGain);
  });

  it('⭐ the preview WRITES NOTHING — a checked settlement that is never posted leaves 1220 alone', async () => {
    const f = await fixture('previewdry');
    await raiseReceivable(f, '10000.00');
    await asOrg(f.orgId, (tx) =>
      previewChannelSettlement(tx, f.manager, {
        storeId: f.storeId, channelId: f.channelId, businessDate: '2026-01-10',
        grossAmount: '10000.00', netDeposited: '9000.00', deductions: { commission: '1000.00' },
      }),
    );
    const outstanding = await asOrg(f.orgId, (tx) =>
      channelSettlementsRepo.outstandingFor(tx, f.orgId, f.channelId),
    );
    expect(Number(outstanding)).toBe(10000);
    const [count] = await sql<{ n: string }[]>`
      select count(*)::text as n from channel_settlements where org_id = ${f.orgId}`;
    expect(Number(count!.n)).toBe(0);
  });

  it('⭐ the preview RETURNS every refusal instead of throwing the first — a form fixes them in one pass', async () => {
    const f = await fixture('blockers');
    // Nothing outstanding AND a shortfall past tolerance: two independent refusals at once.
    const p = await asOrg(f.orgId, (tx) =>
      previewChannelSettlement(tx, f.manager, {
        storeId: f.storeId, channelId: f.channelId, businessDate: '2026-01-10',
        grossAmount: '10000.00', netDeposited: '1000.00',
      }),
    );
    expect(p.blockers.length).toBeGreaterThanOrEqual(1);
    expect(p.blockers.join(' ')).toMatch(/nothing outstanding/);
    // ⚠️ And it did not throw — a screen needs the list, not the first item.
  });

  it('a gain past tolerance is reported as needing acknowledgement, and clears once given', async () => {
    const f = await fixture('previewgain');
    await raiseReceivable(f, '10000.00');
    const args = {
      storeId: f.storeId, channelId: f.channelId, businessDate: '2026-01-10',
      grossAmount: '10000.00', netDeposited: '13000.00',
    };
    const before = await asOrg(f.orgId, (tx) => previewChannelSettlement(tx, f.manager, args));
    expect(before.needsGainAcknowledgement).toBe(true);
    expect(before.blockers.join(' ')).toMatch(/recognizeGain/);
    expect(before.settlementGain).toBe('3000.00');

    const after = await asOrg(f.orgId, (tx) =>
      previewChannelSettlement(tx, f.manager, { ...args, recognizeGain: true }),
    );
    expect(after.needsGainAcknowledgement).toBe(false);
    expect(after.blockers).toEqual([]);
  });

  it('⛔ DEF-146 — the 2307 file id is PERSISTED, not silently dropped', async () => {
    const f = await fixture('cert');
    await raiseReceivable(f, '10000.00');
    const [file] = await sql<{ id: string }[]>`
      insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size,
                                checksum, uploaded_by)
      values (${f.orgId}, ${f.storeId}, 'ar_collection_proof', ${`orgs/${f.orgId}/2307/${uid('f')}.pdf`},
              'application/pdf', 1024, ${uid('sum')}, ${f.personId})
      returning id`;

    const r = await asOrg(f.orgId, (tx) =>
      recordChannelSettlement(tx, f.manager, {
        storeId: f.storeId, channelId: f.channelId, salesDayId: f.salesDayId,
        businessDate: '2026-01-10', grossAmount: '10000.00', netDeposited: '9500.00',
        deductions: { withholdingTax: '500.00' },
        withholdingCertificateFileId: file!.id,
        settledOn: '2026-01-15',
      }),
    );

    // ⚠️ The insert was cast `as never`, so TypeScript could not see that the repo row type had
    // no such field and the value went nowhere. It read back null before this test existed.
    const [row] = await sql<{ withholding_certificate_file_id: string | null }[]>`
      select withholding_certificate_file_id from channel_settlements where id = ${r.settlementId}`;
    expect(row!.withholding_certificate_file_id).toBe(file!.id);
  });

  it('⛔ a channel belonging to ANOTHER store is refused — the receivable would land on the wrong books', async () => {
    const f = await fixture('wrongstore');
    await raiseReceivable(f, '10000.00');
    await expect(
      asOrg(f.orgId, (tx) =>
        recordChannelSettlement(tx, f.manager, {
          // The manager is scoped to both stores, so authorize() passes — this is the guard that
          // catches a mismatch authorization cannot see.
          storeId: f.otherStoreId, channelId: f.channelId, salesDayId: f.salesDayId,
          businessDate: '2026-01-10', grossAmount: '10000.00', netDeposited: '10000.00',
          settledOn: '2026-01-15',
        }),
      ),
    ).rejects.toThrow(/belongs to another store/);
  });

  describe('setChannelPayoutDestination — the setting that had no writer at all', () => {
    it('points a channel at its store’s account, and the settlement then banks there', async () => {
      const f = await fixture('setdest');
      // T-350: setChannelPayoutDestination now gates on set_channel_payout (admin and up), not
      // manage_store_settings (manager and up) — f.manager needs the grant to still be a holder.
      await sql`insert into person_grants (person_id, grant_name) values (${f.personId}, 'set_channel_payout')`;
      // A channel with nowhere to bank: exactly the state every real channel was in.
      const [channel] = await sql<{ id: string }[]>`
        insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code)
        values (${f.orgId}, ${f.storeId}, ${`GrabFood ${uid('c')}`}, false, '1220') returning id`;

      const blocked = await asOrg(f.orgId, (tx) =>
        previewChannelSettlement(tx, f.manager, {
          storeId: f.storeId, channelId: channel!.id, businessDate: '2026-01-10',
          grossAmount: '100.00', netDeposited: '100.00',
        }),
      );
      expect(blocked.blockers.join(' ')).toMatch(/no destination account set/);

      await asOrg(f.orgId, (tx) =>
        setChannelPayoutDestination(tx, f.manager, {
          channelId: channel!.id,
          moneyAccountId: f.bankId,
        }),
      );
      const [row] = await sql<{ destination_money_account_id: string }[]>`
        select destination_money_account_id from sales_channels where id = ${channel!.id}`;
      expect(row!.destination_money_account_id).toBe(f.bankId);
    });

    it('⛔ refuses another store’s account — that is a transfer, not a setting', async () => {
      const f = await fixture('crossdest');
      // T-350: same grant as above — this leg tests the cross-store refusal, not the capability
      // gate, so f.manager must hold set_channel_payout to reach that check at all.
      await sql`insert into person_grants (person_id, grant_name) values (${f.personId}, 'set_channel_payout')`;
      const [other] = await sql<{ id: string }[]>`
        insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian)
        values (${f.orgId}, ${f.otherStoreId}, 'Other store wallet', 'bank', '1140', 'office')
        returning id`;
      await expect(
        asOrg(f.orgId, (tx) =>
          setChannelPayoutDestination(tx, f.manager, {
            channelId: f.channelId,
            moneyAccountId: other!.id,
          }),
        ),
      ).rejects.toThrow(/belongs to another store/);
    });

    it('⛔ a cashier may not set it — manage_store_settings is manager and up', async () => {
      const f = await fixture('destcashier');
      const [p] = await sql<{ id: string }[]>`
        insert into persons (org_id, display_name) values (${f.orgId}, 'Cashier') returning id`;
      await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${f.orgId}, 'staff')`;
      await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${f.storeId})`;
      await expect(
        asOrg(f.orgId, (tx) =>
          setChannelPayoutDestination(tx, actor(f.orgId, p!.id), {
            channelId: f.channelId,
            moneyAccountId: f.bankId,
          }),
        ),
      ).rejects.toThrow();
    });
  });

  it('⛔ DEF-145 — a loan docked out of a payout MOVES THE LOAN’S POSITION', async () => {
    const f = await fixture('loanpos');
    await raiseReceivable(f, '20000.00');
    const [loan] = await sql<{ id: string }[]>`
      insert into loans (org_id, store_id, lender_name, name, principal_amount, interest_rate,
                         rate_period, interest_method, payment_frequency, term_periods, start_date, created_by)
      values (${f.orgId}, ${f.storeId}, 'Grab', 'Grab advance', 5000, 0,
              'month', 'straight', 'monthly', 6, '2026-01-01', ${f.personId}) returning id`;
    // Disburse it, so there is a real principal to repay.
    await asOrg(f.orgId, (tx) =>
      postEntry(tx, {
        orgId: f.orgId, entryDate: '2026-01-02', sourceType: 'loan_disbursement', sourceId: loan!.id,
        idempotencyKey: `loan_disbursement:${loan!.id}`, memo: 'Draw', postedBy: f.personId,
        lines: [
          { accountCode: '1130', storeId: f.storeId, debit: '5000.00' },
          { accountCode: '2400', storeId: f.storeId, credit: '5000.00', partyType: 'loan', partyId: loan!.id },
        ],
      }),
    );

    const before = await asOrg(f.orgId, (tx) => loansRepo.positionOf(tx, f.orgId, loan!.id));
    expect(Number(before.outstanding)).toBe(5000);

    await asOrg(f.orgId, (tx) =>
      recordChannelSettlement(tx, f.manager, {
        storeId: f.storeId, channelId: f.channelId, salesDayId: f.salesDayId,
        businessDate: '2026-01-10', grossAmount: '20000.00', netDeposited: '18000.00',
        loan: { loanId: loan!.id, amount: '2000.00' },
        settledOn: '2026-01-15',
      }),
    );

    // ⛔ This read 5,000.00 before the fix: `positionOf` filtered on
    // `source_type in ('loan_disbursement','loan_payment')`, so a repayment posted as a leg of a
    // `channel_settlement` entry was invisible — the ledger right, the loan screen wrong.
    const after = await asOrg(f.orgId, (tx) => loansRepo.positionOf(tx, f.orgId, loan!.id));
    expect(Number(after.principalPaid)).toBe(2000);
    expect(Number(after.outstanding)).toBe(3000);

    // The register's one-query version has to agree with the per-loan one.
    const register = await asOrg(f.orgId, (tx) => loansRepo.positionsByLoan(tx, f.orgId));
    expect(register.get(loan!.id)?.outstanding).toBe('3000.00');
  });

  it('⭐ and voiding that settlement puts the LOAN back too, not only the receivable', async () => {
    const f = await fixture('loanvoid');
    await raiseReceivable(f, '20000.00');
    const [loan] = await sql<{ id: string }[]>`
      insert into loans (org_id, store_id, lender_name, name, principal_amount, interest_rate,
                         rate_period, interest_method, payment_frequency, term_periods, start_date, created_by)
      values (${f.orgId}, ${f.storeId}, 'Grab', 'Grab advance', 5000, 0,
              'month', 'straight', 'monthly', 6, '2026-01-01', ${f.personId}) returning id`;
    await asOrg(f.orgId, (tx) =>
      postEntry(tx, {
        orgId: f.orgId, entryDate: '2026-01-02', sourceType: 'loan_disbursement', sourceId: loan!.id,
        idempotencyKey: `loan_disbursement:${loan!.id}`, memo: 'Draw', postedBy: f.personId,
        lines: [
          { accountCode: '1130', storeId: f.storeId, debit: '5000.00' },
          { accountCode: '2400', storeId: f.storeId, credit: '5000.00', partyType: 'loan', partyId: loan!.id },
        ],
      }),
    );
    const r = await asOrg(f.orgId, (tx) =>
      recordChannelSettlement(tx, f.manager, {
        storeId: f.storeId, channelId: f.channelId, salesDayId: f.salesDayId,
        businessDate: '2026-01-10', grossAmount: '20000.00', netDeposited: '18000.00',
        loan: { loanId: loan!.id, amount: '2000.00' },
        settledOn: '2026-01-15',
      }),
    );
    await asOrg(f.orgId, (tx) =>
      voidChannelSettlement(tx, f.manager, { settlementId: r.settlementId, reason: 'Wrong payout file.' }),
    );

    // ⭐ The reversal carries the same party on the same account, so the position unwinds with it —
    // which is only true because the position is read from the account rather than from a
    // document type (DEF-145). Checked because a void is where a half-fixed read model shows.
    const after = await asOrg(f.orgId, (tx) => loansRepo.positionOf(tx, f.orgId, loan!.id));
    expect(Number(after.outstanding)).toBe(5000);
    expect(Number(after.principalPaid)).toBe(0);
    const outstanding = await asOrg(f.orgId, (tx) =>
      channelSettlementsRepo.outstandingFor(tx, f.orgId, f.channelId),
    );
    expect(Number(outstanding)).toBe(20000);
  });

  it('the queue lists a verified channel-day and drops it once settled', async () => {
    const f = await fixture('queue');
    // A verified day with a channel breakdown — what the screen actually reads.
    await forceVerifiedSql(sql, f.salesDayId, f.personId);
    await sql`
      insert into sales_day_channels (sales_day_id, channel_id, amount, no_sales)
      values (${f.salesDayId}, ${f.channelId}, 10000, false)`;
    await raiseReceivable(f, '10000.00');

    const before = await asOrg(f.orgId, (tx) =>
      channelSettlementsRepo.listSettleableChannelDays(tx, f.orgId, {}),
    );
    expect(before.map((d) => d.channelId)).toContain(f.channelId);
    expect(before.find((d) => d.channelId === f.channelId)?.reportedAmount).toBe('10000.00');

    await asOrg(f.orgId, (tx) =>
      recordChannelSettlement(tx, f.manager, {
        storeId: f.storeId, channelId: f.channelId, salesDayId: f.salesDayId,
        businessDate: '2026-01-10', grossAmount: '10000.00', netDeposited: '10000.00',
        settledOn: '2026-01-15',
      }),
    );
    const after = await asOrg(f.orgId, (tx) =>
      channelSettlementsRepo.listSettleableChannelDays(tx, f.orgId, {}),
    );
    expect(after.map((d) => d.channelId)).not.toContain(f.channelId);
  });

  it('⛔ an UNVERIFIED day never reaches the queue — it has raised no receivable to clear', async () => {
    const f = await fixture('unverified');
    // status stays 'open' — the default.
    await sql`
      insert into sales_day_channels (sales_day_id, channel_id, amount, no_sales)
      values (${f.salesDayId}, ${f.channelId}, 10000, false)`;
    const rows = await asOrg(f.orgId, (tx) =>
      channelSettlementsRepo.listSettleableChannelDays(tx, f.orgId, {}),
    );
    expect(rows.map((d) => d.channelId)).not.toContain(f.channelId);
  });

  it('the channel list carries what 1220 says it is owed, and the history shows a void', async () => {
    const f = await fixture('lists');
    await raiseReceivable(f, '10000.00');
    const channels = await asOrg(f.orgId, (tx) =>
      channelSettlementsRepo.listSettlementChannels(tx, f.orgId, {}),
    );
    expect(channels.find((c) => c.id === f.channelId)?.outstanding).toBe('10000.00');
    expect(channels.find((c) => c.id === f.channelId)?.destinationAccountName).toBe('Payout wallet');

    const r = await asOrg(f.orgId, (tx) =>
      recordChannelSettlement(tx, f.manager, {
        storeId: f.storeId, channelId: f.channelId, salesDayId: f.salesDayId,
        businessDate: '2026-01-10', grossAmount: '10000.00', netDeposited: '9000.00',
        deductions: { commission: '600.00', marketing: '400.00' }, settledOn: '2026-01-15',
      }),
    );
    const posted = await asOrg(f.orgId, (tx) => channelSettlementsRepo.listSettlements(tx, f.orgId, {}));
    const row = posted.find((s) => s.id === r.settlementId)!;
    expect(row.feesTotal).toBe('1000.00');
    expect(row.status).toBe('posted');

    await asOrg(f.orgId, (tx) =>
      voidChannelSettlement(tx, f.manager, { settlementId: r.settlementId, reason: 'Duplicate file.' }),
    );
    const voided = await asOrg(f.orgId, (tx) => channelSettlementsRepo.listSettlements(tx, f.orgId, {}));
    // ⚠️ Still listed. A void is a reversal, not a delete — it stays visible with its reason.
    expect(voided.find((s) => s.id === r.settlementId)?.status).toBe('voided');
    expect(voided.find((s) => s.id === r.settlementId)?.voidReason).toBe('Duplicate file.');
  });
});
