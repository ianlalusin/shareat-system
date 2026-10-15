/**
 * T-392 S4 (TESTER) - the dual-run `extract` side and the CLI surface. docs/tasks/392-dual-run-comparator.md R2, R3, R7, R10,
 * Contract section 1, invariants 27-30 (+ "S3 rulings"). Unit: a Firestore fake, no database.
 *
 * ---- PINNED CONTRACT (the spec names only the files; the builder follows these or says why not) ----
 * scripts/lib/dual-run-extract.ts exports:
 *   runDualRunExtract(client: ReadOnlyV1Client /* makeReadOnlyV1Client(firestore) from master-data/snapshot *\/, opts: {
 *       from: string; through: string; outDir: string; stores?: string[] /* v1 store ids; omitted = every operating store *\/;
 *       env: { NODE_ENV?: string; [k: string]: string | undefined }; now?: Date; v2?: V2KeyCatalogue /* keys pre-fill, default empty *\/;
 *   }): Promise<{ snapshotPath: string; shaPath: string; keysPath: string; sha: string; snapshot: V1Snapshot;
 *       counts: { journal: number; expenses: number; salesDays: number }; /* KEPT in the snapshot *\/
 *       summary: string /* what the command prints: store count beside the list, the excluded stores NAMED, counts, window, sha *\/ }>
 *   - NODE_ENV === 'production' rejects (message names "production") BEFORE any read or write.
 *   - Reads per store: `stores` once, then `stores/{id}/journal`, `.../expenses`, `.../salesDays`, `.../suppliers`,
 *     `.../paymentAccounts`. A document's storeId is taken from the PATH (a stored storeId field is not trusted).
 *   - Builds the snapshot with buildSnapshot({from, through, extractedAt: (now ?? new Date()).toISOString()}), writes
 *     v1-dual-run-<from>-<through>.json, v1-dual-run-<from>-<through>.sha256 (first token = sha256 of the .json bytes), and
 *     dual-run-keys.csv (prefillKeys: existing rows kept exactly as left, ticked or not). No key material in any output.
 *   - from / through must be real calendar dates, through >= from (rejects, /date/i).
 *   loadSnapshotFile(path, opts?: { stat?: (p: string) => { mode: number; uid: number }; currentUid?: number }): { snapshot: V1Snapshot; sha: string }
 *   - reads <path> and its sibling .sha256 (same stem); rejects /sha/i on a missing sidecar or a mismatch; rejects /mode|permission/i when
 *     (mode & 0o077) !== 0; rejects /owner/i when stat.uid !== currentUid. An INJECTED stat is always enforced (default stat: POSIX only).
 *   removeSnapshotFile(path): deletes the .json (the .sha256 may stay).
 * scripts/dual-run.ts: `npm run dual-run` (package.json), subcommands `extract` and `compare` only. Anything else, `classify` included,
 *   prints a usage error, exits 1 and writes nothing. No script imports a disposition writer (import-graph assertion below).
 *
 * Red today: scripts/lib/dual-run-extract.ts and scripts/dual-run.ts do not exist.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeReadOnlyV1Client } from '../src/master-data/snapshot';
import { computeV1Figures } from '../src/dual-run/v1-figures';
import { parseKeysCsv, serialiseKeysCsv } from '../src/dual-run/keys';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const ROOT = join(__dirname, '..', '..', '..');
const L = 'b9DzsnPbr1BUnY88lyT4';
const M = 'dZUyvX4q824JBSVDAfE9';
const PADRE = 'y1DMgfisuTHBF57cNL6i';
const TEST_STORE = 'XbkyEgZqunmj2wzhicNf';

/** Sentinels that must never reach a file or the printed summary. */
const PII = ['PII-PARTICULARS-1', 'PII-PAYEE-NAME', 'PII-MEMO-7', 'PII-NOTES-3', 'EMP-SECRET-9', 'STAFFID-SECRET-5', 'PII-CASHIER-NAME', 'PII-PHONE-000', 'EMPSECRET777', 'PII-SUPPLIER-ADDRESS'];
const FAKE_KEY = 'FAKE-PRIVATE-KEY-sentinel-4d1f';

type Docs = Record<string, Array<{ id: string; data: Record<string, unknown> }>>;

