import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-584 S4 - PIN-attached signatures and void (docs/tasks/584-documents.md s3 items 3 and 7, s7, R3, R4, R7; s8 tests 4, 5, 6, 10).
 * Real Postgres. A saved signature is attached only when its OWNER enters their own Employee ID and PIN; it is copied by reference at that moment;
 * signatures belong to ONE version, so a revision starts unsigned; a void document stays in the register and cannot be revised or signed.
 *
 * MUTANTS (each a one-line edit in packages/domain/src/documents/sign.ts or packages/auth/src/signer-pin.ts, run, red, reverted):
 *   M1  expectedPersonId = actor.personId (anyone signs for anyone)           -> "another person's PIN" red
 *   M2  drop the idOk term in verifySignerPin                                  -> "wrong Employee ID" red
 *   M3  copy persons.signature_file_id at READ time instead of at signing       -> test 6 red
 *   M4  skip the versionNo === current check                                    -> "stale page" red
 *   M5  no audit row on a refused PIN                                           -> "audited" red
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - name must contain "_test".`);
}

import { APP_ROLE, closeDb, transaction, RefusalError, type Tx } from '@shareat/db';
import { AuthenticationError, AuthorizationError, type Actor } from '@shareat/auth';
import { inMemoryDriver, setStorageDriver } from '@shareat/domain';
import {
  documentPrintData,
  documentSignatureImage,
  getIssuedDocument,
  issueDocument,
  listIssuedDocuments,
  reviseDocument,
  saveDocumentTemplate,
  signDocument,
  voidDocument,
} from '@shareat/domain';
import { documentFixture, nextPin, type DocFixture, type Person } from './_fixtures/t584-documents';

const sql = postgres(url, { max: 8 });
const REFUSED = 'That Employee ID and PIN do not match the person who has to sign.';
const CAPPED = 'Too many wrong PINs from your account today. An administrator can clear this on your user page, or try again tomorrow.';
const WRONG = '000000';

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
async function sentenceOf(p: Promise<unknown>): Promise<string> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, 'expected a refusal, got success').not.toBeNull();
  const ok = err instanceof RefusalError || err instanceof AuthorizationError || err instanceof AuthenticationError;
  expect(ok, `expected a refusal, got ${String((err as Error)?.message)}`).toBe(true);
  return ((err as { userMessage?: string }).userMessage ?? (err as Error).message) as string;
}
async function denied(p: Promise<unknown>): Promise<void> {
  expect(await p.then(() => null, (e: unknown) => e)).toBeInstanceOf(AuthorizationError);
}

const BODY_TEMPLATE = 'Certificate for {{employee.full_name}}.';
interface World {
  f: DocFixture;
  documentId: string;
  number: string;
}
async function world(hint: string, slots: Array<'issuer' | 'employee'> = ['issuer', 'employee'], who: 'employee' | 'noSignature' = 'employee'): Promise<World> {
  const f = await documentFixture(sql, hint);
  const t = await asOrg(f.orgId, (tx) => saveDocumentTemplate(tx, f.admin.actor, { name: 'COE', kindId: f.kind.coe, body: BODY_TEMPLATE, signatureSlots: slots }));
  const r = await asOrg(f.orgId, (tx) =>
    issueDocument(tx, f.managerA.actor, { templateId: t.templateId, employmentId: f[who].employmentId, body: 'Certificate for the test employee.' }),
  );
  // the in-memory driver holds the bytes of every saved signature
  for (const row of await sql<{ storage_path: string }[]>`select storage_path from stored_files where org_id = ${f.orgId}`) driver.files.set(row.storage_path, new Uint8Array([137, 80, 78, 71]));
  return { f, documentId: r.documentId, number: r.number };
}
const sign = (w: World, at: Actor, slot: 'issuer' | 'employee', who: Person | null, over: { employeeId?: string; pin?: string; versionNo?: number } = {}) =>
  asOrg(w.f.orgId, (tx) =>
    signDocument(tx, at, {
      documentId: w.documentId,
      slot,
      versionNo: over.versionNo ?? 1,
      employeeId: over.employeeId ?? who?.employeeId ?? '',
      pin: over.pin ?? who?.pin ?? WRONG,
    }),
  );
const view = (w: World, as: Actor = w.f.admin.actor) => asOrg(w.f.orgId, (tx) => getIssuedDocument(tx, as, w.documentId));

describe('T-584 S4 - the right person with the right PIN signs (test 5)', () => {
  it("the issuer signs the issuer slot and the employee, handed the device, signs the employee slot; each records who, when and THEIR file [kills: nothing attached]", async () => {
    const w = await world('both');
    const a = await sign(w, w.f.managerA.actor, 'issuer', w.f.managerA);
    const b = await sign(w, w.f.managerA.actor, 'employee', w.f.employee);
    expect(a.versionNo).toBe(1);
    const got = await view(w);
    expect(got.versions[0]!.signatures.map((s) => [s.slot, s.personId]).sort()).toEqual([['employee', w.f.employee.personId], ['issuer', w.f.managerA.personId]].sort());
    const rows = await sql<{ id: string; slot: string; file_id: string; person_id: string }[]>`
      select id, slot, file_id, person_id from issued_document_signatures where org_id = ${w.f.orgId}`;
    expect(rows.find((r) => r.slot === 'employee')!.file_id).toBe(await w.f.signatureFileOf(w.f.employee.personId));
    expect(rows.find((r) => r.slot === 'issuer')!.file_id).toBe(await w.f.signatureFileOf(w.f.managerA.personId));
    expect(new Set([a.signatureId, b.signatureId]).size).toBe(2);
  });

  it('the Employee ID may be typed as the number or the whole code [kills: a format only one screen understands]', async () => {
    const w = await world('idform');
    await sign(w, w.f.managerA.actor, 'employee', w.f.employee, { employeeId: w.f.employee.staffCode! });
    const w2 = await world('idform2');
    await sign(w2, w2.f.managerA.actor, 'employee', w2.f.employee, { employeeId: w2.f.employee.staffCode!.toLowerCase() });
  });

  it("another person's PIN for the employee slot is refused, even a real manager's [kills: anyone can sign for anyone]", async () => {
    const w = await world('other');
    // the manager types THEIR OWN Employee ID and PIN into the employee slot
    expect(await sentenceOf(sign(w, w.f.managerA.actor, 'employee', w.f.managerA))).toBe(REFUSED);
    // the employee's PIN into the issuer slot
    expect(await sentenceOf(sign(w, w.f.managerA.actor, 'issuer', w.f.employee))).toBe(REFUSED);
    // an administrator's PIN into the employee slot
    expect(await sentenceOf(sign(w, w.f.managerA.actor, 'employee', w.f.admin))).toBe(REFUSED);
    expect((await view(w)).versions[0]!.signatures).toHaveLength(0);
  });

  it("the right PIN with someone else's Employee ID is refused with the same sentence [kills: the Employee ID not being checked]", async () => {
    const w = await world('wrongid');
    expect(await sentenceOf(sign(w, w.f.managerA.actor, 'employee', w.f.employee, { employeeId: w.f.managerA.employeeId! }))).toBe(REFUSED);
    expect(await sentenceOf(sign(w, w.f.managerA.actor, 'employee', w.f.employee, { employeeId: '' }))).toBe(REFUSED);
  });

  it('a wrong PIN is refused with one generic sentence, is audited without the PIN, and nothing is signed [kills: an unaudited refusal]', async () => {
    const w = await world('wrongpin');
    const bad = nextPin();
    expect(await sentenceOf(sign(w, w.f.managerA.actor, 'employee', w.f.employee, { pin: bad }))).toBe(REFUSED);
    const rows = await sql<{ action: string; after: Record<string, unknown>; store_id: string | null }[]>`
      select action, after, store_id from audit_log where org_id = ${w.f.orgId} and action = 'document.sign_refused'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.after).toMatchObject({ documentId: w.documentId, slot: 'employee' });
    expect(rows[0]!.store_id).toBe(w.f.storeA);
    expect(JSON.stringify(rows)).not.toContain(bad);
    expect((await view(w)).versions[0]!.signatures).toHaveLength(0);
  });

  it('after five wrong PINs from one account the lock-out sentence is shown, even for a right PIN; the cap is the person at the keyboard [kills: no attempt cap]', async () => {
    const w = await world('cap');
    for (let i = 0; i < 5; i++) expect(await sentenceOf(sign(w, w.f.managerA.actor, 'employee', w.f.employee, { pin: nextPin() }))).toBe(REFUSED);
    expect(await sentenceOf(sign(w, w.f.managerA.actor, 'employee', w.f.employee))).toBe(CAPPED);
    expect((await view(w)).versions[0]!.signatures).toHaveLength(0);
    // another account at the keyboard has its own budget
    await sign(w, w.f.admin.actor, 'employee', w.f.employee);
  });

  it('a person with no saved signature is refused in plain words after the PIN is right, and nothing is signed [kills: a blank signature stamped]', async () => {
    const w = await world('nosig', ['issuer', 'employee'], 'noSignature');
    const s = await sentenceOf(sign(w, w.f.managerA.actor, 'employee', w.f.noSignature));
    expect(s).toMatch(/Save a signature on the staff page first/);
    expect((await view(w)).versions[0]!.signatures).toHaveLength(0);
  });

  it('a slot the template did not ask for, a slot already signed, and a memo with no employee are each refused in plain words [kills: signing what is not asked]', async () => {
    const w = await world('slots', ['issuer']);
    expect(await sentenceOf(sign(w, w.f.managerA.actor, 'employee', w.f.employee))).toMatch(/does not take/i);
    await sign(w, w.f.managerA.actor, 'issuer', w.f.managerA);
    expect(await sentenceOf(sign(w, w.f.managerA.actor, 'issuer', w.f.managerA))).toMatch(/already/i);

    const f = await documentFixture(sql, 'memo-slots');
    const t = await asOrg(f.orgId, (tx) => saveDocumentTemplate(tx, f.admin.actor, { name: 'Memo', kindId: f.kind.memo, body: 'x', signatureSlots: ['issuer', 'employee'] }));
    const m = await asOrg(f.orgId, (tx) => issueDocument(tx, f.managerA.actor, { templateId: t.templateId, storeId: f.storeA, body: 'A memo.' }));
    const w2: World = { f, documentId: m.documentId, number: m.number };
    expect(await sentenceOf(sign(w2, f.managerA.actor, 'employee', f.employee))).toMatch(/employee/i);
  });

  it("only someone who may read the document at its store can sign it: another store's manager and staff are refused before any PIN is charged [kills: signing as a stranger]", async () => {
    const w = await world('stranger');
    await denied(sign(w, w.f.managerB.actor, 'employee', w.f.employee));
    await denied(sign(w, w.f.staff.actor, 'employee', w.f.employee));
    expect(await sql`select 1 from sign_in_attempts where org_id = ${w.f.orgId}`).toHaveLength(0);
  });

  it('a signing is audited with ids, never the PIN or the file [kills: an unaudited signature]', async () => {
    const w = await world('audit');
    await sign(w, w.f.managerA.actor, 'employee', w.f.employee);
    const rows = await sql<{ action: string; after: Record<string, unknown> }[]>`select action, after from audit_log where org_id = ${w.f.orgId} and action = 'document.signed'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.after).toMatchObject({ documentId: w.documentId, number: w.number, versionNo: 1, slot: 'employee', signerPersonId: w.f.employee.personId });
    expect(JSON.stringify(rows)).not.toContain(w.f.employee.pin);
    expect(JSON.stringify(rows)).not.toContain('orgs/');
  });
});

describe('T-584 S4 - a later signature change does not alter a signed document (R3, test 6)', () => {
  it('the signature copied at signing time still points at the OLD file after the person saves a new one [kills: reading the current signature at print time]', async () => {
    const w = await world('stable');
    await sign(w, w.f.managerA.actor, 'employee', w.f.employee);
    const before = (await sql<{ file_id: string }[]>`select file_id from issued_document_signatures where org_id = ${w.f.orgId}`)[0]!.file_id;
    const fresh = await w.f.replaceSignature(w.f.employee.personId);
    expect(fresh).not.toBe(before);
    expect(await w.f.signatureFileOf(w.f.employee.personId)).toBe(fresh);
    const after = (await sql<{ file_id: string }[]>`select file_id from issued_document_signatures where org_id = ${w.f.orgId}`)[0]!.file_id;
    expect(after).toBe(before);
    // and the image served is the old one's bytes
    const sigId = (await view(w)).versions[0]!.signatures[0]!.id;
    const [oldFile] = await sql<{ storage_path: string }[]>`select storage_path from stored_files where id = ${before}`;
    driver.files.set(oldFile!.storage_path, new Uint8Array([1, 1, 1]));
    const img = await asOrg(w.f.orgId, (tx) => documentSignatureImage(tx, w.f.managerA.actor, sigId));
    expect(Array.from(img.bytes)).toEqual([1, 1, 1]);
    expect(img.contentType).toBe('image/png');
  });
});

describe('T-584 S4 - every version is signed on its own (R7, test 10)', () => {
  it('revising a signed v1 makes an unsigned v2; v1 still prints with both signatures [kills: a signature carried into the changed text]', async () => {
    const w = await world('r7');
    await sign(w, w.f.managerA.actor, 'issuer', w.f.managerA);
    await sign(w, w.f.managerA.actor, 'employee', w.f.employee);
    await asOrg(w.f.orgId, (tx) => reviseDocument(tx, w.f.managerA.actor, { documentId: w.documentId, body: 'Certificate, corrected.', reason: 'Wrong date' }));
    const got = await view(w);
    expect(got.versions.map((v) => [v.versionNo, v.signatures.length])).toEqual([[2, 0], [1, 2]]);
    const p1 = await asOrg(w.f.orgId, (tx) => documentPrintData(tx, w.f.admin.actor, w.documentId, 1));
    expect(p1.slots.map((s) => [s.slot, s.signatureId !== null])).toEqual([['issuer', true], ['employee', true]]);
    const p2 = await asOrg(w.f.orgId, (tx) => documentPrintData(tx, w.f.admin.actor, w.documentId));
    expect(p2.slots.map((s) => [s.slot, s.signatureId])).toEqual([['issuer', null], ['employee', null]]);
    // the blank slots still name who must sign
    expect(p2.slots.map((s) => s.name)).toEqual(['Manager A', 'Employee, Staffer']);
  });

  it('signing v1 from a page opened before the revision is refused in plain words, and v2 can then be signed [kills: signing a superseded text]', async () => {
    const w = await world('stale');
    await asOrg(w.f.orgId, (tx) => reviseDocument(tx, w.f.managerA.actor, { documentId: w.documentId, body: 'Changed.', reason: 'Because' }));
    expect(await sentenceOf(sign(w, w.f.managerA.actor, 'employee', w.f.employee, { versionNo: 1 }))).toMatch(/changed|newer|version/i);
    const ok = await sign(w, w.f.managerA.actor, 'employee', w.f.employee, { versionNo: 2 });
    expect(ok.versionNo).toBe(2);
  });

  it("the issuer slot of a revised version is the person who wrote that version [kills: asking the wrong person to sign the new text]", async () => {
    const w = await world('slotowner');
    await asOrg(w.f.orgId, (tx) => reviseDocument(tx, w.f.admin.actor, { documentId: w.documentId, body: 'Admin edit.', reason: 'Admin fixed it' }));
    // the original issuer (manager A) wrote v1, the admin wrote v2: the admin signs the issuer slot of v2
    expect(await sentenceOf(sign(w, w.f.admin.actor, 'issuer', w.f.managerA, { versionNo: 2 }))).toBe(REFUSED);
    await sign(w, w.f.admin.actor, 'issuer', w.f.admin, { versionNo: 2 });
  });
});

describe('T-584 S4 - void (test 4)', () => {
  it('the issuing store manager voids with a reason; it stays in the register marked void and its print says so [kills: deleting a document]', async () => {
    const w = await world('void');
    await sign(w, w.f.managerA.actor, 'issuer', w.f.managerA);
    await asOrg(w.f.orgId, (tx) => voidDocument(tx, w.f.managerA.actor, { documentId: w.documentId, reason: 'Issued to the wrong person' }));
    const list = await asOrg(w.f.orgId, (tx) => listIssuedDocuments(tx, w.f.managerA.actor, {}));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: w.documentId, voided: true, voidReason: 'Issued to the wrong person' });
    const p = await asOrg(w.f.orgId, (tx) => documentPrintData(tx, w.f.managerA.actor, w.documentId));
    expect(p).toMatchObject({ voided: true, voidReason: 'Issued to the wrong person', number: w.number });
    // the signed version is still readable
    expect((await view(w)).versions[0]!.signatures).toHaveLength(1);
  });

  it('a void without a reason, a second void, another store\'s manager and staff are refused [kills: re-voiding; void by a stranger]', async () => {
    const w = await world('voidrefuse');
    const v = (as: Actor, reason: string) => asOrg(w.f.orgId, (tx) => voidDocument(tx, as, { documentId: w.documentId, reason }));
    expect(await sentenceOf(v(w.f.managerA.actor, '  '))).toMatch(/reason/i);
    await denied(v(w.f.managerB.actor, 'because'));
    await denied(v(w.f.staff.actor, 'because'));
    await v(w.f.admin.actor, 'Admin voided it');
    expect(await sentenceOf(v(w.f.admin.actor, 'again'))).toMatch(/already void/i);
  });

  it('a void document cannot be revised or signed [kills: reviving a void document]', async () => {
    const w = await world('voidlocked');
    await asOrg(w.f.orgId, (tx) => voidDocument(tx, w.f.managerA.actor, { documentId: w.documentId, reason: 'Wrong person' }));
    expect(await sentenceOf(asOrg(w.f.orgId, (tx) => reviseDocument(tx, w.f.managerA.actor, { documentId: w.documentId, body: 'x', reason: 'y' })))).toMatch(/void/i);
    expect(await sentenceOf(sign(w, w.f.managerA.actor, 'issuer', w.f.managerA))).toMatch(/void/i);
  });

  it('the void is audited with its reason and the document number [kills: an unaudited void]', async () => {
    const w = await world('voidaudit');
    await asOrg(w.f.orgId, (tx) => voidDocument(tx, w.f.managerA.actor, { documentId: w.documentId, reason: 'Duplicate' }));
    const rows = await sql<{ after: Record<string, unknown> }[]>`select after from audit_log where org_id = ${w.f.orgId} and action = 'document.voided'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.after).toMatchObject({ documentId: w.documentId, number: w.number, reason: 'Duplicate' });
  });
});

