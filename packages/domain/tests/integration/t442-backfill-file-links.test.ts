import { config } from 'dotenv';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-442 S1 TESTER - docs/tasks/442-receipt-photo-link-backfill.md section 5 (M1-M10), audit A1/A2/A3/A4/A5 (M13, M14,
 * census-on-every-write-path), plus S2 M11/M12/M15 and the combined census/cap scheduler output.
 *
 * ASSUMED CONTRACT (the builder must provide exactly these names):
 *   @shareat/db   filesRepo.FILE_REFERENCES: readonly { table; column; label }[]            (packages/db/src/repo/files.ts)
 *                 filesRepo.listReferencedUnlinked(tx, orgId) -> { fileId, ownerId, source, purpose }[]   one row PER reference
 *                 filesRepo.listReferenceProblems(tx, orgId)  -> { shared, mismatched, crossOrg } (arrays; empty = clean)
 *                 filesRepo.listUnreferenced(tx, orgId)       -> report rows
 *                 filesRepo.backfillLink(tx, orgId, fileId, ownerId)  conditional UPDATE ... WHERE linked_to IS NULL
 *   domain        backfillFileLinks(orgId, { confirm }) from '../../src/files/backfill-links' (packages/domain/src/files/backfill-links.ts)
 *                 -> { linked: Record<purpose,n>; bySource: Record<label,n>; shared; mismatched; crossOrg; wrongPurpose; unreferenced }
 *                 shared/mismatched/crossOrg/wrongPurpose are arrays (a bare count is also tolerated); unreferenced sums to the
 *                 number of unreferenced files (per purpose and age bucket, each file counted once).
 *   script        scripts/backfill-file-links.ts: args --confirm | --check | --org=<uuid>; reads DATABASE_URL (it.mjs sets it).
 *
 * RED reason before the build: filesRepo.FILE_REFERENCES (and the rest) do not exist; the domain module and the script do
 * not exist. The domain module is imported lazily, so each case fails on its own message instead of the whole file failing.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { closeDb, transaction, systemTransaction, APP_ROLE, filesRepo, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import {
  inMemoryDriver,
  setStorageDriver,
  createSupplier,
  recordInvoice,
  uploadFile,
  claimUpload,
  setStaffPhoto,
  setStaffSignature,
  sweepOrphanedFiles,
  runOrphanFileSweep,
} from '@shareat/domain';

const sql = postgres(url, { max: 8 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const id = () => crypto.randomUUID();

/** In-memory storage driver with a remove() counter (M8: the backfill touches no bytes). */
let driver = inMemoryDriver();
let removeCalls = 0;
beforeEach(() => {
  removeCalls = 0;
  driver = inMemoryDriver();
  const real = driver.remove.bind(driver);
  driver.remove = async (p: string) => {
    removeCalls++;
    return real(p);
  };
  setStorageDriver(driver);
});
afterAll(async () => {
  setStorageDriver(null);
  await closeDb();
  await sql.end({ timeout: 5 });
});

// ------------------------------------------------------------------ lazy access to what the builder provides

const repo = filesRepo as unknown as Record<string, unknown>;
function repoFn<T extends (...a: never[]) => unknown>(name: string): T {
  const fn = repo[name];
  if (typeof fn !== 'function') throw new Error(`filesRepo.${name} is not exported yet (packages/db/src/repo/files.ts)`);
  return fn as T;
}
type Ref = { table: string; column: string; label: string };
function registry(): readonly Ref[] {
  const r = repo['FILE_REFERENCES'];
  if (!Array.isArray(r)) throw new Error('filesRepo.FILE_REFERENCES is not exported yet (packages/db/src/repo/files.ts)');
  return r as Ref[];
}
const labelOf = (table: string, column: string): string => {
  const hit = registry().find((r) => r.table === table && r.column === column);
  if (!hit) throw new Error(`FILE_REFERENCES has no entry for ${table}.${column}`);
  return hit.label;
};

type Report = Record<string, unknown> & { linked: Record<string, number>; bySource: Record<string, number> };
async function backfill(orgId: string, confirm: boolean): Promise<Report> {
  // import.meta.glob on the exact path: {} while the file is missing (a per-case failure, not a whole-file import failure).
  const loaders = import.meta.glob('../../src/files/backfill-links.ts') as Record<string, () => Promise<{ backfillFileLinks?: unknown }>>;
  const load = Object.values(loaders)[0];
  if (!load) throw new Error('import fails: packages/domain/src/files/backfill-links.ts does not exist yet');
  const mod = await load();
  if (typeof mod.backfillFileLinks !== 'function') throw new Error('backfillFileLinks is not exported from packages/domain/src/files/backfill-links.ts');
  return (await (mod.backfillFileLinks as (o: string, x: { confirm: boolean }) => Promise<Report>)(orgId, { confirm })) as Report;
}

/** Count-ish view of anything the report returns: number -> itself, array -> length, object -> sum of its parts. */
const tot = (x: unknown): number =>
  typeof x === 'number' ? x : Array.isArray(x) ? x.length : x && typeof x === 'object' ? Object.values(x).reduce<number>((a, v) => a + tot(v), 0) : 0;
const text = (x: unknown) => JSON.stringify(x ?? null);

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}
const unlinkedList = (orgId: string) =>
  asOrg(orgId, (tx) => repoFn<(t: Tx, o: string) => Promise<{ fileId: string; ownerId: string; source: string; purpose: string }[]>>('listReferencedUnlinked')(tx, orgId));
const problems = (orgId: string) => asOrg(orgId, (tx) => repoFn<(t: Tx, o: string) => Promise<unknown>>('listReferenceProblems')(tx, orgId));

// ------------------------------------------------------------------ raw fixture (FK checks off: parents are irrelevant here)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function raw<T>(fn: (t: any) => Promise<T>): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return sql.begin(async (t: any) => {
    await t`set local session_replication_role = replica`;
    return fn(t);
  }) as Promise<T>;
}

