import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-351 — follow-ups from the post-commit `/code-review 0944455` review (DEF-480..483).
 * `docs/tasks/351-def-480-483-0944455-review-followups.md` §Legs A1-A5b (item 1), D1-D2
 * (items 2/3/4), S1-S3 (item 5).
 *
 * ⛔ TESTER, not BUILDER. `validateInvoiceLines` still has no `>= 0` check on the unit price at
 * all — a negative reaches the DB unparsed. `createLoan`/`confirmPrepaidTerm` take a plain
 * `number` for their whole-number fields, with no shared parser. `SettlementPreview` has no
 * `figuresComputed` field. Every A/D/S red below is one of those gaps, measured, not presumed.
 *
 * Fixtures reuse `items.test.ts`'s `fixture`/`porkBelly`/`evidence` shape (M2, orchestrator
 * amendment): to reach a raw Postgres constraint TODAY (A1), the bad line must sit beside a good
 * line whose combined total matches the invoice's own stored total — a single bad line alone trips
 * the lines-vs-invoice-total reconcile throw (`items/index.ts:277`) before Postgres ever sees it.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import {
  createItem,
  createLoan,
  createPrepaidItem,
  createSupplier,
  confirmPrepaidTerm,
  previewChannelSettlement,
  recordInvoice,
  setInvoiceLines,
} from '@shareat/domain';
import { grantEverydayPositionAccess } from './_fixtures/staff-everyday-access';
import { postEntry } from '../../src/ledger/post-entry';
import { testItemCode } from './_fixtures/item-code';

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
  const code = uid(`t351-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const storeId = store!.id;

  const [admin] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${admin!.id}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${admin!.id}, ${storeId})`;

  // `createItem` is super-admin only (`approve_item`) — items.test.ts's own `porkBelly` uses it.
  const [superAdmin] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Super') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${superAdmin!.id}, ${orgId}, 'super_admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${superAdmin!.id}, ${storeId})`;

  const [staff] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Staff') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${staff!.id}, ${orgId}, 'staff')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${staff!.id}, ${storeId})`;
  const [staffEmployment] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${orgId}, ${storeId}, ${staff!.id}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, 'regular', '2025-01-01')
    returning id`;
  await grantEverydayPositionAccess(sql, {
    orgId, storeId, employmentId: staffEmployment!.id, personId: staff!.id, setBy: admin!.id,
  });

  const supplier = await asOrg(orgId, (tx) => createSupplier(tx, actor(orgId, admin!.id), { name: `Supplier ${code}` }));

  return {
    orgId, storeId,
    admin: actor(orgId, admin!.id), adminId: admin!.id,
    superAdmin: actor(orgId, superAdmin!.id),
    staff: actor(orgId, staff!.id), staffId: staff!.id,
    supplierId: supplier.id,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function evidence(f: Fixture): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${f.orgId}, ${f.storeId}, 'receipt_photo', ${`orgs/${f.orgId}/receipt_photo/${uid('f')}.jpg`},
            'image/jpeg', 1024, ${uid('sum')}, ${f.staffId})
    returning id`;
  return row!.id;
}

async function porkBelly(f: Fixture): Promise<{ id: string; name: string }> {
  const name = `Pork belly ${uid('n')}`;
  const { id } = await asOrg(f.orgId, (tx) =>
    createItem(tx, f.superAdmin, { code: testItemCode(), name, kind: 'raw_material', baseUnit: 'kg' }),
  );
  return { id, name };
}

/** A PENDING invoice carrying `lines`, left unverified so `setInvoiceLines` can still edit it. */
async function pendingInvoice(f: Fixture, total: string, lines: Parameters<typeof recordInvoice>[2]['lines']) {
  const fileId = await evidence(f);
  const created = await asOrg(f.orgId, (tx) =>
    recordInvoice(tx, f.staff, {
      storeId: f.storeId, supplierId: f.supplierId, invoiceDate: '2026-01-10',
      totalAmount: total, receiptFileId: fileId, lines,
    }),
  );
  return created.id;
}

