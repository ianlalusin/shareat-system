import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-637 - the document editor's server half and the editable document kinds (docs/tasks/637-document-editor.md tests 1, 4, 5, 8 and the Addition's tests).
 * Real Postgres. Kinds: the seed, a new kind usable in a template, retire refused while an ACTIVE template uses it, who may edit, another org, audit, issued documents keep the
 * name they were issued with. Documents: the server refuses a stored doc off the whitelist, the new fields resolve (primary email and phone, length of service, store phone), a missing
 * value blocks issue, the header and footer are filled and frozen, a version from before 0281 still prints from its body.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - name must contain "_test".`);
}

import { APP_ROLE, closeDb, transaction, RefusalError, type Tx } from '@shareat/db';
import { AuthorizationError } from '@shareat/auth';
import {
  createDocumentKind,
  documentDraft,
  documentKindOptions,
  documentPrintData,
  getIssuedDocument,
  issueDocument,
  listDocumentKinds,
  listDocumentTemplates,
  listIssuedDocuments,
  renameDocumentKind,
  retireDocumentTemplate,
  reviseDocument,
  saveDocumentTemplate,
  setDocumentKindStatus,
  type DocJson,
  type DocNode,
} from '@shareat/domain';
import { documentFixture, type DocFixture } from './_fixtures/t584-documents';

const sql = postgres(url, { max: 6 });
let seq = 0;
const uniq = (p: string) => `${p}-${Date.now()}-${++seq}`;

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
  expect(s).toBeTruthy();
  return s as string;
}
async function denied(p: Promise<unknown>): Promise<void> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, 'expected the permission refusal, got success').toBeInstanceOf(AuthorizationError);
}
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const p = (...content: DocNode[]): DocNode => ({ type: 'paragraph', content });
const t = (text: string, marks?: DocNode['marks']): DocNode => ({ type: 'text', text, ...(marks ? { marks } : {}) });
const field = (name: string): DocNode => ({ type: 'field', attrs: { name } });
const doc = (...content: DocNode[]): DocJson => ({ type: 'doc', content });
const save = (f: DocFixture, input: Partial<Parameters<typeof saveDocumentTemplate>[2]> = {}) =>
  asOrg(f.orgId, (tx) => saveDocumentTemplate(tx, f.admin.actor, { name: uniq('Tpl'), kindId: f.kind.coe, bodyDoc: doc(p(t('Hello '), field('employee.full_name'))), signatureSlots: [], ...input }));

// ---------------------------------------------------------------------------------------------------------------------
describe('T-637 kinds - the list Ian edits', () => {
  it('every org starts with the seven kinds, replacing the old enum values with readable names [kills: a seed that is missing or still shows codes]', async () => {
    const f = await documentFixture(sql, 'k-seed');
    const kinds = await asOrg(f.orgId, (tx) => listDocumentKinds(tx, f.admin.actor));
    expect(kinds.map((k) => k.name)).toEqual(['Certificate of employment', 'Memo', 'Notice to explain', 'Contract', 'Other', 'Explanation letter', 'Incident report']);
    expect(kinds.every((k) => k.active)).toBe(true);
    // the five old enum values map to the five kinds the fixture hands out
    expect(Object.keys(f.kind).sort()).toEqual(['coe', 'contract', 'memo', 'nte', 'other']);
  });

  it('a kind Ian adds is usable in a template, shows on the document, and filters the register [kills: a kind that cannot be used]', async () => {
    const f = await documentFixture(sql, 'k-new');
    const { id } = await asOrg(f.orgId, (tx) => createDocumentKind(tx, f.admin.actor, { name: '  Warning letter ' }));
    const tpl = await save(f, { kindId: id });
    const list = await asOrg(f.orgId, (tx) => listDocumentTemplates(tx, f.admin.actor));
    expect(list.find((x) => x.id === tpl.templateId)).toMatchObject({ kindId: id, kindName: 'Warning letter' });
    const issued = await asOrg(f.orgId, (tx) => issueDocument(tx, f.managerA.actor, { templateId: tpl.templateId, employmentId: f.employee.employmentId, bodyDoc: doc(p(t('Warned.'))) }));
    const reg = await asOrg(f.orgId, (tx) => listIssuedDocuments(tx, f.admin.actor, { kindId: id }));
    expect(reg.map((r) => r.id)).toEqual([issued.documentId]);
    expect(reg[0]!.kindName).toBe('Warning letter');
    expect(await asOrg(f.orgId, (tx) => listIssuedDocuments(tx, f.admin.actor, { kindId: f.kind.memo }))).toEqual([]);
    expect((await asOrg(f.orgId, (tx) => documentPrintData(tx, f.admin.actor, issued.documentId))).kind).toBe('Warning letter');
  });

  it('retire is refused while an ACTIVE template uses the kind, and allowed once that template is retired; a retired kind cannot be given to a template [kills: retiring a kind in use]', async () => {
    const f = await documentFixture(sql, 'k-retire');
    const tpl = await save(f, { kindId: f.kind.nte });
    const s = await sentenceOf(asOrg(f.orgId, (tx) => setDocumentKindStatus(tx, f.admin.actor, { kindId: f.kind.nte, status: 'retired' })));
    expect(s).toMatch(/Notice to explain is used by 1 template/);
    await asOrg(f.orgId, (tx) => retireDocumentTemplate(tx, f.admin.actor, tpl.templateId));
    await asOrg(f.orgId, (tx) => setDocumentKindStatus(tx, f.admin.actor, { kindId: f.kind.nte, status: 'retired' }));
    expect((await asOrg(f.orgId, (tx) => listDocumentKinds(tx, f.admin.actor))).find((k) => k.id === f.kind.nte)!.active).toBe(false);
    expect(await sentenceOf(save(f, { kindId: f.kind.nte }))).toMatch(/retired/i);
    await asOrg(f.orgId, (tx) => setDocumentKindStatus(tx, f.admin.actor, { kindId: f.kind.nte, status: 'active' }));
    await save(f, { kindId: f.kind.nte });
  });

  it('a name is unique per org ignoring case, 1 to 40 characters; rename keeps the id [kills: two kinds called Memo]', async () => {
    const f = await documentFixture(sql, 'k-names');
    expect(await sentenceOf(asOrg(f.orgId, (tx) => createDocumentKind(tx, f.admin.actor, { name: 'MEMO' })))).toMatch(/already a kind called "Memo"/);
    expect(await sentenceOf(asOrg(f.orgId, (tx) => createDocumentKind(tx, f.admin.actor, { name: '   ' })))).toMatch(/name/i);
    expect(await sentenceOf(asOrg(f.orgId, (tx) => createDocumentKind(tx, f.admin.actor, { name: 'x'.repeat(41) })))).toMatch(/40 characters/);
    await asOrg(f.orgId, (tx) => renameDocumentKind(tx, f.admin.actor, { kindId: f.kind.other, name: 'Letter' }));
    const kinds = await asOrg(f.orgId, (tx) => listDocumentKinds(tx, f.admin.actor));
    expect(kinds.find((k) => k.id === f.kind.other)!.name).toBe('Letter');
    expect(await sentenceOf(asOrg(f.orgId, (tx) => renameDocumentKind(tx, f.admin.actor, { kindId: f.kind.other, name: 'memo' })))).toMatch(/already a kind/);
    await asOrg(f.orgId, (tx) => renameDocumentKind(tx, f.admin.actor, { kindId: f.kind.other, name: 'LETTER' })); // only the capitals change: its own name, allowed
  });

  it('a manager, a cashier and staff are refused editing kinds; anyone who may read documents may read the names; another org cannot touch them [kills: a missing authorize]', async () => {
    const f = await documentFixture(sql, 'k-who');
    const other = await documentFixture(sql, 'k-who-b');
    for (const who of [f.managerA, f.staff, f.employee]) {
      await denied(asOrg(f.orgId, (tx) => createDocumentKind(tx, who.actor, { name: 'Sneaky' })));
      await denied(asOrg(f.orgId, (tx) => renameDocumentKind(tx, who.actor, { kindId: f.kind.memo, name: 'Sneaky' })));
      await denied(asOrg(f.orgId, (tx) => setDocumentKindStatus(tx, who.actor, { kindId: f.kind.memo, status: 'retired' })));
      await denied(asOrg(f.orgId, (tx) => listDocumentKinds(tx, who.actor)));
    }
    // the names are readable by a manager (they print on the register) but not by staff with no documents capability
    expect((await asOrg(f.orgId, (tx) => documentKindOptions(tx, f.managerA.actor))).map((k) => k.name)).toContain('Memo');
    await denied(asOrg(f.orgId, (tx) => documentKindOptions(tx, f.staff.actor)));
    expect(await sentenceOf(asOrg(other.orgId, (tx) => renameDocumentKind(tx, other.admin.actor, { kindId: f.kind.memo, name: 'Hijack' })))).toBeTruthy();
    expect((await asOrg(other.orgId, (tx) => listDocumentKinds(tx, other.admin.actor))).map((k) => k.name)).not.toContain('Hijack');
  });

  it('each change is audited, and an issued document keeps the kind name it was issued with after a rename or a retire [kills: no audit; a printed page that follows a rename]', async () => {
    const f = await documentFixture(sql, 'k-audit');
    const tpl = await save(f, { kindId: f.kind.contract });
    const issued = await asOrg(f.orgId, (tx) => issueDocument(tx, f.managerA.actor, { templateId: tpl.templateId, employmentId: f.employee.employmentId, bodyDoc: doc(p(t('Signed.'))) }));
    await asOrg(f.orgId, (tx) => renameDocumentKind(tx, f.admin.actor, { kindId: f.kind.contract, name: 'Agreement' }));
    await asOrg(f.orgId, (tx) => retireDocumentTemplate(tx, f.admin.actor, tpl.templateId));
    await asOrg(f.orgId, (tx) => setDocumentKindStatus(tx, f.admin.actor, { kindId: f.kind.contract, status: 'retired' }));
    await asOrg(f.orgId, (tx) => setDocumentKindStatus(tx, f.admin.actor, { kindId: f.kind.contract, status: 'active' }));
    expect((await asOrg(f.orgId, (tx) => documentPrintData(tx, f.admin.actor, issued.documentId))).kind).toBe('Contract'); // frozen on its version
    const rows = await sql<{ action: string; before: unknown; after: unknown }[]>`
      select action, before, after from audit_log where org_id = ${f.orgId} and action like 'document_kind.%' order by id`;
    expect(rows.map((r) => r.action)).toEqual(['document_kind.renamed', 'document_kind.retired', 'document_kind.reactivated']);
    expect(rows[0]).toMatchObject({ before: { name: 'Contract' }, after: { name: 'Agreement' } });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('T-637 test 1 and test 8 - what the server keeps, and the warning that does not block', () => {
  it('the server refuses a stored doc with a script, iframe or image node, a colour mark, an href, merged cells or an unknown field; nothing is saved [kills: a whitelist only the browser knew]', async () => {
    const f = await documentFixture(sql, 'd-refuse');
    const bad: Array<[string, DocJson, RegExp]> = [
      ['script', doc({ type: 'script' } as DocNode), /"script"/],
      ['iframe', doc({ type: 'iframe' } as DocNode), /"iframe"/],
      ['image', doc(p({ type: 'image', attrs: { src: 'x' } } as DocNode)), /image/],
      ['colour', doc(p(t('x', [{ type: 'textStyle', attrs: { color: 'red' } }]))), /color/],
      ['link', doc(p(t('x', [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }]))), /link/],
      ['href', doc({ type: 'paragraph', attrs: { href: 'x' }, content: [t('x')] }), /href/],
      ['unknown field', doc(p(field('employee.salary'))), /employee\.salary/],
    ];
    for (const [label, d, re] of bad) expect(await sentenceOf(save(f, { bodyDoc: d })), label).toMatch(re);
    expect(await sentenceOf(save(f, { bodyDoc: doc(p(t('ok'))), headerDoc: doc({ type: 'script' } as DocNode) }))).toMatch(/header/i);
    expect(await sentenceOf(save(f, { bodyDoc: doc(p(t('ok'))), margins: 'huge' as never }))).toMatch(/margins/i);
    expect(await sentenceOf(save(f, { bodyDoc: doc(p()) }))).toMatch(/cannot be empty/i);
    expect(await sentenceOf(save(f, { bodyDoc: 'not json' as never }))).toMatch(/cannot be saved/i);
    expect(await asOrg(f.orgId, (tx) => listDocumentTemplates(tx, f.admin.actor))).toHaveLength(0);
  });

  it('a good document is kept as JSON with its page settings, the old body column holds its plain text, and an empty header is no header [kills: JSON not stored]', async () => {
    const f = await documentFixture(sql, 'd-keep');
    const body = doc({ type: 'heading', attrs: { level: 1, textAlign: 'center' }, content: [t('Title', [{ type: 'bold' }])] }, p(t('Dear '), field('employee.full_name')));
    const r = await save(f, { bodyDoc: body, headerDoc: doc(p(field('store.name'))), footerDoc: doc(p()), margins: 'wide' });
    expect(r.warnings).toEqual([]);
    const [row] = await sql<{ body: string; body_doc: unknown; margins: string; header_doc: unknown; footer_doc: unknown }[]>`
      select body, body_doc, margins, header_doc, footer_doc from document_template_versions where id = ${r.versionId}`;
    expect(row!.body).toBe('Title\n\nDear {{employee.full_name}}');
    expect(row!.body_doc).toEqual(body);
    expect(row).toMatchObject({ margins: 'wide', header_doc: doc(p(field('store.name'))), footer_doc: null });
    const listed = (await asOrg(f.orgId, (tx) => listDocumentTemplates(tx, f.admin.actor))).find((x) => x.id === r.templateId)!;
    expect(listed.latest).toMatchObject({ legacy: false, margins: 'wide' });
    expect(listed.latest.doc).toEqual(body);
    expect(listed.latest.footerDoc).toBeNull();
  });

  it('[SOMETHING IN CAPS] text saves with a warning and does not block [kills: a placeholder lookalike that blocks, or is never mentioned]', async () => {
    const f = await documentFixture(sql, 'd-warn');
    const r = await save(f, { bodyDoc: doc(p(t('This certifies [EMPLOYEE FULL NAME] works at {{x}}'))), headerDoc: doc(p(t('[COMPANY NAME]'))) });
    expect(r.versionNo).toBe(1);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('[EMPLOYEE FULL NAME]');
    expect(r.warnings[0]).toContain('[COMPANY NAME]');
    expect(r.warnings[0]).toMatch(/Insert field/);
    expect((await save(f, { bodyDoc: doc(p(t('No placeholders here.'))) })).warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('T-637 tests 4 and 5 - fields resolve from stored data; a missing value blocks issue', () => {
  const ALL = doc(
    p(field('employee.first_name'), t('|'), field('employee.last_name'), t('|'), field('employee.email'), t('|'), field('employee.phone')),
    p(field('employee.length_of_service'), t('|'), field('store.phone'), t('|'), field('employee.full_name')),
  );

  it('the primary email and phone: a verified one before an unverified one, then the one on file longest; length of service and the store phone come from stored data [kills: a random email, a wrong month count]', async () => {
    const f = await documentFixture(sql, 'd-fields');
    const pid = f.employee.personId;
    const em = (v: string, verified: boolean, at: string) =>
      sql`insert into person_identities (person_id, kind, value, is_verified, created_at) values (${pid}, 'email', ${`${uniq(v)}@example.com`}, ${verified}, ${at})`;
    await em('newer-unverified', false, '2026-03-01T00:00:00Z');
    await em('older-unverified', false, '2025-01-01T00:00:00Z');
    const [pick] = await sql<{ value: string }[]>`
      insert into person_identities (person_id, kind, value, is_verified, created_at) values (${pid}, 'email', ${`verified-${uniq('v')}@example.com`}, true, '2026-06-01T00:00:00Z') returning value`;
    await sql`insert into person_identities (person_id, kind, value, created_at) values (${pid}, 'phone', ${uniq('0917')}, '2026-02-01T00:00:00Z')`;
    const [firstPhone] = await sql<{ value: string }[]>`
      insert into person_identities (person_id, kind, value, created_at) values (${pid}, 'phone', ${uniq('0918')}, '2025-02-01T00:00:00Z') returning value`;
    await sql`update stores set contact_number = '(043) 555 0101' where id = ${f.storeA}`;
    await sql`update employments set started_on = '2025-01-06' where id = ${f.employee.employmentId}`;
    const tpl = await save(f, { bodyDoc: ALL });
    const draft = await asOrg(f.orgId, (tx) => documentDraft(tx, f.managerA.actor, { templateId: tpl.templateId, employmentId: f.employee.employmentId }));
    const lines = draft.body.split('\n\n');
    const [first, last, email, phone] = lines[0]!.split('|');
    expect([first, last]).toEqual(['Staffer', 'Employee']);
    expect(email).toBe(pick!.value); // verified wins over two older and newer unverified ones
    expect(phone).toBe(firstPhone!.value); // neither verified: the one on file longest
    const [months, storePhone] = lines[1]!.split('|');
    const expectMonths = (() => {
      const now = new Date(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date()) + 'T00:00:00Z');
      const total = (now.getUTCFullYear() - 2025) * 12 + (now.getUTCMonth() - 0) - (now.getUTCDate() < 6 ? 1 : 0);
      const y = Math.floor(total / 12);
      const m = total % 12;
      return [y > 0 ? `${y} ${y === 1 ? 'year' : 'years'}` : '', m > 0 ? `${m} ${m === 1 ? 'month' : 'months'}` : ''].filter(Boolean).join(', ');
    })();
    expect(months).toBe(expectMonths);
    expect(storePhone).toBe('(043) 555 0101');
    expect(draft.missing).toEqual([]);
  });

  it('a person with no email, no phone or no first name leaves a [missing: x] gap that BLOCKS issue; an unknown field never reaches issue [kills: a blank printed, or issue allowed with a gap]', async () => {
    const f = await documentFixture(sql, 'd-missing');
    await sql`update stores set contact_number = null where id = ${f.storeA}`;
    const tpl = await save(f, { bodyDoc: ALL });
    const draft = await asOrg(f.orgId, (tx) => documentDraft(tx, f.admin.actor, { templateId: tpl.templateId, employmentId: f.employeeB.employmentId }));
    // employeeB is at store B: no store contact is set there either; no identities were added for this person
    expect(draft.missing).toEqual(expect.arrayContaining(['employee.first_name', 'employee.last_name', 'employee.email', 'employee.phone', 'store.phone']));
    expect(draft.body).toContain('[missing: employee.email]');
    const s = await sentenceOf(asOrg(f.orgId, (tx) => issueDocument(tx, f.admin.actor, { templateId: tpl.templateId, employmentId: f.employeeB.employmentId, bodyDoc: draft.doc })));
    expect(s).toMatch(/\[missing: employee\.email\]/);
    // editing the gap out lets it through
    const fixed = doc(p(t('Cleared.')));
    expect((await asOrg(f.orgId, (tx) => issueDocument(tx, f.admin.actor, { templateId: tpl.templateId, employmentId: f.employeeB.employmentId, bodyDoc: fixed }))).number).toMatch(/^DOC-\d{4}-\d{4}$/);
    // the server judges the issued body with the same whitelist
    expect(await sentenceOf(asOrg(f.orgId, (tx) => issueDocument(tx, f.admin.actor, { templateId: tpl.templateId, employmentId: f.employeeB.employmentId, bodyDoc: doc({ type: 'script' } as DocNode) })))).toMatch(/"script"/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('T-637 page - header and footer are filled at issue and frozen; a version from before 0281 prints from its body', () => {
  it('the header and footer are filled on the server for THIS document, missing values print nothing, and later changes to the company or the template change nothing printed [kills: a header read live]', async () => {
    const f = await documentFixture(sql, 'p-freeze');
    const tpl = await save(f, {
      bodyDoc: doc(p(t('Body '), field('employee.full_name'))),
      headerDoc: doc(p(field('org.legal_name')), p(field('store.name')), p(field('store.phone'))),
      footerDoc: doc(p(t('Footer for '), field('store.name'))),
      margins: 'narrow',
    });
    const draft = await asOrg(f.orgId, (tx) => documentDraft(tx, f.managerA.actor, { templateId: tpl.templateId, employmentId: f.employee.employmentId }));
    expect(draft.page.margins).toBe('narrow');
    const r = await asOrg(f.orgId, (tx) => issueDocument(tx, f.managerA.actor, { templateId: tpl.templateId, employmentId: f.employee.employmentId, bodyDoc: draft.doc }));
    const print = (v?: number) => asOrg(f.orgId, (tx) => documentPrintData(tx, f.admin.actor, r.documentId, v));
    const first = await print(1);
    expect(first.page!.margins).toBe('narrow');
    // store.phone is empty at store A: that line is dropped, the others are text
    expect(first.page!.headerDoc!.content.map((n) => (n.content ?? []).map((c) => c.text).join(''))).toEqual(['Test Org Incorporated', 'Test Store A']);
    expect(first.page!.footerDoc!.content[0]!.content!.map((c) => c.text).join('')).toBe('Footer for Test Store A');
    expect(JSON.stringify(first.page)).not.toContain('"field"');
    // the company, the store and the template all change afterwards
    await sql`update organizations set legal_name = 'Renamed Corp' where id = ${f.orgId}`;
    await sql`update stores set name = 'Renamed Store' where id = ${f.storeA}`;
    await save(f, { templateId: tpl.templateId, bodyDoc: doc(p(t('Other'))), headerDoc: doc(p(t('NEW HEADER'))), margins: 'wide' });
    expect(await print(1)).toMatchObject({ page: first.page });
    // a revision carries the page over exactly as it was filled at issue
    await asOrg(f.orgId, (tx) => reviseDocument(tx, f.admin.actor, { documentId: r.documentId, bodyDoc: doc(p(t('Revised body.'))), reason: 'Fix' }));
    const second = await print(2);
    expect(second.page).toEqual(first.page);
    expect(second.doc).toEqual(doc(p(t('Revised body.'))));
    expect(await print(1).then((x) => x.doc)).toEqual(draft.doc);
  });

  it('a header that needs a store the document does not have prints nothing and does not block an org-wide memo [kills: a letterhead that blocks issue]', async () => {
    const f = await documentFixture(sql, 'p-orgwide');
    const tpl = await save(f, { bodyDoc: doc(p(t('Memo to all.'))), headerDoc: doc(p(field('store.address'))), kindId: f.kind.memo });
    const r = await asOrg(f.orgId, (tx) => issueDocument(tx, f.admin.actor, { templateId: tpl.templateId, bodyDoc: doc(p(t('Memo to all.'))) }));
    const printed = await asOrg(f.orgId, (tx) => documentPrintData(tx, f.admin.actor, r.documentId));
    expect(printed.page).toMatchObject({ margins: 'normal', headerDoc: { type: 'doc', content: [{ type: 'paragraph' }] } });
  });

  it('a version from before 0281 (no body_doc, no page) prints from its stored body with the old built-in letterhead, and a revision of it writes a document [kills: old documents rewritten or unreadable]', async () => {
    const f = await documentFixture(sql, 'p-legacy');
    const tpl = await save(f);
    const [tv] = await sql<{ id: string }[]>`select id from document_template_versions where template_id = ${tpl.templateId}`;
    const [d] = await sql<{ id: string }[]>`
      insert into issued_documents (org_id, store_id, number, template_version_id, employment_id, issued_by)
      values (${f.orgId}, ${f.storeA}, ${`DOC-2026-${String(9000 + seq++)}`}, ${tv!.id}, ${f.employee.employmentId}, ${f.admin.personId}) returning id`;
    await sql`
      insert into issued_document_versions (org_id, issued_document_id, version_no, body, letterhead, created_by)
      values (${f.orgId}, ${d!.id}, 1, ${'# Old heading\n\nOld **bold** wording with a typed {{today}}.'},
        ${sql.json({ orgLegalName: 'Old Corp', orgTradingName: 'Old', orgTin: '1', tinBranchCode: '00001', storeName: 'S', storeAddress: 'A', storeContact: null, templateName: 'COE', templateKind: 'coe' })},
        ${f.admin.personId})`;
    const old = await asOrg(f.orgId, (tx) => documentPrintData(tx, f.admin.actor, d!.id));
    expect(old.page).toBeNull(); // the page draws the old built-in company block
    expect(old.kind).toBeTruthy();
    expect(old.letterhead.legalName).toBe('Old Corp');
    expect(old.body).toBe('# Old heading\n\nOld **bold** wording with a typed {{today}}.'); // the stored text is untouched
    expect(JSON.stringify(old.doc)).not.toContain('"field"'); // a typed {{today}} in an old issued body prints as typed, not as a chip
    expect(old.doc.content[0]).toMatchObject({ type: 'heading', attrs: { level: 2 } });
    expect(JSON.stringify(old.doc)).toContain('"bold"');
    const got = await asOrg(f.orgId, (tx) => getIssuedDocument(tx, f.admin.actor, d!.id));
    expect(got.versions[0]).toMatchObject({ legacy: true, page: null });
    // revising it writes version 2 as a document, and version 1 is exactly as it was
    await asOrg(f.orgId, (tx) => reviseDocument(tx, f.admin.actor, { documentId: d!.id, bodyDoc: old.doc, reason: 'Moved to the editor' }));
    const [v1, v2] = await sql<{ version_no: number; body_doc: unknown }[]>`select version_no, body_doc from issued_document_versions where issued_document_id = ${d!.id} order by version_no`;
    expect(v1!.body_doc).toBeNull();
    expect(v2!.body_doc).not.toBeNull();
  });
});
