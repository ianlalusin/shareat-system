import { testItemCode } from '../../packages/domain/tests/integration/_fixtures/item-code';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-390 S2 - opening stock (DEF-623 core). `docs/tasks/390-opening-stock-and-subledger-tieout.md` s4 R5, R5a, R6-R8, R13, R14, R17,
 * s5.2, s6 I1-I5 and I7, s8 tests 8, 9, 9a, 10, 10a, 11, 12, 13, 14, 14a, 15 (S2 part), and T1 of s5.3 (T1 lives HERE, not in
 * t390-s3-tie-out.test.ts: that file's fixture is the S3 one and says T1 "lands with S2").
 *
 * TESTER-first: red until `valueOpeningStock`, `planOpeningStock`, the C5 stock write, the purge's C2 row, R6/R8/R13 and T1 exist.
 * Every C2 here is reached through the REAL `applyPurge` (`t390-real-purge.ts`), never a hand-inserted `cutover_steps` row, except the
 * ONE `attested` row that proves R8 does not accept it.
 *
 * ⚠️ SPEC DEFECT (reported): s8 test 10a says the inventory draft holds `raw_material` + `supply` + `prepped` (three lines), but
 * `items_kind_check` (migration 0047) allows only raw_material, supply, retail, meat_slab, meat_sliced, so 1330 is unreachable from a
 * real item. Test 10a here uses 1310 + 1320 (two lines in one draft); `prepped` -> 1330 is pinned in the unit test only.
 */
import { closeDb, stockLayersRepo } from '@shareat/db';
import { AuthorizationError } from '@shareat/auth';
import {
  EXPECT, asOrg, attestC3P, count, defer, domain, errorOf, needS2, onHand, openingEntryStatuses, openingLayers,
  openingMovements, post, postedOpeningLine, primePool, readyToPost, s2fixture, sentenceOf, settle3900, sleep, sql, standardCounts, uid, value,
  type LayerRow, type S2Fixture,
} from './t390-s2-common';
import { CONVERSION, peso, sentenceWith, sentences, tieOut, type TieOut } from './t390-s3-common';

const asS3 = (f: S2Fixture) => f as unknown as Parameters<typeof tieOut>[0];
const tie = (f: S2Fixture): Promise<TieOut> => tieOut(asS3(f));

beforeAll(async () => {
  await primePool(34);
}, 300_000);

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

/** The figure as a money-account style line: Dr `accountCode` / Cr 3900, entered through the real domain function. */
const figure = (f: S2Fixture, accountCode: string, amount: string, storeId = f.storeA, direction: 'debit' | 'credit' = 'debit') =>
  asOrg(f.orgId, (tx) =>
    domain.addOpeningFigure(tx, f.admin, { accountCode, storeId, direction, amount, entryDate: CONVERSION }),
  );

const entriesWithKey = async (orgId: string, like: string) =>
  sql<{ id: string; status: string; idempotency_key: string }[]>`
    select id, status, idempotency_key from journal_entries where org_id = ${orgId} and idempotency_key like ${like}`;

const linesOf = (entryId: string) =>
  sql<{ code: string; debit: string; credit: string; store_id: string }[]>`
    select a.code, jl.debit::text, jl.credit::text, jl.store_id
    from journal_lines jl join accounts a on a.id = jl.account_id where jl.entry_id = ${entryId} order by a.code`;

const PURGE_SENTENCE = /The purge \(C2\) has not run\./;
const OPENED_SENTENCE = /The books were opened on/;

// =============================================================================================================================
// R5 - valueOpeningStock (test 8, kills M8)
// =============================================================================================================================

describe('R5 - valueOpeningStock writes one generated draft per store (test 8, kills M8)', () => {
  it('Dr 1310 / Dr 1320 / Cr 3900 at the store, dated 2027-01-01, idempotency key opening-stock:{org}:{store}; returns the figures', async () => {
    const f = await s2fixture('value-lines');
    await standardCounts(f);
    const r = await value(f, f.storeA);
    expect(r, 'valueOpeningStock returned null for a store with valuable counts').not.toBeNull();
    const byAccount = Object.fromEntries(r!.byAccount.map((l) => [l.code, Number(l.amount).toFixed(2)]));
    expect(byAccount).toEqual(EXPECT.A);

    const [entry] = await sql<{ status: string; entry_date: string; source_type: string; idempotency_key: string }[]>`
      select status, entry_date::text, source_type, idempotency_key from journal_entries where id = ${r!.entryId}`;
    expect(entry!.status).toBe('draft');
    expect(entry!.entry_date).toBe(CONVERSION);
    expect(entry!.source_type).toBe('opening_balance');
    expect(entry!.idempotency_key).toBe(`opening-stock:${f.orgId}:${f.storeA}`);

    const lines = await linesOf(r!.entryId);
    // Only non-zero accounts: no 1330 line. One rounding per item per store: 800.00 + 49.33 + 0.02 = 849.35.
    expect(lines.map((l) => [l.code, Number(l.debit).toFixed(2), Number(l.credit).toFixed(2)])).toEqual([
      ['1310', '849.35', '0.00'],
      ['1320', '25.00', '0.00'],
      ['3900', '0.00', '874.35'],
    ]);
    expect(new Set(lines.map((l) => l.store_id))).toEqual(new Set([f.storeA]));
  });

  it('pressing it twice leaves exactly ONE draft per store, and its figures are the SECOND call\'s counts (kills M8: second draft added)', async () => {
    const f = await s2fixture('value-twice');
    await standardCounts(f);
    await value(f, f.storeA);
    await count(f, { store: f.storeA, room: f.kitA, item: f.raw, qty: '6', cost: '100.0000' }); // 5 -> 6: +100.00
    const second = await value(f, f.storeA);

    const drafts = await entriesWithKey(f.orgId, `opening-stock:${f.orgId}:${f.storeA}`);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.status).toBe('draft');
    expect(drafts[0]!.id).toBe(second!.entryId);
    const line = (await linesOf(second!.entryId)).find((l) => l.code === '1310')!;
    expect(Number(line.debit).toFixed(2)).toBe('949.35');
    // The other store's key is separate: A's press never touches B.
    expect(await entriesWithKey(f.orgId, `opening-stock:${f.orgId}:${f.storeB}`)).toHaveLength(0);
  });

  it('a store whose counts are worth nothing: returns null and REMOVES the old draft', async () => {
    const f = await s2fixture('value-null');
    await standardCounts(f);
    const first = await value(f, f.storeB);
    expect(first).not.toBeNull();
    await count(f, { store: f.storeB, room: f.barB, item: f.raw, qty: '0' });
    const again = await value(f, f.storeB);
    expect(again).toBeNull();
    expect(await entriesWithKey(f.orgId, `opening-stock:${f.orgId}:${f.storeB}`)).toHaveLength(0);
  });

  it('refuses a counted quantity with no cost and lists at most five item names', async () => {
    const f = await s2fixture('value-nocost');
    const extra: string[] = [];
    for (let i = 0; i < 7; i++) {
      const nm = `Unpriced ${i} ${uid('x')}`;
      const [it] = await sql<{ id: string }[]>`
        insert into items (org_id, code, name, kind, base_unit, created_by) values (${f.orgId}, ${testItemCode()}, ${nm}, 'raw_material', 'kg', ${f.adminId}) returning id`;
      extra.push(nm);
      await count(f, { store: f.storeB, room: f.barB, item: it!.id, qty: '2' });
    }
    const err = await errorOf(value(f, f.storeB));
    expect(err, 'valueOpeningStock valued counts that have no cost').not.toBeNull();
    const text = sentenceOf(err);
    const named = extra.filter((n) => text.includes(n));
    expect(named.length, `the sentence names none of the items: ${text}`).toBeGreaterThanOrEqual(1);
    expect(named.length, `the sentence names more than five items: ${text}`).toBeLessThanOrEqual(5);
    expect(await entriesWithKey(f.orgId, `opening-stock:${f.orgId}:${f.storeB}`)).toHaveLength(0);
  });

  it('refuses when one item carries two costs in one store (R3 re-check), naming the item and the store', async () => {
    const f = await s2fixture('value-r3');
    await count(f, { store: f.storeA, room: f.kitA, item: f.raw, qty: '5', cost: '100.0000' });
    await count(f, { store: f.storeA, room: f.frzA, item: f.raw, qty: '3', cost: '100.0000' });
    // A cost the domain would never write: the two rooms of ONE item disagree.
    await sql`update opening_counts set unit_cost = 101 where org_id = ${f.orgId} and store_id = ${f.storeA} and location_id = ${f.frzA} and item_id = ${f.raw}`;
    const err = await errorOf(value(f, f.storeA));
    expect(err, 'two costs for one item in one store were valued').not.toBeNull();
    const text = sentenceOf(err);
    expect(text).toContain(f.names.raw!);
    expect(text).toContain(f.nameA);
    expect(await entriesWithKey(f.orgId, `opening-stock:${f.orgId}:%`)).toHaveLength(0);
  });

  it('staff cannot value the count', async () => {
    const f = await s2fixture('value-staff');
    await standardCounts(f);
    const err = await errorOf(value(f, f.storeA, f.staff));
    expect(err).toBeInstanceOf(AuthorizationError);
  });
});