async function mkOrg(hint: string): Promise<string> {
  const code = uid(`t442-${hint}`);
  const [o] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  return o!.id;
}

interface FileInfo { id: string; path: string; purpose: string }
async function mkFile(orgId: string, purpose: string, o: { ageHours?: number; linkedTo?: string | null } = {}): Promise<FileInfo> {
  const fid = id();
  const path = `orgs/${orgId}/${purpose}/${fid}.jpg`;
  await driver.put({ path, bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), contentType: 'image/jpeg' } as never);
  await raw(
    (t) => t`
    insert into stored_files (id, org_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by, linked_to, uploaded_at)
    values (${fid}, ${orgId}, ${purpose}, ${path}, 'image/jpeg', 4, ${uid('sum')}, ${id()}, ${o.linkedTo ?? null},
            now() - make_interval(hours => ${o.ageHours ?? 48}))`,
  );
  return { id: fid, path, purpose };
}

const PERSON_NAME = 'ZZPERSONNAME-t442';

/** One referencing row of the given registry source, pointing at `fileId`. Returns the row's id (the expected `linked_to`). */
async function mkRef(src: SrcKey, orgId: string, fileId: string, rowId: string = id()): Promise<string> {
  const store = id();
  await raw(async (t) => {
    switch (src) {
      case 'inv':
        await t`insert into supplier_invoices (id, org_id, store_id, supplier_id, invoice_date, total_amount, created_by, receipt_file_id)
                values (${rowId}, ${orgId}, ${store}, ${id()}, '2026-01-01', 10, ${id()}, ${fileId})`;
        break;
      case 'ar':
        await t`insert into ar_collections (id, org_id, store_id, customer_id, collection_date, amount, money_account_id, created_by, receipt_file_id)
                values (${rowId}, ${orgId}, ${store}, ${id()}, '2026-01-01', 10, ${id()}, ${id()}, ${fileId})`;
        break;
      case 'del':
        await t`insert into deliveries (id, org_id, store_id, kind, delivered_on, created_by, proof_file_id)
                values (${rowId}, ${orgId}, ${store}, 'commissary', '2026-01-01', ${id()}, ${fileId})`;
        break;
      case 'set':
        await t`insert into channel_settlements (id, org_id, store_id, channel_id, sales_day_id, business_date, gross_amount, outstanding_cleared,
                  net_deposited, destination_money_account_id, settled_on, created_by, withholding_certificate_file_id)
                values (${rowId}, ${orgId}, ${store}, ${id()}, ${id()}, '2026-01-01', 1, 1, 1, ${id()}, '2026-01-01', ${id()}, ${fileId})`;
        break;
      case 'emp':
        await t`insert into employments (id, org_id, store_id, person_id, staff_code, employment_status, started_on, photo_file_id)
                values (${rowId}, ${orgId}, ${store}, ${id()}, ${uid('SC')}, 'regular', '2025-01-01', ${fileId})`;
        break;
      case 'per':
        await t`insert into persons (id, org_id, display_name, signature_file_id) values (${rowId}, ${orgId}, ${PERSON_NAME}, ${fileId})`;
        break;
    }
  });
  return rowId;
}

