import { afterAll, describe, expect, it } from 'vitest';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-390 S3 - `valueOpeningAsset`. `docs/tasks/390-opening-stock-and-subledger-tieout.md` s4 R10, R8/R13 (this writer), s5.2, s8
 * tests 19 and the `valueOpeningAsset` leg of 14a. Written TESTER-FIRST: red until `domain/cutover/opening-assets.ts` exists and
 * is exported.
 *
 * ⛔ 14a covers ONE of its writers here. `recordOpeningCount` is S1's and is already tested there; `addOpeningFigure`,
 * `removeOpeningFigure` and `valueOpeningStock` take the shared lock in S2 and carry their own 14a legs in S2's tests.
 */
import { closeDb, RefusalError, type Tx } from '@shareat/db';
import { AuthorizationError } from '@shareat/auth';
import {
  CONVERSION, asOrg, cutoverRepo, errorOf, figure, fixture, mkAsset, mkShell, need, settle3900, sql, tieOut, uid, sentences,
  type Fixture,
} from './t390-s3-common';

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

interface ValueInput {
  assetId: string;
  bookValue: string;
  remainingLifeMonths: number;
  salvageValue?: string;
}
const value = (f: Fixture, input: ValueInput, actor = f.admin) =>
  asOrg(f.orgId, (tx) =>
    need<(tx: Tx, actor: unknown, input: ValueInput) => Promise<unknown>>('valueOpeningAsset')(tx, actor, input),
  );

interface AssetRow {
  status: string;
  cost: string | null;
  acquired_on: string | null;
  useful_life_months: number;
  salvage_value: string | null;
}
const assetRow = async (id: string) => {
  const [r] = await sql<AssetRow[]>`
    select status, cost::text, acquired_on::text, useful_life_months, salvage_value::text from fixed_assets where id = ${id}`;
  return r!;
};

describe('test 19 - valueOpeningAsset (kills M21)', () => {
  it('sets cost = book value, acquired_on = 2027-01-01 (NOT the original date), life = REMAINING months, and activates the shell', async () => {
    const f = await fixture('va-set');
    const shell = await mkShell(f, f.storeA);
    await value(f, { assetId: shell.id, bookValue: '7500.00', remainingLifeMonths: 18, salvageValue: '500.00' });
    const r = await assetRow(shell.id);
    expect(r.status).toBe('active');
    expect(Number(r.cost)).toBe(7500);
    expect(r.acquired_on, 'acquired_on must be the conversion date, so depreciation starts there (row 109)').toBe(CONVERSION);
    expect(r.useful_life_months).toBe(18);
    expect(Number(r.salvage_value)).toBe(500);
  });

  it('with no salvage given the asset is valued with zero salvage', async () => {
    const f = await fixture('va-nosalv');
    const shell = await mkShell(f, f.storeA);
    await value(f, { assetId: shell.id, bookValue: '1200.00', remainingLifeMonths: 12 });
    const r = await assetRow(shell.id);
    expect(r.status).toBe('active');
    expect(Number(r.salvage_value ?? 0)).toBe(0);
  });

  it('T2 then TIES once the 1510 figure equals the valued cost, and DOES NOT while it is typed 500.00 short', async () => {
    const f = await fixture('va-tie');
    const shell = await mkShell(f, f.storeA);
    await value(f, { assetId: shell.id, bookValue: '7500.00', remainingLifeMonths: 18 });
    await figure(f, { accountCode: '1510', storeId: f.storeA, direction: 'debit', amount: '7000.00' });
    await settle3900(f);
    const bad = await tieOut(f);
    expect(bad.holds, 'a 1510 figure 500.00 short of the valued assets must not tie').toBe(false);
    expect(bad.lines.some((l) => /500\.00/.test(l.sentence)), sentences(bad)).toBe(true);

    // Replace the figure with the right one: remove the draft, re-enter.
    const drafts = await asOrg(f.orgId, (tx) => cutoverRepo.openingDrafts(tx, f.orgId));
    for (const id of new Set(drafts.filter((d) => d.accountCode === '1510' || d.accountCode === '3300').map((d) => d.id))) {
      await asOrg(f.orgId, (tx) => need<(tx: Tx, a: unknown, i: { entryId: string }) => Promise<void>>('removeOpeningFigure')(tx, f.admin, { entryId: id }));
    }
    await figure(f, { accountCode: '1510', storeId: f.storeA, direction: 'debit', amount: '7500.00' });
    await settle3900(f);
    const good = await tieOut(f);
    expect(good.holds, sentences(good)).toBe(true);
  });

  it('a shell left PENDING shows in the tie-out by name; valuing it removes it', async () => {
    const f = await fixture('va-pending');
    const shell = await mkShell(f, f.storeA);
    const before = await tieOut(f);
    expect(before.holds).toBe(false);
    expect(before.lines.some((l) => l.sentence.includes(shell.name)), sentences(before)).toBe(true);
    await value(f, { assetId: shell.id, bookValue: '800.00', remainingLifeMonths: 6 });
    await figure(f, { accountCode: '1510', storeId: f.storeA, direction: 'debit', amount: '800.00' });
    await settle3900(f);
    const after = await tieOut(f);
    expect(after.holds, sentences(after)).toBe(true);
  });
});