// =============================================================================================================================
// R6 - typing an inventory or 1590 figure is refused (test 15, S2 part, kills M16)
// =============================================================================================================================

describe('R6 - typing 1310, 1320, 1330 or 1590 is refused (test 15, kills M16)', () => {
  for (const code of ['1310', '1320', '1330']) {
    it(`${code}: "Inventory opens from the count", and nothing is drafted`, async () => {
      const f = await s2fixture(`r6-${code}`);
      const err = await errorOf(figure(f, code, '100.00'));
      expect(err, `a typed ${code} figure was accepted`).not.toBeNull();
      expect(sentenceOf(err)).toMatch(/Inventory opens from the count/);
      expect(await openingEntryStatuses(f.orgId)).toEqual([]);
    });
  }

  it('1590: assets open at net book value, so accumulated depreciation opens at zero', async () => {
    const f = await s2fixture('r6-1590');
    const err = await errorOf(figure(f, '1590', '100.00', f.storeA, 'credit'));
    expect(err, 'a typed 1590 figure was accepted').not.toBeNull();
    expect(sentenceOf(err)).toMatch(/net book value/i);
    expect(await openingEntryStatuses(f.orgId)).toEqual([]);
  });

  it('control: an ordinary figure is still accepted on a purged database', async () => {
    const f = await s2fixture('r6-control');
    const r = await figure(f, '1130', '100.00');
    expect(r.entryId).toBeTruthy();
  });
});

// =============================================================================================================================
// R8 - C2 first (tests 9, 9a, kill M9, M9a, M9b)
// =============================================================================================================================

