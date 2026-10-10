/**
 * T-391 S2 (TESTER) - `extract`: the read-only v1 client, the snapshot whitelist (R10), what leaves Ian's
 * machine (R15, test 15a, test 27), the production refusal (R1), and the superseded import-items main.
 *
 * CONTRACT these tests pin:
 *   snapshot.ts  makeReadOnlyV1Client(firestoreLike) -> { collection(path) -> { get() } } and NOTHING else
 *                runExtract(client, { outDir, env }) -> Promise<{ storeCount }>; writes exactly
 *                  v1-snapshot.json, v1-snapshot.sha256 (sha256 of the snapshot file, hex first),
 *                  v1-staff-rates.local.csv, stores.csv (v1_store_id,name,role,org_code,store_code)
 *                rejects (message names "production", nothing written) when env.NODE_ENV === 'production'
 *   Snapshot records: { id, store, ...whitelisted fields } under items/suppliers/arCustomers/staff,
 *   staffIdentities: { id, staffRefs }, stores: { id, name }.
 *   scripts/master-data.ts: `extract` refuses under NODE_ENV=production; `npm run master-data` exists;
 *   scripts/import-items.ts main says it is superseded by `npm run master-data` and exits 1.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeReadOnlyV1Client, runExtract } from '../src/master-data/snapshot';
import { parseCsv } from '../src/master-data/sheets';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const ROOT = join(__dirname, '..', '..', '..');
const L = 'b9DzsnPbr1BUnY88lyT4';
const M = 'dZUyvX4q824JBSVDAfE9';
const B = 'iGOW7q2pZbeHWV832UNh';
const D = 'eVYKj6wABdakk8RgEotW';
const P = 'y1DMgfisuTHBF57cNL6i';
const T1 = 'XbkyEgZqunmj2wzhicNf';
const T2 = 'TEST';

const RATE = '613.37'; // a pay rate nobody would type by accident
const HOURLY = '76.67';
const SSS = '3412345678';
const SECRETS = ['PRIVATE_KEY_SENTINEL', 'sa-sentinel@sentinel-proj.iam.gserviceaccount.com'];

const DATA: Record<string, Array<{ id: string; data: Record<string, unknown> }>> = {
  stores: [
    [L, 'SharEat Lipa'], [M, 'SharEat Malvar'], [B, 'SharEat Banay-Banay'], [D, 'SharEat Davao'],
    [P, 'SharEat Padre Garcia'], [T1, 'TEST'], [T2, 'Test Commissary'],
  ].map(([id, name]) => ({ id: id!, data: { name, address: 'ADDRESS_SENTINEL' } })),
  [`stores/${L}/items`]: [
    {
      id: 'i1',
      data: {
        name: 'Pork Belly', kind: 'raw_material', baseUnit: 'kg', purchaseUnit: 'kg', conversionFactor: 1,
        currentCost: 'COST_SENTINEL', costBasisProductId: 'CBP_SENTINEL',
      },
    },
  ],
  [`stores/${L}/suppliers`]: [
    {
      id: 's1',
      data: {
        businessName: 'Acme Meats', classification: 'Corporate', vatStatus: 'VAT Reg', isActive: true,
        balance: 'BALANCE_SENTINEL', outstandingAp: 'AP_SENTINEL',
        bankAccounts: [{ bankName: 'BDO', accountNumber: '001122334455' }],
      },
    },
  ],
  [`stores/${L}/arCustomers`]: [
    { id: 'c1', data: { name: 'Corner Cafe', classification: 'corporate', status: 'active', arBalance: 'ARBAL_SENTINEL' } },
  ],
  [`stores/${L}/staff`]: [
    {
      id: 'st1',
      data: {
        staffCode: 'SE-001', fullName: 'Maria Santos', positions: ['Cashier'], employmentStatus: 'regular',
        dateHired: '2024-05-01', isActive: true,
        birthday: 'BIRTHDAY_SENTINEL', address: 'STAFFADDR_SENTINEL', email: 'maria@example.invalid',
        photoUrl: 'PHOTO_SENTINEL', signature: 'SIGNATURE_SENTINEL', sssNo: SSS,
        payType: 'daily', dailyRate: Number(RATE), hourlyRate: Number(HOURLY),
        hourlyRateEffectiveFrom: '2024-05-01',
      },
    },
  ],
  staffIdentities: [{ id: 'g1', data: { staffRefs: [{ storeId: L, staffId: 'st1' }], note: 'NOTE_SENTINEL' } }],
};

/** A Firestore-shaped fake. Any write call is recorded; `get` is the only legitimate one. */
function fakeFirestore() {
  const writes: string[] = [];
  const reads: string[] = [];
  const collection = (path: string) => ({
    get: async () => {
      reads.push(path);
      return { docs: (DATA[path] ?? []).map((d) => ({ id: d.id, data: () => d.data })) };
    },
    limit: () => {
      throw new Error('extract must not cap a listing (STORE-ROSTER rule)');
    },
    add: () => writes.push('add'),
    doc: () => ({
      set: () => writes.push('set'),
      update: () => writes.push('update'),
      delete: () => writes.push('delete'),
    }),
  });
  return {
    writes, reads,
    collection,
    batch: () => writes.push('batch'),
    runTransaction: () => writes.push('runTransaction'),
    set: () => writes.push('set'),
  };
}

