import { describe, it, expect, afterAll } from 'vitest';
import postgres from 'postgres';

/**
 * The walking-skeleton proof (PROJECT_BIBLE.md §15.1): before any business logic exists,
 * demonstrate that the test harness really reaches a real PostgreSQL and that the
 * behaviours the accounting spine depends on actually hold.
 *
 * These run against TEST_DATABASE_URL, guarded by tests/integration/setup.ts.
 */
const sql = postgres(process.env.TEST_DATABASE_URL!, { max: 2 });

afterAll(async () => {
  await sql`drop table if exists probe_line, probe_entry cascade`;
  await sql`drop function if exists probe_assert_balanced() cascade`;
  await sql.end({ timeout: 5 });
});

describe('database harness', () => {
  it('connects to a real PostgreSQL', async () => {
    const rows = await sql<{ ok: number }[]>`select 1 as ok`;
    expect(rows[0]?.ok).toBe(1);
  });

  it('is PostgreSQL 16 or newer', async () => {
    const [row] = await sql<{ version: string }[]>`
      select current_setting('server_version') as version
    `;
    const major = Number(row!.version.split('.')[0]);
    expect(major).toBeGreaterThanOrEqual(16);
  });
});

describe('numeric never becomes a float', () => {
  // The single most important property for the ledger. numeric(14,2) must survive the
  // round trip exactly — v1 stored money as JS floats and fought the drift by rounding
  // at every write (§12 landmine 25).
  it('returns numeric as a string, not a JS number', async () => {
    const [row] = await sql<{ amount: string }[]>`select 1234.56::numeric(14,2) as amount`;
    expect(typeof row!.amount).toBe('string');
    expect(row!.amount).toBe('1234.56');
  });

  it('adds exactly, where floats would drift', async () => {
    const [row] = await sql<{ total: string }[]>`
      select (0.1::numeric(14,2) + 0.2::numeric(14,2)) as total
    `;
    expect(row!.total).toBe('0.30');
    expect(0.1 + 0.2).not.toBe(0.3); // the JS equivalent is wrong
  });

  it('sums a thousand centavos without error', async () => {
    const [row] = await sql<{ total: string }[]>`
      select sum(0.01::numeric(14,2)) as total from generate_series(1, 1000)
    `;
    expect(row!.total).toBe('10.00');
  });
});

describe('transactions roll back atomically', () => {
  it('undoes every statement when one fails', async () => {
    await sql`create temporary table tx_probe (id int primary key, note text)`;

    await expect(
      sql.begin(async (tx) => {
        await tx`insert into tx_probe (id, note) values (1, 'first')`;
        await tx`insert into tx_probe (id, note) values (1, 'duplicate key — must fail')`;
      }),
    ).rejects.toThrow();

    const rows = await sql<{ id: number }[]>`select id from tx_probe`;
    expect(rows).toHaveLength(0); // the first insert was rolled back too
  });
});

/**
 * Proves the exact mechanism Phase 1 uses to enforce accounting invariants 1 and 2:
 * "every journal entry balances" and "no single-leg escape hatch".
 *
 * IMPORTANT FINDING, caught by this test: PostgreSQL does NOT allow CHECK constraints to
 * be marked DEFERRABLE — "ERROR: CHECK constraints cannot be marked DEFERRABLE". Only
 * FOREIGN KEY, UNIQUE, PRIMARY KEY, EXCLUDE and CONSTRAINT TRIGGERS can be deferred.
 *
 * That matters because a balance rule is inherently multi-row: after the first line is
 * inserted the entry is legitimately unbalanced, and it only has to be correct at COMMIT.
 * So the balance and minimum-two-lines rules must be a DEFERRABLE CONSTRAINT TRIGGER,
 * while the per-row rules (debit >= 0, exactly one side populated) stay ordinary
 * immediate CHECKs.
 */