describe('R8 - nothing opening-related works before the purge (test 9, kills M9)', () => {
  it('addOpeningFigure, valueOpeningStock and postOpeningBalances all refuse with the purge sentence; a COUNT is still accepted', async () => {
    const f = await s2fixture('r8-none', 'none');
    // The count is 31 Dec and the purge is 1 Jan: recording it before C2 must work (opening_counts is KEEP).
    await count(f, { store: f.storeA, room: f.kitA, item: f.raw, qty: '5', cost: '100.0000' });
    const counted = await sql<{ n: string }[]>`select count(*)::text as n from opening_counts where org_id = ${f.orgId}`;
    expect(Number(counted[0]!.n)).toBe(1);

    const add = await errorOf(figure(f, '1130', '100.00'));
    expect(add, 'addOpeningFigure worked before the purge').not.toBeNull();
    expect(sentenceOf(add)).toMatch(PURGE_SENTENCE);

    const val = await errorOf(value(f, f.storeA));
    expect(val, 'valueOpeningStock worked before the purge').not.toBeNull();
    expect(sentenceOf(val)).toMatch(PURGE_SENTENCE);

    // No figures exist, and the purge sentence must still win: R8 is checked BEFORE "there are no opening figures to post".
    const p = await errorOf(post(f));
    expect(p, 'postOpeningBalances worked before the purge').not.toBeNull();
    expect(sentenceOf(p)).toMatch(PURGE_SENTENCE);

    expect(await openingEntryStatuses(f.orgId)).toEqual([]);
  });
});

describe('R8 / test 9a - C2 is written by the REAL purge and only `performed` satisfies it (kills M9a, M9b)', () => {
  it('an `attested` C2 row does not satisfy R8 (kills M9b: any completion accepted)', async () => {
    const f = await s2fixture('r8-attested', 'attested');
    const add = await errorOf(figure(f, '1130', '100.00'));
    expect(add, 'an attested C2 opened the gate').not.toBeNull();
    expect(sentenceOf(add)).toMatch(PURGE_SENTENCE);
    await count(f, { store: f.storeA, room: f.kitA, item: f.raw, qty: '5', cost: '100.0000' });
    const val = await errorOf(value(f, f.storeA));
    expect(sentenceOf(val)).toMatch(PURGE_SENTENCE);
  });

  it('attestStep("C2") is refused: the purge records it itself', async () => {
    const f = await s2fixture('r8-attest-c2', 'none');
    const err = await errorOf(asOrg(f.orgId, (tx) => domain.attestStep(tx, f.admin, { stepCode: 'C2' })));
    expect(err, 'C2 could be ticked by hand').not.toBeNull();
    const text = `${sentenceOf(err)} ${(err as Error).message}`;
    expect(text).toContain('The purge records this itself when it runs.');
    const rows = await sql`select 1 from cutover_steps where org_id = ${f.orgId} and step_code = 'C2'`;
    expect(rows).toHaveLength(0);
  });

  it('applyPurge(..., {performedBy}) writes exactly one `C2 performed` row per org, by that person, with the row-count note; a rehearsal leaves none', async () => {
    const { realPurge } = await import('./t390-real-purge');
    const a = await s2fixture('r8-9a-a', 'none');
    const b = await s2fixture('r8-9a-b', 'none');
    const c2Rows = (orgId: string) =>
      sql<{ completion: string; completed_by: string; note: string | null }[]>`
        select completion, completed_by, note from cutover_steps where org_id = ${orgId} and step_code = 'C2'`;

    // Rehearsal: the full purge inside a transaction that ALWAYS rolls back. The C2 row rolls back with everything else.
    await realPurge(sql, a.adminId, { rollback: true });
    expect(await c2Rows(a.orgId), 'a rehearsal left a C2 row (kills M9a: the row is written outside the purge transaction)').toHaveLength(0);
    expect(await c2Rows(b.orgId)).toHaveLength(0);

    await realPurge(sql, { [a.orgId]: a.adminId, [b.orgId]: b.adminId });
    for (const f of [a, b]) {
      const rows = await c2Rows(f.orgId);
      expect(rows, `org ${f.orgId}: expected exactly one C2 row (kills M9a: the purge records nothing)`).toHaveLength(1);
      expect(rows[0]!.completion).toBe('performed');
      expect(rows[0]!.completed_by).toBe(f.adminId); // DEF-640: each org's own performer
      expect(rows[0]!.note).toMatch(/^Purged \d+ rows? from \d+ tables? as of 2027-01-01/);
    }
    // And the gate is now open for the purged orgs.
    expect((await figure(a, '1130', '100.00')).entryId).toBeTruthy();

    // A second purge (the real one after a rehearsal copy, or a re-run) must not duplicate or crash on the unique step key.
    await realPurge(sql, a.adminId);
    expect(await c2Rows(a.orgId)).toHaveLength(1);
    expect(await c2Rows(b.orgId)).toHaveLength(1);
  });
});

// =============================================================================================================================
// C5 writes the stock (tests 10, 10a, 11; I1-I5)
// =============================================================================================================================