describe('T-584 s7 - the signature image is shown only on its own document, to someone who may view it', () => {
  it("a viewer at the document's store gets the bytes; another store's manager and staff are refused [kills: the image leaking through a guessed id]", async () => {
    const w = await world('image');
    await sign(w, w.f.managerA.actor, 'employee', w.f.employee);
    const sigId = (await view(w)).versions[0]!.signatures[0]!.id;
    const img = await asOrg(w.f.orgId, (tx) => documentSignatureImage(tx, w.f.managerA.actor, sigId));
    expect(Array.from(img.bytes)).toEqual([137, 80, 78, 71]);
    await denied(asOrg(w.f.orgId, (tx) => documentSignatureImage(tx, w.f.managerB.actor, sigId)));
    await denied(asOrg(w.f.orgId, (tx) => documentSignatureImage(tx, w.f.staff.actor, sigId)));
  });

  it("another organisation's id is simply not there [kills: a cross-org id]", async () => {
    const a = await world('imgA');
    const b = await world('imgB');
    await sign(a, a.f.managerA.actor, 'employee', a.f.employee);
    const sigId = (await view(a)).versions[0]!.signatures[0]!.id;
    await sentenceOf(asOrg(b.f.orgId, (tx) => documentSignatureImage(tx, b.f.admin.actor, sigId)));
  });
});

