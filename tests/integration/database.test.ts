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
  await sql.end({ timeout: 5 });
});

describe('database harness', () => {
  it('connects to a real PostgreSQL', async () => {
    const rows = await sql<{ ok: number }[]>`select 1 as ok`;
    expect(rows[0]?.ok).toBe(1);
  });

  it('is PostgreSQL 16 or newer', async () => {
    const [row] = await sql<{ v: string }[]>`show server_version`;
    const major = Number(row!.v.split('.')[0]);
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
  // The whole thesis: a failed write can never leave a partial state (§Backend orientation).
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

describe('deferred constraints fire at COMMIT', () => {
  // Phase 1 enforces "every journal entry balances" and "at least two lines" with
  // DEFERRABLE INITIALLY DEFERRED constraint triggers. Prove the mechanism works here,
  // before the accounting spine depends on it.
  it('allows a temporarily invalid state inside the transaction, then rejects at commit', async () => {
    await sql`
      create temporary table deferred_probe (
        id int primary key,
        paired_id int,
        constraint must_be_paired check (paired_id is not null)
          deferrable initially deferred
      )
    `;

    await expect(
      sql.begin(async (tx) => {
        // Legal mid-transaction because the check is deferred...
        await tx`insert into deferred_probe (id, paired_id) values (1, null)`;
        // ...and never corrected, so COMMIT must reject it.
      }),
    ).rejects.toThrow(/must_be_paired/);

    const rows = await sql<{ id: number }[]>`select id from deferred_probe`;
    expect(rows).toHaveLength(0);
  });
});