describe('C5 writes the stock in its own transaction (tests 10, 10a, 11, I1-I5)', () => {
  let f: S2Fixture;
  let entries: { entryA: string; entryB: string };
  let result: Awaited<ReturnType<typeof post>>;

  beforeAll(async () => {
    f = await s2fixture('post');
    entries = await readyToPost(f);
    result = await post(f);
  }, 120_000);

  it('10a: posts each distinct draft ONCE: `posted` counts entries, not lines (kills M27)', async () => {
    // Store A's inventory draft has TWO non-3900 lines (1310, 1320): the per-line shape of `openingDrafts` would post it twice
    // and hit `recordGone`. Entries: inventory A, inventory B, and one 3300 reconcile figure per store = 4.
    expect(result.posted).toBe(4);
    expect(new Set(result.entryIds).size).toBe(result.entryIds.length);
    expect(result.entryIds).toHaveLength(4);
    expect(await openingEntryStatuses(f.orgId)).toEqual(['posted', 'posted', 'posted', 'posted']);
  });

  it('10: one `opening` movement per counted row with quantity > 0 (room kept), none for a zero count (kills M10, M11)', async () => {
    const counts = await sql<{ id: string; store_id: string; location_id: string; item_id: string; quantity: string; unit_cost: string }[]>`
      select id, store_id, location_id, item_id, quantity::text, unit_cost::text from opening_counts where org_id = ${f.orgId}`;
    const positive = counts.filter((c) => Number(c.quantity) > 0);
    expect(positive).toHaveLength(EXPECT.qtyRows);
    const movements = await openingMovements(f.orgId);
    expect(movements, 'one movement per room row, not per store or per item (kills M10)').toHaveLength(EXPECT.qtyRows);

    const entryOf = new Map([[f.storeA, entries.entryA], [f.storeB, entries.entryB]]);
    for (const c of positive) {
      const m = movements.find((x) => x.source_id === c.id);
      expect(m, `no movement for count row ${c.id}`).toBeDefined();
      expect(m!.kind).toBe('opening');
      expect(m!.source_type).toBe('opening_count');
      expect(m!.store_id).toBe(c.store_id);
      expect(m!.location_id).toBe(c.location_id);
      expect(m!.item_id).toBe(c.item_id);
      expect(Number(m!.quantity)).toBe(Number(c.quantity));
      expect(m!.moved_at).toBe(`${CONVERSION}T00:00:00`);
      expect(m!.journal_entry_id).toBe(entryOf.get(c.store_id));
    }
    // The zero count (Gloves in the Freezer) writes nothing.
    const zero = counts.find((c) => Number(c.quantity) === 0)!;
    expect(movements.find((x) => x.source_id === zero.id)).toBeUndefined();
    expect((await openingLayers(f.orgId)).find((l) => l.source_id === zero.id)).toBeUndefined();
  });

  it('10: onHand per item per ROOM is the counted quantity', async () => {
    expect(await onHand(f.orgId, f.raw, f.kitA)).toBe(5);
    expect(await onHand(f.orgId, f.raw, f.frzA)).toBe(3);
    expect(await onHand(f.orgId, f.raw, f.barB)).toBe(2);
    expect(await onHand(f.orgId, f.ret, f.kitA)).toBe(4);
    expect(await onHand(f.orgId, f.sup, f.kitA)).toBe(10);
    expect(await onHand(f.orgId, f.sup, f.frzA)).toBe(0);
    expect(await onHand(f.orgId, f.pinch, f.dryA)).toBe(1);
  });

  it('10 / I2: one `opening` layer per movement: same source, movement_id, received_at, unit_cost, quantity', async () => {
    const movements = await openingMovements(f.orgId);
    const layers = await openingLayers(f.orgId);
    expect(layers).toHaveLength(EXPECT.qtyRows);
    const costs = await sql<{ id: string; unit_cost: string }[]>`select id, unit_cost::text from opening_counts where org_id = ${f.orgId}`;
    for (const l of layers) {
      const m = movements.find((x) => x.id === l.movement_id);
      expect(m, `layer ${l.id} points at no opening movement`).toBeDefined();
      expect(l.source).toBe('opening');
      expect(l.source_id).toBe(m!.source_id);
      expect(l.received_at).toBe(`${CONVERSION}T00:00:00`);
      expect(Number(l.quantity)).toBe(Number(m!.quantity));
      expect(Number(l.remaining_quantity)).toBe(Number(m!.quantity));
      expect(Number(l.unit_cost)).toBe(Number(costs.find((c) => c.id === l.source_id)!.unit_cost));
    }
  });

  it('I3: every `opening` layer of an item in a store shares ONE unit cost and ONE received_at', async () => {
    const layers = await openingLayers(f.orgId);
    const byKey = new Map<string, LayerRow[]>();
    for (const l of layers) byKey.set(`${l.store_id}|${l.item_id}`, [...(byKey.get(`${l.store_id}|${l.item_id}`) ?? []), l]);
    expect([...byKey.values()].some((g) => g.length > 1), 'fixture has no item in two rooms').toBe(true);
    for (const [k, g] of byKey) {
      expect(new Set(g.map((l) => Number(l.unit_cost))).size, `${k}: more than one unit cost`).toBe(1);
      expect(new Set(g.map((l) => l.received_at)).size, `${k}: more than one received_at`).toBe(1);
    }
  });

  it('11 / I1: the layer valuation equals the posted inventory lines, per store per account, to the centavo (kills M12)', async () => {
    const kinds = new Map((await sql<{ id: string; kind: string }[]>`select id, kind from items where org_id = ${f.orgId}`).map((r) => [r.id, r.kind]));
    const accountOf = (kind: string) => (kind === 'supply' ? '1320' : kind === 'prepped' ? '1330' : '1310');
    // Exact centavos as bigint; no float anywhere.
    const cents = (t: string): bigint => {
      const [w = '0', fr = ''] = t.split('.');
      return BigInt(w) * 100n + BigInt(fr.padEnd(2, '0').slice(0, 2));
    };
    let books = 0n;
    let layersTotal = 0n;
    for (const [storeId, expected] of [[f.storeA, EXPECT.A], [f.storeB, EXPECT.B]] as const) {
      const valuation = await asOrg(f.orgId, (tx) => stockLayersRepo.valuation(tx, storeId));
      const byAccount: Record<string, bigint> = { '1310': 0n, '1320': 0n, '1330': 0n };
      for (const v of valuation) byAccount[accountOf(kinds.get(v.itemId)!)]! += cents(v.value);
      for (const code of ['1310', '1320', '1330'] as const) {
        const posted = cents(await postedOpeningLine(f.orgId, storeId, code));
        expect(posted, `${code} at ${storeId}: posted line vs layer valuation`).toBe(byAccount[code]!);
        expect(posted).toBe(cents((expected as Record<string, string>)[code] ?? '0.00'));
        books += posted;
        layersTotal += byAccount[code]!;
      }
    }
    expect(books).toBe(layersTotal);
    expect(books).toBe(97435n); // A 849.35 + 25.00, B 100.00
  });

  it('I4 / I5: a second post is refused in words and writes nothing more', async () => {
    const before = (await openingMovements(f.orgId)).length;
    const err = await errorOf(post(f));
    expect(err, 'the second post succeeded').not.toBeNull();
    expect(sentenceOf(err)).toMatch(OPENED_SENTENCE);
    expect((await openingMovements(f.orgId)).length).toBe(before);
    expect((await openingLayers(f.orgId)).length).toBe(before);
  });

  it('I5 / R8: after the post every opening writer refuses with the books-opened sentence', async () => {
    const attempts: [string, () => Promise<unknown>][] = [
      ['recordOpeningCount', () => count(f, { store: f.storeA, room: f.kitA, item: f.raw, qty: '9', cost: '100.0000' })],
      ['addOpeningFigure', () => figure(f, '1120', '10.00')],
      ['valueOpeningStock', () => value(f, f.storeA)],
    ];
    for (const [name, run] of attempts) {
      const err = await errorOf(run());
      expect(err, `${name} worked after the books were opened`).not.toBeNull();
      expect(sentenceOf(err), name).toMatch(OPENED_SENTENCE);
    }
    const [posted] = await sql<{ id: string }[]>`select id from journal_entries where org_id = ${f.orgId} and source_type = 'opening_balance' limit 1`;
    const rm = await errorOf(asOrg(f.orgId, (tx) => domain.removeOpeningFigure(tx, f.admin, { entryId: posted!.id })));
    expect(rm, 'a posted opening figure was removable').not.toBeNull();
    expect(sentenceOf(rm)).toMatch(/books were opened|already been posted/i);
  });
});

