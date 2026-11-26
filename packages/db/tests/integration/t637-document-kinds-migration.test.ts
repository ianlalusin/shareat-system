/**
 * T-637 - migration 0281: the document-kinds table, its seed, the backfill of `document_templates.kind` into `kind_id`, and the new columns.
 * `docs/tasks/637-document-editor.md` (Addition).
 *
 * The backfill and the seed are SQL INSIDE the migration file; this test cuts them out of the file and runs them on old-shape rows inside a transaction that is always rolled back,
 * so what is proven is the migration's own text, not a copy. Raw SQL on the migration role; the constraint and grant checks run as the app role.
 *
 * Mutants (each proven red by hand, 25 Nov 2026): map memo to the wrong name (B1 red); drop the NULL guard (B2 red); seed fewer than the seven (B3 red). The constraint, RLS and grant checks
 * below read the live schema; a constraint or grant dropped from the migration goes red on a freshly migrated database.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { DOCUMENT_KIND_SEED, seedDocumentKinds } from '../../seed/document-kinds';
import { APP_ROLE } from '../../src/rls/registry';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

const sql = postgres(url, { max: 3 });
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

const FILE = readFileSync(resolve(__dirname, '..', '..', 'migrations', '0281_t637_document_editor.sql'), 'utf8');
const BACKFILL = FILE.slice(FILE.indexOf('DO $do$'), FILE.indexOf('$do$;') + '$do$;'.length);
const SEED_SQL = FILE.slice(FILE.indexOf('INSERT INTO "document_kinds"'), FILE.indexOf(') AS v("name", "sort_order");') + ') AS v("name", "sort_order");'.length);

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
class Rollback extends Error {}
type Tx = postgres.TransactionSql;

async function inTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  let out: T | undefined;
  try {
    await sql.begin(async (tx) => {
      out = await fn(tx);
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  return out as T;
}

async function org(tx: Tx): Promise<{ orgId: string; person: string }> {
  const code = uid('t637');
  const [o] = await tx<{ id: string }[]>`insert into organizations (name, code) values (${`Test Org ${code}`}, ${code}) returning id`;
  const [p] = await tx<{ id: string }[]>`insert into persons (org_id, display_name) values (${o!.id}, 'Admin A') returning id`;
  return { orgId: o!.id, person: p!.id };
}

describe('T-637 migration 0281 - the seed', () => {
  it('the SQL in the migration seeds exactly the list in packages/db/seed/document-kinds.ts, in the same order [kills: the two copies drifting]', async () => {
    const inFile = [...SEED_SQL.matchAll(/\('([^']+)', (\d+)\)/g)].map((m) => ({ name: m[1], sortOrder: Number(m[2]) }));
    expect(inFile).toEqual(DOCUMENT_KIND_SEED.map((s) => ({ name: s.name, sortOrder: s.sortOrder })));
    expect(DOCUMENT_KIND_SEED.map((s) => s.name)).toEqual(['Certificate of employment', 'Memo', 'Notice to explain', 'Contract', 'Other', 'Explanation letter', 'Incident report']);
  });

  it('running the migration seed on an org without kinds gives that org the seven, and only that org; seedDocumentKinds adds the missing ones and is idempotent [kills: an org left without kinds]', async () => {
    await inTx(async (tx) => {
      const a = await org(tx);
      const b = await org(tx);
      await tx`delete from document_kinds where org_id in ${tx([a.orgId, b.orgId])}`;
      // The migration seeds EVERY org (there are none with kinds yet); here the two test orgs only, so other tests' orgs are not touched.
      await tx.unsafe(SEED_SQL.replace(/;$/, ` WHERE o."id" IN ('${a.orgId}', '${b.orgId}');`));
      for (const o of [a, b]) {
        const names = (await tx<{ name: string }[]>`select name from document_kinds where org_id = ${o.orgId} order by sort_order`).map((r) => r.name);
        expect(names).toEqual(DOCUMENT_KIND_SEED.map((s) => s.name));
      }
      await tx`delete from document_kinds where org_id = ${a.orgId} and name in ('Memo', 'Incident report')`;
      await tx`update document_kinds set name = 'CONTRACT' where org_id = ${a.orgId} and name = 'Contract'`;
      expect((await seedDocumentKinds(tx as unknown as postgres.Sql, a.orgId)).inserted).toBe(2); // Contract (any case) is not added twice
      expect((await seedDocumentKinds(tx as unknown as postgres.Sql, a.orgId)).inserted).toBe(0);
    });
  });
});

describe('T-637 migration 0281 - the backfill of kind into kind_id', () => {
  /** Puts the table in its pre-0281 shape inside the transaction: a `kind` text column, `kind_id` nullable and empty. */
  async function oldShape(tx: Tx): Promise<void> {
    await tx`alter table document_templates add column kind text`;
    await tx`alter table document_templates alter column kind_id drop not null`;
  }
  const template = (tx: Tx, o: { orgId: string; person: string }, kind: string) =>
    tx`insert into document_templates (org_id, name, kind, created_by) values (${o.orgId}, ${uid('T')}, ${kind}, ${o.person}) returning id`;

  it('maps every old kind of every org to that org\'s kind of the readable name [kills: a wrong or missing mapping]', async () => {
    await inTx(async (tx) => {
      await oldShape(tx);
      const a = await org(tx);
      const b = await org(tx);
      await seedDocumentKinds(tx as unknown as postgres.Sql, a.orgId);
      await seedDocumentKinds(tx as unknown as postgres.Sql, b.orgId);
      const want: Record<string, string> = { coe: 'Certificate of employment', memo: 'Memo', nte: 'Notice to explain', contract: 'Contract', other: 'Other' };
      const made: Array<{ id: string; org: string; kind: string }> = [];
      for (const o of [a, b]) for (const kind of Object.keys(want)) made.push({ id: (await template(tx, o, kind))[0]!.id, org: o.orgId, kind });
      await tx.unsafe(BACKFILL);
      for (const m of made) {
        const [r] = await tx<{ name: string; org_id: string }[]>`select k.name, k.org_id from document_templates t join document_kinds k on k.id = t.kind_id where t.id = ${m.id}`;
        expect(r!.name, `${m.kind} in its own org`).toBe(want[m.kind]);
        expect(r!.org_id).toBe(m.org); // the kind is the SAME org's, never another's
      }
    });
  });

  it('an empty org (no templates) is fine, and an old kind that maps to nothing STOPS the migration naming how many [kills: a template left with a NULL kind]', async () => {
    await inTx(async (tx) => {
      await oldShape(tx);
      const a = await org(tx);
      await seedDocumentKinds(tx as unknown as postgres.Sql, a.orgId);
      await template(tx, a, 'coe');
      await template(tx, a, 'waiver'); // outside the old five (the old CHECK made this impossible; the guard is the belt)
      await tx`savepoint s`;
      const err = await tx.unsafe(BACKFILL).then(() => null, (e: Error) => e);
      expect(err?.message ?? '').toMatch(/T-637 STOP: 1 document template\(s\) have a kind that maps to no document kind/);
      await tx`rollback to savepoint s`;
    });
  });
});