describe('T-584 R7 - a signature keeps the signer\'s name as it was', () => {
  it('renaming the signer after signing changes neither the history nor the print [kills: names read live]', async () => {
    const w = await world('signername');
    await sign(w, w.f.managerA.actor, 'issuer', w.f.managerA);
    await sign(w, w.f.managerA.actor, 'employee', w.f.employee);
    await sql`update persons set display_name = 'Someone Else', first_name = null, middle_name = null, last_name = null where id in (${w.f.managerA.personId}, ${w.f.employee.personId})`;
    const p = await asOrg(w.f.orgId, (tx) => documentPrintData(tx, w.f.admin.actor, w.documentId, 1));
    expect(p.slots.map((s) => s.name)).toEqual(['Manager A', 'Employee, Staffer']);
    expect((await view(w)).versions[0]!.signatures.map((s) => s.personName).sort()).toEqual(['Employee, Staffer', 'Manager A']);
  });

  it('a void reason over 500 characters is refused in plain words [kills: an unbounded reason]', async () => {
    const w = await world('voidcap');
    const v = (reason: string) => asOrg(w.f.orgId, (tx) => voidDocument(tx, w.f.managerA.actor, { documentId: w.documentId, reason }));
    expect(await sentenceOf(v('z'.repeat(501)))).toMatch(/500/);
    await v('z'.repeat(500));
  });
});