type SrcKey = 'inv' | 'ar' | 'del' | 'set' | 'emp' | 'per';
const SOURCES: { key: SrcKey; table: string; column: string; purpose: string }[] = [
  { key: 'inv', table: 'supplier_invoices', column: 'receipt_file_id', purpose: 'receipt_photo' },
  { key: 'ar', table: 'ar_collections', column: 'receipt_file_id', purpose: 'receipt_photo' },
  { key: 'del', table: 'deliveries', column: 'proof_file_id', purpose: 'receipt_photo' },
  { key: 'set', table: 'channel_settlements', column: 'withholding_certificate_file_id', purpose: 'memo_document' },
  { key: 'emp', table: 'employments', column: 'photo_file_id', purpose: 'staff_photo' },
  { key: 'per', table: 'persons', column: 'signature_file_id', purpose: 'staff_signature' },
];

interface OrgSeed {
  orgId: string;
  u: Record<SrcKey, FileInfo & { ownerId: string }>;
  okLinked: FileInfo & { ownerId: string };
  mismatch: FileInfo & { ownerId: string; otherId: string };
  shared: FileInfo & { low: string; high: string };
  wrongSig: FileInfo & { ownerId: string };
  wrongLeave: FileInfo & { ownerId: string };
  unrefOld: FileInfo;
  unrefFresh: FileInfo;
  all: FileInfo[];
}

/** The spec fixture for one org: an unlinked referenced file per registry source, one already linked, one mismatched,
 *  one shared, two wrong-purpose, one unreferenced old, one unreferenced fresh. */
async function seedOrg(orgId: string): Promise<OrgSeed> {
  const all: FileInfo[] = [];
  const track = <T extends FileInfo>(f: T): T => (all.push(f), f);
  const u = {} as OrgSeed['u'];
  for (const s of SOURCES) {
    const f = track(await mkFile(orgId, s.purpose));
    u[s.key] = { ...f, ownerId: await mkRef(s.key, orgId, f.id) };
  }
  const okOwner = id();
  const okF = track(await mkFile(orgId, 'receipt_photo', { linkedTo: okOwner }));
  await mkRef('inv', orgId, okF.id, okOwner);
  const otherId = id();
  const mmF = track(await mkFile(orgId, 'receipt_photo', { linkedTo: otherId }));
  const mmOwner = await mkRef('del', orgId, mmF.id);
  const shF = track(await mkFile(orgId, 'receipt_photo'));
  const [low, high] = [id(), id()].sort();
  await mkRef('inv', orgId, shF.id, high);
  await mkRef('inv', orgId, shF.id, low);
  const wsF = track(await mkFile(orgId, 'staff_signature'));
  const wsOwner = await mkRef('inv', orgId, wsF.id);
  const wlF = track(await mkFile(orgId, 'leave_document'));
  const wlOwner = await mkRef('set', orgId, wlF.id);
  const unrefOld = track(await mkFile(orgId, 'receipt_photo', { ageHours: 72 }));
  const unrefFresh = track(await mkFile(orgId, 'receipt_photo', { ageHours: 0 }));
  return {
    orgId, u,
    okLinked: { ...okF, ownerId: okOwner },
    mismatch: { ...mmF, ownerId: mmOwner, otherId },
    shared: { ...shF, low: low!, high: high! },
    wrongSig: { ...wsF, ownerId: wsOwner },
    wrongLeave: { ...wlF, ownerId: wlOwner },
    unrefOld, unrefFresh, all,
  };
}

interface World { A: OrgSeed; B: OrgSeed; crossOrgFile: FileInfo; crossOrgOwner: string }
/** Two orgs, the full fixture in each, plus an org-A invoice that references an org-B file (the DEF-491 shape). */
async function world(hint: string): Promise<World> {
  const a = await mkOrg(`${hint}a`);
  const b = await mkOrg(`${hint}b`);
  const A = await seedOrg(a);
  const B = await seedOrg(b);
  const crossOrgFile = await mkFile(b, 'receipt_photo');
  const crossOrgOwner = await mkRef('inv', a, crossOrgFile.id);
  return { A, B, crossOrgFile, crossOrgOwner };
}

const linkedMap = async (orgId: string): Promise<Record<string, string | null>> =>
  Object.fromEntries((await sql<{ id: string; linked_to: string | null }[]>`select id, linked_to from stored_files where org_id = ${orgId}`).map((r) => [r.id, r.linked_to]));