const lipaJournal = (amount = 1000, withDeleted = true) => [
  { id: 'j1', data: { businessDate: '2026-10-20', sourceType: 'sale', sourceId: 's1', legKey: 'k1', accountId: 'cash__cashier', direction: 'in', amount, status: 'posted', createdAtMs: 1760900000000, particulars: 'PII-PARTICULARS-1', memo: 'PII-MEMO-7', employeeId: 'EMP-SECRET-9', storeId: 'WRONG-STORE-FIELD' } },
  { id: 'j2', data: { businessDate: '2026-12-25', sourceType: 'sale', sourceId: 's9', legKey: 'k9', accountId: 'cash__cashier', direction: 'in', amount: 77, status: 'posted' } },
  { id: 'j3', data: { businessDate: '20261021', sourceType: 'sale', sourceId: 's3', legKey: 'k3', accountId: 'cash__cashier', direction: 'in', amount: 10, status: 'posted' } },
  { id: 'jstaff', data: { businessDate: '2026-10-22', sourceType: 'expense_payment', sourceId: 'e1', legKey: 'k4', accountId: 'staff_cash__EMPSECRET777', direction: 'out', amount: 5, status: 'posted' } },
  ...(withDeleted ? [{ id: 'jdel', data: { businessDate: '2026-10-22', sourceType: 'expense_payment', sourceId: 'e2', legKey: 'k5', accountId: 'cash__cashier', direction: 'out', amount: 300, status: 'posted' } }] : []),
];

function data(over: Partial<Docs> = {}, journal = lipaJournal()): Docs {
  return {
    stores: [
      { id: L, data: { name: 'SharEat Lipa' } },
      { id: M, data: { name: 'SharEat Malvar' } },
      { id: PADRE, data: { name: 'SharEat Padre Garcia' } },
      { id: TEST_STORE, data: { name: 'Test Store One' } },
    ],
    [`stores/${L}/journal`]: journal,
    [`stores/${L}/expenses`]: [
      { id: 'ex1', data: { dayKey: '2026-10-21', totalAmount: 250, status: 'posted', supplierId: 'sup1', expenseEntryId: 'ent1', expenseEntryGroup: 'OPEX', category: 'Supplies', particulars: 'PII-PARTICULARS-1', payee: 'PII-PAYEE-NAME', notes: 'PII-NOTES-3', employeeId: 'EMP-SECRET-9', payments: [{ method: 'cash', amount: 250, staffId: 'STAFFID-SECRET-5' }] } },
    ],
    [`stores/${L}/salesDays`]: [
      { id: '2026-10-20', data: { status: 'verified', dineInSales: 1000, onlineBreakdown: {}, creditSales: 0, otherPaymentSales: 0, cashierName: 'PII-CASHIER-NAME', notes: 'PII-NOTES-3' } },
    ],
    [`stores/${L}/suppliers`]: [{ id: 'sup1', data: { businessName: 'Acme Meats', phone: 'PII-PHONE-000', address: 'PII-SUPPLIER-ADDRESS' } }],
    [`stores/${L}/paymentAccounts`]: [],
    [`stores/${M}/journal`]: [],
    [`stores/${M}/expenses`]: [],
    [`stores/${M}/salesDays`]: [],
    [`stores/${M}/suppliers`]: [],
    [`stores/${M}/paymentAccounts`]: [],
    ...over,
  };
}

/** A Firestore double that records every read path and every write attempt. */
function fakeFirestore(docs: Docs) {
  const reads: string[] = [];
  const writes: string[] = [];
  return {
    reads,
    writes,
    collection: (path: string) => ({
      get: async () => {
        reads.push(path);
        return { docs: (docs[path] ?? []).map((d) => ({ id: d.id, data: () => d.data })) };
      },
      add: () => writes.push('add'),
      doc: () => ({ set: () => writes.push('set'), update: () => writes.push('update'), delete: () => writes.push('delete') }),
    }),
    batch: () => writes.push('batch'),
    runTransaction: () => writes.push('runTransaction'),
  };
}

const tmp = (): string => mkdtempSync(join(tmpdir(), 't392-s4-extract-'));
const env = { NODE_ENV: 'development', CAPTURE_ERP_SA_KEY_FILE: `C:/keys/${FAKE_KEY}.json`, FIREBASE_SERVICE_ACCOUNT_KEY: FAKE_KEY };
const sha256 = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');
const allText = (dir: string): string => readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')).join(String.fromCharCode(10));