describe('T-584 organisation-wide documents: the signature image is readable by a store manager (Ian, 15 Nov)', () => {
  it('a manager at any store sees the image on a storeless document the admin signed; staff do not [kills: a signed memo image only an administrator can open]', async () => {
    const f = await documentFixture(sql, 'storeless-image');
    const t = await asOrg(f.orgId, (tx) => saveDocumentTemplate(tx, f.admin.actor, { name: 'Memo', kindId: f.kind.memo, body: 'x', signatureSlots: ['issuer'] }));
    const m = await asOrg(f.orgId, (tx) => issueDocument(tx, f.admin.actor, { templateId: t.templateId, body: 'Everyone, signed.' }));
    for (const row of await sql<{ storage_path: string }[]>`select storage_path from stored_files where org_id = ${f.orgId}`) driver.files.set(row.storage_path, new Uint8Array([9, 9, 9]));
    await asOrg(f.orgId, (tx) => signDocument(tx, f.admin.actor, { documentId: m.documentId, slot: 'issuer', versionNo: 1, employeeId: '', pin: f.admin.pin }));
    const sigId = (await asOrg(f.orgId, (tx) => getIssuedDocument(tx, f.managerA.actor, m.documentId))).versions[0]!.signatures[0]!.id;
    for (const who of [f.managerA.actor, f.managerB.actor]) {
      const img = await asOrg(f.orgId, (tx) => documentSignatureImage(tx, who, sigId));
      expect(Array.from(img.bytes)).toEqual([9, 9, 9]);
    }
    await denied(asOrg(f.orgId, (tx) => documentSignatureImage(tx, f.staff.actor, sigId)));
    // reading is not signing: a manager cannot sign the storeless memo
    await denied(asOrg(f.orgId, (tx) => signDocument(tx, f.managerA.actor, { documentId: m.documentId, slot: 'issuer', versionNo: 1, employeeId: '', pin: f.admin.pin })));
  });
});
