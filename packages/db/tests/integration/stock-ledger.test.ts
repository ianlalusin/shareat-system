import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-161 §7 — the stock ledger, proven against real PostgreSQL.
 *
 * ⭐ Every refusal is attempted in RAW SQL. Bible row 104: name the statement the DATABASE
 * rejects, never the call our code declines to make — and DEF-041 is the cost of getting that
 * backwards, where an append-only claim was "proved" by grepping our own repo while raw SQL
 * quietly rewrote a landed row and deleted it.
 */
config({ path: '../../../.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { APP_ROLE } from '../../src/rls/registry';
import { testItemCode } from '../../../domain/tests/integration/_fixtures/item-code';

const sql = postgres(url, { max: 5 });

let orgA: string, orgB: string, storeA: string, storeB: string;
let personB: string, personA: string, roomA: string, roomB: string, roomA2: string;
let itemA: string, itemB: string;

async function asOrg<T>(org: string | null, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return (await sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${APP_ROLE}`);
    if (org !== null) await tx`select set_config('app.org_id', ${org}, true)`;
    return (await fn(tx)) as never;
  })) as T;
}

/** Write a movement as the owner. `over` lets one test bend exactly one thing. */
async function move(
  qty: string,
  over: {
    item?: string; location?: string; store?: string; org?: string;
    kind?: string; sourceType?: string; sourceId?: string;
    movedAt?: string; reversalOf?: string | null;
  } = {},
  tx: postgres.TransactionSql | postgres.Sql = sql,
) {
  const [r] = await tx<{ id: string }[]>`
    insert into stock_movements
      (org_id, store_id, location_id, item_id, moved_at, quantity, kind, source_type, source_id, reversal_of_id, created_by)
    values (${over.org ?? orgA}, ${over.store ?? storeA}, ${over.location ?? roomA}, ${over.item ?? itemA},
            ${over.movedAt ?? '2026-08-20T02:00:00Z'}, ${qty}, ${over.kind ?? 'receipt'},
            ${over.sourceType ?? 'delivery'}, ${over.sourceId ?? crypto.randomUUID()},
            ${over.reversalOf ?? null}, ${(over.org ?? orgA) === orgB ? personB : personA})
    returning id`;
  return r!.id;
}

async function onHand(item = itemA, location = roomA): Promise<string> {
  const [r] = await sql<{ t: string }[]>`
    select coalesce(sum(quantity), 0)::text as t from stock_movements
    where item_id = ${item} and location_id = ${location}`;
  return r!.t;
}

beforeEach(async () => {
  await sql`
    truncate table stock_movements, stock_locations, location_types, departments,
      person_grants, person_store_scope, person_roles,
      journal_lines, journal_entries, audit_log, fiscal_periods,
      accounts, items, person_identities, persons, stores, organizations restart identity cascade
  `;
  const [a] = await sql<{ id: string }[]>`insert into organizations (name, code) values ('Org A','org-a') returning id`;
  const [b] = await sql<{ id: string }[]>`insert into organizations (name, code) values ('Org B','org-b') returning id`;
  orgA = a!.id; orgB = b!.id;

  const [sa] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, stock_model) values (${orgA},'A1','A One','multi_room') returning id`;
  const [sb] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, stock_model) values (${orgB},'B1','B One','multi_room') returning id`;
  storeA = sa!.id; storeB = sb!.id;

  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgA},'Alice') returning id`;
  personA = p!.id;
  const [pb] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgB},'Bob') returning id`;
  personB = pb!.id;

  const [t] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${orgA},'STK','Stockroom') returning id`;
  const [tb] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${orgB},'STK','Stockroom') returning id`;

  const [r1] = await sql<{ id: string }[]>`
    insert into stock_locations (org_id, store_id, code, name, type_id, created_by)
    values (${orgA}, ${storeA}, 'MAIN', 'Main', ${t!.id}, ${personA}) returning id`;
  const [r2] = await sql<{ id: string }[]>`
    insert into stock_locations (org_id, store_id, code, name, type_id, created_by)
    values (${orgA}, ${storeA}, 'KIT', 'Kitchen', ${t!.id}, ${personA}) returning id`;
  const [r3] = await sql<{ id: string }[]>`
    insert into stock_locations (org_id, store_id, code, name, type_id, created_by)
    values (${orgB}, ${storeB}, 'MAIN', 'Main', ${tb!.id}, ${pb!.id}) returning id`;
  roomA = r1!.id; roomA2 = r2!.id; roomB = r3!.id;

  const [i] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, created_by)
    values (${orgA},${testItemCode()},'Pork Belly','raw_material','kg',${personA}) returning id`;
  const [i2] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, created_by)
    values (${orgB},${testItemCode()},'Beef','raw_material','kg',${pb!.id}) returning id`;
  itemA = i!.id; itemB = i2!.id;
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe('T-161 — on-hand is a query over signed movements', () => {
  it('equals the signed sum, exactly, at three decimals', async () => {
    await move('10.500');
    await move('4.250');
    await move('2.125');
    await move('-3.875', { kind: 'usage', sourceType: 'usage' });
    await move('-1.000', { kind: 'usage', sourceType: 'usage' });
    // 10.5 + 4.25 + 2.125 - 3.875 - 1 = 12.000, and it is EXACT — no float, nothing to tolerate.
    expect(await onHand()).toBe('12.000');
  });

  it('⭐ there is no balance column anywhere in this table', async () => {
    const cols = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_name = 'stock_movements' and column_name in ('balance','on_hand','running_total')`;
    // DEF-075's pattern, refused for the ninth time. A reviewer finding one has found a defect.
    expect(cols).toHaveLength(0);
  });

  it('reads as at a past moment, ignoring later movements', async () => {
    await move('10', { movedAt: '2026-08-01T02:00:00Z' });
    await move('5', { movedAt: '2026-08-25T02:00:00Z' });
    const [r] = await sql<{ t: string }[]>`
      select coalesce(sum(quantity),0)::text as t from stock_movements
      where item_id = ${itemA} and location_id = ${roomA} and moved_at <= '2026-08-10T00:00:00Z'`;
    expect(r!.t).toBe('10.000');
  });

  it('balances are per LOCATION, not per store', async () => {
    await move('10');
    await move('4', { location: roomA2 });
    expect(await onHand(itemA, roomA)).toBe('10.000');
    expect(await onHand(itemA, roomA2)).toBe('4.000');
  });
});

