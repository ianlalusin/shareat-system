/**
 * T-584 S1 - the five document tables as migration 0259 builds them (hand-authored, ADR-012 s5). docs/tasks/584-documents.md s4, s8 (tests 4, 7, 10 at the table level).
 * Real Postgres via TEST_DATABASE_URL, `_test` name guard. Fixtures are synthetic ("Test Org", "Staff A"); no real company data.
 *
 * What is pinned: the journal entry; RLS forced; the append-only triggers (template versions, document versions, signatures) refuse UPDATE and DELETE even for the
 * owner role; an issued document is immutable except the void columns, once; version_no is exactly previous + 1; a void document cannot be revised or signed; only the
 * CURRENT version can be signed; same-org foreign keys; the app role has no DELETE and no UPDATE of an immutable column.
 */
import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

import { APP_ROLE } from '../../src/rls/registry';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const MIGRATIONS = join(__dirname, '..', '..', 'migrations');
const TABLES = ['document_templates', 'document_template_versions', 'issued_documents', 'issued_document_versions', 'issued_document_signatures'];

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

async function caught<T>(p: Promise<T>): Promise<(Error & { code?: string; constraint_name?: string }) | undefined> {
  try {
    await p;
  } catch (err) {
    return err as Error & { code?: string; constraint_name?: string };
  }
  return undefined;
}
async function asApp<T>(orgId: string, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return (await sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${APP_ROLE}`);
    await tx`select set_config('app.principal_kind', 'staff', true)`;
    await tx`select set_config('app.org_id', ${orgId}, true)`;
    return (await fn(tx)) as never;
  })) as T;
}

async function fixture(hint: string) {
  const code = uid(hint);
  const [o] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Test Org ${code}`}, ${code}) returning id`;
  const orgId = o!.id;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('st')}, 'Test Store') returning id`;
  const mkPerson = async (name: string) => (await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`)[0]!.id;
  const issuer = await mkPerson('Issuer A');
  const employee = await mkPerson('Staff B');
  const [emp] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${orgId}, ${store!.id}, ${employee}, 'SE-001', 'regular', '2025-01-06') returning id`;
  const [file] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${orgId}, 'staff_signature', ${`orgs/${orgId}/sig-${uid('f')}.png`}, 'image/png', 10, 'x', ${issuer}) returning id`;
  const [t] = await sql<{ id: string }[]>`insert into document_templates (org_id, name, kind, created_by) values (${orgId}, 'Test COE', 'coe', ${issuer}) returning id`;
  const [tv] = await sql<{ id: string }[]>`
    insert into document_template_versions (org_id, template_id, version_no, body, signature_slots, created_by)
    values (${orgId}, ${t!.id}, 1, 'Body {{employee.full_name}}', ${sql.array(['issuer', 'employee'])}, ${issuer}) returning id`;
  return { orgId, storeId: store!.id, issuer, employee, employmentId: emp!.id, fileId: file!.id, templateId: t!.id, templateVersionId: tv!.id };
}
type F = Awaited<ReturnType<typeof fixture>>;

async function document(f: F, number: string) {
  const [d] = await sql<{ id: string }[]>`
    insert into issued_documents (org_id, store_id, number, template_version_id, employment_id, issued_by)
    values (${f.orgId}, ${f.storeId}, ${number}, ${f.templateVersionId}, ${f.employmentId}, ${f.issuer}) returning id`;
  const [v] = await sql<{ id: string }[]>`
    insert into issued_document_versions (org_id, issued_document_id, version_no, body, created_by)
    values (${f.orgId}, ${d!.id}, 1, 'Text one', ${f.issuer}) returning id`;
  return { id: d!.id, v1: v!.id };
}
const revise = (f: F, docId: string, no: number, reason: string | null = 'because') =>
  sql`insert into issued_document_versions (org_id, issued_document_id, version_no, body, reason, created_by)
      values (${f.orgId}, ${docId}, ${no}, ${`Text ${no}`}, ${reason}, ${f.issuer}) returning id`;
const sign = (f: F, versionId: string, slot: 'issuer' | 'employee') =>
  sql`insert into issued_document_signatures (org_id, issued_document_version_id, slot, person_id, signature_file_id)
      values (${f.orgId}, ${versionId}, ${slot}, ${slot === 'issuer' ? f.issuer : f.employee}, ${f.fileId}) returning id`;

describe('T-584 migration 0259 - journal and tables', () => {
  it('the journal has idx 259, a tag naming one existing file, and a when later than every earlier entry [kills: an unregistered file; a clock-time when]', () => {
    const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as { entries: { idx: number; tag: string; when: number }[] };
    const e = journal.entries.find((x) => x.idx === 259);
    expect(e, 'no journal entry with idx 259').toBeDefined();
    expect(e!.tag).toBe('0259_t584_documents');
    expect(readdirSync(MIGRATIONS).filter((n) => n.startsWith('0259_'))).toEqual(['0259_t584_documents.sql']);
    for (const x of journal.entries.filter((y) => y.idx < 259)) expect(e!.when, `after idx ${x.idx}`).toBeGreaterThan(x.when);
  });

  it('all five tables exist with RLS enabled AND forced, and one org-isolation policy each [kills: RLS left off a new table]', async () => {
    const rows = await sql<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      select relname, relrowsecurity, relforcerowsecurity from pg_class where relkind = 'r' and relname in ${sql(TABLES)}`;
    expect(rows.map((r) => r.relname).sort()).toEqual([...TABLES].sort());
    for (const r of rows) {
      expect(r.relrowsecurity, r.relname).toBe(true);
      expect(r.relforcerowsecurity, r.relname).toBe(true);
    }
    const pol = await sql<{ tablename: string; policyname: string }[]>`select tablename, policyname from pg_policies where tablename in ${sql(TABLES)}`;
    expect(pol.map((p) => p.tablename).sort()).toEqual([...TABLES].sort());
  });

  it('the immutability triggers are ENABLE ALWAYS (they still fire under session_replication_role = replica) [kills: a trigger that a restore script switches off]', async () => {
    const rows = await sql<{ tgname: string; tgenabled: string }[]>`
      select tgname, tgenabled from pg_trigger where not tgisinternal and tgrelid::regclass::text in ${sql(TABLES)}`;
    const names = rows.map((r) => r.tgname).sort();
    expect(names).toEqual(
      [
        'document_template_versions_append_only',
        'issued_document_signatures_append_only',
        'issued_document_signatures_current_version',
        'issued_document_versions_append_only',
        'issued_document_versions_sequence',
        'issued_documents_guard',
      ].sort(),
    );
    for (const r of rows) expect(r.tgenabled, r.tgname).toBe('A');
  });
});