const mod = async (): Promise<Any> => await import('../../../scripts/lib/dual-run-extract');
async function extract(docs: Docs, over: Record<string, unknown> = {}, outDir = tmp()) {
  const fs = fakeFirestore(docs);
  const m = await mod();
  const result = await m.runDualRunExtract(makeReadOnlyV1Client(fs as Any), {
    from: '2026-10-19', through: '2026-10-25', outDir, env, now: new Date('2026-10-26T01:00:00.000Z'), ...over,
  });
  return { fs, result, outDir };
}

describe('E. extract writes the v1 snapshot under the rules (R2, R3)', () => {
  it('E1: writes v1-dual-run-<from>-<through>.json + .sha256 + dual-run-keys.csv; sha = sha256 of the file bytes; the window drops a far leg and a legacy YYYYMMDD date is normalised. Mutant: whole payload kept / sha of the object not the file. Red today: scripts/lib/dual-run-extract.ts missing', async () => {
    const { result, outDir } = await extract(data());
    expect(readdirSync(outDir).sort()).toEqual(['dual-run-keys.csv', 'v1-dual-run-2026-10-19-2026-10-25.json', 'v1-dual-run-2026-10-19-2026-10-25.sha256']);
    const bytes = readFileSync(join(outDir, 'v1-dual-run-2026-10-19-2026-10-25.json'));
    expect(result.sha).toBe(sha256(bytes));
    expect(readFileSync(join(outDir, 'v1-dual-run-2026-10-19-2026-10-25.sha256'), 'utf8').trim().split(/\s+/)[0]).toBe(sha256(bytes));
    const snap = JSON.parse(bytes.toString('utf8'));
    expect(snap.version).toBe(1);
    expect(snap.from).toBe('2026-10-19');
    expect(snap.through).toBe('2026-10-25');
    expect(snap.extractedAt).toBe('2026-10-26T01:00:00.000Z');
    const ids = snap.journal.map((l: Any) => l.id).sort();
    expect(ids).toEqual(['j1', 'j3', 'jdel', 'jstaff']);
    expect(snap.journal.find((l: Any) => l.id === 'j3').businessDate).toBe('2026-10-21');
    expect(result.counts).toEqual({ journal: 4, expenses: 1, salesDays: 1 });
    // storeId comes from the PATH, not from the document's own (wrong) field.
    expect(snap.journal.find((l: Any) => l.id === 'j1').storeId).toBe(L);
  });

  it('E2: no PII beyond the whitelist reaches any file or the printed summary; no key material either. Mutant: blacklist / payload copied whole. Red today: module missing', async () => {
    const { result, outDir } = await extract(data());
    const everything = `${allText(outDir)}\n${result.summary}\n${JSON.stringify(result.snapshot)}`;
    for (const s of [...PII, FAKE_KEY, 'private_key']) expect(everything, s).not.toContain(s);
  });

  it('E3: the summary prints the store count beside the list, NAMES the excluded stores, and prints the counts, window and sha. Mutant: silent exclusion. Red today: module missing', async () => {
    const { result } = await extract(data());
    expect(result.summary).toMatch(/\b2 stores\b/i);
    expect(result.summary).toContain('SharEat Lipa');
    expect(result.summary).toContain('SharEat Padre Garcia');
    expect(result.summary).toContain('Test Store One');
    expect(result.summary).toContain(result.sha);
    expect(result.summary).toContain('2026-10-19');
    expect(result.summary).toMatch(/journal\D{0,12}4/i);
  });

  it('E4: refuses NODE_ENV=production BEFORE any read or write: rejects naming production, no Firestore read, nothing on disk. Red today: module missing', async () => {
    const fs = fakeFirestore(data());
    const outDir = tmp();
    const m = await mod();
    await expect(
      m.runDualRunExtract(makeReadOnlyV1Client(fs as Any), { from: '2026-10-19', through: '2026-10-25', outDir, env: { ...env, NODE_ENV: 'production' } }),
    ).rejects.toThrow(/production/i);
    expect(fs.reads).toEqual([]);
    expect(readdirSync(outDir)).toEqual([]);
  });

  it('E5: v1 is only ever read: a write attempt on the fake never happens. Mutant: any write call. Red today: module missing', async () => {
    const { fs } = await extract(data());
    expect(fs.writes).toEqual([]);
    expect(fs.reads.length).toBeGreaterThan(0);
  });

  it('E6: --stores limits the reads to those stores (Malvar is not read) and the snapshot to them. Red today: module missing', async () => {
    const { fs, result } = await extract(data(), { stores: [L] });
    expect(fs.reads.some((p) => p.startsWith(`stores/${M}/`))).toBe(false);
    expect(fs.reads).toContain(`stores/${L}/journal`);
    expect(result.snapshot.stores.map((s: Any) => s.id)).toEqual([L]);
  });

  it('E9: from and through must be real calendar dates, in order. Red today: module missing', async () => {
    const m = await mod();
    const run = (from: string, through: string) =>
      m.runDualRunExtract(makeReadOnlyV1Client(fakeFirestore(data()) as Any), { from, through, outDir: tmp(), env });
    await expect(run('2026-02-30', '2026-03-05')).rejects.toThrow(/date/i);
    await expect(run('2026-10-25', '2026-10-19')).rejects.toThrow(/date|through/i);
  });
});

