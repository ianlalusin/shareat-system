/**
 * T-398 S7f (TESTER) - O9: the 1 Jan purge with two companies (Ian's and an onboarded Padre Garcia), one same-org performer per company.
 * docs/tasks/398-s7/S7-REFRESH.md s8 (runbook), s11 (O9), s15 (Q-S7-1 = c: no keep-org mode).
 * Real Postgres via TEST_DATABASE_URL. ⚠️ A real purge truncates every purge-class table of the WHOLE database; this file follows DEF-640's precedent
 * (def640-purge-per-org-performer.test.ts: real planPurge/applyPurge on the test database, org created BEFORE the purge) and needs the PG18 dump tools.
 *
 * STATUS: RED until `onboardFranchiseOrganization` creates PG (S7b/S7c); the purge itself already handles two orgs (DEF-640), so once PG exists the
 * refusal legs and the C2 leg are GREEN-AS-GUARD for the purge and RED only through the onboarding.
 *
 * SCOPE, said plainly: "an opening per org and 3900 = 0 in each" needs the whole T-390 opening machinery (counts, cash, owed-to-commissary) on a
 * company that onboarding creates empty. This file proves what O9's mutant needs: BOTH companies are purged and get their own C2 row, the refusal
 * fires for either missing --by, the onboarding configuration is KEPT (classification keep), and the per-org 3900 net over opening_balance entries is
 * 0 for each company afterwards (queried per org, so a loop over the first org only would leave the other's rows). The opening posting itself stays
 * with the S7f builder's rehearsal recipe (S7-REFRESH s10).
 *
 * MUTANTS: purge loop over the first org only (the other keeps its journal); apply accepting a missing --by for one org; a performer from the wrong org
 * accepted; the purge deleting franchise_agreements / PG's items / Ian's customer + price list.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import { APP_ROLE, closeDb, cutoverRepo, systemTransaction, transaction, type Tx } from '@shareat/db';
import { sql as dsql } from 'drizzle-orm';
import { addOpeningFigure, postOpeningBalances } from '../../packages/domain/src/cutover';
import { createFirstAdmin, createOrganization } from '../../packages/domain/src/organizations';
import { parseOnboardingFile } from '../../packages/domain/src/organizations/onboarding-file';
import { applyPurge, planPurge } from '../../packages/db/src/cutover/purge';
import { PURGE_AS_OF } from './t390-real-purge';

const url = process.env.TEST_DATABASE_URL!;
const sql = postgres(url, { max: 4 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const MOCK = JSON.parse(readFileSync(join(repoRoot, 'scripts', 'fixtures', 'onboarding', 'MOCK-padre-garcia.onboarding.json'), 'utf8'));
let seq = 0;
const tag = () => `${Date.now().toString(36)}${++seq}`.toUpperCase();

async function twoCompanies() {
  const t = tag();
  const code = `S7FL${t}`;
  const l = await systemTransaction(async (tx) => {
    const org = await createOrganization(tx, { code, name: `Mock Franchisor Co ${t}` });
    const admin = await createFirstAdmin(tx, { orgId: org.orgId, displayName: `Mock Ian ${t}` });
    return { orgId: org.orgId, adminId: admin.personId };
  });
  const file = parseOnboardingFile({
    ...MOCK,
    franchisorOrgCode: code,
    org: { code: `MOCKPG${t}`, name: `Mock Padre Garcia Foods ${t}` },
    store: { ...MOCK.store, code: `MPG${t}`, name: `Mock SharEat Padre Garcia ${t}`, posStoreId: `MOCK-POS-${t}` },
    franchisorPerson: { ...MOCK.franchisorPerson, email: `franchisor.${t.toLowerCase()}@example.test` },
    owner: { ...MOCK.owner, email: `owner.${t.toLowerCase()}@example.test` },
    commissary: { ...MOCK.commissary, customerName: `Mock PG ${t}`, supplierName: `Mock Commissary ${t}`, priceListName: `Mock prices ${t}` },
  });
  const mod = (await import('../../packages/domain/src/organizations')) as unknown as {
    onboardFranchiseOrganization: (i: { file: unknown; byPersonId: string }, o: { dryRun: boolean }) => Promise<unknown>;
  };
  await mod.onboardFranchiseOrganization({ file, byPersonId: l.adminId }, { dryRun: false });
  const pgOrg = (await sql<{ id: string }[]>`select id from organizations where code = ${file.org.code}`)[0];
  expect(pgOrg, 'onboarding did not create PG').toBeDefined();
  const [pgAdmin] = await sql<{ id: string }[]>`
    select p.id from persons p join person_roles r on r.person_id = p.id and r.org_id = ${pgOrg!.id} and r.role = 'admin' where p.org_id = ${pgOrg!.id}`;
  return { l, pgOrgId: pgOrg!.id, pgAdminId: pgAdmin!.id, file };
}

/** A draft journal entry in the org: a purge-class row, so "this org was purged" is observable per org. */
async function seedJournal(orgId: string, personId: string): Promise<void> {
  const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${orgId} order by starts_on limit 1`;
  const accts = await sql<{ id: string }[]>`select id from accounts where org_id = ${orgId} and is_postable order by code limit 2`;
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, idempotency_key, memo, posted_by, status)
      values (${orgId}, '2026-11-20', ${period!.id}, 'manual_journal', ${`s-${tag()}`}, ${`k-${tag()}`}, 's7f', ${personId}, 'draft') returning id`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, debit, credit) values (${e!.id}, 1, ${accts[0]!.id}, '100.00', 0)`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, debit, credit) values (${e!.id}, 2, ${accts[1]!.id}, 0, '100.00')`;
  });
}