describe('T-584 append-only tables refuse UPDATE and DELETE, even for the owner role (test 7, test 10)', () => {
  it('a template version cannot be updated or deleted [kills: editing v1 in place]', async () => {
    const f = await fixture('tv');
    expect((await caught(sql`update document_template_versions set body = 'edited' where id = ${f.templateVersionId}`))?.code).toBe('23001');
    expect((await caught(sql`delete from document_template_versions where id = ${f.templateVersionId}`))?.code).toBe('23001');
  });

  it('an issued document version cannot be updated or deleted [kills: R7 - rewriting a version]', async () => {
    const f = await fixture('dv');
    const d = await document(f, 'DOC-2026-0001');
    expect((await caught(sql`update issued_document_versions set body = 'edited' where id = ${d.v1}`))?.code).toBe('23001');
    expect((await caught(sql`delete from issued_document_versions where id = ${d.v1}`))?.code).toBe('23001');
  });

  it('a signature cannot be updated or deleted [kills: swapping the file a signature points at]', async () => {
    const f = await fixture('sg');
    const d = await document(f, 'DOC-2026-0001');
    const [s] = await sign(f, d.v1, 'issuer');
    expect((await caught(sql`update issued_document_signatures set signature_file_id = ${f.fileId} where id = ${s!.id}`))?.code).toBe('23001');
    expect((await caught(sql`delete from issued_document_signatures where id = ${s!.id}`))?.code).toBe('23001');
  });
});