describe('E7. two extracts of one week (invariant 30): v1 is read fresh, never through the landing table', () => {
  const figuresOf = (snap: Any, weekStart: string) => {
    const f = computeV1Figures(snap, { weekStart });
    return f.stores[L]!.lines.find((l) => l.kind === 'cash_bank' && l.key === 'cash__cashier');
  };

  it('E7a: a leg deleted between extracts is no longer counted. Mutant: read through the landing table (deleted leg stays current). Red today: module missing', async () => {
    const first = await extract(data());
    const second = await extract(data({}, lipaJournal(1000, false)), {}, tmp());
    // first: sale 1000 + 10 in, expense_payment 300 out on the cashier cash account = 71000 centavos.
    expect(figuresOf(first.result.snapshot, '2026-10-19')!.amount).toBe(71000);
    expect(figuresOf(second.result.snapshot, '2026-10-19')!.amount).toBe(101000);
  });

  it('E7b: a leg EDITED in place (same id, new amount, original businessDate) restates THAT week; the extract date does not take the delta. Mutant: delta placed on the extract date. Red today: module missing', async () => {
    const first = await extract(data());
    const second = await extract(data({}, lipaJournal(1200)), { now: new Date('2026-11-03T01:00:00.000Z') }, tmp());
    expect(figuresOf(first.result.snapshot, '2026-10-19')!.amount).toBe(71000);
    expect(figuresOf(second.result.snapshot, '2026-10-19')!.amount).toBe(91000);
    // the week the second extract ran in (2 Nov) carries nothing for that leg.
    expect(figuresOf(second.result.snapshot, '2026-11-02')).toBeUndefined();
    expect(second.result.snapshot.extractedAt).toBe('2026-11-03T01:00:00.000Z');
  });
});

describe('K. the keys sheet written by extract (R7)', () => {
  it('K1: rows Ian ticked are kept exactly as left; new keys are added unticked with an exact-name suggestion only. Mutant: overwrite / auto-tick. Red today: module missing', async () => {
    const outDir = tmp();
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      join(outDir, 'dual-run-keys.csv'),
      serialiseKeysCsv([{ section: 'store', v1Store: '', v1Key: L, v1Label: 'SharEat Lipa', v2Key: 'LIPA-ZZ', ticked: true }]),
    );
    const { result } = await extract(data(), { v2: { stores: [{ key: 'MLVR', name: 'sharEat  malvar' }, { key: 'LIPA', name: 'SharEat Lipa' }], money: [], categories: [] } }, outDir);
    const rows = parseKeysCsv(readFileSync(result.keysPath, 'utf8'));
    const lipa = rows.find((r) => r.section === 'store' && r.v1Key === L)!;
    expect(lipa).toMatchObject({ ticked: true, v2Key: 'LIPA-ZZ' });
    const malvar = rows.find((r) => r.section === 'store' && r.v1Key === M)!;
    expect(malvar).toMatchObject({ ticked: false, v2Key: 'MLVR' });
    expect(rows.some((r) => r.section === 'store' && (r.v1Key === PADRE || r.v1Key === TEST_STORE))).toBe(false);
  });
});