// =============================================================================================================================
// I7 - all or none (tests 12, 13) and the closed period
// =============================================================================================================================

describe('I7 - a refusal anywhere in C5 leaves nothing behind', () => {
  const nothingWritten = async (f: S2Fixture) => {
    expect(await openingMovements(f.orgId), 'opening movements were left behind').toHaveLength(0);
    expect(await openingLayers(f.orgId), 'opening layers were left behind').toHaveLength(0);
    const statuses = await openingEntryStatuses(f.orgId);
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses.every((s) => s === 'draft'), `an opening entry was posted: ${statuses.join(',')}`).toBe(true);
  };

  it('12: a count edited AFTER valuing is refused ("press Value the count again") and nothing is written (kills M13)', async () => {
    const f = await s2fixture('i7-stale');
    await readyToPost(f);
    await count(f, { store: f.storeA, room: f.kitA, item: f.raw, qty: '6', cost: '100.0000' });
    const err = await errorOf(post(f));
    expect(err, 'C5 posted a stale draft').not.toBeNull();
    expect(sentenceOf(err)).toMatch(/Value the count/i);
    expect(sentenceOf(err)).toContain(f.nameA);
    await nothingWritten(f);
  });

  it('a store whose count was never valued blocks C5 on the tie-out and writes nothing', async () => {
    const f = await s2fixture('i7-unvalued');
    await standardCounts(f);
    await value(f, f.storeA); // B is never valued
    await settle3900(f);
    await attestC3P(f);
    const err = await errorOf(post(f));
    expect(err, 'C5 posted although Malvar\'s stock has no opening figure').not.toBeNull();
    expect(sentenceOf(err)).toContain(f.nameB);
    await nothingWritten(f);
  });

  it('13: a failure AFTER the movements and layers are written rolls them back (kills M14: stock committed apart from the post)', async () => {
    const f = await s2fixture('i7-inject');
    await standardCounts(f);
    await value(f, f.storeA);
    await value(f, f.storeB);
    // A marked draft Dr 1130 / Cr 3900 whose POSTING will fail at the database, after the stock rows exist.
    const marker = `T390-S2-FAIL-${uid('m')}`;
    const { journalRepo } = await import('@shareat/db');
    await asOrg(f.orgId, async (tx) => {
      const period = await journalRepo.findPeriodForDate(tx, f.orgId, CONVERSION);
      const { id } = await journalRepo.insertDraftEntry(tx, {
        orgId: f.orgId, entryDate: CONVERSION, periodId: period!.id, memo: marker,
        sourceType: 'opening_balance', sourceId: `marked:${marker}`, idempotencyKey: `marked:${marker}`,
      });
      const acct = (code: string) => journalRepo.resolveAccountId(tx, f.orgId, code);
      await journalRepo.insertLines(tx, id, [
        { accountId: await acct('1130'), lineNo: 1, storeId: f.storeB, debit: '50.00' as never, credit: '0' as never, partyType: null, partyId: null, lineMemo: 'x', channelId: null },
        { accountId: await acct('3900'), lineNo: 2, storeId: f.storeB, debit: '0' as never, credit: '50.00' as never, partyType: null, partyId: null, lineMemo: 'x', channelId: null },
      ]);
    });
    await settle3900(f);
    await attestC3P(f);

    const fn = `t390s2_fail_fn_${Date.now()}`;
    const trg = `t390s2_fail_trg_${Date.now()}`;
    await sql.unsafe(`
      create function ${fn}() returns trigger language plpgsql as $$
      begin raise exception 'T390 S2 injected failure at posting'; end $$`);
    await sql.unsafe(`
      create trigger ${trg} before update on journal_entries for each row
      when (new.status = 'posted' and old.status is distinct from 'posted' and new.memo = '${marker}')
      execute function ${fn}()`);
    try {
      const err = await errorOf(post(f));
      expect(err, 'the injected failure did not fire (the stock/post order changed, or the post path is not an UPDATE to posted)').not.toBeNull();
      expect(`${(err as Error).message} ${sentenceOf(err)}`).toMatch(/injected failure/);
    } finally {
      await sql.unsafe(`drop trigger if exists ${trg} on journal_entries`);
      await sql.unsafe(`drop function if exists ${fn}()`);
    }
    await nothingWritten(f);
  });

  it('a closed period refuses BEFORE the first write', async () => {
    const f = await s2fixture('i7-closed');
    await readyToPost(f);
    await sql`
      update fiscal_periods set status = 'closed', closed_by = ${f.adminId}, closed_at = now()
      where org_id = ${f.orgId} and starts_on = '2027-01-01'`;
    const err = await errorOf(post(f));
    expect(err, 'C5 posted into a closed period').not.toBeNull();
    expect(await openingMovements(f.orgId)).toHaveLength(0);
    expect(await openingLayers(f.orgId)).toHaveLength(0);
  });
});

