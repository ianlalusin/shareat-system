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
  addOpeningFigure,
  removeOpeningFigure,
  postOpeningBalances,
} from '@shareat/domain';
import { postEntry } from '../../src/ledger/post-entry';
import { testItemCode } from './_fixtures/item-code';

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
  const [locType] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${orgId}, 'STK', 'Stockroom') returning id`;
  await sql`insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by) values (${orgId}, ${store!.id}, 'KIT', 'Kitchen', ${locType!.id}, 'operating', true, ${adminId})`; // T-390 R1: a count needs a default room

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
    expect(b1.blockedBy).toMatch(/values the newest stock at nothing/);
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
    // ⚠️ Asserts the SUBSTANCE, not the wording — this string is user-facing copy and will be
    // reworded again. What must not change is that it says why nobody can check it here.
    expect(a1.def.cannotVerifyHere).toMatch(/old system/);
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
        code: testItemCode(), name: `${name} ${uid('n')}`, kind: 'raw_material', baseUnit: 'kg',
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
      recordOpeningCount(tx, f.admin, { storeId: f.storeId, itemId, quantity: '4', unitCost: '250', costSource: 'typed' }),
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

// =========================================================================================
// C3 and C5 — entering the opening balances, and the act that opens the books
// =========================================================================================

describe('the opening balances', () => {
  const DATE = '2027-01-01';

  it('⭐ a figure is a BALANCED draft against 3900, and the residual moves', async () => {
    const f = await fixture('openfig');
    await asOrg(f.orgId, (tx) =>
      addOpeningFigure(tx, f.admin, {
        accountCode: '1110', storeId: f.storeId, direction: 'debit',
        amount: '5000.00', entryDate: DATE,
      }),
    );
    const p = await progress(f);
    // Cash in one side, equity the other — so 3900 carries the whole thing until its match arrives.
    expect(Number(p.openingResidual)).toBe(5000);

    // ⚠️ And the trial balance NEVER drifts, even mid-entry: each figure balances on its own.
    expect(Number(p.trialBalanceDrift)).toBe(0);
  });

  it('the matching side nets 3900 to zero, and C4 then holds', async () => {
    const f = await fixture('opennets');
    await asOrg(f.orgId, (tx) =>
      addOpeningFigure(tx, f.admin, {
        accountCode: '1110', storeId: f.storeId, direction: 'debit', amount: '5000.00', entryDate: DATE,
      }),
    );
    await asOrg(f.orgId, (tx) =>
      addOpeningFigure(tx, f.admin, {
        // ⚠️ An account with NO requires_party — the point here is the residual, not the subledger.
        accountCode: '1130', storeId: f.storeId, direction: 'credit', amount: '5000.00', entryDate: DATE,
      }),
    );
    const p = await progress(f);
    expect(Number(p.openingResidual)).toBe(0);
  });

  it('⛔ 3900 itself cannot be entered as a figure — that would be plugging the difference', async () => {
    const f = await fixture('noplug');
    await expect(
      asOrg(f.orgId, (tx) =>
        addOpeningFigure(tx, f.admin, {
          accountCode: '3900', storeId: f.storeId, direction: 'credit', amount: '100.00', entryDate: DATE,
        }),
      ),
    ).rejects.toThrow(/not a figure of its own/);
  });

  it('re-entering the same figure updates rather than doubling it', async () => {
    const f = await fixture('openidem');
    const args = {
      accountCode: '1110', storeId: f.storeId, direction: 'debit' as const,
      amount: '5000.00', entryDate: DATE,
    };
    const a = await asOrg(f.orgId, (tx) => addOpeningFigure(tx, f.admin, args));
    const b = await asOrg(f.orgId, (tx) => addOpeningFigure(tx, f.admin, args));
    expect(b.entryId).toBe(a.entryId);
    const p = await progress(f);
    // ⭐ Still 5,000 — not 10,000. Entering the list over several days has to be safe to retry.
    expect(Number(p.openingResidual)).toBe(5000);
  });

  it('a draft figure can simply be deleted — it was never final', async () => {
    const f = await fixture('openremove');
    const { entryId } = await asOrg(f.orgId, (tx) =>
      addOpeningFigure(tx, f.admin, {
        accountCode: '1110', storeId: f.storeId, direction: 'debit', amount: '900.00', entryDate: DATE,
      }),
    );
    expect(Number((await progress(f)).openingResidual)).toBe(900);
    await asOrg(f.orgId, (tx) => removeOpeningFigure(tx, f.admin, { entryId }));
    expect(Number((await progress(f)).openingResidual)).toBe(0);
  });

  it('⛔ posting refuses while 3900 still carries a residual — and there is no override', async () => {
    const f = await fixture('openhalt');
    await asOrg(f.orgId, (tx) =>
      addOpeningFigure(tx, f.admin, {
        accountCode: '1110', storeId: f.storeId, direction: 'debit', amount: '5000.00', entryDate: DATE,
      }),
    );
    await expect(
      asOrg(f.orgId, (tx) => postOpeningBalances(tx, f.admin)),
    ).rejects.toThrow(/no plug account/);
  });

  it('⭐ posting a balanced set opens the books, and records C5', async () => {
    const f = await fixture('openpost');
    await asOrg(f.orgId, (tx) =>
      addOpeningFigure(tx, f.admin, {
        accountCode: '1110', storeId: f.storeId, direction: 'debit', amount: '5000.00', entryDate: DATE,
      }),
    );
    await asOrg(f.orgId, (tx) =>
      addOpeningFigure(tx, f.admin, {
        accountCode: '1130', storeId: f.storeId, direction: 'credit', amount: '5000.00', entryDate: DATE,
      }),
    );
    const result = await asOrg(f.orgId, (tx) => postOpeningBalances(tx, f.admin));
    expect(result.posted).toBe(2);

    const [row] = await sql<{ n: string }[]>`
      select count(*)::text as n from journal_entries
      where org_id = ${f.orgId} and source_type = 'opening_balance' and status = 'posted'`;
    expect(row!.n).toBe('2');

    const c5 = await stepOf(f, 'C5');
    expect(c5.completion).toBe('performed');
  });

  it('⛔ a POSTED figure can no longer be deleted — invariant 5 starts at the post', async () => {
    const f = await fixture('openposted');
    const { entryId } = await asOrg(f.orgId, (tx) =>
      addOpeningFigure(tx, f.admin, {
        accountCode: '1110', storeId: f.storeId, direction: 'debit', amount: '400.00', entryDate: DATE,
      }),
    );
    await asOrg(f.orgId, (tx) =>
      addOpeningFigure(tx, f.admin, {
        accountCode: '1130', storeId: f.storeId, direction: 'credit', amount: '400.00', entryDate: DATE,
      }),
    );
    await asOrg(f.orgId, (tx) => postOpeningBalances(tx, f.admin));
    await expect(
      asOrg(f.orgId, (tx) => removeOpeningFigure(tx, f.admin, { entryId })),
    ).rejects.toThrow(/already been posted/);
  });

  it('⛔ posting nothing is refused, rather than quietly succeeding', async () => {
    const f = await fixture('opennone');
    await expect(
      asOrg(f.orgId, (tx) => postOpeningBalances(tx, f.admin)),
    ).rejects.toThrow(/no opening figures to post/);
  });
});

describe('DEF-272 — a sub-centavo amount is refused with a written sentence, not driver text', () => {
  const DATE = '2027-01-01';

  // ⭐ Found by the shape scanner, not in the T-260 spec's original known-sites table — and a real
  // instance: before the fix, "1.234" silently became "1.23" via `.toFixed(2)` on the way into the
  // journal lines, with nothing refusing it (no `Number(x)<=0` bypass involved at all — the guard
  // was `!(amount > 0)` on a variable, not a literal comparison the old census could spot).
  it('addOpeningFigure refuses "0.004"', async () => {
    const f = await fixture('def272-open');
    await expect(
      asOrg(f.orgId, (tx) =>
        addOpeningFigure(tx, f.admin, {
          accountCode: '1110', storeId: f.storeId, direction: 'debit', amount: '0.004', entryDate: DATE,
        }),
      ),
    ).rejects.toThrow(/addOpeningFigure: the amount.*"0\.004"/);
  });

  it('addOpeningFigure refuses "1.234" — previously silently truncated to "1.23" via toFixed(2)', async () => {
    const f = await fixture('def272-precision');
    await expect(
      asOrg(f.orgId, (tx) =>
        addOpeningFigure(tx, f.admin, {
          accountCode: '1110', storeId: f.storeId, direction: 'debit', amount: '1.234', entryDate: DATE,
        }),
      ),
    ).rejects.toThrow(/"1\.234"/);
  });

  it('an ordinary figure still works, and the exact value posts on both legs', async () => {
    const f = await fixture('def272-happy');
    const { entryId } = await asOrg(f.orgId, (tx) =>
      addOpeningFigure(tx, f.admin, {
        accountCode: '1110', storeId: f.storeId, direction: 'debit', amount: '0.01', entryDate: DATE,
      }),
    );
    const [row] = await sql<{ debit: string }[]>`
      select debit::text from journal_lines where entry_id = ${entryId} order by debit desc limit 1
    `;
    expect(row!.debit).toBe('0.01');
  });
});

describe('T-343 S5.3 — removeOpeningFigure’s gone-entry refusal, in human terms', () => {
  it('userMessage is the S3 gone sentence, no UUID', async () => {
    const f = await fixture('s5-3-opening');
    const missingEntryId = crypto.randomUUID();

    const caught = await asOrg(f.orgId, (tx) => removeOpeningFigure(tx, f.admin, { entryId: missingEntryId })).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(caught, 'the removal was not refused at all').not.toBeNull();
    expect(caught!.message).toContain(missingEntryId);
    const userMessage = (caught as { userMessage?: string }).userMessage;
    expect(userMessage, 'must carry a userMessage').toBeDefined();
    expect(userMessage).toMatch(/^That opening figure could not be found\./);
    expect(userMessage).not.toContain(missingEntryId);
  }, 30000);
});

describe('T-343 S5.3b — R2: addOpeningFigure’s amount refusal carries a human userMessage', () => {
  it('amount "1.234": userMessage is capitalised, names neither addOpeningFigure nor the lower-case "the amount —" fragment (was no userMessage at all)', async () => {
    const f = await fixture('s5-3b-r2');

    const caught = await asOrg(f.orgId, (tx) =>
      addOpeningFigure(tx, f.admin, {
        accountCode: '1110', storeId: f.storeId, direction: 'debit', amount: '1.234', entryDate: '2027-01-01',
      }),
    ).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(caught, 'the bad amount was not refused at all').not.toBeNull();
    // ⛔ Raw stays byte-identical — R1.5's own promise, re-asserted here (R2's ⛔ half).
    expect(caught!.message).toBe('addOpeningFigure: the amount — "1.234" is not a valid amount. Use at most two decimal places.');
    const userMessage = (caught as unknown as { userMessage?: string }).userMessage;
    expect(userMessage, 'must carry a userMessage').toBeDefined();
    expect(userMessage).toMatch(/^[A-Z]/);
    expect(userMessage).not.toContain('addOpeningFigure');
    expect(userMessage).not.toContain('the amount —');
  }, 30000);
});