describe('T-584 an issued document is immutable except the void columns, once (test 4)', () => {
  it('number, store, employee, template version, issuer and time cannot change; the row cannot be deleted [kills: editing after issue]', async () => {
    const f = await fixture('imm');
    const d = await document(f, 'DOC-2026-0001');
    expect((await caught(sql`update issued_documents set number = 'DOC-2026-0099' where id = ${d.id}`))?.code).toBe('23001');
    expect((await caught(sql`update issued_documents set issued_by = ${f.employee} where id = ${d.id}`))?.code).toBe('23001');
    expect((await caught(sql`update issued_documents set employment_id = null where id = ${d.id}`))?.code).toBe('23001');
    expect((await caught(sql`update issued_documents set issued_at = now() - interval '1 day' where id = ${d.id}`))?.code).toBe('23001');
    expect((await caught(sql`delete from issued_documents where id = ${d.id}`))?.code).toBe('23001');
  });

  it('it can be voided once with a reason; a second void, or a void with no reason, is refused [kills: re-voiding; a void with no reason]', async () => {
    const f = await fixture('void');
    const d = await document(f, 'DOC-2026-0001');
    expect((await caught(sql`update issued_documents set voided_at = now(), voided_by = ${f.issuer} where id = ${d.id}`))?.constraint_name).toBe('issued_documents_void_all_or_nothing_check');
    expect(await caught(sql`update issued_documents set voided_at = now(), voided_by = ${f.issuer}, void_reason = 'wrong person' where id = ${d.id}`)).toBeUndefined();
    expect((await caught(sql`update issued_documents set void_reason = 'changed my mind' where id = ${d.id}`))?.code).toBe('23001');
  });

  it('the number is unique per organisation, and the same number in another organisation is fine [kills: a global or missing unique]', async () => {
    const a = await fixture('numA');
    const b = await fixture('numB');
    await document(a, 'DOC-2026-0001');
    expect((await caught(document(a, 'DOC-2026-0001')))?.code).toBe('23505');
    expect(await caught(document(b, 'DOC-2026-0001'))).toBeUndefined();
  });

  it('a malformed number is refused by the table [kills: free-text numbers]', async () => {
    const f = await fixture('numfmt');
    expect((await caught(document(f, 'INV-1')))?.constraint_name).toBe('issued_documents_number_check');
  });
});

describe('T-584 revisions: version_no is exactly previous + 1, and a void document cannot be revised (R7, test 10)', () => {
  it('v2 is accepted; skipping to v3, repeating v2 or a revision with no reason is refused [kills: gaps, duplicates, silent edits]', async () => {
    const f = await fixture('rev');
    const d = await document(f, 'DOC-2026-0001');
    expect((await caught(revise(f, d.id, 3)))?.code).toBe('23514');
    expect((await caught(revise(f, d.id, 2, null)))?.constraint_name).toBe('issued_document_versions_reason_check');
    expect((await caught(revise(f, d.id, 2, '   ')))?.constraint_name).toBe('issued_document_versions_reason_check');
    expect(await caught(revise(f, d.id, 2))).toBeUndefined();
    expect((await caught(revise(f, d.id, 2)))?.code).toBe('23514');
    expect(await caught(revise(f, d.id, 3))).toBeUndefined();
  });

  it('a void document cannot be revised [kills: reviving a void document by editing it]', async () => {
    const f = await fixture('revvoid');
    const d = await document(f, 'DOC-2026-0001');
    await sql`update issued_documents set voided_at = now(), voided_by = ${f.issuer}, void_reason = 'test' where id = ${d.id}`;
    expect((await caught(revise(f, d.id, 2)))?.code).toBe('23514');
  });
});

