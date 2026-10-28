import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-492 S1 / DEF-785 (audit F17). The two transaction-local exemption flags -- `app.reversal_posting`
 * (migration 0005) and `app.period_override` (migration 0143) -- are set by `reverseEntry` /
 * `postEntry` for ONE entry (bible row 193) and must be switched off straight after it, so a LATER
 * ordinary write in the SAME transaction is judged by the database triggers exactly as if neither
 * had ever run. Real Postgres; the triggers stay the enforcer.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - name must contain "_test".`);
}

import { money } from '@shareat/core/money';
import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, journalRepo, withOrgPrincipal, type Tx } from '@shareat/db';
import { postEntry, reverseEntry } from '@shareat/domain';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

async function fixture(hint: string, janStatus: 'open' | 'closed' = 'open') {
  const code = uid(`t492-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [period] = await sql<{ id: string }[]>`
    insert into fiscal_periods (org_id, starts_on, ends_on, status)
    values (${orgId}, '2026-01-01', '2026-01-31', ${janStatus}) returning id`;
  return { orgId, periodId: period!.id };
}

const postAsOrg = (orgId: string, input: Parameters<typeof postEntry>[1]) => withOrgPrincipal(orgId, (tx) => postEntry(tx, input));

const flag = async (tx: Tx, name: string) => {
  const rows = (await tx.execute(dsql`select current_setting(${name}, true) as v`)) as unknown as { v: string | null }[];
  return rows[0]?.v ?? null;
};

describe('F17 - app.reversal_posting is switched off after reverseEntry', () => {
  it('a later ordinary postEntry to an archived account, in the SAME transaction, is refused by the trigger', async () => {
    const { orgId } = await fixture('rev');
    const original = await postAsOrg(orgId, {
      orgId,
      entryDate: '2026-01-15',
      sourceType: 'test',
      sourceId: uid('orig'),
      idempotencyKey: uid('orig-key'),
      lines: [
        { accountCode: '6900', debit: '11.00' },
        { accountCode: '1110', credit: '11.00' },
      ],
    });
    await sql`update accounts set status = 'archived', updated_at = now() where org_id = ${orgId} and code = '6900'`;

    let flagAfterReverse: string | null = 'unset';
    const run = withOrgPrincipal(orgId, async (tx) => {
      const r = await reverseEntry(tx, { entryId: original.entryId, reason: 'archived since' });
      expect(r.created, 'control: the reversal itself posts onto the archived account').toBe(true);
      flagAfterReverse = await flag(tx, 'app.reversal_posting');
      return postEntry(tx, {
        orgId,
        entryDate: '2026-01-16',
        sourceType: 'test',
        sourceId: uid('later'),
        idempotencyKey: uid('later-key'),
        lines: [
          { accountCode: '6900', debit: '5.00' },
          { accountCode: '1110', credit: '5.00' },
        ],
      });
    });
    await expect(run).rejects.toThrow(/cannot be posted to|status/i);
    expect(flagAfterReverse).not.toBe('on');
  });

  it('control: the flag is still on DURING the reversal (reverse-entry.test.ts proves the archived-account reversal posts)', async () => {
    const { orgId } = await fixture('rev-ctl');
    const original = await postAsOrg(orgId, {
      orgId,
      entryDate: '2026-01-15',
      sourceType: 'test',
      sourceId: uid('orig2'),
      idempotencyKey: uid('orig2-key'),
      lines: [
        { accountCode: '6900', debit: '12.00' },
        { accountCode: '1110', credit: '12.00' },
      ],
    });
    await sql`update accounts set status = 'archived', updated_at = now() where org_id = ${orgId} and code = '1110'`;
    const r = await withOrgPrincipal(orgId, (tx) => reverseEntry(tx, { entryId: original.entryId, reason: 'archived since' }));
    expect(r.created).toBe(true);
  });
});

describe('F17 - app.period_override is switched off after an override posting', () => {
  it('a later ordinary write into the closed month, in the SAME transaction, is refused by the trigger', async () => {
    const { orgId, periodId } = await fixture('ovr', 'closed');
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, 'admin')`;

    let flagAfterOverride: string | null = 'unset';
    const run = withOrgPrincipal(orgId, async (tx) => {
      const r = await postEntry(tx, {
        orgId,
        entryDate: '2026-01-15',
        sourceType: 'test',
        sourceId: uid('ovr'),
        idempotencyKey: uid('ovr-key'),
        lines: [
          { accountCode: '6900', debit: '10.00' },
          { accountCode: '1110', credit: '10.00' },
        ],
        periodOverride: { actor: { personId: p!.id, orgId }, reason: 'late_supplier_invoice' },
      });
      expect(r.created, 'control: the override posting itself lands in the closed month').toBe(true);
      flagAfterOverride = await flag(tx, 'app.period_override');
      // An ordinary write into the same closed month, bypassing postEntry's own TS check: only the trigger can refuse it.
      const { id } = await journalRepo.insertDraftEntry(tx, {
        orgId,
        entryDate: '2026-01-16',
        periodId,
        memo: null,
        sourceType: 'test',
        sourceId: uid('ovr-later'),
        idempotencyKey: uid('ovr-later-key'),
      });
      const [dr, cr] = await Promise.all([
        journalRepo.resolveAccountId(tx, orgId, '6900'),
        journalRepo.resolveAccountId(tx, orgId, '1110'),
      ]);
      const blank = { storeId: null, channelId: null, partyType: null, partyId: null, lineMemo: null };
      await journalRepo.insertLines(tx, id, [
        { lineNo: 1, accountId: dr, debit: money('3.00'), credit: money('0'), ...blank },
        { lineNo: 2, accountId: cr, debit: money('0'), credit: money('3.00'), ...blank },
      ]);
      await journalRepo.postDraftEntry(tx, id, null);
      return id;
    });
    await expect(run).rejects.toThrow(/cannot post journal entry into period|status = closed/i);
    expect(flagAfterOverride).not.toBe('on');
  });
});
