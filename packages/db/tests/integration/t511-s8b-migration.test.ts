/**
 * T-511 S8b - migration 0260: an Appendix B charge keeps its Official Document Number, an upload keeps the earlier items its Appendix C lists.
 * docs/tasks/511-settlement-upload-s8-spec.md "S8b" item 2. Real Postgres via TEST_DATABASE_URL.
 *
 *  M1  a file `0260_*.sql` naming t511, journal idx 260, `when` = 0259's 1808451107084 + 86,400,000 = 1808537507084, breakpoints true.
 *  M2  settlement_other_lines.official_document text NULL, no default; 1 to 40 characters when present (never ''); a partial, NON-unique index on (org_id, official_document)
 *      where not null (the lookup the netting does).
 *  M3  settlement_uploads.prior_items jsonb NOT NULL default '[]', refused unless it is a json array (23514).
 *  M4  the app role gains ONE column-level UPDATE, official_document (the repeat-upload fill); prior_items and every money column stay insert-only.
 *  No new table, so the registries and the classification are unchanged (their own guards say so).
 */
import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { APP_ROLE } from '../../src/rls/registry';

config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
const sql = postgres(url, { max: 4 });
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

const MIGRATIONS = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'migrations');
const TARGET_IDX = 260;
const TARGET_WHEN = 1808537507084;
type PgErr = Error & { code?: string };
type Tx = postgres.TransactionSql;
class Rollback extends Error {}
let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;

async function run<T>(fn: (tx: Tx) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; err: PgErr }> {
  let value: T | undefined;
  try {
    await sql.begin(async (tx) => {
      value = await fn(tx);
      throw new Rollback('rollback');
    });
  } catch (e) {
    if (e instanceof Rollback) return { ok: true, value: value as T };
    return { ok: false, err: e as PgErr };
  }
  return { ok: true, value: value as T };
}
const refusedWith = async (fn: (tx: Tx) => Promise<unknown>, code: string, what: string): Promise<void> => {
  const o = await run(fn);
  if (o.ok) throw new Error(`${what}: expected SQLSTATE ${code} but the statement succeeded`);
  expect(o.err.code, `${what}: ${o.err.message}`).toBe(code);
};
const accepted = async (fn: (tx: Tx) => Promise<unknown>, what: string): Promise<void> => {
  const o = await run(fn);
  if (!o.ok) throw new Error(`${what}: expected success but got ${o.err.code}: ${o.err.message}`);
};

interface Side { orgId: string; upload: string; person: string }
let sideP: Promise<Side> | null = null;
const side = (): Promise<Side> =>
  (sideP ??= (async () => {
    const code = uid('t511s8b');
    const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
    const orgId = org!.id;
    const [s1] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('S1')}, 'Lipa') returning id`;
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${uid('Admin')}) returning id`;
    const [ch] = await sql<{ id: string }[]>`
      insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code, platform, platform_store_code)
      values (${orgId}, ${s1!.id}, ${uid('Foodpanda')}, false, '1220', 'foodpanda', ${uid('FP')}) returning id`;
    const [file] = await sql<{ id: string }[]>`
      insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
      values (${orgId}, ${s1!.id}, 'memo_document', ${`orgs/${orgId}/stores/${s1!.id}/memo_document/${uid('f')}.pdf`}, 'application/pdf', 10, 'abc', ${p!.id}) returning id`;
    const [up] = await sql<{ id: string }[]>`
      insert into settlement_uploads (org_id, channel_id, store_id, platform, file_kind, file_id, fingerprint, reader_version, uploaded_by)
      values (${orgId}, ${ch!.id}, ${s1!.id}, 'foodpanda', 'foodpanda_invoice', ${file!.id}, ${uid('fp')}, '1', ${p!.id}) returning id`;
    return { orgId, upload: up!.id, person: p!.id };
  })());

describe('T-511 S8b / 0260 - the migration file and its journal entry', () => {
  it('a 0260_*.sql file naming t511 is journalled as idx 260, when 1808537507084 (0259 + one day), breakpoints true, after every earlier entry [kills: wrong number / when; a file the journal does not name]', () => {
    const files = readdirSync(MIGRATIONS).filter((f) => /^0260_.*\.sql$/.test(f));
    expect(files, 'exactly one packages/db/migrations/0260_*.sql').toHaveLength(1);
    const tag = files[0]!.replace(/\.sql$/, '');
    expect(tag).toMatch(/t511/);
    expect(existsSync(join(MIGRATIONS, `${tag}.sql`))).toBe(true);
    const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as { entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[] };
    expect(journal.entries.find((x) => x.idx === TARGET_IDX)).toEqual({ idx: TARGET_IDX, version: '7', when: TARGET_WHEN, tag, breakpoints: true });
    const earlier = journal.entries.filter((x) => x.idx < TARGET_IDX);
    expect(Math.max(...earlier.map((x) => x.when))).toBeLessThan(TARGET_WHEN);
  });
});

