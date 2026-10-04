import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-281 (DEF-302) — `stock_movements_check_period_open` (migration 0063, replaced forward by
 * 0145) gains no new behaviour: a movement into a closed or locked period is refused today and
 * stays refused, for every role. What changes is the SENTENCE when the caller holds the
 * period-override GUC (migration 0143's `app.period_override`) — it now says the override does
 * not extend to stock movements, instead of the generic refusal that gives no clue the override
 * was ever consulted.
 *
 * ⚠️ Tests 3/4 call `journalRepo.beginPeriodOverrideContext` directly rather than hand-rolling
 * `set_config` — the real mechanism `postEntry` uses after `authorize()` succeeds, per
 * `docs/tasks/281-def-302-honest-stock-period-refusal.md`. That is the whole point of the task:
 * an admin genuinely holding the override still gets the INSERT refused.
 *
 * ⚠️ Deliberately NOT run through `confirmReceipt` / `runProductionPosting` /
 * `recordInternalReturn` — same reasoning `period-override.test.ts` already gives for why
 * `postEntry` itself is tested directly there: those three write their stock movement before
 * calling `postEntry` in the same transaction, so a test built on one of them would fail for a
 * reason that has nothing to do with this task. The write below goes through
 * `stockLedgerRepo.insertMovement` — the same thin repo call all three production flows use, with
 * no business logic of its own — rather than raw SQL, so the trigger under test is exercised the
 * same way it is in production, parameterised, with no hand-built SQL string.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { closeDb, journalRepo, stockLedgerRepo, withOrgPrincipal, type Tx } from '@shareat/db';
import { decimal } from '@shareat/core/money';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

interface Fixture {
  orgId: string;
  storeId: string;
  locationId: string;
  itemId: string;
  personId: string;
}

async function fixture(): Promise<Fixture> {
  const code = uid('stock-period');
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id
  `;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name, stock_model) values (${orgId}, ${uid('st')}, 'Store', 'single_room') returning id
  `;
  const storeId = store!.id;
  const [person] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Staff') returning id
  `;
  const personId = person!.id;
  const [type] = await sql<{ id: string }[]>`
    insert into location_types (org_id, code, name) values (${orgId}, 'STK', 'Stockroom') returning id
  `;
  const [location] = await sql<{ id: string }[]>`
    insert into stock_locations (org_id, store_id, code, name, type_id, created_by)
    values (${orgId}, ${storeId}, 'A', 'Room A', ${type!.id}, ${personId}) returning id
  `;
  const locationId = location!.id;
  const [item] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, created_by)
    values (${orgId}, ${uid('ITEM')}, 'Test Item', 'raw_material', 'kg', ${personId}) returning id
  `;
  const itemId = item!.id;

  return { orgId, storeId, locationId, itemId, personId };
}

async function insertPeriod(orgId: string, status: 'open' | 'closed' | 'locked'): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into fiscal_periods (org_id, starts_on, ends_on, status)
    values (${orgId}, '2026-02-01', '2026-02-28', ${status})
    returning id
  `;
  return row!.id;
}

async function rejectionMessage(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error('expected the promise to reject, but it resolved');
}

function writeMovement(tx: Tx, f: Fixture) {
  // `source_id` is a uuid column (schema/stock-ledger.ts) — a free-text tag would fail with a
  // Postgres type error that has nothing to do with the period lock, masking the trigger's own
  // message. `source_type` carries the human-readable tag instead.
  return stockLedgerRepo.insertMovement(tx, {
    orgId: f.orgId,
    storeId: f.storeId,
    locationId: f.locationId,
    itemId: f.itemId,
    movedAt: new Date('2026-02-15T00:00:00Z'),
    quantity: decimal('1.000', '14,3'),
    kind: 'opening',
    sourceType: 'test',
    sourceId: crypto.randomUUID(),
    createdBy: f.personId,
  });
}

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('T-281 — baseline: closed period, no override, unchanged message', () => {
  it('rejects with the exact pre-existing text and no mention of an override', async () => {
    const f = await fixture();
    await insertPeriod(f.orgId, 'closed');

    const msg = await rejectionMessage(
      withOrgPrincipal(f.orgId, (tx) => writeMovement(tx, f)),
    );

    expect(msg).toMatch(/^cannot move stock into a closed period \(moved_at = /);
    expect(msg).not.toMatch(/override/i);
  });
});

describe('T-281 — baseline: locked period, no override, unchanged message', () => {
  it('rejects with the exact pre-existing text and no mention of an override', async () => {
    const f = await fixture();
    await insertPeriod(f.orgId, 'locked');

    const msg = await rejectionMessage(
      withOrgPrincipal(f.orgId, (tx) => writeMovement(tx, f)),
    );

    expect(msg).toMatch(/^cannot move stock into a locked period \(moved_at = /);
    expect(msg).not.toMatch(/override/i);
  });
});

describe('T-281 — THE test: closed period, override GENUINELY held, still refused', () => {
  it('rejects the insert even with the real override mechanism invoked first, honest message', async () => {
    const f = await fixture();
    await insertPeriod(f.orgId, 'closed');

    const msg = await rejectionMessage(
      withOrgPrincipal(f.orgId, async (tx) => {
        // The real mechanism `postEntry` uses after `authorize()` succeeds — never hand-rolled
        // `set_config`. If disposition (c) had been built by mistake, this line is what would
        // let the insert through; the assertion below is what would catch it.
        await journalRepo.beginPeriodOverrideContext(tx);
        return writeMovement(tx, f);
      }),
    );

    expect(msg).toMatch(/^cannot move stock into a closed period \(moved_at = /);
    expect(msg).toMatch(/does not extend to stock movements/i);
  });
});

describe('T-281 — locked period, override held, still refused, same honest wording', () => {
  it('rejects the insert; the message does not invent a separate "locked" sentence', async () => {
    const f = await fixture();
    await insertPeriod(f.orgId, 'locked');

    const msg = await rejectionMessage(
      withOrgPrincipal(f.orgId, async (tx) => {
        await journalRepo.beginPeriodOverrideContext(tx);
        return writeMovement(tx, f);
      }),
    );

    expect(msg).toMatch(/^cannot move stock into a locked period \(moved_at = /);
    expect(msg).toMatch(/does not extend to stock movements/i);
  });
});

describe('T-281 — open period, override held: untouched, no exception at all', () => {
  it('inserts cleanly and the GUC being on changes nothing', async () => {
    const f = await fixture();
    await insertPeriod(f.orgId, 'open');

    const row = await withOrgPrincipal(f.orgId, async (tx) => {
      await journalRepo.beginPeriodOverrideContext(tx);
      return writeMovement(tx, f);
    });

    expect(row.quantity).toBe('1.000');
    const count = await sql<{ n: string }[]>`select count(*)::text as n from stock_movements where org_id = ${f.orgId}`;
    expect(count[0]!.n).toBe('1');
  });
});
