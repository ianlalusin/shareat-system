import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-511 S4 audit fixes (2026-11-04), the database parts. docs/tasks/511-settlement-upload-s4-spec.md "Opus rulings".
 *
 *  F1  `changed_since_booked` survives later versions (v1 booked, v2 changed, v3 changed again: v3 still true)
 *  F2  a Grab upload pairs with ALL current uploads of the other kind (merged by settlement id, newest wins): the result does not depend on how the
 *      Transfers file was split, nor on the order of the uploads
 *  F3  a counterpart that cannot be read back (object missing, or the old file is refused by the reader) is skipped with a plain warning naming
 *      its upload date; the new upload is never blocked
 *  F4  the inactive-channel sentence is behind the store gate: a manager of another store gets only the generic sentence
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { inMemoryDriver, setStorageDriver } from '@shareat/domain';
import { ingestSettlementFile } from '../../src/settlement-intake/ingest';
import { LIPA_FP, bookLine, fixture, parseGrab, synthFoodpanda, upload, world, type World } from './_fixtures/t511-s4-world';
import { setCell, toCsv, type GrabCsv } from '../unit/t511-s3-helpers';

const sql = postgres(url, { max: 8 });
let driver = inMemoryDriver();
beforeEach(() => {
  driver = inMemoryDriver();
  setStorageDriver(driver);
});
afterAll(async () => {
  setStorageDriver(null);
  await closeDb();
  await sql.end({ timeout: 5 });
});

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

type File = { bytes: Buffer; contentType: string };
const ingest = (w: World, actor: Actor, f: File) => asOrg(w.orgId, (tx) => ingestSettlementFile(tx, actor, { bytes: f.bytes, contentType: f.contentType }));
const attempt = async (w: World, actor: Actor, f: File): Promise<{ ok: true; r: Awaited<ReturnType<typeof ingest>> } | { ok: false; e: Error & { userMessage?: string; code?: string } }> => {
  try {
    return { ok: true, r: await ingest(w, actor, f) };
  } catch (e) {
    return { ok: false, e: e as Error };
  }
};
const csv = (b: Buffer): File => ({ bytes: b, contentType: 'text/csv' });
const zip = (b: Buffer): File => ({ bytes: b, contentType: 'application/zip' });
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

interface Line {
  id: string; sales_date: string; version: number; is_current: boolean; review_state: string; order_value: string; gross_info: string; commission: string; marketing: string;
  platform_fee: string; loan_deduction: string; loan_disbursal: string; net_payout: string; unexplained: string; payout_reference: string | null; payout_date: string | null;
  payment_arrival_date: string | null; paid_state: string; changed_since_booked: boolean;
}
const lines = (orgId: string, channelId: string) => sql<Line[]>`
  select id::text, sales_date::text, version, is_current, review_state, order_value::text, gross_info::text, commission::text, marketing::text, platform_fee::text,
         loan_deduction::text, loan_disbursal::text, net_payout::text, unexplained::text, payout_reference, payout_date::text, payment_arrival_date::text, paid_state, changed_since_booked
    from settlement_day_lines where org_id = ${orgId} and channel_id = ${channelId} order by sales_date, version`;
const current = async (orgId: string, channelId: string) => (await lines(orgId, channelId)).filter((l) => l.is_current);
const norm = (ls: Line[]) =>
  ls.map((l) => [l.sales_date, l.order_value, l.gross_info, l.commission, l.marketing, l.platform_fee, l.loan_deduction, l.loan_disbursal, l.net_payout, l.unexplained,
    l.payout_reference, l.payout_date, l.payment_arrival_date, l.paid_state, l.review_state].join('|'));
const count = async (table: string, orgId: string): Promise<number> => {
  const [r] = await sql<{ n: number }[]>`select count(*)::int as n from ${sql(table)} where org_id = ${orgId}`;
  return r!.n;
};
const storagePathOf = async (orgId: string, uploadId: string): Promise<string> =>
  (await sql<{ storage_path: string }[]>`select f.storage_path from settlement_uploads u join stored_files f on f.id = u.file_id where u.org_id = ${orgId} and u.id = ${uploadId}`)[0]!.storage_path;

/* ================================================================== F1 */

describe('T-511 S4 audit F1 - changed_since_booked survives later versions', () => {
  const orders = (revenues: [string, number][]) => revenues.map(([date, revenue]) => ({ date, revenue }));

  it('v1 booked, v2 changed, v3 changed again: v2 and v3 are both flagged, v3 is the current pending one [kills: the flag dropped on the second change]', async () => {
    const w = await world(sql, 'f1');
    await ingest(w, w.managerA, zip(synthFoodpanda(orders([['2026-10-10', 100]]), LIPA_FP, 'a')));
    const v1 = (await current(w.orgId, w.fpA))[0]!;
    await bookLine(sql, w, v1.id);
    await ingest(w, w.managerA, zip(synthFoodpanda(orders([['2026-10-10', 175]]), LIPA_FP, 'b')));
    await ingest(w, w.managerA, zip(synthFoodpanda(orders([['2026-10-10', 200]]), LIPA_FP, 'c')));
    const all = await lines(w.orgId, w.fpA);
    expect(all.map((l) => `${l.version}:${l.review_state}:${l.is_current}:${l.order_value}:${l.changed_since_booked}`)).toEqual([
      '1:booked:false:100.00:false',
      '2:pending:false:175.00:true',
      '3:pending:true:200.00:true',
    ]);
  });
});

