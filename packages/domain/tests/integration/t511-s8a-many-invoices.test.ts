import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-511 S8a - one zip holding SEVERAL Foodpanda invoice workbooks (docs/tasks/511-settlement-upload-s8-spec.md "S8a"). `ingestSettlementUpload` splits it into one
 * upload per workbook, in invoice-date order (then invoice number), each in its OWN transaction; a refused workbook never undoes the others. The stored file of each
 * is a deterministic mini zip (that workbook + the pdf of the same name); a zip with exactly one workbook keeps its original bytes. Real Postgres, a new org per test.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { type Actor } from '@shareat/auth';
import { inMemoryDriver, setStorageDriver } from '@shareat/domain';
import { ingestSettlementUpload, type UploadMemberResult } from '../../src/settlement-intake/ingest-many';
import { fingerprintOf } from '../../src/settlement-intake/ingest';
import { openSettlementZip } from '../../src/settlement-intake/safe-zip';
import { storedZip } from '../../src/settlement-intake/zip-repack';
import { LIPA_FP, MALVAR_FP, world, synthFoodpanda, type World } from './_fixtures/t511-s4-world';
import { day, fp34Order, fpWorkbook, zipBytes, type ZipEntry } from '../unit/t511-s3-helpers';

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

const upload = (w: World, actor: Actor, bytes: Buffer, contentType = 'application/zip', fileName = 'week.zip'): Promise<UploadMemberResult[]> =>
  ingestSettlementUpload((fn) => asOrg(w.orgId, fn), actor, { bytes, contentType, fileName });

const ok = (m: UploadMemberResult) => {
  if (!m.outcome.ok) throw new Error(`expected accepted, got: ${String((m.outcome.error as Error).message)}`);
  return m.outcome.result;
};
const refusedText = (m: UploadMemberResult): string => {
  if (m.outcome.ok) throw new Error('expected refused');
  const e = m.outcome.error as { userMessage?: string; message: string };
  return e.userMessage ?? e.message;
};

/* ------------------------------------------------------------------ builders */

const ymd = (iso: string): string => iso.replaceAll('-', '');
interface Inv {
  no: string;
  invoiceDate: string;
  orderDate: string;
  vendor?: string;
  pdf?: boolean;
}
const workbookOf = (i: Inv): Buffer =>
  fpWorkbook({
    orderRows: [0, 1].map((n) => fp34Order(`${(i.vendor ?? LIPA_FP).toLowerCase()}-${i.no}-${n}`, { 2: day(i.invoiceDate), 7: day(i.orderDate) }, i.no, i.vendor ?? LIPA_FP)),
    chargeRows: [],
  });
const baseOf = (i: Inv): string => `${ymd(i.invoiceDate)}_${i.no}`;
const entriesOf = (i: Inv): ZipEntry[] => [
  { name: `${baseOf(i)}.xls`, data: workbookOf(i) },
  ...(i.pdf === false ? [] : [{ name: `${baseOf(i)}.pdf`, data: Buffer.from(`%PDF-1.4 ${i.no}`) }]),
];

// invoice dates run A (10 Oct) < B (11 Oct) < C (12 Oct); order dates differ so no invoice replaces another (that is S8b's concern)
const A: Inv = { no: '200000000001', invoiceDate: '2026-10-10', orderDate: '2026-10-05' };
const B: Inv = { no: '200000000002', invoiceDate: '2026-10-11', orderDate: '2026-10-06' };
const C: Inv = { no: '200000000003', invoiceDate: '2026-10-12', orderDate: '2026-10-07' };
/** listed C, A, B: the zip order is NOT the processing order */
const weekZip = (extra: ZipEntry[] = []): Buffer => zipBytes([...entriesOf(C), ...entriesOf(A), ...entriesOf(B), ...extra]);

/* ------------------------------------------------------------------ read-backs (raw connection, no RLS) */

const uploadsOf = (orgId: string) => sql<{ id: string; invoice_number: string | null; fingerprint: string; file_id: string; pdf_file_id: string | null; superseded_by: string | null; period_from: string | null; store_id: string }[]>`
  select id::text, invoice_number, fingerprint, file_id::text, pdf_file_id::text, superseded_by::text, period_from::text, store_id::text
    from settlement_uploads where org_id = ${orgId} order by uploaded_at, id`;