describe('deferred constraint triggers — the Phase 1 balance mechanism', () => {
  it('sets up an entry/line pair guarded by a deferred balance trigger', async () => {
    await sql`drop table if exists probe_line, probe_entry cascade`;
    await sql`create table probe_entry (id int primary key)`;
    await sql`
      create table probe_line (
        id serial primary key,
        entry_id int not null references probe_entry(id),
        debit  numeric(14,2) not null default 0,
        credit numeric(14,2) not null default 0,
        -- per-row rules are IMMEDIATE: they are true of a single line in isolation
        constraint probe_line_non_negative check (debit >= 0 and credit >= 0),
        constraint probe_line_one_side check ((debit = 0) <> (credit = 0))
      )
    `;
    await sql`
      create or replace function probe_assert_balanced() returns trigger as $$
      declare
        total_debit  numeric(14,2);
        total_credit numeric(14,2);
        line_count   int;
      begin
        select coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*)
          into total_debit, total_credit, line_count
          from probe_line where entry_id = new.entry_id;

        if line_count < 2 then
          raise exception 'entry % has % line(s); at least 2 required', new.entry_id, line_count;
        end if;
        if total_debit <> total_credit then
          raise exception 'entry % does not balance: debit % <> credit %',
            new.entry_id, total_debit, total_credit;
        end if;
        return null;
      end $$ language plpgsql
    `;
    await sql`
      create constraint trigger probe_line_balanced
        after insert or update on probe_line
        deferrable initially deferred
        for each row execute function probe_assert_balanced()
    `;

    const [row] = await sql<{ n: string }[]>`select count(*) as n from probe_entry`;
    expect(row!.n).toBe('0');
  });

  it('accepts a balanced two-line entry', async () => {
    await sql.begin(async (tx) => {
      await tx`insert into probe_entry (id) values (1)`;
      await tx`insert into probe_line (entry_id, debit)  values (1, 100.00)`;
      await tx`insert into probe_line (entry_id, credit) values (1, 100.00)`;
    });

    const [row] = await sql<{ n: string }[]>`select count(*) as n from probe_line where entry_id = 1`;
    expect(row!.n).toBe('2');
  });

  it('tolerates an unbalanced state MID-transaction, then rejects it at COMMIT', async () => {
    // This is the behaviour a non-deferred constraint could not provide: the first insert
    // leaves the entry unbalanced, which must be legal until the unit of work completes.
    await expect(
      sql.begin(async (tx) => {
        await tx`insert into probe_entry (id) values (2)`;
        await tx`insert into probe_line (entry_id, debit) values (2, 50.00)`; // legal here
        await tx`insert into probe_line (entry_id, credit) values (2, 49.00)`; // still legal
      }),
    ).rejects.toThrow(/does not balance/);

    const [row] = await sql<{ n: string }[]>`select count(*) as n from probe_line where entry_id = 2`;
    expect(row!.n).toBe('0'); // whole unit rolled back
  });

  it('rejects a single-leg entry — no "trivially balanced" escape hatch', async () => {
    // v1's balancer.ts:64-67 treated a one-leg entry as trivially balanced. That is the
    // hole the nominal ledger fell through (§16.0). Here it is structurally impossible.
    await expect(
      sql.begin(async (tx) => {
        await tx`insert into probe_entry (id) values (3)`;
        await tx`insert into probe_line (entry_id, debit) values (3, 75.00)`;
      }),
    ).rejects.toThrow(/at least 2 required/);

    const [row] = await sql<{ n: string }[]>`select count(*) as n from probe_line where entry_id = 3`;
    expect(row!.n).toBe('0');
  });

  it('still enforces per-row rules immediately', async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx`insert into probe_entry (id) values (4)`;
        // both sides populated — rejected at once, not deferred
        await tx`insert into probe_line (entry_id, debit, credit) values (4, 10.00, 10.00)`;
      }),
    ).rejects.toThrow(/probe_line_one_side/);
  });
});
