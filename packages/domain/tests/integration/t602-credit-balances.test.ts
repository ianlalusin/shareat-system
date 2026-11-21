/**
 * T-602 S6-3 / S6-4 - `supplierCreditBalances` and `customerCreditBalances` (one grouped query each) give the same balance per party as the per-party
 * `supplierCreditBalance` / `customerCreditBalance` the returns pages looped over; a party with no line is absent (0).
 * MUTANT: flip the sign in the grouped query -> red. Rows are raw inserts in a transaction that is always rolled back (replica role, so no ledger fixture).
 */
import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { sql as dsql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);

import type { Tx } from '@shareat/db';
import { customerCreditBalance, customerCreditBalances, supplierCreditBalance, supplierCreditBalances } from '../../src';

const pg = postgres(url, { max: 1 });
const db = drizzle(pg);
afterAll(async () => {
  await pg.end({ timeout: 5 });
});

class Rollback extends Error {}
async function rolledBack(fn: (tx: Tx) => Promise<void>): Promise<void> {
  try {
    await db.transaction(async (dtx) => {
      const tx = dtx as unknown as Tx;
      await tx.execute(dsql`set local session_replication_role = replica`);
      await fn(tx);
      throw new Rollback('rollback');
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
}

describe('T-602 S6-3/4 - one grouped query equals the per-party loop', () => {
  it('supplier 1240 and customer 2140 balances match party by party, drafts excluded, absent = 0', async () => {
    await rolledBack(async (tx) => {
      const org = randomUUID();
      const acct = async (code: string, type: string, normal: string) => {
        const id = randomUUID();
        await tx.execute(dsql`insert into accounts (id, org_id, code, name, type, normal_balance) values (${id}, ${org}, ${code}, ${code}, ${type}, ${normal})`);
        return id;
      };
      const a1240 = await acct('1240', 'asset', 'debit');
      const a2140 = await acct('2140', 'liability', 'credit');
      const a2110 = await acct('2110', 'liability', 'credit'); // another account on the same party: must not count
      const period = randomUUID();
      const contra = await acct('9999', 'asset', 'debit');
      // Posted entries are born draft, given two balanced lines (the posting triggers insist), then posted.
      const line = async (account: string, partyType: 'supplier' | 'customer', party: string, debit: string, credit: string, status = 'posted') => {
        const entry = randomUUID();
        await tx.execute(dsql`insert into journal_entries (id, org_id, entry_date, period_id, source_type, source_id, status) values (${entry}, ${org}, '2026-02-01', ${period}, 'manual_journal', ${entry}, 'draft')`);
        await tx.execute(dsql`insert into journal_lines (entry_id, line_no, account_id, debit, credit, party_type, party_id) values (${entry}, 1, ${account}, ${debit}, ${credit}, ${partyType}, ${party})`);
        await tx.execute(dsql`insert into journal_lines (entry_id, line_no, account_id, debit, credit) values (${entry}, 2, ${contra}, ${credit}, ${debit})`);
        if (status !== 'draft') await tx.execute(dsql`update journal_entries set status = ${status}, posted_at = now() where id = ${entry}`);
      };
      const [s1, s2, s3] = [randomUUID(), randomUUID(), randomUUID()];
      await line(a1240, 'supplier', s1, '500.00', '0'); // a return: the credit we hold
      await line(a1240, 'supplier', s1, '0', '120.25'); // spent
      await line(a1240, 'supplier', s2, '75.10', '0');
      await line(a1240, 'supplier', s2, '999.00', '0', 'draft'); // a draft never counts
      await line(a2110, 'supplier', s3, '10.00', '0'); // no 1240 line at all
      const [c1, c2, c3] = [randomUUID(), randomUUID(), randomUUID()];
      await line(a2140, 'customer', c1, '0', '300.00');
      await line(a2140, 'customer', c1, '40.50', '0');
      await line(a2140, 'customer', c2, '0', '9.99');
      await line(a2140, 'customer', c2, '0', '999.00', 'draft');
      await line(a2140, 'customer', c3, '5.00', '0'); // overdrawn: negative, still reported

      const sup = await supplierCreditBalances(tx, org);
      for (const s of [s1, s2, s3]) expect(sup.get(s) ?? '0.00', `supplier ${s}`).toBe(await supplierCreditBalance(tx, org, s));
      expect(sup.get(s1)).toBe('379.75');
      expect(sup.has(s3)).toBe(false);
      const cus = await customerCreditBalances(tx, org);
      for (const c of [c1, c2, c3]) expect(cus.get(c) ?? '0.00', `customer ${c}`).toBe(await customerCreditBalance(tx, org, c));
      expect(cus.get(c1)).toBe('259.50');
      expect(cus.get(c3)).toBe('-5.00');
    });
  });
});
