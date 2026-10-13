import { config } from 'dotenv';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - name must contain "_test".`);
}

import { planPurge, applyPurge } from '../../packages/db/src/cutover/purge';

/**
 * DEF-640 - the purge records C2 once per organization, each by a person OF THAT ORG (0194's same-org FK refuses anything else).
 * A real purge truncates the whole database, so run this file against its own database (run-with-db.mjs).
 */
const sql = postgres(url, { max: 2 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const AS_OF = '2027-01-01';

async function mkOrg(): Promise<{ orgId: string; personId: string }> {
  const code = uid('def640');
  const [o] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${o!.id}, 'Performer') returning id`;
  return { orgId: o!.id, personId: p!.id };
}

/** One draft journal entry for the org: a purge-class row, so "nothing is written" is observable. */
async function seedJournal(orgId: string, personId: string): Promise<void> {
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-04-01', '2026-04-30', 'open')`;
  const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${orgId} limit 1`;
  const acct = async (code: string, type: string, normal: string): Promise<string> =>
    (await sql<{ id: string }[]>`
      insert into accounts (org_id, code, name, type, normal_balance, is_postable, is_system, status)
      values (${orgId}, ${code}, ${code}, ${type}, ${normal}, true, true, 'active') returning id`)[0]!.id;
  const cash = await acct('1110', 'asset', 'debit');
  const income = await acct('4100', 'income', 'credit');
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, idempotency_key, memo, posted_by, status)
      values (${orgId}, '2026-04-10', ${period!.id}, 'manual_journal', ${uid('src')}, ${uid('key')}, 'def640', ${personId}, 'draft')
      returning id`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, debit, credit) values (${e!.id}, 1, ${cash}, '100.00', 0)`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, debit, credit) values (${e!.id}, 2, ${income}, 0, '100.00')`;
  });
}

const journalCount = async (): Promise<number> => (await sql<{ c: number }[]>`select count(*)::int as c from journal_entries`)[0]!.c;
const c2 = (orgId: string) =>
  sql<{ completion: string; completed_by: string }[]>`
    select completion, completed_by from cutover_steps where org_id = ${orgId} and step_code = 'C2'`;

async function purge(performedBy: Record<string, string>): Promise<void> {
  await sql.begin(async (tx) => {
    const plan = await planPurge(tx, AS_OF);
    await applyPurge(tx, plan, { performedBy });
  });
}

/** Every org in the database needs a performer; give the ones this file did not create their own earliest person (or make one). */
async function withOthers(mine: Record<string, string>): Promise<Record<string, string>> {
  const map = { ...mine };
  for (const o of await sql<{ id: string }[]>`select id from organizations`) {
    if (map[o.id]) continue;
    const [any] = await sql<{ id: string }[]>`select id from persons where org_id = ${o.id} order by id limit 1`;
    if (any) map[o.id] = any.id;
    else {
      const [made] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${o.id}, 'C2 performer') returning id`;
      map[o.id] = made!.id;
    }
  }
  return map;
}

describe('DEF-640 - one same-org C2 performer per organization', () => {
  let a: { orgId: string; personId: string };
  let b: { orgId: string; personId: string };

  beforeAll(async () => {
    a = await mkOrg();
    b = await mkOrg();
    await seedJournal(a.orgId, a.personId);
  });
  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  it('a person given for the wrong org cannot become another org\'s performer (refused, nothing written)', async () => {
    const before = await journalCount();
    expect(before).toBeGreaterThan(0);
    const map = await withOthers({ [a.orgId]: a.personId, [b.orgId]: a.personId });
    await expect(purge(map)).rejects.toThrow();
    expect(await journalCount(), 'the refused purge truncated the journal').toBe(before);
    expect(await c2(a.orgId)).toHaveLength(0);
    expect(await c2(b.orgId)).toHaveLength(0);
  });

  it('an apply missing a performer for one org refuses, and nothing is written', async () => {
    const before = await journalCount();
    const map = await withOthers({ [a.orgId]: a.personId, [b.orgId]: b.personId });
    delete map[b.orgId];
    await expect(purge(map)).rejects.toThrow(new RegExp(b.orgId));
    expect(await journalCount(), 'the refused purge truncated the journal').toBe(before);
    expect(await c2(a.orgId)).toHaveLength(0);
  });

  it('a performer that does not exist refuses, and nothing is written', async () => {
    const before = await journalCount();
    const map = await withOthers({ [a.orgId]: a.personId, [b.orgId]: '00000000-0000-0000-0000-000000000000' });
    await expect(purge(map)).rejects.toThrow(/does not exist/);
    expect(await journalCount()).toBe(before);
  });

  it('with two orgs, each org\'s C2 row names that org\'s own performer', async () => {
    await purge(await withOthers({ [a.orgId]: a.personId, [b.orgId]: b.personId }));
    expect(await journalCount(), 'the purge did not run').toBe(0);
    const ra = await c2(a.orgId);
    const rb = await c2(b.orgId);
    expect(ra).toHaveLength(1);
    expect(rb).toHaveLength(1);
    expect(ra[0]).toMatchObject({ completion: 'performed', completed_by: a.personId });
    expect(rb[0]).toMatchObject({ completion: 'performed', completed_by: b.personId });
  });
});