// =============================================================================================================================
// R13 - one opening per org, concurrency-safe (tests 14, 14a, kill M15, M28)
// =============================================================================================================================

describe('R13 - the exclusive lock (test 14, kills M15)', () => {
  it('two concurrent posts on two connections: exactly one succeeds, one is refused, one set of movements', async () => {
    const f = await s2fixture('r13-race');
    await readyToPost(f);
    const [a, b] = await Promise.all([errorOf(post(f)), errorOf(post(f))]);
    const failures = [a, b].filter((e) => e !== null);
    expect(failures, `expected exactly one refusal, got ${failures.length}`).toHaveLength(1);
    expect(sentenceOf(failures[0])).toMatch(OPENED_SENTENCE);
    expect(await openingMovements(f.orgId)).toHaveLength(EXPECT.qtyRows);
    expect(await openingLayers(f.orgId)).toHaveLength(EXPECT.qtyRows);
  });
});

describe('R13 / test 14a - every other writer waits for C5 and is then refused (kills M28: a writer skips the shared lock)', () => {
  /**
   * Connection 1 plays C5: it takes the EXCLUSIVE opening lock and posts an opening entry, then HOLDS its transaction open. Connection 2
   * runs the writer and must BLOCK. After connection 1 commits, the writer is refused by R8 and has written nothing.
   * (A separate posted entry is used, not the drafts, so a writer that merely waits on a ROW lock cannot pass for one that waits on the
   * advisory lock.)
   */
  async function raceC5(f: S2Fixture, act: () => Promise<unknown>): Promise<unknown> {
    const holding = defer();
    const release = defer();
    const holder = asOrg(f.orgId, async (tx) => {
      await tx.execute(dsql`select pg_advisory_xact_lock(390001, hashtext(${f.orgId}::text))`);
      await domain.postEntry(tx, {
        orgId: f.orgId, entryDate: CONVERSION, sourceType: 'opening_balance', sourceId: uid('c5'), idempotencyKey: uid('c5'),
        memo: 'stand-in for C5', postedBy: f.adminId,
        lines: [
          { accountCode: '1130', storeId: f.storeA, debit: '1.00' },
          { accountCode: '3900', storeId: f.storeA, credit: '1.00' },
        ],
      } as Parameters<typeof domain.postEntry>[1]);
      holding.resolve();
      await release.promise;
    });
    holder.catch(() => undefined);
    try {
      await holding.promise;
      const pending = errorOf(act());
      const first = await Promise.race([pending.then(() => 'settled' as const), sleep(900).then(() => 'blocked' as const)]);
      expect(first, 'the writer did not wait for the opening lock: it ran while C5 held the exclusive lock').toBe('blocked');
      release.resolve();
      await holder;
      return await pending;
    } finally {
      release.resolve();
      await holder.catch(() => undefined);
    }
  }

  it('recordOpeningCount', async () => {
    const f = await s2fixture('r13-count');
    const err = await raceC5(f, () => count(f, { store: f.storeA, room: f.kitA, item: f.raw, qty: '3', cost: '10.0000' }));
    expect(sentenceOf(err)).toMatch(OPENED_SENTENCE);
    const rows = await sql`select 1 from opening_counts where org_id = ${f.orgId}`;
    expect(rows).toHaveLength(0);
  });

  it('addOpeningFigure', async () => {
    const f = await s2fixture('r13-add');
    const err = await raceC5(f, () => figure(f, '1120', '100.00'));
    expect(sentenceOf(err)).toMatch(OPENED_SENTENCE);
    const rows = await sql`select 1 from journal_entries where org_id = ${f.orgId} and source_type = 'opening_balance' and status = 'draft'`;
    expect(rows).toHaveLength(0);
  });

  it('removeOpeningFigure (the draft survives)', async () => {
    const f = await s2fixture('r13-remove');
    const { entryId } = await figure(f, '1130', '100.00');
    const err = await raceC5(f, () => asOrg(f.orgId, (tx) => domain.removeOpeningFigure(tx, f.admin, { entryId })));
    expect(sentenceOf(err)).toMatch(/books were opened|already been posted/i);
    const [row] = await sql<{ status: string }[]>`select status from journal_entries where id = ${entryId}`;
    expect(row, 'the draft was deleted by a writer that never waited').toBeDefined();
    expect(row!.status).toBe('draft');
  });

  it('valueOpeningStock (no inventory draft is written)', async () => {
    const f = await s2fixture('r13-value');
    await count(f, { store: f.storeA, room: f.kitA, item: f.raw, qty: '5', cost: '100.0000' });
    const err = await raceC5(f, () => value(f, f.storeA));
    expect(sentenceOf(err)).toMatch(OPENED_SENTENCE);
    expect(await entriesWithKey(f.orgId, 'opening-stock:%')).toHaveLength(0);
  });

  it('valueOpeningAsset (the shell stays pending)', async () => {
    const f = await s2fixture('r13-asset');
    const [shell] = await sql<{ id: string }[]>`
      insert into fixed_assets (org_id, store_id, name, category, status, created_by)
      values (${f.orgId}, ${f.storeA}, ${uid('Chiller')}, 'equipment', 'pending_valuation', ${f.adminId}) returning id`;
    const err = await raceC5(f, () =>
      asOrg(f.orgId, (tx) => domain.valueOpeningAsset(tx, f.admin, { assetId: shell!.id, bookValue: '1000.00', remainingLifeMonths: 12 })),
    );
    expect(sentenceOf(err)).toMatch(OPENED_SENTENCE);
    const [row] = await sql<{ status: string }[]>`select status from fixed_assets where id = ${shell!.id}`;
    expect(row!.status).toBe('pending_valuation');
  });
});

