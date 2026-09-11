import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { money } from '@shareat/core/money';
import { closeDb, withOrgPrincipal } from '@shareat/db';
import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { postConsumption, postCountVariance, postWastage } from '../../src/stock/consumption-posting';
import { isReservedUsageCategory, WASTAGE_REASONS } from '../../src/stock/wastage-reasons';
import { quantity } from '../../src/stock/quantity';
import type { ConsumedLine } from '../../src/stock/layers';

/**
 * T-164 — the three exits, and the accounts that must not be merged.
 *
 * ⭐ **This is the task that makes gross margin true.** §16.7 defect 5: v1's COGS is
 * purchase-basis, so margin moves with when stock was bought. From here it moves with what was
 * sold.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');

const sql = postgres(url, { max: 3 });

let orgA: string, storeA: string, personA: string;

/** Two FIFO lines, as `planConsumption` would return them: 10 @ ₱100 and 5 @ ₱120. */
const costLines: ConsumedLine[] = [
  { layerId: crypto.randomUUID(), quantity: quantity('10'), unitCost: '100.0000', cost: money('1000.00') },
  { layerId: crypto.randomUUID(), quantity: quantity('5'), unitCost: '120.0000', cost: money('600.00') },
];

async function balances(): Promise<Record<string, string>> {
  const rows = await sql<{ code: string; net: string }[]>`
    select a.code, (sum(l.debit) - sum(l.credit))::text as net
    from journal_lines l join accounts a on a.id = l.account_id
    where a.org_id = ${orgA} group by a.code order by a.code`;
  return Object.fromEntries(rows.map((r) => [r.code, r.net]));
}

const base = () => ({
  orgId: orgA,
  storeId: storeA,
  inventoryAccount: '1310',
  movedOn: '2026-08-20',
  sourceType: 'usage',
  sourceId: crypto.randomUUID(),
  costLines,
  postedBy: personA,
});