const linkedTo = async (fid: string) => (await sql<{ linked_to: string | null }[]>`select linked_to from stored_files where id = ${fid}`)[0]!.linked_to;
const fileCount = async (orgId: string) => (await sql<{ n: number }[]>`select count(*)::int as n from stored_files where org_id = ${orgId}`)[0]!.n;

// ------------------------------------------------------------------ the script, run for real

const tsx = 'node_modules/tsx/dist/cli.mjs';
function runScript(args: string[]): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [tsx, 'scripts/backfill-file-links.ts', ...args], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: url },
    encoding: 'utf8',
    timeout: 180_000,
  });
  return { status: r.status, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
}

// ================================================================== M1 catalog

describe('M1 the registry is exactly the set of foreign keys into stored_files', () => {
  it('pg_constraint (DISTINCT table, non-org column) equals FILE_REFERENCES exactly (A1: the composite persons FK is not a 7th)', async () => {
    const fks = await sql<{ tbl: string; col: string }[]>`
      select distinct c.conrelid::regclass::text as tbl, a.attname as col
      from pg_constraint c
      join lateral unnest(c.conkey) as k(attnum) on true
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
      where c.contype = 'f' and c.confrelid = 'stored_files'::regclass and a.attname <> 'org_id'`;
    const actual = fks.map((r) => `${r.tbl.replace(/^public\./, '')}.${r.col}`).sort();
    const declared = registry().map((r) => `${r.table}.${r.column}`).sort();
    expect(declared).toEqual(actual);
    expect(actual.length).toBe(6);
  });

  it('A1: every uuid column named *file_id in public is in the registry (a file column added WITHOUT an FK is caught too)', async () => {
    const cols = await sql<{ t: string; c: string }[]>`
      select table_name as t, column_name as c from information_schema.columns
      where table_schema = 'public' and data_type = 'uuid' and column_name like '%file_id'`;
    const declared = new Set(registry().map((r) => `${r.table}.${r.column}`));
    const missing = cols.map((r) => `${r.t}.${r.c}`).filter((k) => !declared.has(k));
    expect(missing).toEqual([]);
  });
});

// ================================================================== repo-level census reads

describe('listReferencedUnlinked (repo)', () => {
  it('lists one row per reference whose file is unlinked and in this org: owner, source, purpose', async () => {
    const w = await world('lru');
    const rows = await unlinkedList(w.A.orgId);
    for (const s of SOURCES) {
      const hit = rows.find((r) => r.fileId === w.A.u[s.key].id);
      expect(hit, `${s.table}.${s.column} missing from the census`).toBeTruthy();
      expect(hit!.ownerId).toBe(w.A.u[s.key].ownerId);
      expect(hit!.purpose).toBe(s.purpose);
      expect(hit!.source).toBe(labelOf(s.table, s.column));
    }
    const ids = rows.map((r) => r.fileId);
    expect(ids).not.toContain(w.A.okLinked.id);
    expect(ids).not.toContain(w.A.mismatch.id);
    expect(ids).not.toContain(w.crossOrgFile.id);
    expect(ids).not.toContain(w.B.u.inv.id);
    expect(rows.filter((r) => r.fileId === w.A.shared.id).length).toBe(2);
    // 10 = 6 registry sources + 2 refs to the shared file + the wrong-purpose signature + the wrong-purpose leave doc (the census is purpose-agnostic: it lists every unlinked reference; the purpose guard acts only in the backfill)
    expect(rows.length).toBe(10);
  });
});

// ================================================================== M2-M9, M14 against the domain entry

describe('M2 the linked_to IS NULL guard', () => {
  it('a file already linked to X stays linked to X after --confirm, and backfillLink refuses to overwrite it', async () => {
    const w = await world('m2');
    await backfill(w.A.orgId, true);
    expect(await linkedTo(w.A.mismatch.id)).toBe(w.A.mismatch.otherId);
    expect(await linkedTo(w.A.okLinked.id)).toBe(w.A.okLinked.ownerId);
    await asOrg(w.A.orgId, (tx) => repoFn<(t: Tx, o: string, f: string, own: string) => Promise<unknown>>('backfillLink')(tx, w.A.orgId, w.A.mismatch.id, id()));
    expect(await linkedTo(w.A.mismatch.id)).toBe(w.A.mismatch.otherId);
  });
});