describe('F. snapshot file rules on the droplet side (R3, invariant 28)', () => {
  const prep = (text = '{"version":1}') => {
    const dir = tmp();
    const p = join(dir, 'v1-dual-run-2026-10-19-2026-10-25.json');
    writeFileSync(p, text);
    writeFileSync(join(dir, 'v1-dual-run-2026-10-19-2026-10-25.sha256'), `${sha256(text)}  v1-dual-run-2026-10-19-2026-10-25.json\n`);
    return p;
  };
  const good = { mode: 0o600, uid: 1001 };

  it('F1: a good file (mode 600, own uid, sha matches) loads and returns the sha. Red today: module missing', async () => {
    const m = await mod();
    const p = prep();
    const r = m.loadSnapshotFile(p, { stat: () => good, currentUid: 1001 });
    expect(r.sha).toBe(sha256('{"version":1}'));
    expect(r.snapshot.version).toBe(1);
  });

  it('F2: a sha mismatch (file edited after extract) and a missing .sha256 are refused. Mutant: sha not checked. Red today: module missing', async () => {
    const m = await mod();
    const p = prep();
    writeFileSync(p, '{"version":1,"tampered":true}');
    expect(() => m.loadSnapshotFile(p, { stat: () => good, currentUid: 1001 })).toThrow(/sha/i);
    const q = prep();
    rmSync(q.replace(/\.json$/, '.sha256'));
    expect(() => m.loadSnapshotFile(q, { stat: () => good, currentUid: 1001 })).toThrow(/sha/i);
  });

  it('F3: a mode wider than 600 (644, 660, 640) is refused. Mutant: mode unchecked. Red today: module missing', async () => {
    const m = await mod();
    for (const mode of [0o644, 0o660, 0o640, 0o604]) {
      expect(() => m.loadSnapshotFile(prep(), { stat: () => ({ mode, uid: 1001 }), currentUid: 1001 }), mode.toString(8)).toThrow(/mode|permission/i);
    }
  });

  it('F4: another owner is refused. Mutant: owner unchecked. Red today: module missing', async () => {
    const m = await mod();
    expect(() => m.loadSnapshotFile(prep(), { stat: () => ({ mode: 0o600, uid: 0 }), currentUid: 1001 })).toThrow(/owner/i);
  });

  it('F5: removeSnapshotFile deletes the json. Red today: module missing', async () => {
    const m = await mod();
    const p = prep();
    m.removeSnapshotFile(p);
    expect(existsSync(p)).toBe(false);
  });
});

describe('P. file modes and a crashed or truncated extract (audit ruling f)', () => {
  it.skipIf(process.platform === 'win32')('P1: extract writes the json, the sha256 and the keys csv with mode 0600 (POSIX). Mutant: default umask. No injectable fs seam exists, so this reads the real modes', async () => {
    const { result } = await extract(data());
    for (const p of [result.snapshotPath, result.shaPath, result.keysPath]) expect(statSync(p).mode & 0o777, p).toBe(0o600);
  });

  const prep2 = (jsonText: string, shaOf: string) => {
    const dir = tmp();
    const p = join(dir, 'v1-dual-run-2026-10-19-2026-10-25.json');
    writeFileSync(p, jsonText);
    writeFileSync(join(dir, 'v1-dual-run-2026-10-19-2026-10-25.sha256'), `${sha256(shaOf)}  x.json\n`);
    return p;
  };
  const stat = { stat: () => ({ mode: 0o600, uid: 7 }), currentUid: 7 };
  const full = JSON.stringify({ version: 1, journal: [{ id: 'a' }, { id: 'b' }] });

  it('P2: a truncated json whose sidecar still holds the sha of the full file (a crash mid-write) is refused on the sha. Red today: module missing', async () => {
    const m = await mod();
    expect(() => m.loadSnapshotFile(prep2(full.slice(0, 30), full), stat)).toThrow(/sha/i);
  });

  it('P3: a stale sidecar (the sha of the PREVIOUS extract) beside a complete new json is refused. Red today: module missing', async () => {
    const m = await mod();
    expect(() => m.loadSnapshotFile(prep2(full, JSON.stringify({ version: 1, journal: [] })), stat)).toThrow(/sha/i);
  });

  it('P4: a truncated json whose sidecar was computed over the truncated bytes (sha ok, JSON broken) is still refused, with an error that names the snapshot rather than a bare SyntaxError. Red if JSON.parse leaks', async () => {
    const m = await mod();
    const cut = full.slice(0, 30);
    expect(() => m.loadSnapshotFile(prep2(cut, cut), stat)).toThrow(/snapshot|json|truncated/i);
  });
});

