import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-134 — the 31 December conversion. `docs/tasks/134-cutover-wizard.md`.
 *
 * ⭐ The tests that carry the design are the two refusals: **a verified step cannot be ticked by
 * hand**, and **a 3900 residual halts with no plug account**. Everything else is progress
 * bookkeeping.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, cutoverRepo, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import {
  CUTOVER_GATES,
  CUTOVER_STEPS,
  attestStep,
  createItem,
  cutoverProgress,
  openingGaps,
  recordOpeningCount,
} from '@shareat/domain';
import { postEntry } from '../../src/ledger/post-entry';

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
  const code = uid(`cu-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`
    insert into fiscal_periods (org_id, starts_on, ends_on, status) values
      (${orgId}, '2026-12-01', '2026-12-31', 'open'),
      (${orgId}, '2027-01-01', '2027-01-31', 'open')`;
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;

  const mk = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${store!.id})`;
    return p!.id;
  };
  const adminId = await mk('Admin', 'admin');
  const superId = await mk('Super', 'super_admin');
  const staffId = await mk('Staff', 'staff');

  return {
    orgId, storeId: store!.id,
    admin: actor(orgId, adminId), superAdmin: actor(orgId, superId), staff: actor(orgId, staffId),
    adminId,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const progress = (f: Fixture) => asOrg(f.orgId, (tx) => cutoverProgress(tx, f.orgId, [f.storeId]));
const stepOf = async (f: Fixture, code: string) =>
  (await progress(f)).steps.find((s) => s.def.code === code)!;

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('the wizard is a guide, not a checklist', () => {
  it('every step is present, and per-store steps get one row per store', async () => {
    const f = await fixture('shape');
    const p = await progress(f);
    // 12 definitions; the three per-store ones expand across the one store here.
    expect(p.steps.length).toBe(CUTOVER_STEPS.length);
    expect(p.byPhase.A!.total).toBe(4);
    expect(p.byPhase.C!.total).toBe(5);
  });

  it('⭐ a blocked step says WHAT TO GO AND DO, rather than hiding', async () => {
    const f = await fixture('blocked');
    const b1 = await stepOf(f, 'B1');
    expect(b1.blockedBy).toMatch(/B1 waits on A1/);
    expect(b1.blockedBy).toMatch(/prices the newest/);
  });

  it('the gate opens once its prerequisite is recorded', async () => {
    const f = await fixture('gateopen');
    expect((await stepOf(f, 'B1')).blockedBy).not.toBeNull();
    await asOrg(f.orgId, (tx) =>
      attestStep(tx, f.admin, { stepCode: 'A1', note: 'Backlog cleared in v1 on 28 Dec.' }),
    );
    expect((await stepOf(f, 'B1')).blockedBy).toBeNull();
  });

  it('⚠️ only the four named gates are enforced — A2/A3/A4 are free among themselves', async () => {
    const f = await fixture('free');
    const p = await progress(f);
    const blocked = p.steps.filter((s) => s.blockedBy !== null).map((s) => s.def.code);
    // B1 (waits A1), C3 (waits C2), C4 (waits C3), C5 (waits C4). Nothing else.
    expect(new Set(blocked)).toEqual(new Set(['B1', 'C3', 'C4', 'C5']));
    expect(CUTOVER_GATES).toHaveLength(4);
  });
});

describe('a verified step cannot be ticked by hand', () => {
  it('⛔ attesting C4 is refused — a query decides it', async () => {
    const f = await fixture('notick');
    await expect(
      asOrg(f.orgId, (tx) => attestStep(tx, f.admin, { stepCode: 'C4' })),
    ).rejects.toThrow(/cannot be ticked by hand/);
  });

  it('⛔ and B3 likewise', async () => {
    const f = await fixture('notickb3');
    await expect(
      asOrg(f.orgId, (tx) => attestStep(tx, f.admin, { stepCode: 'B3', storeId: f.storeId })),
    ).rejects.toThrow(/cannot be ticked by hand/);
  });

  it('⚠️ A1 and A2 are declared verified but CANNOT be checked here, and say so', async () => {
    const f = await fixture('cannotverify');
    const a1 = await stepOf(f, 'A1');
    expect(a1.def.kind).toBe('verified');
    // Honest: the query is over v1 data this database never holds.
    expect(a1.machineVerifiable).toBe(false);
    expect(a1.def.cannotVerifyHere).toMatch(/v2 holds no v1 data/);
    // So it accepts an attestation, unlike C4.
    await asOrg(f.orgId, (tx) => attestStep(tx, f.admin, { stepCode: 'A1' }));
    expect((await stepOf(f, 'A1')).done).toBe(true);
  });

  it('a per-store step refuses a single org-wide tick', async () => {
    const f = await fixture('perstore');
    await expect(
      asOrg(f.orgId, (tx) => attestStep(tx, f.admin, { stepCode: 'B1' })),
    ).rejects.toThrow(/hide a store nobody visited/);
  });

  it('⛔ staff cannot run any of it', async () => {
    const f = await fixture('staffdenied');
    await expect(
      asOrg(f.orgId, (tx) => attestStep(tx, f.staff, { stepCode: 'A3' })),
    ).rejects.toThrow(AuthorizationError);
  });

  it('an attestation records a named person, and renders as not machine-verifiable', async () => {
    const f = await fixture('attested');
    await asOrg(f.orgId, (tx) =>
      attestStep(tx, f.admin, { stepCode: 'A3', note: 'All four accounts reconciled.' }),
    );
    const a3 = await stepOf(f, 'A3');
    expect(a3.completion).toBe('attested');
    expect(a3.completedBy).toBe(f.adminId);
    expect(a3.machineVerifiable).toBe(false);
    expect(a3.completedAt).not.toBeNull();
  });
});

describe('B3 — an item silently absent is not an item counted as zero', () => {
  async function anItem(f: Fixture, name: string) {
    const item = await asOrg(f.orgId, (tx) =>
      createItem(tx, f.superAdmin, {
        code: uid('IT'), name: `${name} ${uid('n')}`, kind: 'raw_material', baseUnit: 'kg',
      }),
    );
    return item.id;
  }

  it('⭐ fails while an active item has no count, and names it', async () => {
    const f = await fixture('b3');
    await anItem(f, 'Beef');
    const b3 = await stepOf(f, 'B3');
    expect(b3.done).toBe(false);
    expect(b3.detail).toMatch(/no counted quantity/);
    expect(b3.detail).toMatch(/explicit zero/);
  });

  it('⭐ an explicit ZERO satisfies it — that is the whole point', async () => {
    const f = await fixture('b3zero');
    const itemId = await anItem(f, 'Pork');
    await asOrg(f.orgId, (tx) =>
      recordOpeningCount(tx, f.admin, { storeId: f.storeId, itemId, quantity: '0' }),
    );
    expect((await stepOf(f, 'B3')).done).toBe(true);
  });

  it('a counted quantity with no cost is reported as a gap, by name', async () => {
    const f = await fixture('nocost');
    const itemId = await anItem(f, 'Chicken');
    await asOrg(f.orgId, (tx) =>
      recordOpeningCount(tx, f.admin, { storeId: f.storeId, itemId, quantity: '10' }),
    );
    const gaps = await asOrg(f.orgId, (tx) => openingGaps(tx, f.orgId, '2027-01-01'));
    expect(gaps.countsWithoutCost).toHaveLength(1);
    expect(gaps.countsWithoutCost[0]!.name).toMatch(/Chicken/);
  });

  it('and it stops being a gap once valued', async () => {
    const f = await fixture('costed');
    const itemId = await anItem(f, 'Squid');
    await asOrg(f.orgId, (tx) =>
      recordOpeningCount(tx, f.admin, { storeId: f.storeId, itemId, quantity: '4', unitCost: '250' }),
    );
    const gaps = await asOrg(f.orgId, (tx) => openingGaps(tx, f.orgId, '2027-01-01'));
    expect(gaps.countsWithoutCost).toHaveLength(0);
    const value = await asOrg(f.orgId, (tx) => cutoverRepo.countedValue(tx, f.orgId));
    expect(Number(value)).toBe(1000);
  });
});

describe('the residual halts, and is visible the whole time', () => {
  async function openingLeg(f: Fixture, code: string, debit: string | null, credit: string | null, key: string) {
    await asOrg(f.orgId, (tx) =>
      postEntry(tx, {
        orgId: f.orgId,
        entryDate: '2027-01-01',
        sourceType: 'opening_balance',
        sourceId: key,
        idempotencyKey: key,
        memo: 'Opening balance',
        postedBy: f.adminId,
        lines: [
          { accountCode: code, storeId: f.storeId, ...(debit ? { debit } : {}), ...(credit ? { credit } : {}) },
          {
            accountCode: '3900',
            storeId: f.storeId,
            ...(debit ? { credit: debit } : { debit: credit! }),
          },
        ],
      }),
    );
  }

  it('⭐ the running residual is visible while entering, not revealed at the end', async () => {
    const f = await fixture('residual');
    // One side entered: cash in, equity out. 3900 now carries the other half.
    await openingLeg(f, '1110', '5000.00', null, uid('k'));
    const p = await progress(f);
    expect(Number(p.openingResidual)).toBe(5000);
    // ⛔ And C4 halts on it, naming the amount.
    const c4 = p.steps.find((s) => s.def.code === 'C4')!;
    expect(c4.done).toBe(false);
    expect(c4.detail).toMatch(/halts/);
    expect(c4.detail).toMatch(/no plug account/);
  });

  it('⭐ C4 holds only when 3900 nets to EXACTLY zero', async () => {
    const f = await fixture('netszero');
    await openingLeg(f, '1110', '5000.00', null, uid('k'));
    // The matching side, consuming the equity. ⚠️ Uses an account with NO requires_party — 2110
    // and 2500 both demand one, and the point of this test is the residual, not the subledger.
    await openingLeg(f, '1130', null, '5000.00', uid('k'));
    const p = await progress(f);
    expect(Number(p.openingResidual)).toBe(0);

    // ⭐ The CHECK holds — no halt message — but the step is still blocked, because C3 has not run.
    // A vacuous pass is exactly the false green the gate exists to prevent: on an empty ledger
    // "3900 nets to zero" is trivially true and means nothing.
    const c4 = p.steps.find((s) => s.def.code === 'C4')!;
    expect(c4.detail).toBeNull();
    expect(c4.done).toBe(false);
    expect(c4.blockedBy).toMatch(/C4 waits on C3/);

    // Once the opening entry step is recorded, the check is allowed to count.
    await asOrg(f.orgId, (tx) => attestStep(tx, f.admin, { stepCode: 'C2' }));
    await asOrg(f.orgId, (tx) => attestStep(tx, f.admin, { stepCode: 'C3' }));
    const after = await progress(f);
    expect(after.steps.find((s) => s.def.code === 'C4')!.done).toBe(true);
  });

  it('⛔ the double-counting guard finds a party with BOTH an opening lump and a pre-cutover doc', async () => {
    const f = await fixture('double');
    const [supplier] = await sql<{ id: string }[]>`
      insert into suppliers (org_id, name, status, created_by)
      values (${f.orgId}, ${`Supplier ${uid('s')}`}, 'active', ${f.adminId}) returning id`;

    // The opening lump.
    await asOrg(f.orgId, (tx) =>
      postEntry(tx, {
        orgId: f.orgId, entryDate: '2027-01-01', sourceType: 'opening_balance',
        sourceId: uid('op'), idempotencyKey: uid('op'), memo: 'Opening AP', postedBy: f.adminId,
        lines: [
          { accountCode: '3900', storeId: f.storeId, debit: '3000.00' },
          { accountCode: '2110', storeId: f.storeId, credit: '3000.00', partyType: 'supplier', partyId: supplier!.id },
        ],
      }),
    );
    // ...and a re-entered invoice dated BEFORE the conversion, for the same supplier.
    await asOrg(f.orgId, (tx) =>
      postEntry(tx, {
        orgId: f.orgId, entryDate: '2026-12-20', sourceType: 'supplier_invoice',
        sourceId: uid('inv'), idempotencyKey: uid('inv'), memo: 'December invoice', postedBy: f.adminId,
        lines: [
          { accountCode: '6300', storeId: f.storeId, debit: '3000.00' },
          { accountCode: '2110', storeId: f.storeId, credit: '3000.00', partyType: 'supplier', partyId: supplier!.id },
        ],
      }),
    );

    const gaps = await asOrg(f.orgId, (tx) => openingGaps(tx, f.orgId, '2027-01-01'));
    // ⭐ The same money, counted twice. Guarded by NAMING it, not by hoping.
    expect(gaps.doubleCounted).toHaveLength(1);
    expect(gaps.doubleCounted[0]!.partyId).toBe(supplier!.id);
  });
});
