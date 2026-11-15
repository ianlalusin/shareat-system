import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-584 S3 - issue, register, revise (docs/tasks/584-documents.md s3 items 2, 4, 6; s8 tests 1, 3, 4, 7, 9, 10).
 * Real Postgres. A manager issues only for staff of a store in their scope; a document is numbered DOC-YYYY-NNNN per organisation per year;
 * the body is frozen at issue and a revision is a NEW version (R7); a [missing: ...] marker blocks Issue.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - name must contain "_test".`);
}

import { APP_ROLE, closeDb, documentsRepo, transaction, RefusalError, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import { toBusinessDate } from '@shareat/core/datetime';
import {
  documentDraft,
  documentIssueOptions,
  getIssuedDocument,
  issueDocument,
  listIssuedDocuments,
  reviseDocument,
  saveDocumentTemplate,
  documentPrintData,
  retireDocumentTemplate,
} from '@shareat/domain';
import { documentFixture, type DocFixture } from './_fixtures/t584-documents';

const sql = postgres(url, { max: 8 });
const YEAR = toBusinessDate().slice(0, 4);

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

const COE =
  '# Certificate of Employment\n\n{{employee.full_name}} ({{employee.staff_code}}), {{employee.position}}, {{employee.status}}, started {{employee.started_on}} at {{store.name}}, {{store.address}} (branch {{store.tin_branch_code}}).\n\n{{org.legal_name}}, TIN {{org.tin}}. Issued {{today}} by {{issuer.full_name}}, {{issuer.position}}.';
const ENDED = 'Employment ended on {{employee.ended_on}} for {{employee.full_name}}.';

interface World {
  f: DocFixture;
  coe: { templateId: string; versionId: string };
  ended: { templateId: string; versionId: string };
}
async function world(hint: string): Promise<World> {
  const f = await documentFixture(sql, hint);
  const mk = (name: string, kind: 'coe' | 'nte', body: string) =>
    asOrg(f.orgId, (tx) => saveDocumentTemplate(tx, f.admin.actor, { name, kind, body, signatureSlots: ['issuer', 'employee'] }));
  return { f, coe: await mk('COE', 'coe', COE), ended: await mk('Ended', 'nte', ENDED) };
}
const draftFor = (w: World, actor: Actor, templateId: string, employmentId: string | null, storeId: string | null = null) =>
  asOrg(w.f.orgId, (tx) => documentDraft(tx, actor, { templateId, employmentId, storeId }));
const issue = (w: World, actor: Actor, input: { templateId?: string; employmentId?: string | null; storeId?: string | null; body: string }) =>
  asOrg(w.f.orgId, (tx) => issueDocument(tx, actor, { templateId: input.templateId ?? w.coe.templateId, employmentId: input.employmentId ?? null, storeId: input.storeId ?? null, body: input.body }));

describe('T-584 S3 - the draft fills the merge fields from the database (s5)', () => {
  it('fills every field of the COE from the employee, the store, the organisation and the issuer [kills: a field read from the wrong table]', async () => {
    const w = await world('draft');
    const d = await draftFor(w, w.f.managerA.actor, w.coe.templateId, w.f.employee.employmentId);
    expect(d.missing).toEqual([]);
    expect(d.storeId).toBe(w.f.storeA);
    expect(d.body).toContain('Staffer Employee (SE-');
    expect(d.body).toContain('Server, Regular, started 6 January 2025');
    expect(d.body).toContain('Test Store A, 1 Test Street, Test City (branch 00001)');
    expect(d.body).toContain('Test Org Incorporated, TIN 123456789');
    expect(d.body).toContain('Issued ' + new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Manila' }).format(new Date()));
    expect(d.body).toContain('by Manager A, Test Manager.');
    expect(d.template).toMatchObject({ id: w.coe.templateId, versionNo: 1, kind: 'coe', signatureSlots: ['issuer', 'employee'] });
  });

  it('a value that does not exist becomes a visible [missing: ...] marker, and the draft says which [kills: a blank printed as if it were fine]', async () => {
    const w = await world('missing');
    const d = await draftFor(w, w.f.managerA.actor, w.ended.templateId, w.f.employee.employmentId);
    expect(d.body).toContain('[missing: employee.ended_on]');
    expect(d.missing).toEqual(['employee.ended_on']);
    // an admin with no job has no issuer position
    const d2 = await draftFor(w, w.f.admin.actor, w.coe.templateId, w.f.employee.employmentId);
    expect(d2.missing).toEqual(['issuer.position']);
  });
});

describe('T-584 S3 - who may issue, and for whom (test 1)', () => {
  it('a manager issues for staff of their own store; the document is numbered DOC-YYYY-0001 [kills: nothing issued]', async () => {
    const w = await world('own');
    const draft = await draftFor(w, w.f.managerA.actor, w.coe.templateId, w.f.employee.employmentId);
    const r = await issue(w, w.f.managerA.actor, { employmentId: w.f.employee.employmentId, body: draft.body });
    expect(r.number).toBe(`DOC-${YEAR}-0001`);
    const got = await asOrg(w.f.orgId, (tx) => getIssuedDocument(tx, w.f.managerA.actor, r.documentId));
    expect(got.document).toMatchObject({ number: r.number, storeId: w.f.storeA, employmentId: w.f.employee.employmentId, issuedBy: w.f.managerA.personId, voided: false });
    expect(got.versions).toHaveLength(1);
    expect(got.versions[0]).toMatchObject({ versionNo: 1, body: draft.body, reason: null });
  });

  it("a manager is refused for another store's staff, as the draft and as the issue [kills: store scope not checked]", async () => {
    const w = await world('other');
    await denied(draftFor(w, w.f.managerA.actor, w.coe.templateId, w.f.employeeB.employmentId));
    await denied(issue(w, w.f.managerA.actor, { employmentId: w.f.employeeB.employmentId, body: 'x' }));
    await denied(issue(w, w.f.managerB.actor, { employmentId: w.f.employee.employmentId, body: 'x' }));
    await denied(issue(w, w.f.managerA.actor, { storeId: w.f.storeB, body: 'a memo' }));
  });

  it('staff with no capability are refused, and an admin may issue anywhere [kills: staff true; admin limited to a scope]', async () => {
    const w = await world('roles');
    await denied(issue(w, w.f.staff.actor, { employmentId: w.f.employee.employmentId, body: 'x' }));
    await denied(issue(w, w.f.employee.actor, { employmentId: w.f.employee.employmentId, body: 'x' }));
    const a = await issue(w, w.f.admin.actor, { employmentId: w.f.employeeB.employmentId, body: 'For B.' });
    expect(a.number).toMatch(/^DOC-\d{4}-0001$/);
  });

  it('a general memo with a store is a manager\'s; one with no store at all is an admin\'s only [kills: a manager issuing org-wide]', async () => {
    const w = await world('memo');
    const m = await issue(w, w.f.managerA.actor, { storeId: w.f.storeA, body: 'Store memo.' });
    expect((await asOrg(w.f.orgId, (tx) => getIssuedDocument(tx, w.f.managerA.actor, m.documentId))).document.employmentId).toBeNull();
    await denied(issue(w, w.f.managerA.actor, { body: 'Everyone memo.' }));
    const all = await issue(w, w.f.admin.actor, { body: 'Everyone memo.' });
    expect((await asOrg(w.f.orgId, (tx) => getIssuedDocument(tx, w.f.admin.actor, all.documentId))).document.storeId).toBeNull();
  });

  it("another organisation's employment, or a template of another organisation, is refused [kills: a cross-org reference]", async () => {
    const a = await world('xa');
    const b = await world('xb');
    await sentenceOf(issue(a, a.f.admin.actor, { employmentId: b.f.employee.employmentId, body: 'x' }));
    await sentenceOf(issue(a, a.f.admin.actor, { templateId: b.coe.templateId, employmentId: a.f.employee.employmentId, body: 'x' }));
  });

  it('a retired template cannot be issued from [kills: issuing from a retired template]', async () => {
    const w = await world('retired');
    await asOrg(w.f.orgId, (tx) => retireDocumentTemplate(tx, w.f.admin.actor, w.coe.templateId));
    expect(await sentenceOf(issue(w, w.f.managerA.actor, { employmentId: w.f.employee.employmentId, body: 'x' }))).toMatch(/retired/i);
  });
});

describe('T-584 S3 - a [missing: ...] marker blocks Issue; the body is frozen (test 3, test 7)', () => {
  it('Issue is refused while any marker remains, naming it; editing it out lets it through [kills: issuing a document with a hole in it]', async () => {
    const w = await world('block');
    const d = await draftFor(w, w.f.managerA.actor, w.ended.templateId, w.f.employee.employmentId);
    const s = await sentenceOf(issue(w, w.f.managerA.actor, { templateId: w.ended.templateId, employmentId: w.f.employee.employmentId, body: d.body }));
    expect(s).toContain('employee.ended_on');
    const fixed = d.body.replace('[missing: employee.ended_on]', '30 June 2026');
    const r = await issue(w, w.f.managerA.actor, { templateId: w.ended.templateId, employmentId: w.f.employee.employmentId, body: fixed });
    expect(r.number).toMatch(/^DOC-/);
    expect(await sql`select 1 from issued_documents where org_id = ${w.f.orgId}`).toHaveLength(1);
  });

  it('a blank body and an over-long body are refused [kills: empty documents]', async () => {
    const w = await world('blank');
    await sentenceOf(issue(w, w.f.managerA.actor, { employmentId: w.f.employee.employmentId, body: '  ' }));
    await sentenceOf(issue(w, w.f.managerA.actor, { employmentId: w.f.employee.employmentId, body: 'x'.repeat(50001) }));
  });

  it('a template edit makes v2, but a document issued from v1 still shows v1\'s text and v1\'s id [kills: a document that follows its template]', async () => {
    const w = await world('frozen');
    const r = await issue(w, w.f.managerA.actor, { employmentId: w.f.employee.employmentId, body: 'Frozen text from template v1.' });
    await asOrg(w.f.orgId, (tx) => saveDocumentTemplate(tx, w.f.admin.actor, { templateId: w.coe.templateId, name: 'COE', kind: 'coe', body: 'Entirely new wording.', signatureSlots: [] }));
    const got = await asOrg(w.f.orgId, (tx) => getIssuedDocument(tx, w.f.managerA.actor, r.documentId));
    expect(got.document.templateVersionId).toBe(w.coe.versionId);
    expect(got.document.templateVersionNo).toBe(1);
    expect(got.versions[0]!.body).toBe('Frozen text from template v1.');
    // and a document issued NOW comes from v2
    const d2 = await draftFor(w, w.f.managerA.actor, w.coe.templateId, w.f.employee.employmentId);
    expect(d2.template.versionNo).toBe(2);
    expect(d2.template.signatureSlots).toEqual([]);
  });
});

describe('T-584 S3 - numbering (test 9)', () => {
  it('two issues at once get different numbers, 0001 and 0002, with no duplicate [kills: a race that hands out one number twice]', async () => {
    const w = await world('race');
    const [a, b] = await Promise.all([
      issue(w, w.f.managerA.actor, { employmentId: w.f.employee.employmentId, body: 'A' }),
      issue(w, w.f.admin.actor, { employmentId: w.f.employee.employmentId, body: 'B' }),
    ]);
    expect([a.number, b.number].sort()).toEqual([`DOC-${YEAR}-0001`, `DOC-${YEAR}-0002`]);
  });

  it('the sequence is per organisation: another organisation starts again at 0001 [kills: a global counter]', async () => {
    const a = await world('seqA');
    const b = await world('seqB');
    await issue(a, a.f.admin.actor, { employmentId: a.f.employee.employmentId, body: 'A1' });
    const a2 = await issue(a, a.f.admin.actor, { employmentId: a.f.employee.employmentId, body: 'A2' });
    const b1 = await issue(b, b.f.admin.actor, { employmentId: b.f.employee.employmentId, body: 'B1' });
    expect(a2.number).toBe(`DOC-${YEAR}-0002`);
    expect(b1.number).toBe(`DOC-${YEAR}-0001`);
  });

  it('a new year starts again at 0001 and this year is untouched [kills: a counter that does not reset]', async () => {
    const w = await world('year');
    await issue(w, w.f.admin.actor, { employmentId: w.f.employee.employmentId, body: 'This year' });
    const other = await asOrg(w.f.orgId, (tx) => documentsRepo.allocateNumber(tx, w.f.orgId, 2099));
    expect(other).toBe('DOC-2099-0001');
    const next = await issue(w, w.f.admin.actor, { employmentId: w.f.employee.employmentId, body: 'Next' });
    expect(next.number).toBe(`DOC-${YEAR}-0002`);
  });
});

describe('T-584 S3 - the register (s3 item 4)', () => {
  it("a manager lists only the stores in their scope, an admin lists all, staff are refused [kills: a register that leaks another store]", async () => {
    const w = await world('reg');
    const a = await issue(w, w.f.admin.actor, { employmentId: w.f.employee.employmentId, body: 'Store A staff' });
    const b = await issue(w, w.f.admin.actor, { employmentId: w.f.employeeB.employmentId, body: 'Store B staff' });
    const all = await issue(w, w.f.admin.actor, { body: 'Org-wide' });
    const ids = async (actor: Actor) => (await asOrg(w.f.orgId, (tx) => listIssuedDocuments(tx, actor, {}))).map((d) => d.id).sort();
    expect(await ids(w.f.admin.actor)).toEqual([a.documentId, b.documentId, all.documentId].sort());
    expect(await ids(w.f.managerA.actor)).toEqual([a.documentId]);
    expect(await ids(w.f.managerB.actor)).toEqual([b.documentId]);
    await denied(asOrg(w.f.orgId, (tx) => listIssuedDocuments(tx, w.f.staff.actor, {})));
  });

  it('it filters by employee and kind, newest first, with the current version number [kills: a filter that ignores its argument]', async () => {
    const w = await world('filter');
    const one = await issue(w, w.f.admin.actor, { employmentId: w.f.employee.employmentId, body: 'First' });
    await new Promise((r) => setTimeout(r, 5));
    const two = await issue(w, w.f.admin.actor, { templateId: w.ended.templateId, employmentId: w.f.noSignature.employmentId, body: 'Second' });
    const rows = await asOrg(w.f.orgId, (tx) => listIssuedDocuments(tx, w.f.admin.actor, {}));
    expect(rows.map((r) => r.id)).toEqual([two.documentId, one.documentId]);
    expect((await asOrg(w.f.orgId, (tx) => listIssuedDocuments(tx, w.f.admin.actor, { employmentId: w.f.employee.employmentId! }))).map((r) => r.id)).toEqual([one.documentId]);
    expect((await asOrg(w.f.orgId, (tx) => listIssuedDocuments(tx, w.f.admin.actor, { kind: 'nte' }))).map((r) => r.id)).toEqual([two.documentId]);
    expect((await asOrg(w.f.orgId, (tx) => listIssuedDocuments(tx, w.f.admin.actor, { storeId: w.f.storeB }))).length).toBe(0);
    expect(rows.every((r) => r.currentVersionNo === 1)).toBe(true);
  });

  it("reading another store's document by id is refused with the permission refusal, and another organisation's is 'does not exist' [kills: an id that opens anything]", async () => {
    const w = await world('byid');
    const b = await world('byid-other');
    const r = await issue(w, w.f.admin.actor, { employmentId: w.f.employee.employmentId, body: 'X' });
    await denied(asOrg(w.f.orgId, (tx) => getIssuedDocument(tx, w.f.managerB.actor, r.documentId)));
    await denied(asOrg(w.f.orgId, (tx) => getIssuedDocument(tx, w.f.staff.actor, r.documentId)));
    await sentenceOf(asOrg(b.f.orgId, (tx) => getIssuedDocument(tx, b.f.admin.actor, r.documentId)));
  });
});

describe('T-584 S3 - revise: a new version, every earlier one kept (R7, test 10)', () => {
  it('a revision is version 2 with its reason and its own author; version 1 reads exactly as it was [kills: editing in place]', async () => {
    const w = await world('revise');
    const r = await issue(w, w.f.managerA.actor, { employmentId: w.f.employee.employmentId, body: 'Original wording.' });
    const v2 = await asOrg(w.f.orgId, (tx) => reviseDocument(tx, w.f.admin.actor, { documentId: r.documentId, body: 'Corrected wording.', reason: 'Typo in the position' }));
    expect(v2.versionNo).toBe(2);
    const got = await asOrg(w.f.orgId, (tx) => getIssuedDocument(tx, w.f.admin.actor, r.documentId));
    expect(got.versions.map((v) => [v.versionNo, v.body, v.reason, v.createdByName])).toEqual([
      [2, 'Corrected wording.', 'Typo in the position', 'Admin A'],
      [1, 'Original wording.', null, 'Manager A'],
    ]);
    expect(got.document.currentVersionNo).toBe(2);
    expect(got.document.number).toBe(r.number);
    const p1 = await asOrg(w.f.orgId, (tx) => documentPrintData(tx, w.f.admin.actor, r.documentId, 1));
    expect(p1).toMatchObject({ number: r.number, versionNo: 1, isCurrent: false, body: 'Original wording.', voided: false });
    const pNow = await asOrg(w.f.orgId, (tx) => documentPrintData(tx, w.f.admin.actor, r.documentId));
    expect(pNow).toMatchObject({ versionNo: 2, isCurrent: true, body: 'Corrected wording.' });
  });

  it('a revision with no reason, a blank body, or a leftover [missing: ...] is refused [kills: silent edits]', async () => {
    const w = await world('revrefuse');
    const r = await issue(w, w.f.managerA.actor, { employmentId: w.f.employee.employmentId, body: 'Original.' });
    const rev = (body: string, reason: string) => asOrg(w.f.orgId, (tx) => reviseDocument(tx, w.f.managerA.actor, { documentId: r.documentId, body, reason }));
    expect(await sentenceOf(rev('New.', '   '))).toMatch(/reason/i);
    await sentenceOf(rev('  ', 'why'));
    expect(await sentenceOf(rev('New [missing: employee.ended_on]', 'why'))).toContain('employee.ended_on');
    expect((await asOrg(w.f.orgId, (tx) => getIssuedDocument(tx, w.f.managerA.actor, r.documentId))).versions).toHaveLength(1);
  });

  it("only someone who may issue at that store can revise; another store's manager and staff are refused [kills: store scope on revise]", async () => {
    const w = await world('revscope');
    const r = await issue(w, w.f.managerA.actor, { employmentId: w.f.employee.employmentId, body: 'Original.' });
    await denied(asOrg(w.f.orgId, (tx) => reviseDocument(tx, w.f.managerB.actor, { documentId: r.documentId, body: 'x', reason: 'y' })));
    await denied(asOrg(w.f.orgId, (tx) => reviseDocument(tx, w.f.staff.actor, { documentId: r.documentId, body: 'x', reason: 'y' })));
  });

  it('two revisions at once become versions 2 and 3, never a duplicate; the loser is told in plain words or queues [kills: a version-number race]', async () => {
    const w = await world('revrace');
    const r = await issue(w, w.f.managerA.actor, { employmentId: w.f.employee.employmentId, body: 'Original.' });
    const go = (n: number) => asOrg(w.f.orgId, (tx) => reviseDocument(tx, w.f.managerA.actor, { documentId: r.documentId, body: `Edit ${n}`, reason: `why ${n}` }));
    const results = await Promise.all([go(1), go(2)]);
    expect(results.map((x) => x.versionNo).sort()).toEqual([2, 3]);
  });

  it('every write is audited with ids and no wording [kills: an unaudited issue or revision]', async () => {
    const w = await world('audit');
    const r = await issue(w, w.f.managerA.actor, { employmentId: w.f.employee.employmentId, body: 'SECRET-WORDING-ONE' });
    await asOrg(w.f.orgId, (tx) => reviseDocument(tx, w.f.managerA.actor, { documentId: r.documentId, body: 'SECRET-WORDING-TWO', reason: 'Needed a change' }));
    const rows = await sql<{ action: string; after: Record<string, unknown>; store_id: string | null }[]>`
      select action, after, store_id from audit_log where org_id = ${w.f.orgId} and action like 'document.%' order by id`;
    expect(rows.map((x) => x.action)).toEqual(['document.issued', 'document.revised']);
    expect(rows[0]!.after).toMatchObject({ documentId: r.documentId, number: r.number, versionNo: 1 });
    expect(rows[1]!.after).toMatchObject({ documentId: r.documentId, versionNo: 2, reason: 'Needed a change' });
    expect(rows[0]!.store_id).toBe(w.f.storeA);
    expect(JSON.stringify(rows)).not.toContain('SECRET-WORDING');
  });
});

describe('T-584 S3 - what the issue screen may offer', () => {
  it("a manager is offered only their own store's staff and stores, never a retired template; an admin also the whole company; staff are refused [kills: a picker that leaks another store's staff]", async () => {
    const w = await world('options');
    const extra = await asOrg(w.f.orgId, (tx) => saveDocumentTemplate(tx, w.f.admin.actor, { name: 'Old memo', kind: 'memo', body: 'old', signatureSlots: [] }));
    await asOrg(w.f.orgId, (tx) => retireDocumentTemplate(tx, w.f.admin.actor, extra.templateId));
    const opt = (actor: Actor) => asOrg(w.f.orgId, (tx) => documentIssueOptions(tx, actor));
    const m = await opt(w.f.managerA.actor);
    expect(m.templates.map((t) => t.name).sort()).toEqual(['COE', 'Ended']);
    expect(m.stores.map((s) => s.id)).toEqual([w.f.storeA]);
    expect(m.employments.every((e) => e.storeId === w.f.storeA)).toBe(true);
    expect(m.employments.map((e) => e.id)).toContain(w.f.employee.employmentId);
    expect(m.employments.map((e) => e.id)).not.toContain(w.f.employeeB.employmentId);
    expect(m.canIssueOrgWide).toBe(false);
    const a = await opt(w.f.admin.actor);
    expect(a.stores.map((s) => s.id).sort()).toEqual([w.f.storeA, w.f.storeB].sort());
    expect(a.employments.map((e) => e.id)).toContain(w.f.employeeB.employmentId);
    expect(a.canIssueOrgWide).toBe(true);
    await denied(opt(w.f.staff.actor));
  });
});

describe('T-584 R7 - a version is kept as it was, letterhead included', () => {
  it('changing the company name and the store address after issue leaves version 1 printing as it was; a revision picks up the new facts [kills: print read from live records]', async () => {
    const w = await world('letterhead');
    const r = await issue(w, w.f.managerA.actor, { employmentId: w.f.employee.employmentId, body: 'Frozen letterhead.' });
    const print = (versionNo?: number) => asOrg(w.f.orgId, (tx) => documentPrintData(tx, w.f.admin.actor, r.documentId, versionNo));
    const before = (await print(1)).letterhead;
    expect(before).toMatchObject({ legalName: 'Test Org Incorporated', tin: '123456789', storeName: 'Test Store A', storeAddress: '1 Test Street, Test City', tinBranchCode: '00001', templateName: 'COE' });
    expect((await print(1)).kind).toBe('coe');
    await sql`update organizations set legal_name = 'Renamed Company Corp', tin = '987654321' where id = ${w.f.orgId}`;
    await sql`update stores set address = '99 New Avenue', name = 'Renamed Store', tin_branch_code = '00009', contact_number = '0999' where id = ${w.f.storeA}`;
    await sql`update document_templates set name = 'Renamed template', kind = 'memo' where id = ${w.coe.templateId}`;
    expect((await print(1)).letterhead).toEqual(before);
    expect((await print()).letterhead).toEqual(before);
    await asOrg(w.f.orgId, (tx) => reviseDocument(tx, w.f.admin.actor, { documentId: r.documentId, body: 'Second version.', reason: 'New facts' }));
    expect((await print(1)).letterhead).toEqual(before);
    expect((await print(2)).letterhead).toMatchObject({ legalName: 'Renamed Company Corp', tin: '987654321', storeName: 'Renamed Store', storeAddress: '99 New Avenue', tinBranchCode: '00009', templateName: 'Renamed template' });
    expect((await print(2)).kind).toBe('memo');
    expect((await print(1)).kind).toBe('coe');
  });
});

describe('T-584 limits and edge cases', () => {
  it('a revision reason over 500 characters is refused in plain words; exactly 500 is kept [kills: an unbounded reason]', async () => {
    const w = await world('reasoncap');
    const r = await issue(w, w.f.managerA.actor, { employmentId: w.f.employee.employmentId, body: 'Original.' });
    const rev = (reason: string) => asOrg(w.f.orgId, (tx) => reviseDocument(tx, w.f.managerA.actor, { documentId: r.documentId, body: 'New.', reason }));
    expect(await sentenceOf(rev('x'.repeat(501)))).toMatch(/500/);
    expect((await rev('x'.repeat(500))).versionNo).toBe(2);
  });

  it('a person who may read only organisation-wide documents (no store held) can list them, with no empty IN list [kills: a crash on an empty store list]', async () => {
    const w = await world('storeless');
    const all = await issue(w, w.f.admin.actor, { body: 'Everyone.' });
    await issue(w, w.f.admin.actor, { employmentId: w.f.employee.employmentId, body: 'Store A.' });
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${w.f.orgId}, 'Admin Without Scope') returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${w.f.orgId}, 'admin')`;
    const rows = await asOrg(w.f.orgId, (tx) => listIssuedDocuments(tx, { personId: p!.id, orgId: w.f.orgId }, {}));
    expect(rows.map((d) => d.id)).toEqual([all.documentId]);
  });
});