const journals = async (orgId: string): Promise<number> => (await sql<{ n: number }[]>`select count(*)::int n from journal_entries where org_id = ${orgId}`)[0]!.n;
const c2 = (orgId: string) => sql<{ completion: string; completed_by: string }[]>`select completion, completed_by from cutover_steps where org_id = ${orgId} and step_code = 'C2'`;
const net3900 = async (orgId: string): Promise<number> =>
  Number(
    (
      await sql<{ net: string | null }[]>`
        select sum((jl.credit - jl.debit) * 100)::text as net from journal_lines jl join journal_entries je on je.id = jl.entry_id join accounts a on a.id = jl.account_id
        where je.org_id = ${orgId} and je.source_type = 'opening_balance' and a.code = '3900'`
    )[0]!.net ?? '0',
  );

async function purge(performedBy: Record<string, string>): Promise<void> {
  const { auditDumpFor } = await import('./t402-s3-audit-dump');
  const auditDump = await auditDumpFor(process.env.TEST_DATABASE_URL!, PURGE_AS_OF);
  await sql.begin(async (tx) => {
    const plan = await planPurge(tx, PURGE_AS_OF);
    await applyPurge(tx, plan, { performedBy, auditDump });
  });
}
/** Every OTHER organisation already in this shared test database needs a performer too (DEF-640). */
async function withOthers(mine: Record<string, string>): Promise<Record<string, string>> {
  const map = { ...mine };
  for (const o of await sql<{ id: string }[]>`select id from organizations`) {
    if (map[o.id]) continue;
    const [any] = await sql<{ id: string }[]>`select id from persons where org_id = ${o.id} order by id limit 1`;
    map[o.id] = any ? any.id : (await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${o.id}, 'C2 performer') returning id`)[0]!.id;
  }
  return map;
}

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

describe('O9 - purge with Ian\'s company and an onboarded PG', () => {
  it('apply refuses when EITHER company has no --by (naming that company), and truncates nothing - Mutant: a missing performer accepted for one org', async () => {
    const w = await twoCompanies();
    await seedJournal(w.l.orgId, w.l.adminId);
    await seedJournal(w.pgOrgId, w.pgAdminId);
    const full = await withOthers({ [w.l.orgId]: w.l.adminId, [w.pgOrgId]: w.pgAdminId });

    const noPg = { ...full };
    delete noPg[w.pgOrgId];
    await expect(purge(noPg)).rejects.toThrow(new RegExp(w.pgOrgId));
    const noIan = { ...full };
    delete noIan[w.l.orgId];
    await expect(purge(noIan)).rejects.toThrow(new RegExp(w.l.orgId));

    expect(await journals(w.l.orgId), 'a refused purge touched Ian\'s journal').toBe(1);
    expect(await journals(w.pgOrgId), 'a refused purge touched PG\'s journal').toBe(1);
    expect(await c2(w.l.orgId)).toHaveLength(0);
    expect(await c2(w.pgOrgId)).toHaveLength(0);
  });

  it('a performer from the other company is refused for this one - Mutant: person-to-org check dropped', async () => {
    const w = await twoCompanies();
    const swapped = await withOthers({ [w.l.orgId]: w.pgAdminId, [w.pgOrgId]: w.l.adminId });
    await expect(purge(swapped)).rejects.toThrow(/belongs to organization/);
  });

  it('with one performer per company: BOTH journals are purged, each company has its own C2 row, the onboarding configuration is kept, 3900 = 0 in each - Mutant: loop over the first org only / purge deleting franchise config', async () => {
    const w = await twoCompanies();
    await seedJournal(w.l.orgId, w.l.adminId);
    await seedJournal(w.pgOrgId, w.pgAdminId);
    await purge(await withOthers({ [w.l.orgId]: w.l.adminId, [w.pgOrgId]: w.pgAdminId }));

    expect(await journals(w.l.orgId)).toBe(0);
    expect(await journals(w.pgOrgId)).toBe(0);
    const [ra] = await c2(w.l.orgId);
    const [rb] = await c2(w.pgOrgId);
    expect(ra).toMatchObject({ completion: 'performed', completed_by: w.l.adminId });
    expect(rb).toMatchObject({ completion: 'performed', completed_by: w.pgAdminId });

    // classification 'keep': the agreement, PG's company and store, Ian's customer + price list, PG's items and their declarations survive the 1 Jan clean-up
    expect(await sql`select 1 from organizations where id = ${w.pgOrgId}`).toHaveLength(1);
    expect(await sql`select 1 from franchise_agreements where org_id = ${w.pgOrgId}`).toHaveLength(1);
    expect(await sql`select 1 from stores where org_id = ${w.pgOrgId}`).toHaveLength(1);
    expect(await sql`select 1 from customers where org_id = ${w.l.orgId} and name = ${w.file.commissary.customerName}`).toHaveLength(1);
    expect(await sql`select 1 from price_lists where org_id = ${w.l.orgId} and name = ${w.file.commissary.priceListName}`).toHaveLength(1);

    expect(await net3900(w.l.orgId)).toBe(0);
    expect(await net3900(w.pgOrgId)).toBe(0);
  });

  it('openings per company: "3900 = 0" is the per-company residual (cutoverRepo.openingEquityResidual); a NET-ZERO sum across the two companies must not pass - Mutant: a verify that sums 3900 across orgs', async () => {
    const w = await twoCompanies();
    const [lStore] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${w.l.orgId}, ${`LS${tag()}`}, 'Mock Franchisor Kitchen') returning id`;
    const [pgStore] = await sql<{ id: string }[]>`select id from stores where org_id = ${w.pgOrgId}`;
    await seedJournal(w.l.orgId, w.l.adminId);
    await seedJournal(w.pgOrgId, w.pgAdminId);
    await purge(await withOthers({ [w.l.orgId]: w.l.adminId, [w.pgOrgId]: w.pgAdminId }));

    const ianActor = { orgId: w.l.orgId, personId: w.l.adminId };
    const pgActor = { orgId: w.pgOrgId, personId: w.pgAdminId };
    const D = '2027-01-01';
    const figure = (org: string, actor: typeof ianActor, storeId: string, accountCode: string, direction: 'debit' | 'credit') =>
      asOrg(org, (tx) => addOpeningFigure(tx, actor, { accountCode, storeId, direction, amount: '100.00', entryDate: D } as never));
    const residual = (org: string) => asOrg(org, (tx) => cutoverRepo.openingEquityResidual(tx, org));

    // Stage 1: Ian's company opens cash 100 with nothing against it (3900 carries +100); PG opens 100 the other way round (3900 carries -100).
    await figure(w.l.orgId, ianActor, lStore!.id, '1110', 'debit');
    await figure(w.pgOrgId, pgActor, pgStore!.id, '3300', 'credit');
    expect(await residual(w.l.orgId)).toBe('100.00');
    expect(await residual(w.pgOrgId)).toBe('-100.00');
    const [both] = await sql<{ net: string }[]>`
      select coalesce(sum(jl.credit - jl.debit), 0)::text net from journal_lines jl join journal_entries je on je.id = jl.entry_id join accounts a on a.id = jl.account_id
      where je.org_id in (${w.l.orgId}, ${w.pgOrgId}) and a.code = '3900'`;
    expect(Number(both!.net), 'the trap: summed across both companies 3900 is zero').toBe(0);
    for (const [org, actor] of [[w.l.orgId, ianActor], [w.pgOrgId, pgActor]] as const) {
      const err = await asOrg(org, (tx) => postOpeningBalances(tx, actor)).then(() => null, (e: Error & { userMessage?: string }) => e);
      expect(err, `${org}: the books must not open while this company's 3900 is not zero`).toBeInstanceOf(Error);
      expect(String(err!.userMessage ?? err!.message)).toMatch(/Opening balance equity still carries/);
    }

    // Stage 2: each company completes its own figure; each residual is 0 on its own.
    await figure(w.l.orgId, ianActor, lStore!.id, '3300', 'credit');
    await figure(w.pgOrgId, pgActor, pgStore!.id, '1110', 'debit');
    expect(await residual(w.l.orgId)).toBe('0.00');
    expect(await residual(w.pgOrgId)).toBe('0.00');
    // and the gate now moves on to something else (the party-balance attestation), no longer the 3900 residual
    for (const [org, actor] of [[w.l.orgId, ianActor], [w.pgOrgId, pgActor]] as const) {
      const err = await asOrg(org, (tx) => postOpeningBalances(tx, actor)).then(() => null, (e: Error & { userMessage?: string }) => e);
      if (err) expect(String(err.userMessage ?? err.message)).not.toMatch(/Opening balance equity still carries/);
    }
  });
});