describe('T-584 signatures belong to ONE version, and only the current version of a live document can be signed (R7, test 10)', () => {
  it('both slots sign v1; the same slot twice is refused; v2 starts unsigned and v1 keeps its signatures [kills: a signature carried into the next version]', async () => {
    const f = await fixture('sig');
    const d = await document(f, 'DOC-2026-0001');
    expect(await caught(sign(f, d.v1, 'issuer'))).toBeUndefined();
    expect(await caught(sign(f, d.v1, 'employee'))).toBeUndefined();
    expect((await caught(sign(f, d.v1, 'issuer')))?.code).toBe('23505');
    const [v2] = await revise(f, d.id, 2);
    const onV2 = await sql`select 1 from issued_document_signatures where issued_document_version_id = ${v2!.id}`;
    expect(onV2).toHaveLength(0);
    const onV1 = await sql`select 1 from issued_document_signatures where issued_document_version_id = ${d.v1}`;
    expect(onV1).toHaveLength(2);
  });

  it('signing v1 after v2 exists is refused; signing v2 works [kills: signing a superseded text]', async () => {
    const f = await fixture('sigold');
    const d = await document(f, 'DOC-2026-0001');
    const [v2] = await revise(f, d.id, 2);
    expect((await caught(sign(f, d.v1, 'issuer')))?.code).toBe('23514');
    expect(await caught(sign(f, v2!.id, 'issuer'))).toBeUndefined();
  });

  it('a void document cannot be signed [kills: signing after void]', async () => {
    const f = await fixture('sigvoid');
    const d = await document(f, 'DOC-2026-0001');
    await sql`update issued_documents set voided_at = now(), voided_by = ${f.issuer}, void_reason = 'test' where id = ${d.id}`;
    expect((await caught(sign(f, d.v1, 'issuer')))?.code).toBe('23514');
  });

  it('a slot other than issuer or employee is refused [kills: an invented slot]', async () => {
    const f = await fixture('slot');
    const d = await document(f, 'DOC-2026-0001');
    const e = await caught(sql`insert into issued_document_signatures (org_id, issued_document_version_id, slot, person_id, signature_file_id)
      values (${f.orgId}, ${d.v1}, 'witness', ${f.issuer}, ${f.fileId})`);
    expect(e?.constraint_name).toBe('issued_document_signatures_slot_check');
  });
});

describe('T-584 same-org keys and the template rules', () => {
  it('a document cannot name another organisation\'s employment, store or template version [kills: a cross-org reference]', async () => {
    const a = await fixture('xa');
    const b = await fixture('xb');
    const e1 = await caught(sql`insert into issued_documents (org_id, store_id, number, template_version_id, employment_id, issued_by)
      values (${a.orgId}, ${a.storeId}, 'DOC-2026-0002', ${a.templateVersionId}, ${b.employmentId}, ${a.issuer})`);
    expect(e1?.constraint_name).toBe('issued_documents_employment_same_org_fk');
    const e2 = await caught(sql`insert into issued_documents (org_id, store_id, number, template_version_id, employment_id, issued_by)
      values (${a.orgId}, ${b.storeId}, 'DOC-2026-0003', ${a.templateVersionId}, null, ${a.issuer})`);
    expect(e2?.constraint_name).toBe('issued_documents_store_same_org_fk');
    const e3 = await caught(sql`insert into issued_documents (org_id, store_id, number, template_version_id, employment_id, issued_by)
      values (${a.orgId}, ${a.storeId}, 'DOC-2026-0004', ${b.templateVersionId}, null, ${a.issuer})`);
    expect(e3?.constraint_name).toBe('issued_documents_template_version_same_org_fk');
  });

  it('a signature cannot point at another organisation\'s file [kills: a cross-org signature file]', async () => {
    const a = await fixture('fa');
    const b = await fixture('fb');
    const d = await document(a, 'DOC-2026-0001');
    const e = await caught(sql`insert into issued_document_signatures (org_id, issued_document_version_id, slot, person_id, signature_file_id)
      values (${a.orgId}, ${d.v1}, 'issuer', ${a.issuer}, ${b.fileId})`);
    expect(e?.constraint_name).toBe('issued_document_signatures_file_same_org_fk');
  });

  it('template versions: unique (template, version_no); a slot outside issuer/employee, an empty or oversized body is refused [kills: a bad template version]', async () => {
    const f = await fixture('tpl');
    const ins = (no: number, body: string, slots: string[]) =>
      sql`insert into document_template_versions (org_id, template_id, version_no, body, signature_slots, created_by)
          values (${f.orgId}, ${f.templateId}, ${no}, ${body}, ${sql.array(slots)}, ${f.issuer})`;
    expect((await caught(ins(1, 'dup', [])))?.code).toBe('23505');
    expect((await caught(ins(2, 'x', ['witness'])))?.constraint_name).toBe('document_template_versions_slots_check');
    expect((await caught(ins(2, '   ', [])))?.constraint_name).toBe('document_template_versions_body_check');
    expect((await caught(ins(2, 'x'.repeat(50001), [])))?.constraint_name).toBe('document_template_versions_body_check');
    expect(await caught(ins(2, 'fine', []))).toBeUndefined();
  });
});