describe('M3 a dry run writes nothing and reports what confirm will do', () => {
  it('every file keeps its linked_to; the counts equal the later confirm run', async () => {
    const w = await world('m3');
    const before = await linkedMap(w.A.orgId);
    const dry = await backfill(w.A.orgId, false);
    expect(await linkedMap(w.A.orgId)).toEqual(before);
    expect(tot(dry.linked)).toBeGreaterThan(0);
    const real = await backfill(w.A.orgId, true);
    for (const k of ['linked', 'bySource', 'shared', 'mismatched', 'crossOrg', 'wrongPurpose', 'unreferenced']) {
      expect(text(dry[k]), `dry-run ${k} differs from confirm`).toBe(text(real[k]));
    }
  });
});

describe('M4 the link value is the referencing row id, bare', () => {
  it('each registry source: linked_to equals the owning row id (no file id, no table prefix)', async () => {
    const w = await world('m4');
    await backfill(w.A.orgId, true);
    for (const s of SOURCES) expect(await linkedTo(w.A.u[s.key].id), `${s.table}.${s.column}`).toBe(w.A.u[s.key].ownerId);
  });
});

describe('M5 org scope', () => {
  it("an org A run leaves every org B file untouched, and a cross-org reference is reported, not linked", async () => {
    const w = await world('m5');
    const bBefore = await linkedMap(w.B.orgId);
    const r = await backfill(w.A.orgId, true);
    expect(await linkedMap(w.B.orgId)).toEqual(bBefore);
    expect(await linkedTo(w.crossOrgFile.id)).toBeNull();
    expect(tot(r.crossOrg)).toBe(1);
    expect(r.linked).toBeDefined();
  });
});

describe('M5b org scope holds without RLS (the explicit org_id filters are the second layer, A7)', () => {
  it('as the system connection (the table owner: RLS bypassed, proven by the 10 rows) an org A call neither returns nor links org B rows', async () => {
    const w = await world('m5b');
    const bFileIds = new Set([...w.B.all.map((f) => f.id), w.crossOrgFile.id]);
    const bOwners = new Set(Object.values(w.B.u).map((u) => u.ownerId));
    const rows = await systemTransaction((tx) =>
      repoFn<(t: Tx, o: string) => Promise<{ fileId: string; ownerId: string }[]>>('listReferencedUnlinked')(tx, w.A.orgId),
    );
    expect(rows.length).toBe(10);
    for (const r of rows) {
      expect(bFileIds.has(r.fileId), `org B file ${r.fileId} returned for org A`).toBe(false);
      expect(bOwners.has(r.ownerId)).toBe(false);
    }
    const probs = await systemTransaction((tx) => repoFn<(t: Tx, o: string) => Promise<unknown>>('listReferenceProblems')(tx, w.A.orgId));
    const unref = await systemTransaction((tx) => repoFn<(t: Tx, o: string) => Promise<unknown>>('listUnreferenced')(tx, w.A.orgId));
    for (const x of [text(probs), text(unref)]) for (const b of w.B.all) expect(x).not.toContain(b.id);
    // backfillLink for an org A call aimed at an org B file must not write
    await systemTransaction((tx) => repoFn<(t: Tx, o: string, f: string, own: string) => Promise<unknown>>('backfillLink')(tx, w.A.orgId, w.B.u.inv.id, w.B.u.inv.ownerId));
    expect(await linkedTo(w.B.u.inv.id)).toBeNull();
    await systemTransaction((tx) => repoFn<(t: Tx, o: string, f: string, own: string) => Promise<unknown>>('backfillLink')(tx, w.A.orgId, w.crossOrgFile.id, w.crossOrgOwner));
    expect(await linkedTo(w.crossOrgFile.id)).toBeNull();
  });
});

describe('M6 idempotence', () => {
  it('a second --confirm links nothing and reports identical problem lists (A4: shared never also mismatched)', async () => {
    const w = await world('m6');
    const first = await backfill(w.A.orgId, true);
    const second = await backfill(w.A.orgId, true);
    expect(tot(second.linked)).toBe(0);
    for (const k of ['shared', 'mismatched', 'crossOrg', 'wrongPurpose']) expect(text(second[k]), k).toBe(text(first[k]));
    expect(tot(second.mismatched)).toBe(1);
    expect(text(second.mismatched)).not.toContain(w.A.shared.high);
  });
});

