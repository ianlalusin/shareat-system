import { config } from 'dotenv';
import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-202 — staff onboarding UI: `createPerson` / `searchPersons`. `docs/tasks/202-staff-onboarding-ui.md`.
 *
 * ⭐ Closes DEF-131's own gap: until this task, no domain function anywhere created a `persons`
 * row — `createEmployment` (T-154) requires an existing `personId`, so a real hire could not
 * happen without this closing first. Follows `employment.test.ts`'s fixture shape exactly.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { APP_ROLE, transaction, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { createEmployment, createPerson, searchPersons, seedCanonicalPositions } from '@shareat/domain';

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
  const code = uid(`pp-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const [storeB] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(`${hint}b`)}, ${`Store ${hint} B`}) returning id`;
  const [admin] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${admin!.id}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${admin!.id}, ${store!.id})`;
  await sql`insert into person_store_scope (person_id, store_id) values (${admin!.id}, ${storeB!.id})`;

  // createEmployment defaults an empty positionIds to the canonical 'Server' position — several
  // cases here hire without naming one, so the six canonical positions must exist first (mirrors
  // employment.test.ts's own fixture).
  await asOrg(orgId, (tx) => seedCanonicalPositions(tx, orgId));

  return {
    orgId,
    storeId: store!.id,
    storeBId: storeB!.id,
    admin: actor(orgId, admin!.id),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

// -------------------------------------------------------------------------------------

describe('T-202 — createPerson', () => {
  it('creates a person + hires them in one flow', async () => {
    const f = await fixture('create-hire');
    const person = await asOrg(f.orgId, (tx) =>
      createPerson(tx, f.admin, { storeId: f.storeId, displayName: '  Maria Santos  ' }),
    );
    expect(person.displayName).toBe('Maria Santos'); // trimmed
    expect(person.orgId).toBe(f.orgId);
    expect(person.isActive).toBe(true);

    const employment = await asOrg(f.orgId, (tx) =>
      createEmployment(tx, f.admin, {
        storeId: f.storeId,
        personId: person.id,
        employmentStatus: 'probationary',
        startedOn: '2026-01-05',
      }),
    );
    expect(employment.personId).toBe(person.id);
  });

  it('refuses an empty display name', async () => {
    const f = await fixture('empty-name');
    await expect(
      asOrg(f.orgId, (tx) => createPerson(tx, f.admin, { storeId: f.storeId, displayName: '   ' })),
    ).rejects.toThrow(/name/i);
  });

  it('is refused for a store the actor does not cover', async () => {
    const f = await fixture('wrong-store');
    const [otherStore] = await sql<{ id: string }[]>`
      insert into stores (org_id, code, name) values (${f.orgId}, ${uid('other')}, 'Elsewhere') returning id`;
    await expect(
      asOrg(f.orgId, (tx) =>
        createPerson(tx, f.admin, { storeId: otherStore!.id, displayName: 'Nobody' }),
      ),
    ).rejects.toThrow();
  });

  it('never persists a storeId on the person row — a person has no store of its own', async () => {
    const f = await fixture('no-store-column');
    await asOrg(f.orgId, (tx) => createPerson(tx, f.admin, { storeId: f.storeId, displayName: 'Jose Rizal' }));
    const cols = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns where table_name = 'persons'`;
    expect(cols.map((c) => c.column_name)).not.toContain('store_id');
  });

  it('a staff-role actor cannot create a person', async () => {
    const f = await fixture('authz-create');
    const [s] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${f.orgId}, 'Floor') returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${s!.id}, ${f.orgId}, 'staff')`;
    await sql`insert into person_store_scope (person_id, store_id) values (${s!.id}, ${f.storeId})`;
    await expect(
      asOrg(f.orgId, (tx) =>
        createPerson(tx, actor(f.orgId, s!.id), { storeId: f.storeId, displayName: 'Someone' }),
      ),
    ).rejects.toThrow();
  });
});

describe('T-202 — searchPersons', () => {
  async function seedThree(f: Fixture) {
    await asOrg(f.orgId, (tx) => createPerson(tx, f.admin, { storeId: f.storeId, displayName: 'Maria Santos' }));
    await asOrg(f.orgId, (tx) => createPerson(tx, f.admin, { storeId: f.storeId, displayName: 'Maria Clara' }));
    await asOrg(f.orgId, (tx) => createPerson(tx, f.admin, { storeId: f.storeId, displayName: 'Jose Rizal' }));
  }

  it('finds an existing person by partial name', async () => {
    const f = await fixture('search-partial');
    await seedThree(f);
    const found = await asOrg(f.orgId, (tx) => searchPersons(tx, f.admin, { query: 'mar' }));
    expect(found.map((p) => p.displayName).sort()).toEqual(['Maria Clara', 'Maria Santos']);
  });

  it('is org-scoped — a person in another org never matches', async () => {
    const f = await fixture('search-org-scope');
    await seedThree(f);
    const other = await fixture('search-org-scope-other');
    await asOrg(other.orgId, (tx) =>
      createPerson(tx, other.admin, { storeId: other.storeId, displayName: 'Maria Outsider' }),
    );
    const found = await asOrg(f.orgId, (tx) => searchPersons(tx, f.admin, { query: 'mar' }));
    expect(found.map((p) => p.displayName)).not.toContain('Maria Outsider');
  });

  it('the same person hired at a second store is still reachable through search', async () => {
    const f = await fixture('search-second-store');
    const person = await asOrg(f.orgId, (tx) =>
      createPerson(tx, f.admin, { storeId: f.storeId, displayName: 'Maria Two Stores' }),
    );
    await asOrg(f.orgId, (tx) =>
      createEmployment(tx, f.admin, {
        storeId: f.storeId,
        personId: person.id,
        employmentStatus: 'probationary',
        startedOn: '2026-01-05',
      }),
    );
    // Search is scoped to "every store the actor covers", not to one store — she is findable
    // regardless of which of the actor's stores she is already hired at.
    const found = await asOrg(f.orgId, (tx) => searchPersons(tx, f.admin, { query: 'Two Stores' }));
    expect(found.map((p) => p.id)).toContain(person.id);

    const second = await asOrg(f.orgId, (tx) =>
      createEmployment(tx, f.admin, {
        storeId: f.storeBId,
        personId: person.id,
        employmentStatus: 'probationary',
        startedOn: '2026-02-01',
      }),
    );
    expect(second.personId).toBe(person.id);
  });

  it('a staff-role actor cannot search', async () => {
    const f = await fixture('authz-search');
    await seedThree(f);
    const [s] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${f.orgId}, 'Floor') returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${s!.id}, ${f.orgId}, 'staff')`;
    await sql`insert into person_store_scope (person_id, store_id) values (${s!.id}, ${f.storeId})`;
    await expect(
      asOrg(f.orgId, (tx) => searchPersons(tx, actor(f.orgId, s!.id), { query: 'mar' })),
    ).rejects.toThrow();
  });

  it('an actor with no store scope at all is refused, not given zero results silently', async () => {
    const f = await fixture('authz-no-scope');
    await seedThree(f);
    const [nobody] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${f.orgId}, 'Nobody') returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${nobody!.id}, ${f.orgId}, 'manager')`;
    await expect(
      asOrg(f.orgId, (tx) => searchPersons(tx, actor(f.orgId, nobody!.id), { query: 'mar' })),
    ).rejects.toThrow(/store scope/i);
  });
});

describe('T-202 — the hire transaction rolls back the person too when the employment half fails', () => {
  it('a person created for a second open employment at the same store is rolled back with it', async () => {
    const f = await fixture('rollback');
    const first = await asOrg(f.orgId, (tx) =>
      createPerson(tx, f.admin, { storeId: f.storeId, displayName: 'Already Open' }),
    );
    await asOrg(f.orgId, (tx) =>
      createEmployment(tx, f.admin, {
        storeId: f.storeId,
        personId: first.id,
        employmentStatus: 'probationary',
        startedOn: '2026-01-05',
      }),
    );

    // Simulate the hire screen's one-transaction pattern: a NEW person, in the SAME transaction as
    // an employment that is doomed to fail because `first` already holds this store's slot for a
    // DIFFERENT person id — so use `first.id` again to force createEmployment's own open-employment
    // refusal, with a brand-new person created just before it in the same tx.
    const before = (await sql<{ n: string }[]>`select count(*)::text as n from persons where org_id = ${f.orgId}`)[0]!.n;

    await expect(
      asOrg(f.orgId, async (tx) => {
        const person = await createPerson(tx, f.admin, { storeId: f.storeId, displayName: 'Never Should Exist' });
        return createEmployment(tx, f.admin, {
          storeId: f.storeId,
          // Reuse the FIRST person's id, which already has an open employment at this store —
          // createEmployment refuses this regardless of the new person just created above.
          personId: first.id,
          employmentStatus: 'probationary',
          startedOn: '2026-02-01',
        });
      }),
    ).rejects.toThrow(/already/i);

    const after = (await sql<{ n: string }[]>`select count(*)::text as n from persons where org_id = ${f.orgId}`)[0]!.n;
    // ⭐ The whole hire transaction rolled back, including the person half — `asOrg` runs the
    // callback inside ONE Postgres transaction, and a thrown error rolls the entire thing back.
    // A `persons` row in general is allowed to exist with no employment (T-101 does not forbid
    // it) — but the HIRE FLOW's own transaction boundary (Contract §3: "one transaction, so a
    // person is never created with no employment to show for it if the employment half fails")
    // means a person created THIS way is rolled back along with the failed employment.
    expect(after).toBe(before);
  });
});