// =============================================================================================================================
// R17 and the exports
// =============================================================================================================================

describe('R17 - one implementation of inventory value', () => {
  it('cutoverRepo.countedValue (the float total) is gone; planOpeningStock and valueOpeningStock are exported', async () => {
    const { cutoverRepo } = await import('@shareat/db');
    expect((cutoverRepo as Record<string, unknown>).countedValue, 'countedValue is still exported: two implementations of inventory value').toBeUndefined();
    expect(typeof needS2<unknown>('planOpeningStock')).toBe('function');
    expect(typeof needS2<unknown>('valueOpeningStock')).toBe('function');
  });

  it('R14: the conversion date constant is exported by the domain', () => {
    expect((domain as unknown as { CONVERSION_DATE: string }).CONVERSION_DATE).toBe('2027-01-01');
  });
});

// =============================================================================================================================
// T1 - stock ties to 1310 / 1320 / 1330 (s5.3, I6)
// =============================================================================================================================

describe('T1 - the stock register, per store x 1310/1320/1330 (kills M17 for T1)', () => {
  const stockLines = (t: TieOut) => t.lines.filter((l) => ['1310', '1320', '1330'].includes(l.account ?? ''));

  it('PASS: counts valued and the 3900 cleared: no stock line, and the whole tie-out holds', async () => {
    const f = await s2fixture('t1-pass');
    await standardCounts(f);
    await value(f, f.storeA);
    await value(f, f.storeB);
    await settle3900(f);
    const t = await tie(f);
    expect(stockLines(t), sentences(t)).toEqual([]);
    expect(t.holds, sentences(t)).toBe(true);
  });

  it('FAIL: counted but never valued: one sentence per store and account, naming the store, the account and the pesos', async () => {
    const f = await s2fixture('t1-unvalued');
    await standardCounts(f);
    const t = await tie(f);
    expect(t.holds, 'the tie-out holds although Lipa and Malvar have stock and no opening figure').toBe(false);
    expect(sentenceWith(t, f.nameA, '1310', peso('849.35')), sentences(t)).toBeDefined();
    expect(sentenceWith(t, f.nameA, '1320', peso('25.00')), sentences(t)).toBeDefined();
    expect(sentenceWith(t, f.nameB, '1310', peso('100.00')), sentences(t)).toBeDefined();
    const line = stockLines(t).find((l) => l.storeId === f.storeA && l.account === '1310')!;
    expect(Number(line.registerFigure).toFixed(2)).toBe('849.35');
    expect(Number(line.ledgerFigure).toFixed(2)).toBe('0.00');
    expect(Number(line.difference).toFixed(2)).toBe('849.35');
  });

  it('FAIL: valued for A only: A is quiet, B is named', async () => {
    const f = await s2fixture('t1-one');
    await standardCounts(f);
    await value(f, f.storeA);
    await settle3900(f);
    const t = await tie(f);
    expect(t.holds).toBe(false);
    expect(stockLines(t).filter((l) => l.storeId === f.storeA), sentences(t)).toEqual([]);
    expect(sentenceWith(t, f.nameB, '1310', peso('100.00')), sentences(t)).toBeDefined();
  });

  it('FAIL: a count edited after valuing: register 949.35 against a figure of 849.35, 100.00 apart, "Value the count again"', async () => {
    const f = await s2fixture('t1-stale');
    await standardCounts(f);
    await value(f, f.storeA);
    await value(f, f.storeB);
    await settle3900(f);
    await count(f, { store: f.storeA, room: f.kitA, item: f.raw, qty: '6', cost: '100.0000' });
    const t = await tie(f);
    expect(t.holds).toBe(false);
    const s = sentenceWith(t, f.nameA, '1310', peso('949.35'), peso('849.35'), peso('100.00'), /Value the count/i);
    expect(s, sentences(t)).toBeDefined();
  });

  it('FAIL: counted items with no cost are named ("3 counted items at Malvar have no cost: ..."); a zero count needs no cost', async () => {
    const f = await s2fixture('t1-nocost');
    const mk = async (label: string) => {
      const nm = `${label} ${uid('u')}`;
      const [i] = await sql<{ id: string }[]>`
        insert into items (org_id, code, name, kind, base_unit, created_by) values (${f.orgId}, ${testItemCode()}, ${nm}, 'raw_material', 'kg', ${f.adminId}) returning id`;
      return { id: i!.id, nm };
    };
    const items = [await mk('Tuna'), await mk('Squid'), await mk('Crab')];
    for (const it of items) await count(f, { store: f.storeB, room: f.barB, item: it.id, qty: '2' });
    const zero = await mk('Shrimp');
    await count(f, { store: f.storeB, room: f.barB, item: zero.id, qty: '0' });
    const t = await tie(f);
    expect(t.holds).toBe(false);
    const s = sentenceWith(t, f.nameB, /\b3 counted items?\b/, /no cost/i);
    expect(s, sentences(t)).toBeDefined();
    expect(items.some((it) => s!.includes(it.nm)), `none of the unpriced items is named: ${s}`).toBe(true);
    expect(s!.includes(zero.nm), 'a zero count was reported as unpriced').toBe(false);
  });
});