describe('T-637 migration 0281 - the table, its rules and its grants', () => {
  async function asApp<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return (await sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${APP_ROLE}`);
      await tx`select set_config('app.principal_kind', 'staff', true)`;
      await tx`select set_config('app.org_id', ${orgId}, true)`;
      return (await fn(tx)) as never;
    })) as T;
  }
  const caught = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return e as Error & { code?: string; constraint_name?: string };
    }
    return undefined;
  };

  it('a name is unique per org ignoring case; blank, untrimmed and over-40 names and a bad status are refused; another org may reuse a name [kills: two kinds called Memo, a 41-character kind]', async () => {
    const a = await sql.begin(async (tx) => org(tx));
    const b = await sql.begin(async (tx) => org(tx));
    await sql`insert into document_kinds (org_id, name) values (${a.orgId}, 'Warning letter')`;
    expect((await caught(sql`insert into document_kinds (org_id, name) values (${a.orgId}, 'WARNING LETTER')`))?.constraint_name).toBe('document_kinds_org_name_unique');
    await sql`insert into document_kinds (org_id, name) values (${b.orgId}, 'Warning letter')`;
    for (const bad of ['', ' padded ', 'x'.repeat(41)]) {
      expect((await caught(sql`insert into document_kinds (org_id, name) values (${a.orgId}, ${bad})`))?.constraint_name, JSON.stringify(bad)).toBe('document_kinds_name_check');
    }
    expect((await caught(sql`insert into document_kinds (org_id, name, status) values (${a.orgId}, 'Odd', 'paused')`))?.constraint_name).toBe('document_kinds_status_check');
  });

  it('RLS: another org cannot read or change this org\'s kinds; the app role may insert and update name, sort order and status but never delete [kills: a cross-org read, a delete grant]', async () => {
    const a = await sql.begin(async (tx) => org(tx));
    const b = await sql.begin(async (tx) => org(tx));
    const [k] = await sql<{ id: string }[]>`insert into document_kinds (org_id, name) values (${a.orgId}, 'Visible to A') returning id`;
    expect(await asApp(b.orgId, (tx) => tx`select id from document_kinds where id = ${k!.id}`)).toHaveLength(0);
    expect(await asApp(b.orgId, (tx) => tx`update document_kinds set name = 'Hijack' where id = ${k!.id} returning id`)).toHaveLength(0);
    expect(await asApp(a.orgId, (tx) => tx`update document_kinds set name = 'Renamed by A', sort_order = 5, status = 'retired', updated_at = now() where id = ${k!.id} returning id`)).toHaveLength(1);
    expect((await caught(asApp(a.orgId, (tx) => tx`delete from document_kinds where id = ${k!.id}`)))?.code).toBe('42501');
    expect((await caught(asApp(a.orgId, (tx) => tx`update document_kinds set org_id = ${b.orgId} where id = ${k!.id}`)))?.code).toBe('42501');
    expect((await caught(asApp(b.orgId, (tx) => tx`insert into document_kinds (org_id, name) values (${a.orgId}, 'Planted')`)))?.code).toBe('42501');
  });

  it('a template can only point at a kind of its OWN org, and a kind in use cannot be deleted [kills: a cross-org kind on a template]', async () => {
    const a = await sql.begin(async (tx) => org(tx));
    const b = await sql.begin(async (tx) => org(tx));
    const [ka] = await sql<{ id: string }[]>`insert into document_kinds (org_id, name) values (${a.orgId}, 'A kind') returning id`;
    const [kb] = await sql<{ id: string }[]>`insert into document_kinds (org_id, name) values (${b.orgId}, 'B kind') returning id`;
    expect((await caught(sql`insert into document_templates (org_id, name, kind_id, created_by) values (${a.orgId}, 'X', ${kb!.id}, ${a.person})`))?.constraint_name).toBe('document_templates_kind_same_org_fk');
    await sql`insert into document_templates (org_id, name, kind_id, created_by) values (${a.orgId}, 'Y', ${ka!.id}, ${a.person})`;
    expect(['23001', '23503']).toContain((await caught(sql`delete from document_kinds where id = ${ka!.id}`))?.code); // RESTRICT
  });

  it('the new columns exist: margins defaults to normal and only narrow, normal or wide; body_doc must be an object; the old kind column is gone [kills: a margin the printer cannot honour]', async () => {
    const a = await sql.begin(async (tx) => org(tx));
    const [k] = await sql<{ id: string }[]>`insert into document_kinds (org_id, name) values (${a.orgId}, 'K') returning id`;
    const [t] = await sql<{ id: string }[]>`insert into document_templates (org_id, name, kind_id, created_by) values (${a.orgId}, 'T', ${k!.id}, ${a.person}) returning id`;
    const ins = (extra: { margins?: string; body_doc?: unknown }, no: number) =>
      sql`insert into document_template_versions (org_id, template_id, version_no, body, margins, body_doc, created_by)
          values (${a.orgId}, ${t!.id}, ${no}, 'b', ${extra.margins ?? 'normal'}, ${extra.body_doc === undefined ? null : sql.json(extra.body_doc as never)}, ${a.person}) returning margins`;
    expect((await ins({}, 1))[0]!.margins).toBe('normal');
    expect((await caught(ins({ margins: 'huge' }, 2)))?.constraint_name).toBe('document_template_versions_margins_check');
    expect((await caught(ins({ body_doc: [1, 2] }, 3)))?.constraint_name).toBe('document_template_versions_docs_check');
    const cols = await sql<{ column_name: string }[]>`select column_name from information_schema.columns where table_name = 'document_templates'`;
    expect(cols.map((c) => c.column_name)).not.toContain('kind');
    expect(cols.map((c) => c.column_name)).toContain('kind_id');
    const idx = await sql<{ indexdef: string }[]>`select indexdef from pg_indexes where indexname = 'document_kinds_org_name_unique'`;
    expect(idx[0]!.indexdef).toContain('lower(name)');
  });
});