const out = () => mkdtempSync(join(tmpdir(), 't391-extract-'));
/** Audit 8: the pay-rates file goes to a SEPARATE directory, never under --out. */
const ratesDirFor = (dir: string): string => `${dir}-rates`;
const env = { NODE_ENV: 'development', FIREBASE_SERVICE_ACCOUNT_KEY: JSON.stringify({ private_key: SECRETS[0], client_email: SECRETS[1] }) };
const allText = (dir: string): string =>
  [dir, ratesDirFor(dir)]
    .flatMap((d) => (existsSync(d) ? readdirSync(d).map((f) => join(d, f)) : []))
    .map((p) => readFileSync(p, 'utf8'))
    .join(String.fromCharCode(10));

describe('15a. the v1 client is read-only', () => {
  it('exposes `collection` and nothing that writes', () => {
    const c: Any = makeReadOnlyV1Client(fakeFirestore() as Any);
    expect(Object.keys(c)).toEqual(['collection']);
    for (const w of ['set', 'update', 'delete', 'add', 'batch', 'runTransaction', 'doc', 'bulkWriter', 'create']) {
      expect(c[w], w).toBeUndefined();
    }
    const ref: Any = c.collection('stores');
    expect(Object.keys(ref)).toEqual(['get']);
    for (const w of ['set', 'update', 'delete', 'add', 'doc', 'create']) expect(ref[w], w).toBeUndefined();
  });
  it('extract performs reads only (no write call reached the Firestore), and lists every store (no cap)', async () => {
    const fs = fakeFirestore();
    const dir = out();
    const r = await runExtract(makeReadOnlyV1Client(fs as Any), { outDir: dir, ratesDir: ratesDirFor(dir), env });
    expect(fs.writes).toEqual([]);
    expect(fs.reads).toContain('stores');
    expect(fs.reads).toContain(`stores/${L}/items`);
    expect(fs.reads).toContain('staffIdentities');
    expect(r.storeCount).toBe(7);
  });
});

describe('15a. the snapshot holds only the R10 fields', () => {
  it('staff: id, store, staffCode, fullName, positions, employmentStatus, dateHired, isActive - nothing else', async () => {
    const dir = out();
    await runExtract(makeReadOnlyV1Client(fakeFirestore() as Any), { outDir: dir, ratesDir: ratesDirFor(dir), env });
    const snap: Any = JSON.parse(readFileSync(join(dir, 'v1-snapshot.json'), 'utf8'));
    expect(snap.staff).toHaveLength(1);
    const allowed = new Set(['id', 'store', 'staffCode', 'fullName', 'positions', 'employmentStatus', 'dateHired', 'isActive']);
    for (const k of Object.keys(snap.staff[0])) expect(allowed.has(k), k).toBe(true);
    expect(snap.staff[0]).toMatchObject({ id: 'st1', store: L, staffCode: 'SE-001', fullName: 'Maria Santos', dateHired: '2024-05-01' });
    expect(snap.items[0]).toMatchObject({ id: 'i1', store: L, name: 'Pork Belly', kind: 'raw_material', baseUnit: 'kg' });
    const itemAllowed = new Set(['id', 'store', 'name', 'kind', 'baseUnit', 'purchaseUnit', 'conversionFactor']);
    for (const k of Object.keys(snap.items[0])) expect(itemAllowed.has(k), k).toBe(true);
    expect(snap.staffIdentities).toEqual([{ id: 'g1', staffRefs: [{ storeId: L, staffId: 'st1' }] }]);
    expect(snap.stores.map((s: Any) => s.id).sort()).toEqual([B, D, L, M, P, T1, T2].sort());
  });
  it('no pay rate, birthday, address, email, photo, signature, statutory id, balance or cost anywhere in the snapshot', async () => {
    const dir = out();
    await runExtract(makeReadOnlyV1Client(fakeFirestore() as Any), { outDir: dir, ratesDir: ratesDirFor(dir), env });
    const text = readFileSync(join(dir, 'v1-snapshot.json'), 'utf8');
    for (const s of [RATE, HOURLY, SSS, 'BIRTHDAY_SENTINEL', 'STAFFADDR_SENTINEL', 'maria@example.invalid', 'PHOTO_SENTINEL',
      'SIGNATURE_SENTINEL', 'BALANCE_SENTINEL', 'AP_SENTINEL', 'ARBAL_SENTINEL', 'COST_SENTINEL', 'CBP_SENTINEL',
      'NOTE_SENTINEL', 'ADDRESS_SENTINEL', 'payType', 'dailyRate', 'hourlyRate']) {
      expect(text, s).not.toContain(s);
    }
  });
});

