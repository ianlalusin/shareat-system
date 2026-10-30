/**
 * T-398 S7b (TESTER) - `onboardFranchiseOrganization`, the PG half (steps 1-7): O1 (PG part), O2, O3, O4, O5, O18, O19.
 * docs/tasks/398-s7/S7-REFRESH.md s5 (steps 1-7), s11, s13. Real Postgres via TEST_DATABASE_URL; the function opens its own systemTransaction
 * (owner write, K3), the restricted harness role reads through withOrgPrincipal / viaApp. State is read back AS OWNER by raw SQL.
 *
 * RED TODAY for one reason: `onboardFranchiseOrganization` does not exist in packages/domain/src/organizations/index.ts
 * ("is not a function" on the first call of every leg). The O19 privilege leg is GREEN-AS-GUARD (shareat_app has SELECT only, S6).
 *
 * ASSUMED NAMES (S7-REFRESH s5; the refresh pins the function name and `{ dryRun }`, not the input shape):
 *   onboardFranchiseOrganization({ file: OnboardingFile, byPersonId: string }, { dryRun: boolean }): Promise<{ status: 'created' | 'already-onboarded' | 'dry-run' }>
 *   `byPersonId` = Ian's person in the franchisor org (the CLI's --by). Only `status` is read from the result; everything else is DB state.
 *
 * The file comes from the committed MOCK file with every unique value suffixed, and `franchisorOrgCode` pointing at a franchisor org this test
 * creates (createOrganization + createFirstAdmin, so --by holds the super-admin grants).
 *
 * MUTANTS (each leg names its own): a step skipped; idempotency on name only; a dry run that writes; org insert in its own transaction;
 * owner given an employment row / franchisor scope; staff code taken from outside the generator; agreement written through a widened app grant.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import { closeDb, systemTransaction, withOrgPrincipal } from '@shareat/db';
import { sql as dsql } from 'drizzle-orm';
import { createFirstAdmin, createOrganization } from '../../src/organizations';
import { parseOnboardingFile, type OnboardingFile } from '../../src/organizations/onboarding-file';

const url = process.env.TEST_DATABASE_URL!;
const sql = postgres(url, { max: 6 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');
const MOCK = JSON.parse(readFileSync(join(repoRoot, 'scripts', 'fixtures', 'onboarding', 'MOCK-padre-garcia.onboarding.json'), 'utf8'));
let seq = 0;
const tag = () => `${Date.now().toString(36)}${++seq}`.toUpperCase();

async function franchisor() {
  const t = tag();
  const code = `S7BL${t}`;
  const r = await systemTransaction(async (tx) => {
    const org = await createOrganization(tx, { code, name: `Mock Franchisor Co ${t}` });
    const admin = await createFirstAdmin(tx, { orgId: org.orgId, displayName: `Mock Ian ${t}` });
    return { orgId: org.orgId, adminId: admin.personId };
  });
  const [staff] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${r.orgId}, ${`Mock Plain Staff ${t}`}) returning id`;
  return { ...r, code, staffId: staff!.id };
}
type Franchisor = Awaited<ReturnType<typeof franchisor>>;

function fileFor(l: Franchisor, over: { storeCode?: string; orgName?: string } = {}) {
  const t = tag();
  const raw = {
    ...MOCK,
    franchisorOrgCode: l.code,
    org: { code: `MOCKPG${t}`, name: over.orgName ?? `Mock Padre Garcia Foods ${t}` },
    store: { ...MOCK.store, code: over.storeCode ?? `MPG${t}`, name: `Mock SharEat Padre Garcia ${t}`, posStoreId: `MOCK-POS-${t}` },
    franchisorPerson: { ...MOCK.franchisorPerson, email: `franchisor.${t.toLowerCase()}@example.test` },
    owner: { ...MOCK.owner, email: `owner.${t.toLowerCase()}@example.test` },
    staff: [
      { last: 'Mock', first: `Cook${t}`, middle: 'Q', position: 'Kitchen Staff' },
      { last: 'Mock', first: `Cashier${t}`, middle: null, position: 'Cashier' },
      { last: 'Mock', first: `Server${t}`, middle: null, position: 'Server' },
    ],
  };
  return parseOnboardingFile(raw) as OnboardingFile;
}

const onboard = async (file: OnboardingFile, byPersonId: string, dryRun = false) => {
  const mod = (await import('../../src/organizations')) as unknown as {
    onboardFranchiseOrganization: (i: { file: OnboardingFile; byPersonId: string }, o: { dryRun: boolean }) => Promise<{ status: string }>;
  };
  return mod.onboardFranchiseOrganization({ file, byPersonId }, { dryRun });
};

/** A refusal is an Error that is NOT "the function does not exist" (a missing function must never pass as a refusal). */
async function expectRefused(p: Promise<unknown>): Promise<Error> {
  const err = await p.then(() => null, (e: Error) => e);
  expect(err, 'the call must be refused').toBeInstanceOf(Error);
  expect(err!.message, 'onboardFranchiseOrganization is missing - that is not a refusal').not.toMatch(/is not a function|not defined/);
  return err!;
}