/* ================================================================== F2 and F3 */

describe('T-511 S4 audit F2 - pairing uses every current upload of the other kind', () => {
  const TX = 'grab-lipa-oct-transactions.csv';
  const TR = 'grab-lipa-oct-transfers.csv';

  /** The Transfers fixture as a CSV holding the given rows (the fixture is newest payout first). */
  const transfers = (rows: (g: GrabCsv) => string[][], edit?: (g: GrabCsv) => void): Buffer => {
    const g = parseGrab(fixture(TR));
    g.rows = rows(g);
    edit?.(g);
    return toCsv(g);
  };
  const all = (g: GrabCsv): string[][] => g.rows;

  async function reference(hint: string, tr: Buffer): Promise<string[]> {
    const w = await world(sql, hint);
    await ingest(w, w.managerA, csv(tr));
    await ingest(w, w.managerA, csv(upload(TX).bytes));
    return norm(await current(w.orgId, w.grabA));
  }

  const fixtureRows = parseGrab(fixture(TR)).rows;
  const ta = (): Buffer => transfers((g) => all(g).slice(0, 15));
  const tb = (): Buffer => transfers((g) => all(g).slice(15));

  for (const order of [['T1', 'T2', 'X'], ['X', 'T1', 'T2'], ['T1', 'X', 'T2'], ['T2', 'T1', 'X']] as const) {
    it(`Transfers split in two (15 + 16 payouts, different periods), uploaded in the order ${order.join(', ')}: all 30 days are staged, equal to the one full Transfers file plus the Transactions file [kills: pairing with only the newest counterpart]`, async () => {
      expect(fixtureRows.length).toBe(31);
      const expected = await reference(`f2-ref-${order.join('')}`, upload(TR).bytes);
      expect(expected.length).toBe(30);
      const w = await world(sql, `f2-${order.join('')}`);
      const files = { T1: ta(), T2: tb(), X: upload(TX).bytes };
      for (const step of order) await ingest(w, w.managerA, csv(files[step]));
      expect(norm(await current(w.orgId, w.grabA))).toEqual(expected);
    });
  }

  it('the same settlement id in two current Transfers files with different content: the newest upload wins, however the files were ordered [kills: the older file overriding a newer one]', async () => {
    const rowsA = (g: GrabCsv): string[][] => all(g).slice(0, 20);
    const rowsB = (g: GrabCsv): string[][] => all(g).slice(10); // rows 10..19 are in both files
    const bump = (g: GrabCsv): void => {
      const at = 2; // row 12 of the fixture, present in both files, its Net Total differs in the NEWER file
      setCell(g, at, 'Net Total', (Number(g.rows[at]![g.headers.indexOf('Net Total')]) + 0.5).toFixed(2));
    };
    const a = transfers(rowsA);
    const b = transfers(rowsB, bump);
    // the one file a person would have downloaded had they known: the older file's rows, the newer file's rows on top
    const merged = transfers((g) => [...all(g).slice(0, 10), ...all(g).slice(10)], (g) => setCell(g, 12, 'Net Total', (Number(g.rows[12]![g.headers.indexOf('Net Total')]) + 0.5).toFixed(2)));
    const expected = await reference('f2-newest-ref', merged);
    for (const order of [['A', 'B', 'X'], ['A', 'X', 'B']] as const) {
      const w = await world(sql, `f2-newest-${order.join('')}`);
      const files = { A: a, B: b, X: upload(TX).bytes };
      for (const step of order) await ingest(w, w.managerA, csv(files[step]));
      expect(norm(await current(w.orgId, w.grabA)), order.join('')).toEqual(expected);
    }
  });
});