describe('what extract writes, and what leaves the machine (R15, tests 15a and 27)', () => {
  it('writes exactly three files into --out and the rates file into its own directory; the sha file hashes the snapshot file', async () => {
    const dir = out();
    await runExtract(makeReadOnlyV1Client(fakeFirestore() as Any), { outDir: dir, ratesDir: ratesDirFor(dir), env });
    expect(readdirSync(dir).sort()).toEqual(['stores.csv', 'v1-snapshot.json', 'v1-snapshot.sha256']);
    expect(readdirSync(ratesDirFor(dir))).toEqual(['v1-staff-rates.local.csv']);
    const sha = readFileSync(join(dir, 'v1-snapshot.sha256'), 'utf8').trim().split(/\s+/)[0];
    expect(sha).toBe(createHash('sha256').update(readFileSync(join(dir, 'v1-snapshot.json'))).digest('hex'));
  });
  it('pay rates are in the local-only rates file and in no file that goes to the droplet', async () => {
    const dir = out();
    await runExtract(makeReadOnlyV1Client(fakeFirestore() as Any), { outDir: dir, ratesDir: ratesDirFor(dir), env });
    const rates = readFileSync(join(ratesDirFor(dir), 'v1-staff-rates.local.csv'), 'utf8');
    expect(rates).toContain(RATE);
    expect(rates).toContain(HOURLY);
    expect(rates).toContain('st1');
    for (const f of ['v1-snapshot.json', 'v1-snapshot.sha256', 'stores.csv']) {
      const t = readFileSync(join(dir, f), 'utf8');
      for (const s of [RATE, HOURLY, SSS]) expect(t, `${f} leaks ${s}`).not.toContain(s);
    }
    expect(rates).not.toContain(SSS); // statutory ids are not carried here either
  });
  it('test 27 bank leg: no full bank account number in any droplet-bound file; the snapshot keeps it masked (last 4)', async () => {
    const dir = out();
    await runExtract(makeReadOnlyV1Client(fakeFirestore() as Any), { outDir: dir, ratesDir: ratesDirFor(dir), env });
    for (const f of ['v1-snapshot.json', 'v1-snapshot.sha256', 'stores.csv']) {
      expect(readFileSync(join(dir, f), 'utf8'), f).not.toContain('001122334455');
    }
    const snap: Any = JSON.parse(readFileSync(join(dir, 'v1-snapshot.json'), 'utf8'));
    expect(JSON.stringify(snap.suppliers[0])).toContain('4455');
  });
  it('no output file contains the service-account key, private_key or client_email', async () => {
    const dir = out();
    await runExtract(makeReadOnlyV1Client(fakeFirestore() as Any), { outDir: dir, ratesDir: ratesDirFor(dir), env });
    const text = allText(dir);
    for (const s of [...SECRETS, 'private_key', 'client_email', 'FIREBASE_SERVICE_ACCOUNT_KEY']) {
      expect(text, s).not.toContain(s);
    }
  });
  it('stores.csv lists every v1 store with the STORE-ROSTER roles and blank org_code / store_code', async () => {
    const dir = out();
    await runExtract(makeReadOnlyV1Client(fakeFirestore() as Any), { outDir: dir, ratesDir: ratesDirFor(dir), env });
    const rows = parseCsv(readFileSync(join(dir, 'stores.csv'), 'utf8'));
    expect(rows).toHaveLength(7);
    const role = Object.fromEntries(rows.map((r) => [r.v1_store_id, r.role]));
    expect(role).toEqual({ [L]: 'own', [M]: 'own', [B]: 'own', [D]: 'own', [P]: 'franchise', [T1]: 'exclude', [T2]: 'exclude' });
    for (const r of rows) {
      expect(r.org_code).toBe('');
      expect(r.store_code).toBe('');
    }
    expect(rows.find((r) => r.v1_store_id === P)!.name).toBe('SharEat Padre Garcia');
  });
});

describe('R1. extract refuses under NODE_ENV=production', () => {
  it('runExtract rejects, names production, and writes nothing', async () => {
    const dir = out();
    const fs = fakeFirestore();
    await expect(
      runExtract(makeReadOnlyV1Client(fs as Any), { outDir: dir, ratesDir: ratesDirFor(dir), env: { ...env, NODE_ENV: 'production' } }),
    ).rejects.toThrow(/production/i);
    expect(readdirSync(dir)).toEqual([]);
    expect(fs.reads).toEqual([]);
  });
});

describe('the command line', () => {
  const tsx = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const run = (script: string, args: string[], extraEnv: Record<string, string>) =>
    spawnSync(process.execPath, [tsx, join(ROOT, 'scripts', script), ...args], {
      cwd: ROOT, encoding: 'utf8', timeout: 90_000, env: { ...process.env, ...extraEnv },
    });

  it('package.json has the master-data script', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts['master-data']).toMatch(/scripts[\\/]master-data\.ts/);
  });
  it('`extract` under NODE_ENV=production exits 1 before touching Firestore or the disk', () => {
    const dir = out();
    const r = run('master-data.ts', ['extract', '--out', dir], { NODE_ENV: 'production' });
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toMatch(/production/i);
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  }, 120_000);
  it('import-items main is superseded: says so, names `npm run master-data`, exits 1', () => {
    const r = run('import-items.ts', ['--org', '00000000-0000-0000-0000-000000000000'], {});
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toContain('npm run master-data');
  }, 120_000);
});