const orgOf = async (code: string) => (await sql<{ id: string; name: string }[]>`select id, name from organizations where code = ${code}`)[0];

/** Row counts that a second run / a dry run / a failure must not move, for one company and globally. */
async function footprint(code: string) {
  const [g] = await sql<Record<string, number>[]>`
    select (select count(*) from organizations)::int orgs, (select count(*) from persons)::int persons, (select count(*) from stores)::int stores,
           (select count(*) from person_roles)::int roles, (select count(*) from employments)::int employments, (select count(*) from franchise_agreements)::int agreements,
           (select count(*) from stock_locations)::int locations, (select count(*) from audit_log)::int audits, (select count(*) from positions)::int positions,
           (select count(*) from person_identities)::int identities, (select count(*) from fiscal_periods)::int periods, (select count(*) from accounts)::int accounts`;
  const o = await orgOf(code);
  return { ...g!, thisOrg: o ? 1 : 0 };
}

describe('O1 (PG part) - one assertion per object created', () => {
  it('creates PG with chart, periods, six canonical positions; Ian\'s PG person; owner; staff; store + room; agreement', async () => {
    const l = await franchisor();
    const file = fileFor(l);
    expect((await onboard(file, l.adminId)).status).toBe('created');

    // step 2 - company, chart, months, six positions (Mutant: createOrganization replaced by a bare insert)
    const org = (await orgOf(file.org.code))!;
    expect(org.name).toBe(file.org.name);
    const [seeded] = await sql<{ accounts: number; periods: number; positions: number }[]>`
      select (select count(*) from accounts where org_id = ${org.id})::int accounts,
             (select count(*) from fiscal_periods where org_id = ${org.id})::int periods,
             (select count(*) from positions where org_id = ${org.id} and is_canonical)::int positions`;
    expect(seeded!.accounts).toBeGreaterThan(0);
    expect(seeded!.periods).toBeGreaterThanOrEqual(12);
    expect(seeded!.positions).toBe(6);
    const names = (await sql<{ name: string }[]>`select name from positions where org_id = ${org.id} and is_canonical order by name`).map((r) => r.name);
    expect(names).toEqual(['Cashier', 'Dishwasher', 'Inventory Staff', 'Kitchen Staff', 'Server', 'Slicer']);

    // step 4 - the store and its default room (Mutant: store without a room)
    const [store] = await sql<{ id: string; code: string; name: string }[]>`select id, code, name from stores where org_id = ${org.id}`;
    expect(store).toMatchObject({ code: file.store.code, name: file.store.name });
    const rooms = await sql`select 1 from stock_locations where org_id = ${org.id} and store_id = ${store!.id}`;
    expect(rooms.length).toBeGreaterThanOrEqual(1);

    // step 3 - Ian's PG person: admin, name parts, the second email (Mutant: step skipped / display name only)
    const [adm] = await sql<{ id: string; last_name: string; first_name: string }[]>`
      select p.id, p.last_name, p.first_name from persons p join person_roles r on r.person_id = p.id and r.org_id = ${org.id} and r.role = 'admin' where p.org_id = ${org.id}`;
    expect(adm).toMatchObject({ last_name: file.franchisorPerson.last, first_name: file.franchisorPerson.first });
    const [email] = await sql<{ value: string }[]>`select value from person_identities where person_id = ${adm!.id} and kind = 'email'`;
    expect(email!.value.toLowerCase()).toBe(file.franchisorPerson.email.toLowerCase());
    const scope = await sql`select 1 from person_store_scope where person_id = ${adm!.id} and store_id = ${store!.id}`;
    expect(scope, 'Ian\'s PG person must be scoped to the PG store (step 4)').toHaveLength(1);

    // step 5 - the owner: org-wide manager, no employment (Mutant: owner given an employment row) - see also O5
    const [own] = await sql<{ id: string; last_name: string; first_name: string; role: string }[]>`
      select p.id, p.last_name, p.first_name, r.role from persons p join person_roles r on r.person_id = p.id and r.org_id = ${org.id} and r.role = 'manager' where p.org_id = ${org.id}`;
    expect(own).toMatchObject({ last_name: file.owner.last, first_name: file.owner.first, role: 'manager' });

    // step 6 - staff at PG's store, position from the file (Mutant: staff skipped / wrong position)
    const staff = await sql<{ first_name: string; position: string; store_id: string }[]>`
      select p.first_name, pos.name as position, e.store_id
      from employments e join persons p on p.id = e.person_id
      join employment_positions ep on ep.employment_id = e.id join positions pos on pos.id = ep.position_id
      where e.org_id = ${org.id} order by p.first_name`;
    expect(staff).toHaveLength(file.staff.length);
    for (const s of file.staff) expect(staff.find((r) => r.first_name === s.first)?.position).toBe(s.position);
    expect(new Set(staff.map((r) => r.store_id))).toEqual(new Set([store!.id]));

    // step 7 - the agreement S6 reads (Mutant: step skipped; wrong franchisor / person / date)
    const [ag] = await sql<{ franchisor_org_id: string; franchisor_person_id: string; sales_visible_from: string }[]>`
      select franchisor_org_id, franchisor_person_id, sales_visible_from::text from franchise_agreements where org_id = ${org.id}`;
    expect(ag).toEqual({ franchisor_org_id: l.orgId, franchisor_person_id: adm!.id, sales_visible_from: file.agreement.salesVisibleFrom });
  });

  it('refuses a --by person who is not a super-admin-capability holder of the franchisor org, and one from another org; nothing written (s5) - Mutant: --by unchecked', async () => {
    const l = await franchisor();
    const other = await franchisor();
    const before = await footprint('none');
    await expectRefused(onboard(fileFor(l), l.staffId));
    await expectRefused(onboard(fileFor(l), other.adminId));
    expect(await footprint('none')).toEqual(before);
  });

  it('refuses an unknown franchisorOrgCode; nothing written - Mutant: agreement points at a null / guessed org', async () => {
    const l = await franchisor();
    const f = parseOnboardingFile({ ...fileFor(l), franchisorOrgCode: `NOSUCH${tag()}` });
    const before = await footprint('none');
    await expectRefused(onboard(f, l.adminId));
    expect(await footprint('none')).toEqual(before);
  });
});