describe('T-511 S4 audit F3 - a counterpart that cannot be read back never blocks the new upload', () => {
  const TX = 'grab-lipa-oct-transactions.csv';
  const TR = 'grab-lipa-oct-transfers.csv';
  const part = (from: number, to?: number): Buffer => {
    const g = parseGrab(fixture(TR));
    g.rows = g.rows.slice(from, to);
    return toCsv(g);
  };

  async function twoTransfers(hint: string): Promise<{ w: World; tbPath: string }> {
    const w = await world(sql, hint);
    await ingest(w, w.managerA, csv(part(0, 15)));
    const tb = await ingest(w, w.managerA, csv(part(15)));
    return { w, tbPath: await storagePathOf(w.orgId, tb.uploadId) };
  }

  it('the object of one Transfers file is missing: the Transactions file is stored, the readable Transfers file still stages its 15 days, and the warning names the old file by its date, never an id [kills: a refusal that blocks the upload; a UUID in the sentence]', async () => {
    const { w, tbPath } = await twoTransfers('f3-missing');
    driver.files.delete(tbPath);
    const r = await ingest(w, w.managerA, csv(upload(TX).bytes));
    expect(r).toMatchObject({ kind: 'grab_transactions', alreadyUploaded: false, daysStaged: 15 });
    const warning = r.warnings.find((x) => /could not be read back/i.test(x));
    expect(warning).toMatch(/Transfers file/);
    expect(warning).toMatch(/uploaded on \d{4}-\d{2}-\d{2}/);
    expect(warning).not.toMatch(UUID);
    expect((await current(w.orgId, w.grabA)).length).toBe(15);
    expect(await count('settlement_uploads', w.orgId)).toBe(3);
  });

  it('an old file the current reader refuses: the same, skipped with the same kind of warning [kills: a reader refusal from an old file blocking a new upload]', async () => {
    const { w, tbPath } = await twoTransfers('f3-refused');
    driver.files.set(tbPath, Buffer.from('Date,Something Else\n1,2\n'));
    const r = await ingest(w, w.managerA, csv(upload(TX).bytes));
    expect(r).toMatchObject({ kind: 'grab_transactions', daysStaged: 15 });
    const warning = r.warnings.find((x) => /could not be read back/i.test(x));
    expect(warning).toMatch(/uploaded on \d{4}-\d{2}-\d{2}/);
    expect(warning).not.toMatch(UUID);
  });

  it('when the only counterpart is unreadable nothing can be staged: the upload is kept, the answer says it is waiting for the other file and says why [kills: refusal instead of waiting]', async () => {
    const w = await world(sql, 'f3-only');
    const tr = await ingest(w, w.managerA, csv(upload(TR).bytes));
    driver.files.delete(await storagePathOf(w.orgId, tr.uploadId));
    const r = await ingest(w, w.managerA, csv(upload(TX).bytes));
    expect(r).toMatchObject({ daysStaged: 0, waitingFor: 'transfers_file' });
    expect(r.warnings.join(' | ')).toMatch(/could not be read back/i);
    expect(r.warnings.join(' | ')).toMatch(/waiting for the Transfers file/i);
  });
});

/* ================================================================== F4 */

describe('T-511 S4 audit F4 - the inactive-channel sentence is behind the store gate', () => {
  const GENERIC = 'This file does not belong to your stores';
  const sentences = (e: Error & { userMessage?: string }): string[] => [e.message, e.userMessage].filter((t): t is string => typeof t === 'string');

  for (const platform of ['foodpanda', 'grab'] as const) {
    it(`an inactive ${platform} channel of store B: A's manager gets only the generic sentence; B's manager and the admin get the inactive sentence; nothing is written [kills: the inactive sentence (and so the channel's existence) reaching a manager who may not see that store]`, async () => {
      const w = await world(sql, `f4-${platform}`);
      const file = platform === 'foodpanda' ? zip(upload('foodpanda-malvar-oct12-34col.zip').bytes) : csv(upload('grab-malvar-oct-transfers.csv').bytes);
      await sql`update sales_channels set is_active = false where id = ${platform === 'foodpanda' ? w.fpB : w.grabB}`;
      const other = await attempt(w, w.managerA, file);
      expect(other.ok).toBe(false);
      for (const t of sentences((other as { e: Error & { userMessage?: string } }).e)) {
        expect(t).toContain(GENERIC);
        expect(t).not.toMatch(/inactive|not set up|switch/i);
        expect(t).not.toMatch(UUID);
      }
      for (const actor of [w.managerB, w.admin]) {
        const own = await attempt(w, actor, file);
        expect(own.ok).toBe(false);
        const t = sentences((own as { e: Error & { userMessage?: string } }).e).join(' | ');
        expect(t).toMatch(/inactive/i);
        expect(t).not.toContain(GENERIC);
        expect(t).not.toMatch(UUID);
        expect(t).not.toContain('[hidden]');
      }
      expect(await count('settlement_uploads', w.orgId)).toBe(0);
      expect(await count('stored_files', w.orgId)).toBe(0);
      expect(driver.files.size).toBe(0);
    });
  }

  it('a code that matches no channel anywhere still gets the not-set-up sentence naming the code (it reveals nothing about any store) [kills: the generic sentence swallowing the not-set-up help]', async () => {
    const w = await world(sql, 'f4-nobody');
    const r = await attempt(w, w.managerA, zip(synthFoodpanda([{ date: '2026-10-10', revenue: 100 }], 'NOPE1', 'x')));
    expect(r.ok).toBe(false);
    const t = sentences((r as { e: Error & { userMessage?: string } }).e).join(' | ');
    expect(t).toContain('NOPE1');
    expect(t).toMatch(/not set up/i);
    expect(t).not.toContain(GENERIC);
  });
});