beforeEach(async () => {
  await sql`
    truncate table stock_layer_consumptions, stock_layers, stock_movements,
      stock_locations, location_types, departments,
      journal_lines, journal_entries, fiscal_periods, audit_log,
      accounts, items, person_identities, persons, stores, organizations restart identity cascade`;
  const [o] = await sql<{ id: string }[]>`insert into organizations (name, code) values ('Org A','org-a') returning id`;
  orgA = o!.id;
  const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgA},'A1','A One') returning id`;
  storeA = s!.id;
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgA},'Alice') returning id`;
  personA = p!.id;
  await seedChartOfAccounts(sql, orgA);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status)
            values (${orgA},'2026-08-01','2026-08-31','open')`;
});

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('T-164 — consumption', () => {
  it('⭐ posts Dr 5110 / Cr 1310 at the FIFO cost, as ONE entry across two layers', async () => {
    const res = await withOrgPrincipal(orgA, (tx) => postConsumption(tx, { ...base(), cogsCategory: 'meat' }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.cost).toBe(money('1600.00'));

    const b = await balances();
    expect(b['5110']).toBe('1600.00');
    expect(b['1310']).toBe('-1600.00');

    // One entry, not one per layer — the per-layer detail is the subledger.
    const [n] = await sql<{ c: string }[]>`select count(*)::text as c from journal_entries`;
    expect(n!.c).toBe('1');
  });

  it('routes by COGS category — a beverage lands in 5200', async () => {
    await withOrgPrincipal(orgA, (tx) => postConsumption(tx, { ...base(), cogsCategory: 'beverage' }));
    const b = await balances();
    expect(b['5200']).toBe('1600.00');
    expect(b['5110']).toBeUndefined();
  });

  it('⛔ an unknown COGS category BLOCKS rather than falling back to the catch-all', async () => {
    // COA-ALIGNMENT says drive 5100 to zero. Routing the unknown into it would do the opposite,
    // quietly and forever.
    const res = await withOrgPrincipal(orgA, (tx) => postConsumption(tx, { ...base(), cogsCategory: 'fireworks' }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain('fireworks');
    expect(await balances()).toEqual({});
  });

  it('is idempotent — a retried post writes one entry', async () => {
    const input = { ...base(), cogsCategory: 'meat' };
    const first = await withOrgPrincipal(orgA, (tx) => postConsumption(tx, input));
    const second = await withOrgPrincipal(orgA, (tx) => postConsumption(tx, input));
    expect(first.ok && first.created).toBe(true);
    expect(second.ok && second.created).toBe(false);
    expect((await balances())['5110']).toBe('1600.00');
  });
});

describe('T-164 — wastage is NOT COGS', () => {
  it('⭐ posts 5300, never a COGS account, even for food', async () => {
    const res = await withOrgPrincipal(orgA, (tx) =>
      postWastage(tx, { ...base(), sourceType: 'wastage', reason: 'spoilage' }),
    );
    expect(res.ok).toBe(true);

    const b = await balances();
    expect(b['5300']).toBe('1600.00');
    // ⭐ The assertion by ABSENCE is the one that matters: folding wastage into 5110 would make
    // food cost look worse and hide the shrinkage at the same time.
    expect(b['5110']).toBeUndefined();
    expect(b['1310']).toBe('-1600.00');
  });

  it('the reason rides the movement, not the journal line — one account for every reason', async () => {
    for (const reason of WASTAGE_REASONS.slice(0, 3)) {
      await withOrgPrincipal(orgA, (tx) =>
        postWastage(tx, { ...base(), sourceType: 'wastage', sourceId: crypto.randomUUID(), reason }),
      );
    }
    const b = await balances();
    expect(b['5300']).toBe('4800.00');
    const codes = Object.keys(b).filter((c) => c.startsWith('5'));
    expect(codes).toEqual(['5300']);
  });
});

describe('T-164 — count variance is a CORRECTION, not a cost', () => {
  it('⭐ counted SHORT relieves inventory into 5400', async () => {
    await withOrgPrincipal(orgA, (tx) =>
      postCountVariance(tx, { ...base(), sourceType: 'count', direction: 'short' }),
    );
    const b = await balances();
    expect(b['5400']).toBe('1600.00');
    expect(b['1310']).toBe('-1600.00');
    // Not COGS. A counting error is not appetite.
    expect(b['5110']).toBeUndefined();
  });

  it('⭐ counted LONG runs the other way — inventory up, 5400 credited', async () => {
    await withOrgPrincipal(orgA, (tx) =>
      postCountVariance(tx, { ...base(), sourceType: 'count', direction: 'long' }),
    );
    const b = await balances();
    expect(b['1310']).toBe('1600.00');
    expect(b['5400']).toBe('-1600.00');
  });

  it('⛔ an OPENING count is refused, naming 3900 and T-134', async () => {
    // v2 has no December P&L to charge December's shrinkage to, so the opening variance goes to
    // equity. ERPNext enforces the same distinction with its own error class.
    const res = await withOrgPrincipal(orgA, (tx) =>
      postCountVariance(tx, { ...base(), sourceType: 'count', direction: 'short', isOpeningCount: true }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain('3900');
    expect(res.reason).toContain('T-134');
    expect(await balances()).toEqual({});
  });
});

describe('T-164 — the period lock, on every one of the three paths', () => {
  // ⭐ §16.7 defect 6 is that v1 has NO period guard on 11 of 17 inventory paths. Written as three
  // separate cases deliberately: a guard wired at two of three is the same defect, smaller.
  beforeEach(async () => {
    await sql`update fiscal_periods set status = 'closed' where org_id = ${orgA}`;
  });

  it('consumption into a closed period is refused', async () => {
    await expect(
      withOrgPrincipal(orgA, (tx) => postConsumption(tx, { ...base(), cogsCategory: 'meat' })),
    ).rejects.toThrow(/period/i);
  });

  it('wastage into a closed period is refused', async () => {
    await expect(
      withOrgPrincipal(orgA, (tx) => postWastage(tx, { ...base(), sourceType: 'wastage', reason: 'spoilage' })),
    ).rejects.toThrow(/period/i);
  });

  it('a count variance into a closed period is refused', async () => {
    await expect(
      withOrgPrincipal(orgA, (tx) => postCountVariance(tx, { ...base(), sourceType: 'count', direction: 'short' })),
    ).rejects.toThrow(/period/i);
  });
});

describe('T-164 — the reserved "transfer" category', () => {
  it('⭐ rejects every synonym, case- and separator-insensitively', () => {
    // v1's named footgun: the usage flow writes only an OUT leg, so a movement mislabelled as a
    // transfer DESTROYS stock instead of moving it.
    for (const label of [
      'transfer', 'Transfer', 'TRANSFER', ' transfer ', 'transfer_out',
      'transfer out', 'Transfer-Out', 'move', 'relocation',
    ]) {
      expect(isReservedUsageCategory(label), `"${label}" must be reserved`).toBe(true);
    }
  });

  it('lets real usage categories through', () => {
    for (const label of ['spoilage', 'kitchen prep', 'staff meal', '', null, undefined]) {
      expect(isReservedUsageCategory(label as string)).toBe(false);
    }
  });
});

describe('T-164 — the ledger holds', () => {
  it('⭐ every 5xxx account used here appears in the P&L without a hand-added scan block', async () => {
    // Invariant 2. v1's income statement is a hand-assembled scan list, so a new account is
    // silently omitted; here the P&L is a query over journal_lines and cannot miss one.
    await withOrgPrincipal(orgA, (tx) => postConsumption(tx, { ...base(), cogsCategory: 'meat' }));
    await withOrgPrincipal(orgA, (tx) => postWastage(tx, { ...base(), sourceType: 'wastage', sourceId: crypto.randomUUID(), reason: 'spoilage' }));
    await withOrgPrincipal(orgA, (tx) => postCountVariance(tx, { ...base(), sourceType: 'count', sourceId: crypto.randomUUID(), direction: 'short' }));

    const rows = await sql<{ code: string }[]>`
      select distinct a.code from journal_lines l join accounts a on a.id = l.account_id
      where a.org_id = ${orgA} and a.type = 'expense' order by a.code`;
    expect(rows.map((r) => r.code)).toEqual(['5110', '5300', '5400']);
  });

  it('the trial balance ties after all three', async () => {
    await withOrgPrincipal(orgA, (tx) => postConsumption(tx, { ...base(), cogsCategory: 'meat' }));
    await withOrgPrincipal(orgA, (tx) => postWastage(tx, { ...base(), sourceType: 'wastage', sourceId: crypto.randomUUID(), reason: 'expiry' }));
    await withOrgPrincipal(orgA, (tx) => postCountVariance(tx, { ...base(), sourceType: 'count', sourceId: crypto.randomUUID(), direction: 'long' }));

    const [tb] = await sql<{ net: string }[]>`
      select (sum(debit) - sum(credit))::text as net from journal_lines l
      join accounts a on a.id = l.account_id where a.org_id = ${orgA}`;
    expect(tb!.net).toBe('0.00');
  });
});
