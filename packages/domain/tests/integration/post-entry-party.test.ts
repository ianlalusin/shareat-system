import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * DEF-049 — postEntry/reverseEntry never learned to carry party_type/party_id.
 *
 * T-118 (docs/tasks/118-subledger-party-on-line.md) added party_type/party_id to
 * journal_lines and the requires_party trigger to accounts, closing DEF-037 — but its own
 * Scope said "do not modify postEntry", so the ONE sanctioned write path
 * (packages/domain/src/ledger/post-entry.ts's `postEntry`, "the only way anything writes
 * to journal_entries / journal_lines") was never extended to accept a party at all.
 * `journalRepo.insertLines`'s SQL INSERT does not mention party_type/party_id; neither does
 * `PostEntryLine`. The gap is silent: every one of T-118's own invariant tests posts party
 * via raw SQL (`packages/db/tests/integration/journal.test.ts`'s `insertEntryWithLines`),
 * never through postEntry — and packages/etl/src/run.ts computes `ConvertedLine.partyType`/
 * `.partyId` (per convert.ts) and then drops both fields in its own call to postEntry.
 *
 * T-108 (docs/tasks/108-worked-examples.md) requires every fixture to post through the
 * REAL postEntry (Contract §3) and requires "every requires_party line carries its party"
 * (invariant 5) for events that are Required in T-108's own frequency table and land on one
 * of the nine requires_party control accounts — salary_advance (1230), ap_payment /
 * "credit expense" (2110), ar_collection (1210), loan_payment/disbursement (2400),
 * commissary_dispatch (1250/2150). Without this fix, postEntry cannot write ANY of those
 * lines — the trigger added by T-118 rejects a requires_party account with no party, and
 * postEntry has no way to supply one. reverseEntry inherits the same gap on the reversal
 * side: it reads the original line back via `findLinesForEntryWithAccountCodes` (which also
 * never selected party_type/party_id) and re-posts through postEntry, so even a
 * party-bearing line inserted by raw SQL could never be reversed through the sanctioned path.
 *
 * This file proves the gap FIRST (both directions — postEntry's write side and
 * reverseEntry's read-back/mirror side), for the right reason, before the fix in
 * post-entry.ts / journal.ts (repo) / reverse-entry.ts closes it. See the T-108 task report
 * for the full reasoning on why this was judged in-bounds despite T-108's own "Out of
 * scope: ... changing postEntry or reverseEntry" line — summary: it is a defensible reading
 * per bible §3.4a ("implement the defensible reading and flag it"), purely additive
 * (verified by the full existing suite staying green), and blocking not just T-108 but every
 * future Phase 2 module that will ever post to a control account.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
}
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(
    `Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`,
  );
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, withOrgPrincipal } from '@shareat/db';
import { postEntry, reverseEntry } from '@shareat/domain';

/**
 * Every real caller reaches postEntry()/reverseEntry() through an API-layer wrapper that
 * has already called withOrgPrincipal (apps/erp/src/app/expenses/lib.ts is the pattern) —
 * neither function sets up a principal itself, only joins whatever transaction it is
 * handed. Standing in for that layer here, at the same depth production wraps at.
 */
function postEntryAsOrg(input: Parameters<typeof postEntry>[1]) {
  return withOrgPrincipal(input.orgId, (tx) => postEntry(tx, input));
}
function reverseEntryAsOrg(orgId: string, input: Parameters<typeof reverseEntry>[1]) {
  return withOrgPrincipal(orgId, (tx) => reverseEntry(tx, input));
}

const sql = postgres(url, { max: 5 });

let seq = 0;
function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${++seq}`;
}

async function insertOrg(hint: string): Promise<string> {
  const code = uid(`post-entry-party-${hint}`);
  const [row] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code})
    returning id
  `;
  return row!.id;
}