describe('valueOpeningAsset refuses in words (s5.2: book value > 0, life 1-600 whole months, pending shells only)', () => {
  const refused = async (f: Fixture, input: ValueInput, message: RegExp) => {
    const err = await errorOf(value(f, input));
    expect(err, 'valueOpeningAsset accepted a bad input').toBeInstanceOf(RefusalError);
    expect((err as RefusalError).userMessage).toMatch(message);
    const r = await assetRow(input.assetId);
    expect(r.status, 'the refused call must leave the shell pending').toBe('pending_valuation');
  };

  it('book value zero or negative', async () => {
    const f = await fixture('va-zero');
    const shell = await mkShell(f, f.storeA);
    await refused(f, { assetId: shell.id, bookValue: '0', remainingLifeMonths: 12 }, /book value|greater than zero/i);
    await refused(f, { assetId: shell.id, bookValue: '-5.00', remainingLifeMonths: 12 }, /book value|greater than zero/i);
  });

  it('life of 0 months, 601 months, or a fraction of a month', async () => {
    const f = await fixture('va-life');
    const shell = await mkShell(f, f.storeA);
    await refused(f, { assetId: shell.id, bookValue: '100.00', remainingLifeMonths: 0 }, /month/i);
    await refused(f, { assetId: shell.id, bookValue: '100.00', remainingLifeMonths: 601 }, /month/i);
    await refused(f, { assetId: shell.id, bookValue: '100.00', remainingLifeMonths: 12.5 }, /month/i);
  });

  it('audit 6: salvage equal to or above book value is refused with a plain sentence (no raw constraint text)', async () => {
    const f = await fixture('va-salv');
    const shell = await mkShell(f, f.storeA);
    for (const salvage of ['1000.00', '1500.00']) {
      const err = await errorOf(value(f, { assetId: shell.id, bookValue: '1000.00', remainingLifeMonths: 12, salvageValue: salvage }));
      expect(err, 'salvage >= book value was not refused as a RefusalError').toBeInstanceOf(RefusalError);
      const msg = (err as RefusalError).userMessage;
      expect(msg).toMatch(/salvage/i);
      expect(msg).not.toMatch(/constraint|violates|fixed_assets_|check/i);
    }
    expect((await assetRow(shell.id)).status).toBe('pending_valuation');
  });

  it('the boundaries 1 and 600 are accepted', async () => {
    const f = await fixture('va-bounds');
    const a = await mkShell(f, f.storeA);
    const b = await mkShell(f, f.storeA);
    await value(f, { assetId: a.id, bookValue: '100.00', remainingLifeMonths: 1 });
    await value(f, { assetId: b.id, bookValue: '100.00', remainingLifeMonths: 600 });
    expect((await assetRow(a.id)).useful_life_months).toBe(1);
    expect((await assetRow(b.id)).useful_life_months).toBe(600);
  });

  it('an asset that is already ACTIVE (not a pending shell) is refused, and its cost is untouched', async () => {
    const f = await fixture('va-active');
    const id = await mkAsset(f, f.storeA, '5000.00', '2026-03-01');
    const err = await errorOf(value(f, { assetId: id, bookValue: '100.00', remainingLifeMonths: 12 }));
    expect(err).toBeInstanceOf(RefusalError);
    const r = await assetRow(id);
    expect(Number(r.cost)).toBe(5000);
    expect(r.acquired_on).toBe('2026-03-01');
  });

  it('an asset that does not exist (or is another organisation\'s) is refused', async () => {
    const f = await fixture('va-gone');
    const other = await fixture('va-gone-other');
    const theirs = await mkShell(other, other.storeA);
    for (const id of ['00000000-0000-4000-8000-0000000000aa', theirs.id]) {
      const err = await errorOf(value(f, { assetId: id, bookValue: '100.00', remainingLifeMonths: 12 }));
      expect(err, `valuing ${id} was not refused`).toBeInstanceOf(RefusalError);
    }
    expect((await assetRow(theirs.id)).status).toBe('pending_valuation');
  });

  it('run_cutover is required on the asset\'s store: staff are refused and the shell stays pending', async () => {
    const f = await fixture('va-auth');
    const shell = await mkShell(f, f.storeA);
    const err = await errorOf(value(f, { assetId: shell.id, bookValue: '100.00', remainingLifeMonths: 12 }, f.staff));
    expect(err).toBeInstanceOf(AuthorizationError);
    expect((await assetRow(shell.id)).status).toBe('pending_valuation');
  });
});

