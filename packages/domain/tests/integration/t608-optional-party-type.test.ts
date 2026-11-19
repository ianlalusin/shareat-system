import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-608 - migration 0267 `optional_party_type`: an account may OPTIONALLY carry a party of exactly one named type (7200 -> 'loan').
 * The trigger `journal_lines_check_party_requirement` reads it from the account row, not from a hard-coded code. Real Postgres, real postEntry.
 *
 * MUTANTS (each test title ends with `[kills: ...]`): the trigger drops its type comparison (a supplier party on 7200 is let through); the trigger stays as
 * 0007 left it (a loan party on 7200 is refused); the trigger loosens every account (a party on another expense account is let through); the CHECK is missing
 * (an account both requires and optionally takes a party); the seed forgets the flag (a seeded 7200 refuses its loan party).
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, withOrgPrincipal } from '@shareat/db';
import { postEntry } from '../../src/ledger/post-entry';

const sql = postgres(url, { max: 3 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

async function fixture(): Promise<string> {
  const code = uid('t608-opt');
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  await seedChartOfAccounts(sql, org!.id);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${org!.id}, '2026-01-01', '2026-01-31', 'open')`;
  return org!.id;
}

/** Posts Dr `code` (with `party`) / Cr 1130, the cash side carrying no party. */
function post(orgId: string, code: string, party?: { partyType: string; partyId: string }) {
  return withOrgPrincipal(orgId, (tx) =>
    postEntry(tx, {
      orgId, entryDate: '2026-01-15', sourceType: 'test', sourceId: uid('src'), idempotencyKey: uid('key'), memo: 't608',
      lines: [{ accountCode: code, debit: '10.00', ...(party ?? {}) }, { accountCode: '1130', credit: '10.00' }],
    }),
  );
}

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('T-608 migration 0267 - an account may take one optional party type', () => {
  it('a 7200 line with a loan party is accepted, and so is one with none [kills: the trigger left as 0007 wrote it; the seed forgets optional_party_type on 7200]', async () => {
    const orgId = await fixture();
    expect((await post(orgId, '7200', { partyType: 'loan', partyId: uid('loan') })).created).toBe(true);
    expect((await post(orgId, '7200')).created).toBe(true);
  });

  it('7200 with any OTHER party type is refused, naming the one type it takes [kills: the trigger drops the type comparison]', async () => {
    const orgId = await fixture();
    await expect(post(orgId, '7200', { partyType: 'supplier', partyId: uid('sup') })).rejects.toThrow(/accepts only a loan party/);
    await expect(post(orgId, '7200', { partyType: 'store', partyId: uid('st') })).rejects.toThrow(/accepts only a loan party/);
  });

  it('another expense account still refuses ANY party, a loan one included [kills: the trigger loosens every account]', async () => {
    const orgId = await fixture();
    await expect(post(orgId, '6900', { partyType: 'loan', partyId: uid('loan') })).rejects.toThrow(/does not accept a party/);
    await expect(post(orgId, '6900', { partyType: 'supplier', partyId: uid('sup') })).rejects.toThrow(/does not accept a party/);
  });

  it('a requires_party account is unchanged: no party refused, a party accepted [kills: requires_party branch lost]', async () => {
    const orgId = await fixture();
    const loan = uid('loan');
    await expect(post(orgId, '2400')).rejects.toThrow(/requires a party/);
    expect((await post(orgId, '2400', { partyType: 'loan', partyId: loan })).created).toBe(true);
  });

  it('only 7200 carries the flag in a seeded chart, and no account has both flags [kills: the flag set on the wrong account]', async () => {
    const orgId = await fixture();
    const rows = await sql<{ code: string; optional_party_type: string | null }[]>`select code, optional_party_type from accounts where org_id = ${orgId} and optional_party_type is not null`;
    expect(rows).toEqual([{ code: '7200', optional_party_type: 'loan' }]);
  });

  it('an account that both requires a party and optionally takes one is refused by the CHECK [kills: accounts_party_mode_check missing]', async () => {
    const orgId = await fixture();
    await expect(sql`update accounts set optional_party_type = 'loan' where org_id = ${orgId} and code = '2400'`).rejects.toMatchObject({ code: '23514' });
  });
});