async function invoiceLines(invoiceId: string) {
  return sql<{ item_id: string; unit_price: string; line_total: string; quantity: string }[]>`
    select item_id, unit_price::text, line_total::text, quantity::text
    from supplier_invoice_lines where supplier_invoice_id = ${invoiceId} order by line_no`;
}

async function caught(p: Promise<unknown>): Promise<(Error & { userMessage?: string; code?: string }) | undefined> {
  try {
    await p;
  } catch (err) {
    return err as Error & { userMessage?: string; code?: string };
  }
  return undefined;
}

afterAll(async () => {
  await sql.end();
  await closeDb();
});

describe('A1 — a negative unit price, beside a good line whose sum still matches the invoice total', () => {
  it(
    'rejects with the written sentence; the prior good line is untouched — was red today: a raw Postgres 23514, no userMessage',
    async () => {
      const f = await fixture('a1');
      const item = await porkBelly(f);
      const invoiceId = await pendingInvoice(f, '100.00', [
        { itemId: item.id, quantity: '1', purchaseUnit: 'kg', conversionFactor: '1', unitPrice: '100', lineTotal: '100.00' },
      ]);

      const err = await caught(
        asOrg(f.orgId, (tx) =>
          setInvoiceLines(tx, f.staff, invoiceId, [
            { itemId: item.id, quantity: '10', purchaseUnit: 'kg', conversionFactor: '1', unitPrice: '-5', lineTotal: '-50.00' },
            { itemId: item.id, quantity: '15', purchaseUnit: 'kg', conversionFactor: '1', unitPrice: '10', lineTotal: '150.00' },
          ]),
        ),
      );
      expect(err, 'expected a refusal at all').toBeInstanceOf(Error);
      expect(
        err?.userMessage ?? '(no userMessage)',
        'wanted the written sentence — was red: no userMessage (a raw Postgres constraint error)',
      ).toMatch(/^Line 1 \(.*\)'s unit price — "-5" is not a valid amount\. Use a non-negative number with up to four decimal places\.$/);

      const rows = await invoiceLines(invoiceId);
      expect(rows, 'the prior good line must still be there, unchanged (rolled back atomically)').toHaveLength(1);
      expect(rows[0]!.unit_price).toBe('100.0000');
      expect(rows[0]!.line_total).toBe('100.00');
    },
  );
});

describe('A2 — a fifth decimal place is refused, not rounded', () => {
  it(
    'rejects with the four-decimals sentence; nothing written — was red today: saves 12.3457',
    async () => {
      const f = await fixture('a2');
      const item = await porkBelly(f);
      const invoiceId = await pendingInvoice(f, '1.00', []);

      const err = await caught(
        asOrg(f.orgId, (tx) =>
          setInvoiceLines(tx, f.staff, invoiceId, [
            { itemId: item.id, quantity: '1', purchaseUnit: 'kg', conversionFactor: '1', unitPrice: '12.34565', lineTotal: '12.35' },
          ]),
        ),
      );
      expect(err, 'expected a refusal at all').toBeInstanceOf(Error);
      expect(err?.userMessage ?? '(no userMessage)', 'wanted the four-decimals sentence — was red: no refusal, it saved').toMatch(
        /^Line 1 \(.*\)'s unit price — "12\.34565" is not a valid amount\. Use a non-negative number with up to four decimal places\.$/,
      );
      const rows = await invoiceLines(invoiceId);
      expect(rows, 'nothing should have been written').toHaveLength(0);
    },
  );
});

describe('A3 — the same fifth-decimal refusal at a larger quantity (today: a DB arithmetic mismatch)', () => {
  it(
    'rejects at the parser, before the arithmetic check ever runs — was red today: a raw 23514 (stored 12.3457 × 1000 = 12345.70 ≠ 12345.65)',
    async () => {
      const f = await fixture('a3');
      const item = await porkBelly(f);
      const invoiceId = await pendingInvoice(f, '1.00', []);

      const err = await caught(
        asOrg(f.orgId, (tx) =>
          setInvoiceLines(tx, f.staff, invoiceId, [
            { itemId: item.id, quantity: '1000', purchaseUnit: 'kg', conversionFactor: '1', unitPrice: '12.34565', lineTotal: '12345.65' },
          ]),
        ),
      );
      expect(err, 'expected a refusal at all').toBeInstanceOf(Error);
      expect(err?.userMessage ?? '(no userMessage)', 'wanted the four-decimals sentence — was red: a raw 23514, no userMessage').toMatch(
        /^Line 1 \(.*\)'s unit price — "12\.34565" is not a valid amount\. Use a non-negative number with up to four decimal places\.$/,
      );
      const rows = await invoiceLines(invoiceId);
      expect(rows, 'nothing should have been written').toHaveLength(0);
    },
  );
});

describe('A4 — an 11-digit unit price is refused by name, not a raw numeric overflow', () => {
  it(
    'wanted: "…is too large. Use a number below 10000000000." — was red today: a raw 22003 numeric overflow',
    async () => {
      const f = await fixture('a4');
      const item = await porkBelly(f);
      const invoiceId = await pendingInvoice(f, '1.00', []);

      const err = await caught(
        asOrg(f.orgId, (tx) =>
          setInvoiceLines(tx, f.staff, invoiceId, [
            {
              itemId: item.id, quantity: '1', purchaseUnit: 'kg', conversionFactor: '1',
              unitPrice: '12345678901', lineTotal: '12345678901.00',
            },
          ]),
        ),
      );
      expect(err, 'expected a refusal at all').toBeInstanceOf(Error);
      expect(err?.userMessage ?? '(no userMessage)', 'was red: a raw 22003, no userMessage').toMatch(
        /^Line 1 \(.*\)'s unit price — "12345678901" is too large\. Use a number below 10000000000\.$/,
      );
      const rows = await invoiceLines(invoiceId);
      expect(rows, 'nothing should have been written').toHaveLength(0);
    },
  );
});

describe('A5 (guard, except the trim) — accepted shapes save as expected', () => {
  it('".5", "005" and " 8. " each save at the parsed/trimmed value', async () => {
    const f = await fixture('a5');
    const item1 = await porkBelly(f);
    const invoiceId1 = await pendingInvoice(f, '5.00', []);
    await asOrg(f.orgId, (tx) =>
      setInvoiceLines(tx, f.staff, invoiceId1, [
        { itemId: item1.id, quantity: '10', purchaseUnit: 'kg', conversionFactor: '1', unitPrice: '.5', lineTotal: '5.00' },
      ]),
    );
    expect((await invoiceLines(invoiceId1))[0]!.unit_price).toBe('0.5000');

    const item2 = await porkBelly(f);
    const invoiceId2 = await pendingInvoice(f, '5.00', []);
    await asOrg(f.orgId, (tx) =>
      setInvoiceLines(tx, f.staff, invoiceId2, [
        { itemId: item2.id, quantity: '1', purchaseUnit: 'kg', conversionFactor: '1', unitPrice: '005', lineTotal: '5.00' },
      ]),
    );
    expect((await invoiceLines(invoiceId2))[0]!.unit_price).toBe('5.0000');

    const item3 = await porkBelly(f);
    const invoiceId3 = await pendingInvoice(f, '8.00', []);
    await asOrg(f.orgId, (tx) =>
      setInvoiceLines(tx, f.staff, invoiceId3, [
        { itemId: item3.id, quantity: '1', purchaseUnit: 'kg', conversionFactor: '1', unitPrice: ' 8. ', lineTotal: '8.00' },
      ]),
    );
    // ⭐ The trimmed store (no stray whitespace reaching the column) is only observable for this
    // one, per the leg table — the other two have no whitespace to trim in the first place.
    expect((await invoiceLines(invoiceId3))[0]!.unit_price).toBe('8.0000');
  });
});

describe('A5b — a non-numeric price still names the LINE, before the parser ever runs', () => {
  it(
    'the raw .message keeps I1\'s pinned shape; userMessage is the finiteness sentence, not the parser\'s — was red today: no userMessage',
    async () => {
      const f = await fixture('a5b');
      const item = await porkBelly(f);
      const invoiceId = await pendingInvoice(f, '1.00', []);

      const err = await caught(
        asOrg(f.orgId, (tx) =>
          setInvoiceLines(tx, f.staff, invoiceId, [
            { itemId: item.id, quantity: '10', purchaseUnit: 'kg', conversionFactor: '1', unitPrice: 'abc', lineTotal: (10 * Number('abc')).toFixed(2) },
          ]),
        ),
      );
      expect(err?.message, "must keep items.test.ts's own pinned regex shape").toMatch(
        /line 1 \(Pork belly .*\) — the unit price "abc" is not a number/,
      );
      expect(err?.userMessage, 'wanted the finiteness userMessage — was red: none at all').toBe(
        `Line 1 (${item.name})'s unit price — "abc" is not a number.`,
      );
    },
  );
});

describe('D1 — confirmPrepaidTerm direct, coverageMonths as a NUMBER with a fraction', () => {
  it(
    'rejects with the written sentence — was red today: a raw Error, no userMessage',
    async () => {
      const f = await fixture('d1');
      const created = await asOrg(f.orgId, (tx) =>
        createPrepaidItem(tx, f.admin, {
          storeId: f.storeId, name: `Fire insurance ${uid('p')}`, category: 'insurance',
          coverageStartDate: '2026-01-01', coverageMonths: 12, totalCost: '6000.00',
        }),
      );
      const err = await caught(
        asOrg(f.orgId, (tx) =>
          confirmPrepaidTerm(tx, f.admin, {
            prepaidItemId: created.id, coverageMonths: 1.5 as unknown as number, coverageStartDate: '2026-01-01',
          }),
        ),
      );
      expect(err, 'expected a refusal at all').toBeInstanceOf(Error);
      expect(err?.userMessage, 'was red: a raw Error, no userMessage').toBe(
        'The coverage in months must be a whole number from 1 to 120.',
      );
    },
  );
});

describe('D2 (guard) — createLoan direct, termPeriods as a plain number', () => {
  it('saves 12', async () => {
    const f = await fixture('d2');
    const created = await asOrg(f.orgId, (tx) =>
      createLoan(tx, f.admin, {
        storeId: f.storeId, lenderName: 'Grab', name: `Advance ${uid('l')}`,
        principalAmount: '5000.00', interestRate: '0', ratePeriod: 'month',
        interestMethod: 'straight', paymentFrequency: 'monthly',
        termPeriods: 12 as unknown as number, startDate: '2026-01-01',
      }),
    );
    const [row] = await sql<{ term_periods: number }[]>`select term_periods from loans where id = ${created.id}`;
    expect(row!.term_periods).toBe(12);
  });
});

async function channelSettlementsFixture(hint: string) {
  const f = await fixture(hint);
  // T-351 (orchestrator fix): an OPEN fiscal period covering '2026-01-10' — postEntry (below)
  // refuses an entry with no period covering its date.
  await sql`
    insert into fiscal_periods (org_id, starts_on, ends_on, status)
    values (${f.orgId}, '2026-01-01', '2026-01-31', 'open')`;
  const [bank] = await sql<{ id: string }[]>`
    insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian)
    values (${f.orgId}, ${f.storeId}, 'Payout wallet', 'bank', '1140', 'office') returning id`;
  const [wiredChannel] = await sql<{ id: string }[]>`
    insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code,
                                destination_money_account_id)
    values (${f.orgId}, ${f.storeId}, ${`Foodpanda ${uid('c')}`}, false, '1220', ${bank!.id})
    returning id`;
  const [unwiredChannel] = await sql<{ id: string }[]>`
    insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code)
    values (${f.orgId}, ${f.storeId}, ${`GrabFood ${uid('c')}`}, false, '1220')
    returning id`;
  return { ...f, wiredChannelId: wiredChannel!.id, unwiredChannelId: unwiredChannel!.id, bankId: bank!.id };
}

/** Raises the receivable a verified channel-day would have raised — T-350's own `raiseReceivable`
 *  shape, via the real `postEntry`, never a raw ledger insert. */
async function raiseReceivable(f: Awaited<ReturnType<typeof channelSettlementsFixture>>, channelId: string, amount: string, date = '2026-01-10') {
  await asOrg(f.orgId, (tx) =>
    postEntry(tx, {
      orgId: f.orgId,
      entryDate: date,
      sourceType: 'sales_day',
      sourceId: uid('sd'),
      idempotencyKey: `t351-s3:${channelId}:${amount}:${date}`,
      memo: 'T-351 S3 fixture — channel day',
      postedBy: f.adminId,
      lines: [
        { accountCode: '1220', storeId: f.storeId, debit: amount, partyType: 'channel', partyId: channelId },
        { accountCode: '4150', storeId: f.storeId, credit: amount },
      ],
    }),
  );
}

describe('S1 — a malformed gross figure: figuresComputed is false, blockers name it', () => {
  it('figuresComputed === false, blockers contains the gross sentence — was red today: figuresComputed undefined', async () => {
    const f = await channelSettlementsFixture('s1');
    const preview = await asOrg(f.orgId, (tx) =>
      previewChannelSettlement(tx, f.admin, {
        storeId: f.storeId, channelId: f.wiredChannelId, businessDate: '2026-01-10',
        grossAmount: '1,5', netDeposited: '100.00',
      }),
    );
    expect((preview as { figuresComputed?: boolean }).figuresComputed, 'was red: undefined').toBe(false);
    expect(preview.blockers.some((b) => b.includes('The gross settled'))).toBe(true);
  });
});

describe('S2 — valid figures, but a config blocker (no payout account): figuresComputed is still true', () => {
  it('figuresComputed === true; blockers.length > 0 — was red today: undefined', async () => {
    const f = await channelSettlementsFixture('s2');
    const preview = await asOrg(f.orgId, (tx) =>
      previewChannelSettlement(tx, f.admin, {
        storeId: f.storeId, channelId: f.unwiredChannelId, businessDate: '2026-01-10',
        grossAmount: '100.00', netDeposited: '100.00',
      }),
    );
    expect((preview as { figuresComputed?: boolean }).figuresComputed, 'was red: undefined').toBe(true);
    expect(preview.blockers.length, 'no destination account is a real config blocker').toBeGreaterThan(0);
  });
});

describe('S3 — valid figures, no blockers: figuresComputed is true', () => {
  it('figuresComputed === true, blockers empty — was red today: undefined', async () => {
    const f = await channelSettlementsFixture('s3');
    // The channel must actually be owed something, or the gross/net a real payout statement
    // would name reads as a settlement GAIN with no receivable behind it — a real config/figure
    // blocker, not the code path this leg exists to test.
    await raiseReceivable(f, f.wiredChannelId, '100.00');
    const preview = await asOrg(f.orgId, (tx) =>
      previewChannelSettlement(tx, f.admin, {
        storeId: f.storeId, channelId: f.wiredChannelId, businessDate: '2026-01-10',
        grossAmount: '100.00', netDeposited: '100.00',
      }),
    );
    expect((preview as { figuresComputed?: boolean }).figuresComputed, 'was red: undefined').toBe(true);
    expect(preview.blockers).toEqual([]);
  });
});