describe('T-161 — append only, refused by the database', () => {
  it('⭐ UPDATE raises, in raw SQL', async () => {
    const id = await move('10');
    await expect(sql`update stock_movements set quantity = 999 where id = ${id}`).rejects.toThrow(
      /append-only/,
    );
    expect(await onHand()).toBe('10.000');
  });

  it('⭐ DELETE raises, in raw SQL', async () => {
    await move('10');
    await expect(sql`delete from stock_movements`).rejects.toThrow(/append-only/);
    expect(await onHand()).toBe('10.000');
  });

  it('a zero-quantity movement cannot exist', async () => {
    await expect(move('0')).rejects.toThrow(/quantity_not_zero/);
  });

  it('a movement must name its source', async () => {
    await expect(move('1', { sourceType: '   ' })).rejects.toThrow(/source_type_not_blank/);
  });

  it('an unknown kind is refused', async () => {
    await expect(move('1', { kind: 'teleport' })).rejects.toThrow(/kind_check/);
  });
});

describe('T-161 — stock may not go negative', () => {
  it('⭐ a single movement that overdraws is refused', async () => {
    await move('5');
    await expect(move('-6', { kind: 'usage', sourceType: 'usage' })).rejects.toThrow(/negative/);
    expect(await onHand()).toBe('5.000');
  });

  it('⭐ two lines in ONE transaction that COLLECTIVELY overdraw are refused', async () => {
    // The case a BEFORE ROW trigger cannot see: each line passes alone, the pair does not. This is
    // why the guard is a DEFERRED constraint trigger checked at commit.
    await move('10');
    await expect(
      sql.begin(async (tx) => {
        await move('-6', { kind: 'usage', sourceType: 'usage' }, tx);
        await move('-6', { kind: 'usage', sourceType: 'usage' }, tx);
      }),
    ).rejects.toThrow(/negative/);
    expect(await onHand()).toBe('10.000');
  });

  it('⚠️ a transfer may write its legs in either order without tripping the guard', async () => {
    // Deferring is also what lets the IN leg precede the OUT leg — an intermediate state that is
    // negative at neither end by commit.
    await move('10');
    await sql.begin(async (tx) => {
      await move('4', { location: roomA2, kind: 'transfer_in', sourceType: 'transfer' }, tx);
      await move('-4', { kind: 'transfer_out', sourceType: 'transfer' }, tx);
    });
    expect(await onHand(itemA, roomA)).toBe('6.000');
    expect(await onHand(itemA, roomA2)).toBe('4.000');
  });

  it('⭐ CONCURRENCY — v1’s −20 kg drift, reproduced and prevented', async () => {
    // Two posts decrement 8 from an on-hand of 10, at the same instant. In v1 both read the same
    // snapshot OUTSIDE the transaction, both passed, and both committed. Here one wins.
    await move('10');

    const attempt = (n: number) =>
      sql.begin(async (tx) => {
        await tx`select 1 from stock_movements where item_id = ${itemA} and location_id = ${roomA} for update`;
        await move('-8', { kind: 'usage', sourceType: 'usage', sourceId: crypto.randomUUID() }, tx);
        return n;
      });

    const results = await Promise.allSettled([attempt(1), attempt(2)]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');

    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    // ⭐ The assertion that matters: 2, never −6.
    expect(await onHand()).toBe('2.000');
  });
});

describe('T-161 — a correction is a new opposite row', () => {
  it('reversing restores the balance and links to what it reversed', async () => {
    const id = await move('10');
    await move('-10', { reversalOf: id });
    expect(await onHand()).toBe('0.000');
  });

  it('⭐ a movement may be reversed only ONCE', async () => {
    const id = await move('10');
    await move('-10', { reversalOf: id });
    await expect(move('-10', { reversalOf: id })).rejects.toThrow(/one_reversal_key/);
  });

  it('⭐ a reversal must be the exact opposite quantity', async () => {
    const id = await move('10');
    await expect(move('-4', { reversalOf: id })).rejects.toThrow(/exact opposite/);
  });

  it('a reversal must name the same item and location', async () => {
    const id = await move('10');
    await expect(move('-10', { reversalOf: id, location: roomA2 })).rejects.toThrow(
      /same item and location/,
    );
  });

  it('⛔ a reversal cannot itself be reversed', async () => {
    const id = await move('10');
    const rev = await move('-10', { reversalOf: id });
    await expect(move('10', { reversalOf: rev })).rejects.toThrow(/reverse a reversal/);
  });
});

describe('T-161 — idempotency', () => {
  it('⭐ one source document cannot touch the same item and location twice', async () => {
    const sourceId = crypto.randomUUID();
    await move('10', { sourceId });
    await expect(move('10', { sourceId })).rejects.toThrow(/source_pair_key/);
  });

  it('but it may touch a DIFFERENT location, and a different document may touch the same one', async () => {
    const sourceId = crypto.randomUUID();
    await move('10', { sourceId });
    await expect(move('4', { sourceId, location: roomA2 })).resolves.toBeTruthy();
    await expect(move('4', { sourceId: crypto.randomUUID() })).resolves.toBeTruthy();
  });
});

describe('T-161 — the period lock, on every path (§16.7 defect 6)', () => {
  it('⭐ a movement into a CLOSED period is refused', async () => {
    await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status)
              values (${orgA}, '2026-08-01', '2026-08-31', 'closed')`;
    await expect(move('10', { movedAt: '2026-08-20T02:00:00Z' })).rejects.toThrow(/closed period/);
  });

  it('a movement into a LOCKED period is refused', async () => {
    await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status)
              values (${orgA}, '2026-08-01', '2026-08-31', 'locked')`;
    await expect(move('10')).rejects.toThrow(/locked period/);
  });

  it('an OPEN period lets it through', async () => {
    await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status)
              values (${orgA}, '2026-08-01', '2026-08-31', 'open')`;
    await expect(move('10')).resolves.toBeTruthy();
  });

  it('⚠️ a date NO period covers is allowed — the warehouse does not stop for the bookkeeper', async () => {
    await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status)
              values (${orgA}, '2026-07-01', '2026-07-31', 'closed')`;
    await expect(move('10', { movedAt: '2026-08-20T02:00:00Z' })).resolves.toBeTruthy();
  });

  it('another org’s closed period does not block this org', async () => {
    await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status)
              values (${orgB}, '2026-08-01', '2026-08-31', 'closed')`;
    await expect(move('10')).resolves.toBeTruthy();
  });
});

describe('T-161 — org isolation', () => {
  it('org A sees only its own movements, with no WHERE clause', async () => {
    await move('10');
    await move('7', { org: orgB, store: storeB, location: roomB, item: itemB });

    const a = await asOrg(orgA, async (tx) => tx<{ quantity: string }[]>`select quantity from stock_movements`);
    expect(a).toHaveLength(1);
    expect(a[0]!.quantity).toBe('10.000');
  });

  it('org A cannot insert a movement carrying org B’s id', async () => {
    await expect(
      asOrg(orgA, async (tx) => tx`
        insert into stock_movements (org_id, store_id, location_id, item_id, moved_at, quantity, kind, source_type, source_id, created_by)
        values (${orgB}, ${storeB}, ${roomB}, ${itemB}, now(), 1, 'receipt', 'delivery', ${crypto.randomUUID()}, ${personA})`),
    ).rejects.toThrow(/row-level security/i);
  });

  it('⭐ NO principal returns ZERO movements, never every movement', async () => {
    await move('10');
    const rows = await asOrg(null, async (tx) => tx<{ id: string }[]>`select id from stock_movements`);
    expect(rows).toHaveLength(0);
  });
});