describe('R8 - valueOpeningAsset needs the purge (C2) and refuses once the books are open', () => {
  it('before the purge (no C2 row) it is refused with the purge sentence', async () => {
    const f = await fixture('va-noc2');
    await sql`delete from cutover_steps where org_id = ${f.orgId} and step_code = 'C2'`;
    const shell = await mkShell(f, f.storeA);
    const err = await errorOf(value(f, { assetId: shell.id, bookValue: '100.00', remainingLifeMonths: 12 }));
    expect(err).toBeInstanceOf(RefusalError);
    expect((err as RefusalError).userMessage).toMatch(/purge/i);
    expect((await assetRow(shell.id)).status).toBe('pending_valuation');
  });

  it('after a POSTED opening it is refused in words ("the books were opened"), and the shell stays pending', async () => {
    const f = await fixture('va-posted');
    const shell = await mkShell(f, f.storeA);
    await asOrg(f.orgId, (tx) =>
      need<(tx: Tx, input: unknown) => Promise<unknown>>('postEntry')(tx, {
        orgId: f.orgId, entryDate: CONVERSION, sourceType: 'opening_balance', sourceId: uid('op'), idempotencyKey: uid('op'),
        memo: 'Opening balance', postedBy: f.adminId,
        lines: [
          { accountCode: '1110', storeId: f.storeA, debit: '100.00' },
          { accountCode: '3900', storeId: f.storeA, credit: '100.00' },
        ],
      }),
    );
    const err = await errorOf(value(f, { assetId: shell.id, bookValue: '100.00', remainingLifeMonths: 12 }));
    expect(err).toBeInstanceOf(RefusalError);
    expect((err as RefusalError).userMessage).toMatch(/books were opened/i);
    expect((await assetRow(shell.id)).status).toBe('pending_valuation');
  });
});

describe('R13 / test 14a, valueOpeningAsset leg - it takes the SHARED opening lock before its R8 check (kills M28)', () => {
  const settle = (ms: number) => new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms));

  it('while C5 holds the EXCLUSIVE lock valueOpeningAsset BLOCKS; once the post commits it is refused by R8 and the shell stays pending', async () => {
    const f = await fixture('va-lock');
    const shell = await mkShell(f, f.storeA);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const lockedP = new Promise<void>((r) => (locked = r));

    // Connection 1 stands in for postOpeningBalances: exclusive lock, post the opening, hold the transaction open.
    const conn1 = asOrg(f.orgId, async (tx) => {
      await tx.execute(dsql`select pg_advisory_xact_lock(390001, hashtext(${f.orgId}::text))`);
      await need<(tx: Tx, input: unknown) => Promise<unknown>>('postEntry')(tx, {
        orgId: f.orgId, entryDate: CONVERSION, sourceType: 'opening_balance', sourceId: uid('op'), idempotencyKey: uid('op'),
        memo: 'Opening balance', postedBy: f.adminId,
        lines: [
          { accountCode: '1110', storeId: f.storeA, debit: '100.00' },
          { accountCode: '3900', storeId: f.storeA, credit: '100.00' },
        ],
      });
      locked();
      await gate;
    });

    let conn2: Promise<unknown> = Promise.resolve(null);
    try {
      await lockedP;
      conn2 = errorOf(value(f, { assetId: shell.id, bookValue: '100.00', remainingLifeMonths: 12 }));
      const early = await Promise.race([conn2, settle(1500)]);
      expect(early, 'valueOpeningAsset did not wait for the exclusive lock (no shared lock before its R8 check)').toBe('timeout');
    } finally {
      release();
      await conn1;
    }
    const outcome = await conn2;
    expect(outcome).toBeInstanceOf(RefusalError);
    expect((outcome as RefusalError).userMessage).toMatch(/books were opened/i);
    expect((await assetRow(shell.id)).status).toBe('pending_valuation');
  }, 60_000);

  it('a SHARED holder does not block it (writers run side by side; an exclusive lock in the writer fails this)', async () => {
    const f = await fixture('va-lockshared');
    const shell = await mkShell(f, f.storeA);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const lockedP = new Promise<void>((r) => (locked = r));
    const conn1 = asOrg(f.orgId, async (tx) => {
      await tx.execute(dsql`select pg_advisory_xact_lock_shared(390001, hashtext(${f.orgId}::text))`);
      locked();
      await gate;
    });
    try {
      await lockedP;
      const outcome = await Promise.race([
        value(f, { assetId: shell.id, bookValue: '100.00', remainingLifeMonths: 12 }).then(() => 'wrote' as const),
        settle(5000),
      ]);
      expect(outcome).toBe('wrote');
    } finally {
      release();
      await conn1;
    }
    expect((await assetRow(shell.id)).status).toBe('active');
  }, 60_000);
});