const count = async (table: string, orgId: string): Promise<number> => {
  const [r] = await sql<{ n: number }[]>`select count(*)::int as n from ${sql(table)} where org_id = ${orgId}`;
  return r!.n;
};
const auditCount = async (orgId: string): Promise<number> => {
  const [r] = await sql<{ n: number }[]>`select count(*)::int as n from audit_log where org_id = ${orgId} and action = 'settlement_upload.ingested'`;
  return r!.n;
};
const storedBytes = async (fileId: string): Promise<Buffer> => {
  const [f] = await sql<{ storage_path: string }[]>`select storage_path from stored_files where id = ${fileId}`;
  return Buffer.from(await driver.get(f!.storage_path));
};

/* ================================================================== */

describe('T-511 S8a - a zip with several invoices becomes one upload per invoice', () => {
  it('three invoices listed out of order: three accepted, processed in invoice-date order, each in its own upload with its own audit entry [kills: one upload for the zip; zip order used; a shared transaction]', async () => {
    const w = await world(sql, 's8a-three');
    const rows = await upload(w, w.managerA, weekZip());
    expect(rows.map((r) => r.invoiceNumber)).toEqual([A.no, B.no, C.no]);
    expect(rows.map((r) => r.name)).toEqual([`${baseOf(A)}.xls`, `${baseOf(B)}.xls`, `${baseOf(C)}.xls`]);
    for (const r of rows) expect(ok(r)).toMatchObject({ kind: 'foodpanda_invoice', channelId: w.fpA, storeId: w.storeA, alreadyUploaded: false, daysStaged: 1 });
    const up = await uploadsOf(w.orgId);
    expect(up.map((u) => u.invoice_number)).toEqual([A.no, B.no, C.no]);
    expect(up.map((u) => u.id)).toEqual(rows.map((r) => ok(r).uploadId));
    expect(up.every((u) => u.superseded_by === null)).toBe(true);
    expect(await auditCount(w.orgId)).toBe(3);
  });

  it('the stored file of each is a mini zip of that workbook and its own pdf, byte-for-byte the same every time [kills: the big zip stored three times; a wrong pdf; random timestamps]', async () => {
    const w = await world(sql, 's8a-mini');
    await upload(w, w.managerA, weekZip());
    const up = await uploadsOf(w.orgId);
    for (const [i, inv] of [A, B, C].entries()) {
      const bytes = await storedBytes(up[i]!.file_id);
      const [xls, pdf] = entriesOf(inv);
      expect(bytes.equals(storedZip([{ name: xls!.name, data: xls!.data }, { name: pdf!.name, data: pdf!.data }]))).toBe(true);
      expect(up[i]!.fingerprint).toBe(fingerprintOf(bytes));
      const back = await openSettlementZip(bytes);
      expect(back.workbook.equals(xls!.data)).toBe(true);
      expect(back.pdf?.equals(pdf!.data)).toBe(true);
      expect(up[i]!.pdf_file_id).toBeNull();
    }
    expect(await count('stored_files', w.orgId)).toBe(3);
  });

  it('the same zip again: each invoice says already uploaded, with the earlier upload, and nothing new is written [kills: a fingerprint that changes per call; a double upload]', async () => {
    const w = await world(sql, 's8a-repeat');
    const first = await upload(w, w.managerA, weekZip());
    const again = await upload(w, w.managerA, weekZip());
    expect(again.map((r) => r.invoiceNumber)).toEqual([A.no, B.no, C.no]);
    again.forEach((r, i) => {
      expect(ok(r)).toMatchObject({ alreadyUploaded: true, daysStaged: 0, uploadId: ok(first[i]!).uploadId });
      expect(ok(r).uploadedOn).not.toBeNull();
    });
    expect(await count('settlement_uploads', w.orgId)).toBe(3);
    expect(await count('stored_files', w.orgId)).toBe(3);
    expect(await auditCount(w.orgId)).toBe(3);
  });

  it('a pair of invoices re-uploaded inside a different zip is still already uploaded (the fingerprint is the invoice, not the zip) [kills: fingerprint of the whole zip]', async () => {
    const w = await world(sql, 's8a-other-zip');
    await upload(w, w.managerA, weekZip());
    const smaller = await upload(w, w.managerA, zipBytes([...entriesOf(B), ...entriesOf(A)]));
    expect(smaller.map((r) => ok(r).alreadyUploaded)).toEqual([true, true]);
    expect(await count('settlement_uploads', w.orgId)).toBe(3);
  });

  it('one bad invoice among good ones: the good ones are kept, the bad one is refused in plain words, and nothing of it is written [kills: all-or-nothing; a refusal that hides the others]', async () => {
    const w = await world(sql, 's8a-bad');
    const unknownStore: Inv = { no: '200000000009', invoiceDate: '2026-10-11', orderDate: '2026-10-09', vendor: 'ZZ99' };
    const rows = await upload(w, w.managerA, zipBytes([...entriesOf(A), ...entriesOf(unknownStore), ...entriesOf(C)]));
    expect(rows.map((r) => r.invoiceNumber)).toEqual([A.no, unknownStore.no, C.no]);
    expect(rows.map((r) => r.outcome.ok)).toEqual([true, false, true]);
    expect(refusedText(rows[1]!)).toBe(`The Foodpanda vendor code "ZZ99" is not set up on any channel. Ask an admin to enter it on the store's Foodpanda channel.`);
    expect((await uploadsOf(w.orgId)).map((u) => u.invoice_number)).toEqual([A.no, C.no]);
    expect(await auditCount(w.orgId)).toBe(2);
    expect(await count('stored_files', w.orgId)).toBe(2);
  });

  it('a damaged workbook sorts last and is refused alone; the readable ones go in as before [kills: a sort that throws on one bad member]', async () => {
    const w = await world(sql, 's8a-damaged');
    const rows = await upload(w, w.managerA, zipBytes([{ name: '20261001_broken.xls', data: Buffer.from('this is not a workbook') }, ...entriesOf(B), ...entriesOf(A)]));
    expect(rows.map((r) => r.outcome.ok)).toEqual([true, true, false]);
    expect(rows.map((r) => r.invoiceNumber)).toEqual([A.no, B.no, null]);
    expect(rows[2]!.name).toBe('20261001_broken.xls');
    expect((await uploadsOf(w.orgId)).length).toBe(2);
  });

  it('a workbook with no pdf is stored alone, and a pdf nobody owns is dropped [kills: a pdf paired by position; a stray pdf stored]', async () => {
    const w = await world(sql, 's8a-pdf');
    const rows = await upload(w, w.managerA, zipBytes([...entriesOf({ ...A, pdf: false }), ...entriesOf(B), { name: 'stray.pdf', data: Buffer.from('%PDF-1.4 stray') }]));
    expect(rows.map((r) => r.outcome.ok)).toEqual([true, true]);
    const up = await uploadsOf(w.orgId);
    const aBytes = await storedBytes(up[0]!.file_id);
    expect((await openSettlementZip(aBytes)).pdf).toBeNull();
    const bBytes = await storedBytes(up[1]!.file_id);
    expect(bBytes.includes(Buffer.from('stray'))).toBe(false);
    expect((await openSettlementZip(bBytes)).pdf?.toString()).toBe(`%PDF-1.4 ${B.no}`);
  });
});