describe('K2. the keys sheet and staff cash (S4 tender keys ruling, k)', () => {
  it('K2: the pre-fill has NO cash__staff row even when the snapshot carries staff cash legs. Mutant: staff row pre-filled', async () => {
    const journal = [
      ...lipaJournal(),
      { id: 'jcs', data: { businessDate: '2026-10-22', sourceType: 'expense_payment', sourceId: 'e7', legKey: 'k7', accountId: 'cash__staff', direction: 'in', amount: 40, status: 'posted' } },
    ];
    const { result } = await extract(data({}, journal));
    const rows = parseKeysCsv(readFileSync(result.keysPath, 'utf8'));
    expect(rows.some((r) => r.v1Key === 'cash__staff')).toBe(false);
    expect(rows.some((r) => r.v1Key === 'cash__cashier')).toBe(true);
  });
});

describe('U. usage errors that must not be swallowed (audit ruling g)', () => {
  const tsx = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const run = (args: string[]) =>
    spawnSync(process.execPath, [tsx, join(ROOT, 'scripts', 'dual-run.ts'), ...args], {
      cwd: ROOT, encoding: 'utf8', timeout: 90_000, env: { ...process.env, NODE_ENV: 'development' },
    });
  it('U1: `compare ... --stores --apply` and a trailing `--stores` are usage errors naming --stores (exit 1); `extract ... --stores` with no value too, before any credential is read or the disk touched. Red if the flag takes the next flag as its value', () => {
    const uuid = '00000000-0000-4000-8000-000000000001';
    const base = ['compare', '--snapshot', join(tmp(), 'nope.json'), '--keys', join(tmp(), 'k.csv'), '--org', uuid, '--actor', uuid];
    for (const tail of [['--stores', '--apply'], ['--apply', '--stores']]) {
      const r = run([...base, ...tail]);
      expect(r.status, tail.join(' ')).toBe(1);
      expect(`${r.stdout}${r.stderr}`, tail.join(' ')).toMatch(/usage/i);
      expect(`${r.stdout}${r.stderr}`, tail.join(' ')).toMatch(/--stores/);
    }
    const dir = join(tmp(), 'out');
    const e = run(['extract', '--from', '2026-10-19', '--through', '2026-10-25', '--out', dir, '--stores']);
    expect(e.status).toBe(1);
    expect(`${e.stdout}${e.stderr}`).toMatch(/usage/i);
    expect(existsSync(dir)).toBe(false);
  }, 120_000);
});

describe('C. the command line (Contract section 1, invariants 28-29)', () => {
  const tsx = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const run = (args: string[], extraEnv: Record<string, string> = {}) =>
    spawnSync(process.execPath, [tsx, join(ROOT, 'scripts', 'dual-run.ts'), ...args], {
      cwd: ROOT, encoding: 'utf8', timeout: 90_000, env: { ...process.env, ...extraEnv },
    });

  it('C1: package.json has the dual-run script. Red today: no script', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts['dual-run']).toMatch(/scripts[\\/]dual-run\.ts/);
  });

  it('C2: `classify` (and any unknown subcommand) is a usage error: exit 1, "usage" printed, nothing written. Mutant: a classify subcommand. Red today: scripts/dual-run.ts missing', () => {
    for (const sub of ['classify', 'dispose', 'foo']) {
      const dir = tmp();
      const r = run([sub, '--out', dir, '--ref', 'DEF-1', '--class', 'V2_DEFECT']);
      expect(r.status, sub).toBe(1);
      expect(`${r.stdout}${r.stderr}`, sub).toMatch(/usage/i);
      expect(readdirSync(dir), sub).toEqual([]);
    }
  }, 120_000);

  it('C3: `extract` under NODE_ENV=production exits 1 naming production, before touching Firestore or the disk. Red today: scripts/dual-run.ts missing', () => {
    const dir = join(tmp(), 'out');
    const r = run(['extract', '--from', '2026-10-19', '--through', '2026-10-25', '--out', dir], { NODE_ENV: 'production' });
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toMatch(/production/i);
    expect(existsSync(dir)).toBe(false);
  }, 120_000);

  it('C4: import graph - no dual-run script and no run module imports or names a disposition writer. Mutant: the CLI reaches insertDisposition. Red today: files missing', () => {
    const files = ['scripts/dual-run.ts', 'scripts/lib/dual-run-extract.ts', 'packages/domain/src/dual-run/index.ts'];
    for (const f of files) {
      const text = readFileSync(join(ROOT, f), 'utf8');
      expect(text, f).not.toMatch(/insertDisposition|recordDisposition|from\s+['"][^'"]*dispositions['"]/);
    }
    const cli = readFileSync(join(ROOT, 'scripts/dual-run.ts'), 'utf8');
    expect(cli).not.toMatch(/['"]classify['"]/);
  });
});