describe('M7 counts are keyed by the file purpose and the source label', () => {
  it('the ar_collections file counts under receipt_photo (F2), the employment photo under staff_photo', async () => {
    const w = await world('m7');
    const r = await backfill(w.A.orgId, true);
    // receipt_photo: invoice + ar + delivery + the shared file; the wrong-purpose files are NOT counted anywhere.
    expect(r.linked['receipt_photo']).toBe(4);
    expect(r.linked['staff_photo']).toBe(1);
    expect(r.linked['staff_signature']).toBe(1);
    expect(r.linked['memo_document']).toBe(1);
    expect(r.linked['ar_collection_proof'] ?? 0).toBe(0);
    expect(r.linked['leave_document'] ?? 0).toBe(0);
    expect(r.bySource[labelOf('ar_collections', 'receipt_file_id')]).toBe(1);
    expect(r.bySource[labelOf('employments', 'photo_file_id')]).toBe(1);
    expect(r.bySource[labelOf('deliveries', 'proof_file_id')]).toBe(1);
    expect(r.bySource[labelOf('persons', 'signature_file_id')]).toBe(1);
    expect(r.bySource[labelOf('channel_settlements', 'withholding_certificate_file_id')]).toBe(1);
    expect(r.bySource[labelOf('supplier_invoices', 'receipt_file_id')]).toBe(2); // its own file + the shared file
    expect(tot(r.unreferenced)).toBe(2);
  });
});

describe('M8 nothing is deleted, no bytes touched', () => {
  it('stored_files row count unchanged, storage remove() never called, every byte still there', async () => {
    const w = await world('m8');
    const n = await fileCount(w.A.orgId);
    await backfill(w.A.orgId, false);
    await backfill(w.A.orgId, true);
    expect(await fileCount(w.A.orgId)).toBe(n);
    expect(removeCalls).toBe(0);
    for (const f of w.A.all) expect(driver.files.has(f.path), f.path).toBe(true);
    expect(await linkedTo(w.A.unrefOld.id)).toBeNull();
    expect(await linkedTo(w.A.unrefFresh.id)).toBeNull();
  });
});

describe('M9 a shared file', () => {
  it('is linked once, to the lowest owner id; the other owner is listed as shared, not mismatched', async () => {
    const w = await world('m9');
    const r = await backfill(w.A.orgId, true);
    expect(await linkedTo(w.A.shared.id)).toBe(w.A.shared.low);
    expect(tot(r.shared)).toBe(1);
    expect(text(r.shared)).toContain(w.A.shared.high);
    expect(text(r.shared)).not.toContain(w.A.shared.low);
    expect(text(r.mismatched)).not.toContain(w.A.shared.high);
    expect(r.bySource[labelOf('supplier_invoices', 'receipt_file_id')]).toBe(2);
  });
});

describe('M14 the purpose guard (A3)', () => {
  it('a staff_signature file referenced from supplier_invoices and a leave_document referenced from a settlement stay unlinked and count under wrongPurpose', async () => {
    const w = await world('m14');
    const r = await backfill(w.A.orgId, true);
    expect(await linkedTo(w.A.wrongSig.id)).toBeNull();
    expect(await linkedTo(w.A.wrongLeave.id)).toBeNull();
    expect(tot(r.wrongPurpose)).toBe(2);
    expect(r.linked['staff_signature']).toBe(1); // only the real person signature
  });
});

// ================================================================== M10 / M13 the script

describe('M10 script behaviour (domain entry + the real script)', { timeout: 180_000 }, () => {
  it('--check exits 1 while a referenced file is unlinked, 0 after --confirm; a no-arg run is a dry run', async () => {
    const orgId = await mkOrg('m10');
    const f = await mkFile(orgId, 'receipt_photo');
    const owner = await mkRef('inv', orgId, f.id);
    const org = `--org=${orgId}`;
    expect(runScript(['--check', org]).status).toBe(1);
    expect(runScript([org]).status).toBe(0);
    expect(await linkedTo(f.id)).toBeNull(); // no args = dry run
    expect(runScript(['--confirm', org]).status).toBe(0);
    expect(await linkedTo(f.id)).toBe(owner);
    expect(runScript(['--check', org]).status).toBe(0);
  });

  it('--check is read-only: it writes nothing, and exits 1 for a LINKABLE unlinked file', async () => {
    const orgId = await mkOrg('m10c');
    const f = await mkFile(orgId, 'receipt_photo');
    await mkRef('inv', orgId, f.id);
    const r = runScript(['--check', `--org=${orgId}`]);
    expect(r.status).toBe(1);
    expect(await linkedTo(f.id)).toBeNull();
  });

  it('--check exits 1 when the only unlinked referenced file is wrong-purpose, reports it, and writes nothing', async () => {
    const orgId = await mkOrg('m10w');
    const f = await mkFile(orgId, 'memo_document'); // a memo document referenced from an invoice receipt column: wrong purpose, not guarded (an employment/person source would be count-only), so its id is printable
    await mkRef('inv', orgId, f.id);
    const r = runScript(['--check', `--org=${orgId}`]);
    expect(r.status).toBe(1);
    expect(r.out).toContain(f.id);
    expect(await linkedTo(f.id)).toBeNull();
  });

  it('an unknown argument, a malformed --org, and an org that does not exist all exit 1', async () => {
    expect(runScript(['--confrim']).status).toBe(1);
    expect(runScript(['--org=not-a-uuid']).status).toBe(1);
    expect(runScript([`--org=${id()}`]).status).toBe(1);
  });
});