describe('O2 - run twice', () => {
  it('second run is a no-op "already-onboarded": every count equal, one company with that code - Mutant: idempotency on name only (a second org with a new id)', async () => {
    const l = await franchisor();
    const file = fileFor(l);
    await onboard(file, l.adminId);
    const first = (await orgOf(file.org.code))!.id;
    const before = await footprint(file.org.code);
    const again = await onboard(file, l.adminId);
    expect(again.status).toBe('already-onboarded');
    expect(await footprint(file.org.code)).toEqual(before);
    expect((await orgOf(file.org.code))!.id).toBe(first);
  });

  it('same code, DIFFERENT name: refused, naming the code; nothing written (s5 step 1) - Mutant: renames or creates a twin', async () => {
    const l = await franchisor();
    const file = fileFor(l);
    await onboard(file, l.adminId);
    const before = await footprint(file.org.code);
    const clash = parseOnboardingFile({ ...file, org: { code: file.org.code, name: `${file.org.name} (another)` } });
    const err = await expectRefused(onboard(clash, l.adminId));
    expect(err.message).toContain(file.org.code);
    expect(await footprint(file.org.code)).toEqual(before);
    expect((await orgOf(file.org.code))!.name).toBe(file.org.name);
  });
});

describe('O3 - dry run', () => {
  it('writes nothing: counts SCOPED to what this onboarding would create are unchanged, and the result names the plan - Mutant: writes then keeps the audit/people rows / opens a write path', async () => {
    const l = await franchisor();
    const file = fileFor(l);
    // Scoped to this file's own values, so another worker writing to the same database cannot move them.
    const emails = [file.franchisorPerson.email.toLowerCase(), file.owner.email.toLowerCase()];
    const firsts = file.staff.map((s) => s.first);
    const scoped = async () =>
      (await sql<Record<string, number>[]>`
        select (select count(*) from organizations where code = ${file.org.code})::int orgs,
               (select count(*) from stores where code = ${file.store.code})::int stores,
               (select count(*) from person_identities where lower(value) in ${sql(emails)})::int identities,
               (select count(*) from persons where first_name in ${sql(firsts)})::int staff_persons,
               (select count(*) from franchise_agreements where franchisor_org_id = ${l.orgId})::int agreements,
               (select count(*) from audit_log where org_id = ${l.orgId} and action like 'onboard%')::int audits,
               (select count(*) from positions p join organizations o on o.id = p.org_id where o.code = ${file.org.code})::int positions`)[0]!;
    const before = await scoped();
    expect(before).toEqual({ orgs: 0, stores: 0, identities: 0, staff_persons: 0, agreements: 0, audits: 0, positions: 0 });
    const r = await onboard(file, l.adminId, true);
    expect(r.status).toBe('dry-run');
    expect(JSON.stringify(r), 'the dry-run result must name the plan (org code)').toContain(file.org.code);
    expect(await scoped()).toEqual(before);
  });
});