describe('T-511 S8a - the same invoice is the same upload, however the zip was made', () => {
  it('renamed to upper case, put in a folder, pdf in another case: identical stored bytes, so already uploaded [kills: member names leaking into the fingerprint]', async () => {
    const w = await world(sql, 's8a-canonical');
    await upload(w, w.managerA, zipBytes([...entriesOf(A), ...entriesOf(B)]));
    const reZipped = zipBytes([
      { name: `Week 46/${baseOf(B).toUpperCase()}.XLS`, data: workbookOf(B) },
      { name: `Week 46/${baseOf(B).toUpperCase()}.PDF`, data: Buffer.from(`%PDF-1.4 ${B.no}`) },
      { name: `other/${baseOf(A)}.xls`, data: workbookOf(A) },
      { name: `other/${baseOf(A)}.pdf`, data: Buffer.from(`%PDF-1.4 ${A.no}`) },
    ]);
    const again = await upload(w, w.managerA, reZipped);
    expect(again.map((r) => ok(r).alreadyUploaded)).toEqual([true, true]);
    expect(await count('settlement_uploads', w.orgId)).toBe(2);
    const up = await uploadsOf(w.orgId);
    const [xls, pdf] = entriesOf(A);
    expect((await storedBytes(up[0]!.file_id)).equals(storedZip([{ name: xls!.name, data: xls!.data }, { name: pdf!.name, data: pdf!.data }]))).toBe(true);
  });

  it('a first upload with upper-case and folder names stores the canonical lower-case names [kills: names kept as sent]', async () => {
    const w = await world(sql, 's8a-canonical-first');
    await upload(w, w.managerA, zipBytes([
      { name: `X/${baseOf(A).toUpperCase()}.XLS`, data: workbookOf(A) },
      { name: `X/${baseOf(A).toUpperCase()}.PDF`, data: Buffer.from(`%PDF-1.4 ${A.no}`) },
      ...entriesOf(B),
    ]));
    const [u] = await uploadsOf(w.orgId);
    const stored = await openSettlementZip(await storedBytes(u!.file_id));
    expect(stored.pdf?.toString()).toBe(`%PDF-1.4 ${A.no}`);
    expect((await storedBytes(u!.file_id)).includes(Buffer.from(`${baseOf(A)}.xls`))).toBe(true);
    expect((await storedBytes(u!.file_id)).includes(Buffer.from('X/'))).toBe(false);
  });
});