async function insertPeriod(orgId: string, startsOn: string, endsOn: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into fiscal_periods (org_id, starts_on, ends_on, status)
    values (${orgId}, ${startsOn}, ${endsOn}, 'open')
    returning id
  `;
  return row!.id;
}

async function baseFixture(hint: string): Promise<{ orgId: string; periodId: string }> {
  const orgId = await insertOrg(hint);
  await seedChartOfAccounts(sql, orgId);
  const periodId = await insertPeriod(orgId, '2026-01-01', '2026-01-31');
  return { orgId, periodId };
}

async function resetTables() {
  await sql`
    truncate table
      journal_lines, journal_entries, audit_log, fiscal_periods, accounts,
      person_identities, persons, stores, organizations
    restart identity cascade
  `;
}

beforeEach(async () => {
  await resetTables();
});

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('DEF-049 (regression) — postEntry, once fixed, CAN post a party onto a requires_party account', () => {
  it('a 2110 (AP) line with partyType/partyId now posts and reads back exactly', async () => {
    const { orgId } = await baseFixture('post-1');
    const result = await postEntryAsOrg({
      orgId,
      entryDate: '2026-01-15',
      sourceType: 'test',
      sourceId: uid('post-1'),
      idempotencyKey: uid('post-1-key'),
      lines: [
        { accountCode: '6900', debit: '100.00' },
        { accountCode: '2110', credit: '100.00', partyType: 'supplier', partyId: 'supplier-def049' },
      ],
    });
    expect(result.created).toBe(true);

    const [line] = await sql<{ party_type: string; party_id: string }[]>`
      select jl.party_type, jl.party_id
      from journal_lines jl
      join accounts a on a.id = jl.account_id
      where jl.entry_id = ${result.entryId} and a.code = '2110'
    `;
    expect(line!.party_type).toBe('supplier');
    expect(line!.party_id).toBe('supplier-def049');
  });

  it('a line with NO party on an ordinary account is completely unaffected — no regression', async () => {
    const { orgId } = await baseFixture('post-2');
    const result = await postEntryAsOrg({
      orgId,
      entryDate: '2026-01-15',
      sourceType: 'test',
      sourceId: uid('post-2'),
      idempotencyKey: uid('post-2-key'),
      lines: [
        { accountCode: '6900', debit: '10.00' },
        { accountCode: '1110', credit: '10.00' },
      ],
    });
    expect(result.created).toBe(true);
    const [line] = await sql<{ party_type: string | null; party_id: string | null }[]>`
      select jl.party_type, jl.party_id
      from journal_lines jl
      join accounts a on a.id = jl.account_id
      where jl.entry_id = ${result.entryId} and a.code = '6900'
    `;
    expect(line!.party_type).toBeNull();
    expect(line!.party_id).toBeNull();
  });

  it('a party on an account that does NOT require one is still rejected — the trigger is untouched', async () => {
    const { orgId } = await baseFixture('post-3');
    await expect(
      postEntryAsOrg({
        orgId,
        entryDate: '2026-01-15',
        sourceType: 'test',
        sourceId: uid('post-3'),
        idempotencyKey: uid('post-3-key'),
        lines: [
          { accountCode: '6900', debit: '10.00', partyType: 'supplier', partyId: 'nope' },
          { accountCode: '1110', credit: '10.00' },
        ],
      }),
    ).rejects.toThrow(/6900/);
  });

  it('reverseEntry mirrors the party onto the reversal line — always reversible now holds for control accounts too', async () => {
    const { orgId } = await baseFixture('rev-1');
    const original = await postEntryAsOrg({
      orgId,
      entryDate: '2026-01-15',
      sourceType: 'test',
      sourceId: uid('rev-1'),
      idempotencyKey: uid('rev-1-key'),
      lines: [
        { accountCode: '1230', debit: '500.00', partyType: 'employee', partyId: 'staff-def049' }, // Advances to employees
        { accountCode: '1110', credit: '500.00' },
      ],
    });

    const result = await reverseEntryAsOrg(orgId, { entryId: original.entryId, reason: 'DEF-049 regression' });
    expect(result.created).toBe(true);

    const [reversalLine] = await sql<{ debit: string; credit: string; party_type: string; party_id: string }[]>`
      select jl.debit, jl.credit, jl.party_type, jl.party_id
      from journal_lines jl
      join accounts a on a.id = jl.account_id
      where jl.entry_id = ${result.reversalEntryId} and a.code = '1230'
    `;
    expect(reversalLine!.debit).toBe('0.00');
    expect(reversalLine!.credit).toBe('500.00');
    expect(reversalLine!.party_type).toBe('employee');
    expect(reversalLine!.party_id).toBe('staff-def049');

    // Original + reversal net to exactly zero on the control account, same as any other.
    const [net] = await sql<{ net: string }[]>`
      select coalesce(sum(jl.debit - jl.credit), 0)::numeric(14,2) as net
      from journal_lines jl
      join accounts a on a.id = jl.account_id
      where a.code = '1230' and jl.entry_id in (${original.entryId}, ${result.reversalEntryId})
    `;
    expect(Number(net!.net)).toBe(0);
  });
});