describe('O4 - a fault after the org insert leaves nothing of PG', () => {
  it('a failure at the store insert (step 4) rolls back the org, persons, positions, chart - Mutant: org insert in its own transaction', async () => {
    const l = await franchisor();
    const faultCode = `FAULT${tag()}`;
    const file = fileFor(l, { storeCode: faultCode });
    const fn = `s7b_fault_${tag().toLowerCase()}`;
    await sql.unsafe(`create function ${fn}() returns trigger language plpgsql as $f$ begin if new.code = '${faultCode}' then raise exception 's7b injected fault'; end if; return new; end $f$`);
    await sql.unsafe(`create trigger ${fn} before insert on stores for each row execute function ${fn}()`);
    try {
      const before = await footprint(file.org.code);
      await expect(onboard(file, l.adminId)).rejects.toThrow(/injected fault/);
      expect(await orgOf(file.org.code)).toBeUndefined();
      expect(await footprint(file.org.code)).toEqual(before);
      const left = await sql`select 1 from person_identities where lower(value) in (${file.franchisorPerson.email.toLowerCase()}, ${file.owner.email.toLowerCase()})`;
      expect(left).toHaveLength(0);
    } finally {
      await sql.unsafe(`drop trigger if exists ${fn} on stores`);
      await sql.unsafe(`drop function if exists ${fn}()`);
    }
  });
});