// =============================================================================================================================
// The purge script: `--by` (R8). Last in the file on purpose: `--apply` really purges the (private) database.
// =============================================================================================================================

describe('R8 - scripts/cutover-purge.ts takes --by <personId> (test 9a, script half)', () => {
  const dbUrl = process.env.TEST_DATABASE_URL!;
  const dbName = decodeURIComponent(new URL(dbUrl).pathname.replace(/^\//, ''));
  const reportDir = mkdtempSync(join(tmpdir(), 't390-s2-purge-report-'));
  const run = (...extra: string[]) =>
    spawnSync('npx', ['tsx', 'scripts/cutover-purge.ts', '--confirm-database', dbName, '--as-of', '2027-01-01', ...extra], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: dbUrl, CUTOVER_PURGE_REPORT_DIR: reportDir },
      encoding: 'utf8',
      shell: true,
    });
  const c2Of = (orgId: string) =>
    sql<{ completion: string; completed_by: string }[]>`select completion, completed_by from cutover_steps where org_id = ${orgId} and step_code = 'C2'`;
  const out = (r: ReturnType<typeof run>) => `${r.stdout}\n${r.stderr}`;

  let f: S2Fixture;
  beforeAll(async () => {
    f = await s2fixture('script', 'none');
  }, 60_000);

  it('--apply WITHOUT --by is refused and purges nothing', () => {
    const r = run('--apply');
    expect(r.status, out(r)).not.toBe(0);
    expect(out(r)).toMatch(/--by/);
  }, 120_000);

  it('--apply with a --by that is not a person is refused and purges nothing', async () => {
    const r = run('--apply', '--by', '00000000-0000-4000-8000-000000000000');
    expect(r.status, out(r)).not.toBe(0);
    expect(out(r)).toMatch(/person|--by/i);
    expect(await c2Of(f.orgId), 'a C2 row was written by a refused purge').toHaveLength(0);
  }, 120_000);

  it('--rehearse --by <person> passes and leaves no C2 row', async () => {
    const r = run('--rehearse', '--by', f.adminId);
    expect(r.status, out(r)).toBe(0);
    expect(out(r)).toMatch(/Rehearsal passed/);
    expect(await c2Of(f.orgId)).toHaveLength(0);
  }, 120_000);

  it('--apply --by <person> commits and records C2 as performed by that person', async () => {
    // DEF-640: --by is repeated, one person per organization that exists.
    const { performersForAllOrgs } = await import('./t390-real-purge');
    const perOrg = await performersForAllOrgs(sql, f.adminId);
    // Hundreds of orgs overflow a Windows command line, so the list goes in via CUTOVER_PURGE_BY.
    const r = spawnSync('npx', ['tsx', 'scripts/cutover-purge.ts', '--confirm-database', dbName, '--as-of', '2027-01-01', '--apply'], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: dbUrl, CUTOVER_PURGE_REPORT_DIR: reportDir, CUTOVER_PURGE_BY: Object.values(perOrg).join(',') },
      encoding: 'utf8',
      shell: true,
    });
    expect(r.status, out(r)).toBe(0);
    expect(out(r)).toMatch(/Purge committed/);
    const rows = await c2Of(f.orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.completion).toBe('performed');
    expect(rows[0]!.completed_by).toBe(f.adminId);
  }, 120_000);
});