describe('T-511 S8a - ordering and size edges', () => {
  it('two invoices with the same date go in by invoice number, whatever order the zip lists them [kills: a sort on the date alone]', async () => {
    const w = await world(sql, 's8a-same-date');
    const low: Inv = { no: '200000000004', invoiceDate: '2026-10-11', orderDate: '2026-10-08' };
    const high: Inv = { no: '200000000005', invoiceDate: '2026-10-11', orderDate: '2026-10-09' };
    const rows = await upload(w, w.managerA, zipBytes([...entriesOf(high), ...entriesOf(low)]));
    expect(rows.map((r) => r.invoiceNumber)).toEqual([low.no, high.no]);
    expect((await uploadsOf(w.orgId)).map((u) => u.invoice_number)).toEqual([low.no, high.no]);
  });

  it("an invoice whose files together are over the 3 MB limit is refused alone, in a sentence that fits a zip [kills: 'The file is…' wording; one big member sinking the rest]", async () => {
    const w = await world(sql, 's8a-big-member');
    const rows = await upload(w, w.managerA, zipBytes([{ name: 'big.xls', data: Buffer.alloc(3.5 * 1024 * 1024) }, ...entriesOf(A)]));
    expect(rows.map((r) => r.outcome.ok)).toEqual([true, false]);
    expect(refusedText(rows[1]!)).toBe("This invoice's files together are 3.5 MB, over the 3 MB limit.");
    expect(await count('settlement_uploads', w.orgId)).toBe(1);
  });

  it('more than 20 invoices in a zip: one refusal in plain words, nothing is written [kills: an unbounded number of worker reads]', async () => {
    const w = await world(sql, 's8a-21');
    const rows = await upload(w, w.managerA, zipBytes(Array.from({ length: 21 }, (_, i) => ({ name: `inv${i}.xls`, data: Buffer.from(`wb ${i}`) }))));
    expect(rows).toHaveLength(1);
    expect(refusedText(rows[0]!)).toBe('The zip holds 21 invoices, more than the 20 one zip may hold, so it was refused. Split it into smaller zips.');
    expect(await count('settlement_uploads', w.orgId)).toBe(0);
  });

  it('the days-waiting warning says "loaded", never "staged" [kills: jargon on the screen]', async () => {
    const w = await world(sql, 's8a-words');
    const rows = await upload(w, w.managerA, zipBytes([...entriesOf(A), ...entriesOf(B)]));
    for (const r of rows) {
      expect(ok(r).warnings).toContain('1 day is loaded but waiting for the sales day to be verified before the figure staff recorded can be compared.');
      expect(ok(r).warnings.join(' ')).not.toMatch(/staged/i);
    }
  });
});

