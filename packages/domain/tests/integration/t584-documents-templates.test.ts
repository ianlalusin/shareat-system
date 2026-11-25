import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-584 S2 - the template library (docs/tasks/584-documents.md s3 item 1, s5, s7, s8 tests 3 and 7).
 * Real Postgres. Admins write templates (manage_document_templates, org scope); a manager is refused even in scope of a store.
 * Every save is a NEW version; an old version stays readable and is never edited. An unknown merge field is refused with the bad name shown.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - name must contain "_test".`);
}

import { APP_ROLE, closeDb, transaction, RefusalError, type Tx } from '@shareat/db';
import { AuthorizationError } from '@shareat/auth';
import { listDocumentTemplates, listDocumentTemplateVersions, retireDocumentTemplate, saveDocumentTemplate } from '@shareat/domain';
import { documentFixture, type DocFixture } from './_fixtures/t584-documents';

const sql = postgres(url, { max: 5 });

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

async function sentenceOf(p: Promise<unknown>): Promise<string> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, 'expected a refusal, got success').not.toBeNull();
  expect(err instanceof RefusalError || err instanceof AuthorizationError, `expected a refusal, got ${String((err as Error)?.message)}`).toBe(true);
  const s = (err as RefusalError | AuthorizationError).userMessage;
  expect(s, 'the refusal carries a sentence for a person').toBeTruthy();
  return s as string;
}

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const COE = '# Certificate of Employment\n\nThis certifies that **{{employee.full_name}}** ({{employee.staff_code}}) has worked at {{store.name}} as {{employee.position}} since {{employee.started_on}}.\n\nIssued {{today}} by {{issuer.full_name}}.';
const save = (f: DocFixture, who: 'admin' | 'managerA', input: Partial<Parameters<typeof saveDocumentTemplate>[2]> = {}) =>
  asOrg(f.orgId, (tx) =>
    saveDocumentTemplate(tx, f[who].actor, { name: 'Certificate of Employment', kindId: f.kind.coe, body: COE, signatureSlots: ['issuer', 'employee'], ...input }),
  );

describe('T-584 S2 - who may write templates', () => {
  it('an admin saves a new template: version 1, readable back with its slots [kills: nothing saved]', async () => {
    const f = await documentFixture(sql, 'tpl-admin');
    const r = await save(f, 'admin');
    expect(r.versionNo).toBe(1);
    const list = await asOrg(f.orgId, (tx) => listDocumentTemplates(tx, f.admin.actor));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: r.templateId, name: 'Certificate of Employment', kindName: 'Certificate of employment', kindId: f.kind.coe, retired: false });
    // T-637: an old-markup save is converted to a document; `body` keeps its plain text (heading words and field tags, no markup).
    expect(list[0]!.latest).toMatchObject({ versionNo: 1, signatureSlots: ['issuer', 'employee'], legacy: false });
    expect(list[0]!.latest.body).toContain('This certifies that Employee full name'.replace('Employee full name', '{{employee.full_name}}'));
    expect(list[0]!.latest.doc.content[0]).toMatchObject({ type: 'heading' });
  });

  it('a manager in scope of the store is refused to save, list or retire templates [kills: manager true on manage_document_templates]', async () => {
    const f = await documentFixture(sql, 'tpl-mgr');
    const made = await save(f, 'admin');
    expect(await sentenceOf(save(f, 'managerA'))).toMatch(/can.t|not allowed|may not|cannot/i);
    await sentenceOf(asOrg(f.orgId, (tx) => listDocumentTemplates(tx, f.managerA.actor)));
    await sentenceOf(asOrg(f.orgId, (tx) => retireDocumentTemplate(tx, f.managerA.actor, made.templateId)));
    await sentenceOf(asOrg(f.orgId, (tx) => saveDocumentTemplate(tx, f.staff.actor, { name: 'X', kindId: f.kind.memo, body: 'x', signatureSlots: [] })));
  });

  it('another organisation cannot see or change this template [kills: a missing org filter]', async () => {
    const a = await documentFixture(sql, 'tpl-orgA');
    const b = await documentFixture(sql, 'tpl-orgB');
    const made = await save(a, 'admin');
    expect(await asOrg(b.orgId, (tx) => listDocumentTemplates(tx, b.admin.actor))).toHaveLength(0);
    expect(await sentenceOf(asOrg(b.orgId, (tx) => saveDocumentTemplate(tx, b.admin.actor, { templateId: made.templateId, name: 'Hijack', kindId: b.kind.memo, body: 'x', signatureSlots: [] })))).toMatch(/does not exist/i);
  });
});

describe('T-584 S2 - versions: every save is a new version, the old one stays (test 7)', () => {
  it('editing makes v2; v1 still reads exactly as it was and its id is unchanged [kills: editing v1 in place]', async () => {
    const f = await documentFixture(sql, 'tpl-ver');
    const v1 = await save(f, 'admin');
    const v2 = await save(f, 'admin', { templateId: v1.templateId, body: `${COE}\n\nSecond edition.` });
    expect(v2.versionNo).toBe(2);
    expect(v2.templateId).toBe(v1.templateId);
    expect(v2.versionId).not.toBe(v1.versionId);
    const versions = await asOrg(f.orgId, (tx) => listDocumentTemplateVersions(tx, f.admin.actor, v1.templateId));
    expect(versions.map((v) => v.versionNo)).toEqual([2, 1]);
    expect(versions.find((v) => v.versionNo === 1)).toMatchObject({ id: v1.versionId });
    expect(versions.find((v) => v.versionNo === 1)!.body).toContain('has worked at {{store.name}} as {{employee.position}}'); // plain text of the document (T-637)
    expect(versions.find((v) => v.versionNo === 1)!.body).not.toContain('Second edition');
    expect(versions.find((v) => v.versionNo === 2)!.body).toContain('Second edition.');
    const list = await asOrg(f.orgId, (tx) => listDocumentTemplates(tx, f.admin.actor));
    expect(list[0]!.latest.versionNo).toBe(2);
  });

  it('renaming or changing the kind is still a new version, and the head follows [kills: a silent head change with no version]', async () => {
    const f = await documentFixture(sql, 'tpl-head');
    const v1 = await save(f, 'admin');
    const v2 = await save(f, 'admin', { templateId: v1.templateId, name: 'Employment Certificate', kindId: f.kind.other });
    expect(v2.versionNo).toBe(2);
    const list = await asOrg(f.orgId, (tx) => listDocumentTemplates(tx, f.admin.actor));
    expect(list[0]).toMatchObject({ name: 'Employment Certificate', kindName: 'Other', kindId: f.kind.other });
  });

  it('two saves of one template at once get versions 2 and 3, never the same number [kills: a duplicate version number]', async () => {
    const f = await documentFixture(sql, 'tpl-race');
    const v1 = await save(f, 'admin');
    const [a, b] = await Promise.all([
      save(f, 'admin', { templateId: v1.templateId, body: `${COE}\n\nA` }),
      save(f, 'admin', { templateId: v1.templateId, body: `${COE}\n\nB` }),
    ]);
    expect([a.versionNo, b.versionNo].sort()).toEqual([2, 3]);
  });
});

describe('T-584 S2 - what a template may say (test 3)', () => {
  it('an unknown merge field is refused and the bad name is shown; nothing is saved [kills: a typo saved silently]', async () => {
    const f = await documentFixture(sql, 'tpl-bad');
    const s = await sentenceOf(save(f, 'admin', { body: 'Pay: {{employee.salary}} and {{nope}} for {{employee.full_name}}' }));
    expect(s).toContain('employee.salary');
    expect(s).toContain('nope');
    expect(s).not.toContain('employee.full_name');
    expect(await asOrg(f.orgId, (tx) => listDocumentTemplates(tx, f.admin.actor))).toHaveLength(0);
  });

  it('a blank name, a blank body, a bad kind, a bad slot and a too-long body are each refused in plain words [kills: garbage saved]', async () => {
    const f = await documentFixture(sql, 'tpl-fields');
    expect(await sentenceOf(save(f, 'admin', { name: '   ' }))).toMatch(/name/i);
    expect(await sentenceOf(save(f, 'admin', { body: '  \n ' }))).toMatch(/wording|body|text/i);
    expect(await sentenceOf(save(f, 'admin', { kindId: 'waiver' }))).toMatch(/kind/i);
    expect(await sentenceOf(save(f, 'admin', { signatureSlots: ['witness'] as never }))).toMatch(/signature/i);
    expect(await sentenceOf(save(f, 'admin', { body: 'x'.repeat(50001) }))).toMatch(/too long|50,000|50000/i);
  });

  it('a waiver or quitclaim kind is not on offer (R6) [kills: offering a template a lawyer has not reviewed]', async () => {
    const f = await documentFixture(sql, 'tpl-waiver');
    // A kind exists only if Ian adds it: the seeded list has neither, and an id that is not on the list is refused.
    for (const kindId of ['waiver', 'quitclaim', '0198a8f0-0000-7000-8000-000000000000']) {
      await sentenceOf(save(f, 'admin', { kindId }));
    }
  });
});

describe('T-584 S2 - retire and audit', () => {
  it('a retired template stays listed as retired and cannot be saved again [kills: editing a retired template]', async () => {
    const f = await documentFixture(sql, 'tpl-retire');
    const v1 = await save(f, 'admin');
    await asOrg(f.orgId, (tx) => retireDocumentTemplate(tx, f.admin.actor, v1.templateId));
    const list = await asOrg(f.orgId, (tx) => listDocumentTemplates(tx, f.admin.actor));
    expect(list[0]).toMatchObject({ id: v1.templateId, retired: true });
    expect(await sentenceOf(save(f, 'admin', { templateId: v1.templateId, body: 'new' }))).toMatch(/retired/i);
  });

  it('a save and a retire each leave one audit row with ids and no wording [kills: an unaudited write]', async () => {
    const f = await documentFixture(sql, 'tpl-audit');
    const v1 = await save(f, 'admin');
    await save(f, 'admin', { templateId: v1.templateId, body: 'second' });
    await asOrg(f.orgId, (tx) => retireDocumentTemplate(tx, f.admin.actor, v1.templateId));
    const rows = await sql<{ action: string; after: Record<string, unknown> }[]>`
      select action, after from audit_log where org_id = ${f.orgId} and action like 'document_template.%' order by id`;
    expect(rows.map((r) => r.action)).toEqual(['document_template.version_saved', 'document_template.version_saved', 'document_template.retired']);
    expect(rows[1]!.after).toMatchObject({ templateId: v1.templateId, versionNo: 2, kind: 'Certificate of employment', kindId: f.kind.coe });
    expect(JSON.stringify(rows)).not.toContain('second');
  });
});
