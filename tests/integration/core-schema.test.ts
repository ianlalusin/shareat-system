import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import postgres from 'postgres';

/**
 * Proves the 11 database-level invariants of docs/tasks/101-core-schema.md against a real
 * PostgreSQL (PROJECT_BIBLE.md §9 rule 3) — never a mock, and never application code standing
 * in for the constraint. Each `it` names the invariant it proves.
 *
 * Written FIRST, per the task's method: run once before the schema exists to confirm these
 * fail for the right reason (relations do not exist yet), then again after the migration
 * applies to confirm the database itself rejects every bad state.
 */
const sql = postgres(process.env.TEST_DATABASE_URL!, { max: 2 });

async function resetTables() {
  await sql`
    truncate table
      audit_log, fiscal_periods, accounts, person_identities, persons, stores, organizations
    restart identity cascade
  `;
}

let orgSeq = 0;
async function insertOrg(codeHint: string) {
  const code = `${codeHint}-${++orgSeq}`;
  const [row] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code})
    returning id
  `;
  return row!.id;
}

async function insertPerson(orgId: string, displayName: string) {
  const [row] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, ${displayName})
    returning id
  `;
  return row!.id;
}

beforeEach(async () => {
  await resetTables();
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe('invariant 1 — two people cannot share a phone number', () => {
  it('rejects a second person claiming an already-claimed phone', async () => {
    const orgId = await insertOrg('inv1');
    const p1 = await insertPerson(orgId, 'Person One');
    const p2 = await insertPerson(orgId, 'Person Two');

    await sql`
      insert into person_identities (person_id, kind, value) values (${p1}, 'phone', '+639171234567')
    `;

    await expect(
      sql`
        insert into person_identities (person_id, kind, value)
        values (${p2}, 'phone', '+639171234567')
      `,
    ).rejects.toThrow();
  });
});

describe('invariant 2 — case/whitespace variants of the same value are the same identity', () => {
  it('rejects a phone that only differs by case and surrounding whitespace', async () => {
    const orgId = await insertOrg('inv2');
    const p1 = await insertPerson(orgId, 'Person One');
    const p2 = await insertPerson(orgId, 'Person Two');

    await sql`
      insert into person_identities (person_id, kind, value)
      values (${p1}, 'email', 'user@example.com')
    `;

    await expect(
      sql`
        insert into person_identities (person_id, kind, value)
        values (${p2}, 'email', '  USER@Example.com  ')
      `,
    ).rejects.toThrow();
  });
});

describe('invariant 3 — one person may hold several identities, including two of the same kind', () => {
  it('accepts two phones and an email on a single person', async () => {
    const orgId = await insertOrg('inv3');
    const p1 = await insertPerson(orgId, 'Person One');

    await sql`insert into person_identities (person_id, kind, value) values (${p1}, 'phone', '+639171111111')`;
    await sql`insert into person_identities (person_id, kind, value) values (${p1}, 'phone', '+639172222222')`;
    await sql`insert into person_identities (person_id, kind, value) values (${p1}, 'email', 'p1@example.com')`;

    const rows = await sql`select kind, value from person_identities where person_id = ${p1}`;
    expect(rows).toHaveLength(3);
  });
});

describe('invariant 4 — deleting a person cascades their identities and nothing else', () => {
  it('removes only the deleted persons identities', async () => {
    const orgId = await insertOrg('inv4');
    const p1 = await insertPerson(orgId, 'Person One');
    const p2 = await insertPerson(orgId, 'Person Two');

    await sql`insert into person_identities (person_id, kind, value) values (${p1}, 'phone', '+639173333333')`;
    await sql`insert into person_identities (person_id, kind, value) values (${p2}, 'phone', '+639174444444')`;

    await sql`delete from persons where id = ${p1}`;

    const identities = await sql<{ person_id: string }[]>`select person_id from person_identities`;
    expect(identities.map((r) => r.person_id)).toEqual([p2]);

    const persons = await sql<{ id: string }[]>`select id from persons`;
    expect(persons.map((r) => r.id)).toEqual([p2]);
  });
});

describe('invariant 5 — two overlapping fiscal periods in one org are rejected', () => {
  it('rejects a period that overlaps an existing one in the same org', async () => {
    const orgId = await insertOrg('inv5');
    await sql`insert into fiscal_periods (org_id, starts_on, ends_on) values (${orgId}, '2026-01-01', '2026-01-31')`;

    await expect(
      sql`insert into fiscal_periods (org_id, starts_on, ends_on) values (${orgId}, '2026-01-15', '2026-02-15')`,
    ).rejects.toThrow();
  });
});

describe('invariant 6 — non-overlapping periods in one org are fine; overlaps across orgs are fine', () => {
  it('accepts back-to-back periods in one org and an identical range in a different org', async () => {
    const orgA = await insertOrg('inv6a');
    const orgB = await insertOrg('inv6b');

    await sql`insert into fiscal_periods (org_id, starts_on, ends_on) values (${orgA}, '2026-01-01', '2026-01-31')`;
    await sql`insert into fiscal_periods (org_id, starts_on, ends_on) values (${orgA}, '2026-02-01', '2026-02-28')`;
    // same calendar range as orgA's first period, but a different org — must be accepted
    await sql`insert into fiscal_periods (org_id, starts_on, ends_on) values (${orgB}, '2026-01-01', '2026-01-31')`;

    const rows = await sql`select id from fiscal_periods`;
    expect(rows).toHaveLength(3);
  });
});

describe('invariant 7 — an account with an invalid type or normal_balance is rejected', () => {
  it('rejects an unrecognised type', async () => {
    const orgId = await insertOrg('inv7type');
    await expect(
      sql`
        insert into accounts (org_id, code, name, type, normal_balance)
        values (${orgId}, '1000', 'Cash', 'bogus_type', 'debit')
      `,
    ).rejects.toThrow();
  });

  it('rejects an unrecognised normal_balance', async () => {
    const orgId = await insertOrg('inv7bal');
    await expect(
      sql`
        insert into accounts (org_id, code, name, type, normal_balance)
        values (${orgId}, '1000', 'Cash', 'asset', 'bogus_balance')
      `,
    ).rejects.toThrow();
  });
});

describe('invariant 8 — (org_id, code) is unique for accounts, not globally', () => {
  it('rejects a duplicate code within an org but accepts it in a different org', async () => {
    const orgA = await insertOrg('inv8a');
    const orgB = await insertOrg('inv8b');

    await sql`
      insert into accounts (org_id, code, name, type, normal_balance)
      values (${orgA}, '1000', 'Cash', 'asset', 'debit')
    `;

    await expect(
      sql`
        insert into accounts (org_id, code, name, type, normal_balance)
        values (${orgA}, '1000', 'Cash Duplicate', 'asset', 'debit')
      `,
    ).rejects.toThrow();

    // same code, different org — must be accepted
    await sql`
      insert into accounts (org_id, code, name, type, normal_balance)
      values (${orgB}, '1000', 'Cash', 'asset', 'debit')
    `;

    const rows = await sql`select id from accounts`;
    expect(rows).toHaveLength(2);
  });
});

describe("invariant 9 — a store's code is unique per org, not globally", () => {
  it('rejects a duplicate store code within an org but accepts it in a different org', async () => {
    const orgA = await insertOrg('inv9a');
    const orgB = await insertOrg('inv9b');

    await sql`insert into stores (org_id, code, name) values (${orgA}, 'MAIN', 'Main Branch')`;

    await expect(
      sql`insert into stores (org_id, code, name) values (${orgA}, 'MAIN', 'Main Branch Duplicate')`,
    ).rejects.toThrow();

    // same code, different org — must be accepted
    await sql`insert into stores (org_id, code, name) values (${orgB}, 'MAIN', 'Main Branch')`;

    const rows = await sql`select id from stores`;
    expect(rows).toHaveLength(2);
  });
});

describe('invariant 10 — uuidv7() produces time-ordered ids', () => {
  it('sorts two sequentially-inserted rows by id ascending', async () => {
    const orgId = await insertOrg('inv10');
    const first = await insertPerson(orgId, 'First');
    // make sure the clock actually advances between the two inserts
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await insertPerson(orgId, 'Second');

    const rows = await sql<{ id: string }[]>`
      select id from persons where id in (${first}, ${second}) order by id asc
    `;
    expect(rows.map((r) => r.id)).toEqual([first, second]);
  });
});

describe('invariant 11 — deleting an org with dependent stores is restricted, not cascaded', () => {
  it('rejects the delete and leaves the org and its store intact', async () => {
    const orgId = await insertOrg('inv11');
    await sql`insert into stores (org_id, code, name) values (${orgId}, 'MAIN', 'Main Branch')`;

    await expect(sql`delete from organizations where id = ${orgId}`).rejects.toThrow();

    const orgRows = await sql`select id from organizations where id = ${orgId}`;
    expect(orgRows).toHaveLength(1);
    const storeRows = await sql`select id from stores where org_id = ${orgId}`;
    expect(storeRows).toHaveLength(1);
  });
});

/**
 * BONUS — not one of the 11 numbered invariants above, and not part of the task's required
 * test list. Contract §5 of docs/tasks/101-core-schema.md separately requires (imperative
 * "enforce") that a postable account may not have children. That rule is cross-row — it
 * depends on a second row's state, not just the row being written — so it cannot be a plain
 * CHECK constraint; it is implemented as a BEFORE INSERT OR UPDATE trigger on `accounts`.
 * Covered here for completeness, flagged separately in the task report.
 */
describe('bonus — postable accounts cannot have children (Contract §5)', () => {
  it('rejects a child whose parent is postable', async () => {
    const orgId = await insertOrg('bonus-a');
    const parentRows = await sql<{ id: string }[]>`
      insert into accounts (org_id, code, name, type, normal_balance, is_postable)
      values (${orgId}, '1000', 'Cash', 'asset', 'debit', true)
      returning id
    `;
    const parentId = parentRows[0]!.id;

    await expect(
      sql`
        insert into accounts (org_id, code, name, type, normal_balance, parent_id, is_postable)
        values (${orgId}, '1010', 'Cash - Sub', 'asset', 'debit', ${parentId}, false)
      `,
    ).rejects.toThrow();
  });

  it('rejects marking an account postable once it already has a child', async () => {
    const orgId = await insertOrg('bonus-b');
    const parentRows = await sql<{ id: string }[]>`
      insert into accounts (org_id, code, name, type, normal_balance, is_postable)
      values (${orgId}, '1000', 'Cash', 'asset', 'debit', false)
      returning id
    `;
    const parentId = parentRows[0]!.id;
    await sql`
      insert into accounts (org_id, code, name, type, normal_balance, parent_id, is_postable)
      values (${orgId}, '1010', 'Cash - Sub', 'asset', 'debit', ${parentId}, true)
    `;

    await expect(
      sql`update accounts set is_postable = true where id = ${parentId}`,
    ).rejects.toThrow();
  });
});