describe('T-511 S8a - a zip with one workbook is stored exactly as it came', () => {
  it('the original bytes (even with an extra pdf in it) are kept and fingerprinted, one row, as before [kills: re-packing a single invoice; losing the old fingerprints]', async () => {
    const w = await world(sql, 's8a-one');
    const original = zipBytes([...entriesOf(A), { name: 'stray.pdf', data: Buffer.from('%PDF-1.4 stray') }]);
    const rows = await upload(w, w.managerA, original, 'application/zip', 'one.zip');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('one.zip');
    const r = ok(rows[0]!);
    const [u] = await uploadsOf(w.orgId);
    expect(u!.fingerprint).toBe(fingerprintOf(original));
    expect((await storedBytes(u!.file_id)).equals(original)).toBe(true);
    expect(r.uploadId).toBe(u!.id);
  });

  it('a fixture zip uploaded the old way gives the same fingerprint it always did [kills: a changed fingerprint for existing uploads]', async () => {
    const w = await world(sql, 's8a-fixture');
    const bytes = synthFoodpanda([{ date: '2026-10-05', revenue: 100 }], LIPA_FP, 'fix');
    const rows = await upload(w, w.managerA, bytes);
    expect(rows).toHaveLength(1);
    ok(rows[0]!);
    expect((await uploadsOf(w.orgId))[0]!.fingerprint).toBe(fingerprintOf(bytes));
  });
});

describe('T-511 S8a - who may upload is decided per invoice, by the domain', () => {
  it("a manager of another store: every invoice is refused with the same plain sentence, nothing is written [kills: the gate skipped on the split path]", async () => {
    const w = await world(sql, 's8a-other-store');
    const rows = await upload(w, w.managerB, weekZip());
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(refusedText(r)).toBe('This file does not belong to your stores.');
    expect(await count('settlement_uploads', w.orgId)).toBe(0);
    expect(await count('stored_files', w.orgId)).toBe(0);
    expect(await auditCount(w.orgId)).toBe(0);
  });

  it('staff without the upload permission: one refusal, the zip is not even opened, nothing is written [kills: parsing a zip for someone who may not upload]', async () => {
    const w = await world(sql, 's8a-staff');
    const rows = await upload(w, w.staff, weekZip());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome.ok).toBe(false);
    expect(refusedText(rows[0]!)).toBe('You do not have permission to upload settlement files. Ask an admin.');
    expect(await count('settlement_uploads', w.orgId)).toBe(0);
  });

  it('a manager of Lipa sending a zip of one Lipa invoice and one Malvar invoice: Lipa goes in, Malvar is refused alone [kills: a store check on the first member only]', async () => {
    const w = await world(sql, 's8a-mixed-stores');
    const malvar: Inv = { no: '200000000077', invoiceDate: '2026-10-11', orderDate: '2026-10-08', vendor: MALVAR_FP };
    const rows = await upload(w, w.managerA, zipBytes([...entriesOf(A), ...entriesOf(malvar)]));
    expect(rows.map((r) => r.outcome.ok)).toEqual([true, false]);
    expect(refusedText(rows[1]!)).toBe('This file does not belong to your stores.');
    expect((await uploadsOf(w.orgId)).map((u) => u.store_id)).toEqual([w.storeA]);
  });
});

describe('T-511 S8a - a zip that cannot be split still gives the plain refusal it always did', () => {
  it('a hostile zip (a nested archive) is one refused row with the zip sentence [kills: a refusal swallowed or turned into an empty list]', async () => {
    const w = await world(sql, 's8a-hostile');
    const rows = await upload(w, w.managerA, zipBytes([...entriesOf(A), ...entriesOf(B), { name: 'inner.zip', data: Buffer.from('x') }]));
    expect(rows).toHaveLength(1);
    expect(refusedText(rows[0]!)).toBe('The zip holds another archive ("inner.zip"), which is not allowed.');
    expect(await count('settlement_uploads', w.orgId)).toBe(0);
  });

  it('a zip with no workbook is one refused row', async () => {
    const w = await world(sql, 's8a-none');
    const rows = await upload(w, w.managerA, zipBytes([{ name: 'a.pdf', data: Buffer.from('%PDF-1.4') }]));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome.ok).toBe(false);
  });

  it('an unsupported content type is one refused row, the zip is not split [kills: splitting before the type check]', async () => {
    const w = await world(sql, 's8a-type');
    const rows = await upload(w, w.managerA, weekZip(), 'image/png');
    expect(rows).toHaveLength(1);
    expect(refusedText(rows[0]!)).toBe('Upload the Grab CSV export or the Foodpanda invoice zip as it was downloaded. This file is neither.');
    expect(await count('settlement_uploads', w.orgId)).toBe(0);
  });
});