describe('T-511 S8b / 0260 - settlement_other_lines.official_document', () => {
  it('text, NULL allowed, no default [kills: NOT NULL (every old line breaks the migration); a default that would invent a document number]', async () => {
    const [c] = await sql<{ typ: string; notnull: boolean; hasdef: boolean }[]>`
      select format_type(a.atttypid, a.atttypmod) as typ, a.attnotnull as notnull, a.atthasdef as hasdef
        from pg_attribute a where a.attrelid = 'public.settlement_other_lines'::regclass and a.attname = 'official_document' and not a.attisdropped`;
    expect(c, 'settlement_other_lines.official_document exists').toBeDefined();
    expect(c).toEqual({ typ: 'text', notnull: false, hasdef: false });
  });

  it('a line with a document number, with none, and with exactly 40 characters is accepted; "" and 41 characters are refused (23514) [kills: no length check; an empty string standing for "no document" (it would equal another empty string)]', async () => {
    const s = await side();
    const row = (doc: string | null) => (tx: Tx) =>
      tx`insert into settlement_other_lines (org_id, upload_id, kind, booked_as, amount, vat_amount, official_document) values (${s.orgId}, ${s.upload}, 'period_charge', 'none', '100.00', '12.00', ${doc})`;
    await accepted(row('2000000005092538'), 'a real document number');
    await accepted(row(null), 'no document number');
    await accepted(row('2'.repeat(40)), '40 characters');
    await refusedWith(row(''), '23514', 'an empty document number');
    await refusedWith(row('2'.repeat(41)), '23514', '41 characters');
  });

  it('a partial, non-unique index on (org_id, official_document) where it is not null [kills: no index (the netting scans every line); a unique index (two copies of one charge in two uploads must both stage)]', async () => {
    const rows = await sql<{ indexdef: string }[]>`select indexdef from pg_indexes where schemaname = 'public' and tablename = 'settlement_other_lines' and indexdef ilike '%official_document%'`;
    expect(rows).toHaveLength(1);
    const def = rows[0]!.indexdef;
    expect(def).toMatch(/\(org_id, official_document\)/);
    expect(def).toMatch(/WHERE \(official_document IS NOT NULL\)/);
    expect(def).not.toMatch(/UNIQUE/i);
    const s = await side();
    const same = (tx: Tx) =>
      tx`insert into settlement_other_lines (org_id, upload_id, kind, booked_as, amount, official_document) select ${s.orgId}, ${s.upload}, 'period_charge', 'none', '1.00', '2000000005092538' from generate_series(1, 2)`;
    await accepted(same, 'two lines with one document number');
  });
});

describe('T-511 S8b / 0260 - settlement_uploads.prior_items', () => {
  it('jsonb NOT NULL default [] [kills: nullable (a reader must then guard); a default of null]', async () => {
    const [c] = await sql<{ typ: string; notnull: boolean; def: string }[]>`
      select format_type(a.atttypid, a.atttypmod) as typ, a.attnotnull as notnull, pg_get_expr(d.adbin, d.adrelid) as def
        from pg_attribute a join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
       where a.attrelid = 'public.settlement_uploads'::regclass and a.attname = 'prior_items' and not a.attisdropped`;
    expect(c, 'settlement_uploads.prior_items exists with a default').toBeDefined();
    expect(c!.typ).toBe('jsonb');
    expect(c!.notnull).toBe(true);
    expect(c!.def).toMatch(/'\[\]'::jsonb/);
  });

  it('an upload written without the column reads back [] ; an array of items is kept; an object, a string, a number and NULL are refused [kills: no array check (a reader that does .map on an object); a nullable column]', async () => {
    const s = await side();
    const [row] = await sql<{ prior_items: unknown }[]>`select prior_items from settlement_uploads where id = ${s.upload}`;
    expect(row!.prior_items).toEqual([]);
    const set = (v: string) => (tx: Tx) => tx`update settlement_uploads set prior_items = ${v}::text::jsonb where id = ${s.upload}`;
    await accepted(set('[{"document":"2000000005092538","date":"2026-10-31","amount":"-100.00"}]'), 'an array of items');
    await refusedWith(set('{"document":"x"}'), '23514', 'an object');
    await refusedWith(set('"x"'), '23514', 'a string');
    await refusedWith(set('5'), '23514', 'a number');
    await refusedWith((tx) => tx`update settlement_uploads set prior_items = null where id = ${s.upload}`, '23502', 'NULL');
  });
});

describe('T-511 S8b / 0260 - the app role gains exactly one column', () => {
  it('the app role can UPDATE official_document (the repeat-upload fill) and nothing else new: not prior_items, not amount, kind, booked_as or the VAT [kills: a table-level grant widened by mistake; the fill without its column grant]', async () => {
    const s = await side();
    const asApp = (stmt: (tx: Tx) => Promise<unknown>) => async (tx: Tx) => {
      await tx.unsafe(`set local role ${APP_ROLE}`);
      await tx`select set_config('app.principal_kind', 'staff', true)`;
      await tx`select set_config('app.org_id', ${s.orgId}, true)`;
      return stmt(tx);
    };
    const [line] = await sql<{ id: string }[]>`insert into settlement_other_lines (org_id, upload_id, kind, booked_as, amount) values (${s.orgId}, ${s.upload}, 'period_charge', 'none', '1.00') returning id`;
    await refusedWith(asApp((tx) => tx`update settlement_uploads set prior_items = '[]'::jsonb where id = ${s.upload}`), '42501', 'update prior_items as the app role');
    for (const col of ['amount', 'kind', 'booked_as', 'vat_amount', 'description']) {
      const value = col === 'kind' ? "'adjustment'" : col === 'booked_as' ? "'marketing'" : col === 'description' ? "'x'" : '2';
      await refusedWith(asApp((tx) => tx.unsafe(`update settlement_other_lines set ${col} = ${value} where id = '${line!.id}'`)), '42501', `update ${col} as the app role`);
    }
    await accepted(asApp((tx) => tx`update settlement_other_lines set official_document = '2000000005092538' where id = ${line!.id}`), 'update official_document as the app role');
    await accepted(asApp((tx) => tx`select prior_items from settlement_uploads where id = ${s.upload}`), 'select prior_items as the app role');
  });
});