describe('M13 the script never prints a guarded file, its owner, a path, a name or a URL (A2)', { timeout: 180_000 }, () => {
  it('stdout+stderr of a run over the full fixture', async () => {
    const w = await world('m13');
    const r = runScript(['--org=' + w.A.orgId]);
    const out = r.out;
    expect(out.length).toBeGreaterThan(50); // it did print a report
    for (const f of w.A.all) expect(out, `storage_path ${f.path}`).not.toContain(f.path);
    expect(out).not.toContain(PERSON_NAME);
    expect(out).not.toContain('http');
    const guarded = [w.A.u.emp, w.A.u.per, w.A.wrongSig, w.A.wrongLeave];
    for (const g of guarded) {
      expect(out, `guarded file ${g.purpose}`).not.toContain(g.id);
      expect(out, `owner of guarded file ${g.purpose}`).not.toContain(g.ownerId);
    }
    // non-guarded problems ARE named (file id, source, owner id): the report is for Ian to act on.
    expect(out).toContain(w.A.mismatch.id);
    expect(out).toContain(w.A.shared.high);
  });
});

// ================================================================== census on every write path (the lasting guard)

describe('S2 referenced files survive the orphan sweep (M11/M12/M15)', () => {
  it('M11 excludes every registry source even while still unlinked, with an unreferenced positive control', async () => {
    const org = await mkOrg('s2-candidates');
    const referenced: FileInfo[] = [];
    for (const source of SOURCES) {
      const file = await mkFile(org, source.purpose); await mkRef(source.key, org, file.id); referenced.push(file);
    }
    const shared = await mkFile(org, 'receipt_photo'); await mkRef('inv', org, shared.id); await mkRef('inv', org, shared.id); referenced.push(shared);
    const otherOrg = await mkOrg('s2-other'), otherFile = await mkFile(otherOrg, 'receipt_photo'); await mkRef('inv', otherOrg, otherFile.id);
    const orphan = await mkFile(org, 'receipt_photo');
    const candidates = await asOrg(org, tx => filesRepo.listOrphans(tx, org, 24));
    expect(candidates.map(file => file.id)).toEqual([orphan.id]);
    const result = await sweepOrphanedFiles(org, 24);
    expect(result).toMatchObject({ candidates: 1, removed: 1, claimed: 0, referencedUnlinked: 7, failed: [] });
    for (const file of referenced) expect(driver.files.has(file.path)).toBe(true);
    expect(driver.files.has(orphan.path)).toBe(false);
  });

  it('M12 sweeps only unreferenced files after confirm and records the remaining unlinked census', async () => {
    const org = await mkOrg('s2-confirm'), receipt = await mkFile(org, 'receipt_photo');
    await mkRef('inv', org, receipt.id); await backfill(org, true);
    const orphan = await mkFile(org, 'receipt_photo');
    const result = await sweepOrphanedFiles(org, 24);
    expect(result).toMatchObject({ candidates: 1, removed: 1, referencedUnlinked: 0, failed: [] });
    expect(driver.files.has(receipt.path)).toBe(true); expect(driver.files.has(orphan.path)).toBe(false);
    const unlinked = await mkFile(org, 'receipt_photo'); await mkRef('inv', org, unlinked.id);
    const run = await runOrphanFileSweep({ orgId: org, trigger: 'manual' });
    expect(run.hadFailures).toBe(false);
    expect(run.outcomes[0]?.detail).toBe('referencedUnlinked 1');
  });

  it('M15 treats a reference committed after candidate selection as claimed and keeps its bytes', async () => {
    const org = await mkOrg('s2-race');
    const early = await mkFile(org, 'receipt_photo', { ageHours: 72 });
    const late = await mkFile(org, 'receipt_photo', { ageHours: 48 });
    const originalRemove = driver.remove.bind(driver);
    driver.remove = async path => {
      if (path === early.path) await mkRef('inv', org, late.id);
      return originalRemove(path);
    };
    const result = await sweepOrphanedFiles(org, 24);
    expect(result).toMatchObject({ candidates: 2, removed: 1, claimed: 1, failed: [] });
    expect(driver.files.has(late.path)).toBe(true);
    expect(await linkedTo(late.id)).toBeNull();
    expect((await sql`select id from stored_files where id = ${late.id}`)).toHaveLength(1);
  });

  it('keeps the referenced count and candidate-cap warning together in the real scheduler output', { timeout: 60_000 }, async () => {
    const org = await mkOrg('s2-cap'), referenced = await mkFile(org, 'receipt_photo');
    await mkRef('inv', org, referenced.id);
    for (let index = 0; index <= filesRepo.ORPHAN_SWEEP_BATCH_LIMIT; index++) await mkFile(org, 'receipt_photo');
    const run = await runOrphanFileSweep({ orgId: org, trigger: 'manual' });
    expect(run.hadFailures).toBe(false);
    expect(run.outcomes[0]?.posted).toBe(filesRepo.ORPHAN_SWEEP_BATCH_LIMIT);
    expect(run.outcomes[0]?.detail).toBe(`referencedUnlinked 1 · hit the ${filesRepo.ORPHAN_SWEEP_BATCH_LIMIT}-candidate cap — more orphans may remain in this org`);
    expect(driver.files.has(referenced.path)).toBe(true);
    expect((await asOrg(org, tx => filesRepo.listOrphans(tx, org, 24)))).toHaveLength(1);
  });
});