describe('T-584 the app role: RLS isolation and column-level grants', () => {
  it('another organisation sees no document, version or signature [kills: a missing org policy]', async () => {
    const a = await fixture('rlsA');
    const b = await fixture('rlsB');
    const d = await document(a, 'DOC-2026-0001');
    await sign(a, d.v1, 'issuer');
    for (const t of TABLES) {
      const own = await asApp(a.orgId, (tx) => tx.unsafe(`select count(*)::int as n from "${t}"`));
      const foreign = await asApp(b.orgId, (tx) => tx.unsafe(`select count(*)::int as n from "${t}" where org_id = '${a.orgId}'`));
      expect(Number((own as unknown as { n: number }[])[0]!.n), `${t} own`).toBeGreaterThan(0);
      expect(Number((foreign as unknown as { n: number }[])[0]!.n), `${t} foreign`).toBe(0);
    }
  });

  it('the app role may insert and read but cannot DELETE anything, nor UPDATE an immutable column (42501) [kills: a grant wider than the lock]', async () => {
    const f = await fixture('grant');
    const d = await document(f, 'DOC-2026-0001');
    for (const t of TABLES) {
      const e = await caught(asApp(f.orgId, (tx) => tx.unsafe(`delete from "${t}" where org_id = '${f.orgId}'`)));
      expect(e?.code, `${t} delete`).toBe('42501');
    }
    const e1 = await caught(asApp(f.orgId, (tx) => tx.unsafe(`update issued_documents set number = 'DOC-2026-0050' where id = '${d.id}'`)));
    expect(e1?.code).toBe('42501');
    const e2 = await caught(asApp(f.orgId, (tx) => tx.unsafe(`update issued_document_versions set body = 'x' where id = '${d.v1}'`)));
    expect(e2?.code).toBe('42501');
    const e3 = await caught(asApp(f.orgId, (tx) => tx.unsafe(`update document_template_versions set body = 'x' where id = '${f.templateVersionId}'`)));
    expect(e3?.code).toBe('42501');
    // the void columns and the template head ARE writable
    expect(await caught(asApp(f.orgId, (tx) => tx.unsafe(`update document_templates set retired_at = now() where id = '${f.templateId}'`)))).toBeUndefined();
    expect(await caught(asApp(f.orgId, (tx) => tx.unsafe(`update issued_documents set voided_at = now(), voided_by = '${f.issuer}', void_reason = 'test' where id = '${d.id}'`)))).toBeUndefined();
  });
});