describe('O5 - the owner', () => {
  it('org-wide manager, NO employment row, no franchisor-org store scope; under PG\'s principal only PG\'s store is visible and the franchisor\'s store/persons are not found - Mutant: owner given an employment row / the franchisor org scope', async () => {
    const l = await franchisor();
    await sql`insert into stores (org_id, code, name) values (${l.orgId}, ${`LS${tag()}`}, 'Mock Franchisor Kitchen')`;
    const file = fileFor(l);
    await onboard(file, l.adminId);
    const org = (await orgOf(file.org.code))!;
    const [own] = await sql<{ id: string }[]>`
      select p.id from persons p join person_roles r on r.person_id = p.id and r.org_id = ${org.id} and r.role = 'manager' where p.org_id = ${org.id} and p.last_name = ${file.owner.last} and p.first_name = ${file.owner.first}`;
    expect(await sql`select 1 from employments where person_id = ${own!.id}`, 'the owner is not an employee (row 340)').toHaveLength(0);
    expect(await sql`select 1 from person_roles where person_id = ${own!.id} and org_id <> ${org.id}`).toHaveLength(0);
    const franchisorScope = await sql`select 1 from person_store_scope ss join stores s on s.id = ss.store_id where ss.person_id = ${own!.id} and s.org_id = ${l.orgId}`;
    expect(franchisorScope).toHaveLength(0);

    const seen = await withOrgPrincipal(org.id, async (tx) => ({
      stores: (await tx.execute(dsql`select name from stores`)) as unknown as { name: string }[],
      franchisorPersons: (await tx.execute(dsql`select id from persons where org_id = ${l.orgId}`)) as unknown as unknown[],
      franchisorStores: (await tx.execute(dsql`select id from stores where org_id = ${l.orgId}`)) as unknown as unknown[],
    }));
    expect(seen.stores.map((r) => r.name)).toEqual([file.store.name]);
    expect(seen.franchisorPersons).toHaveLength(0);
    expect(seen.franchisorStores).toHaveLength(0);
  });
});

describe('O18 - staff codes', () => {
  it('each staff member has a distinct SE-NNN code at PG\'s store, issued by the generator (the file has no code field) - Mutant: code taken from the file / two staff share one', async () => {
    const l = await franchisor();
    const file = fileFor(l);
    expect(Object.keys(file.staff[0]!)).not.toContain('staffCode');
    await onboard(file, l.adminId);
    const org = (await orgOf(file.org.code))!;
    const codes = (await sql<{ staff_code: string }[]>`select staff_code from employments where org_id = ${org.id} order by staff_code`).map((r) => r.staff_code);
    expect(codes).toHaveLength(file.staff.length);
    for (const c of codes) expect(c).toMatch(/^SE-[0-9]{3,}$/);
    expect(new Set(codes).size).toBe(codes.length);
    // issued in order from the store's own counter: the first staff member gets a code lower than the second (not random, not taken from another store)
    const nums = codes.map((c) => Number(c.slice(3)));
    expect(nums).toEqual([...nums].sort((a, b) => a - b));
    expect(nums[0]).toBeLessThan(nums[nums.length - 1]!);
  });
});

describe('O19 - the agreement write', () => {
  it('is present after onboarding; the app role cannot insert one (S6 grant unchanged) - Mutant: agreement written through shareat_app with a widened grant', async () => {
    const l = await franchisor();
    const file = fileFor(l);
    await onboard(file, l.adminId);
    const org = (await orgOf(file.org.code))!;
    expect(await sql`select 1 from franchise_agreements where org_id = ${org.id}`).toHaveLength(1);
    const [priv] = await sql<{ ins: boolean; upd: boolean; del: boolean; sel: boolean }[]>`
      select has_table_privilege('shareat_app', 'franchise_agreements', 'INSERT') ins, has_table_privilege('shareat_app', 'franchise_agreements', 'UPDATE') upd,
             has_table_privilege('shareat_app', 'franchise_agreements', 'DELETE') del, has_table_privilege('shareat_app', 'franchise_agreements', 'SELECT') sel`;
    expect(priv).toEqual({ ins: false, upd: false, del: false, sel: true });
  });
});