async function expectCensusClean(orgId: string) {
  expect(await unlinkedList(orgId)).toEqual([]);
  expect(tot(await problems(orgId))).toBe(0);
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

async function realWorld(hint: string) {
  const orgId = await mkOrg(hint);
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const storeId = store!.id;
  const mkPerson = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    return p!.id;
  };
  const managerId = await mkPerson('Manager', 'manager');
  const staffId = await mkPerson('Staff', 'staff');
  const [emp] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${orgId}, ${storeId}, ${staffId}, ${uid('SE')}, 'regular', '2025-01-01') returning id`;
  return { orgId, storeId, managerId, staffId, employmentId: emp!.id, manager: actor(orgId, managerId) };
}

describe('census: a save through the real path leaves no referenced-but-unlinked file and no reference problem (A5)', () => {
  it('supplier_invoices.receipt_file_id: recordInvoice + claimUpload(linkTo = the invoice id), as /ap does', async () => {
    const w = await realWorld('c-inv');
    await asOrg(w.orgId, async (tx) => {
      const supplier = await createSupplier(tx, w.manager, { name: 'Census Supplier', creditTermsDays: 30 });
      const up = await uploadFile(tx, w.manager, { purpose: 'receipt_photo', storeId: w.storeId, contentType: 'image/jpeg', bytes: JPEG });
      const inv = await recordInvoice(tx, w.manager, {
        storeId: w.storeId, supplierId: supplier.id, invoiceDate: '2026-01-01', totalAmount: '100.00', receiptFileId: up.fileId,
      });
      await claimUpload(tx, w.manager, { fileId: up.fileId, purpose: 'receipt_photo', storeId: w.storeId, linkTo: inv.id });
    });
    await expectCensusClean(w.orgId);
  });

  it('employments.photo_file_id: setStaffPhoto', async () => {
    const w = await realWorld('c-emp');
    await asOrg(w.orgId, (tx) => setStaffPhoto(tx, w.manager, { employmentId: w.employmentId, contentType: 'image/jpeg', bytes: JPEG }));
    await expectCensusClean(w.orgId);
  });

  it('persons.signature_file_id: setStaffSignature', async () => {
    const w = await realWorld('c-per');
    await asOrg(w.orgId, (tx) => setStaffSignature(tx, w.manager, { personId: w.staffId, contentType: 'image/png', bytes: PNG }));
    await expectCensusClean(w.orgId);
  });

  it.todo('ar_collections.receipt_file_id: customer payment (/customers) and trade pay-now - flips on in T-441 S2 (link target = the ar_collections id, A5)');
  it.todo('deliveries.proof_file_id: record a delivery with a proof photo - flips on in T-441 S2 (link target = the deliveries row id)');
  it.todo('channel_settlements.withholding_certificate_file_id: settle a channel with a certificate - flips on in T-441 S2');
});
