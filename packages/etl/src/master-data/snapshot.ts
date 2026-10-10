/**
 * T-391 S2 - `extract`: read v1 (Firestore) on Ian's machine, write the snapshot the rest of the load runs from.
 *
 * - The v1 client is READ-ONLY by construction: `makeReadOnlyV1Client` exposes `collection(path).get()` and nothing
 *   else, so no write call can be written against it (R1, test 15a). This module imports no Firebase SDK and holds no
 *   credential; the command line builds the Firestore and hands it in.
 * - The snapshot is a whitelist (R10). No pay rate, birthday, address, email, photo, signature, statutory id, balance,
 *   cost. A bank account number is kept MASKED (last four digits) - nothing droplet-bound holds a full number (test 27).
 * - Pay rates go to `v1-staff-rates.local.csv`, which never leaves Ian's machine (R15).
 * - Under NODE_ENV=production it refuses before reading or writing anything (R1).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { PADRE_GARCIA_V1_STORE_ID } from './store-map';
import { toCsv } from './sheets';

export interface V1DocSnapshotLike {
  id: string;
  data(): Record<string, unknown>;
}
export interface V1FirestoreLike {
  collection(path: string): { get(): Promise<{ docs: V1DocSnapshotLike[] }> };
}
export interface ReadOnlyV1Client {
  collection(path: string): { get(): Promise<{ docs: V1DocSnapshotLike[] }> };
}

/** The one door to v1. `Object.keys(client)` is `['collection']` and `Object.keys(ref)` is `['get']`. */
export function makeReadOnlyV1Client(firestore: V1FirestoreLike): ReadOnlyV1Client {
  return {
    collection(path: string) {
      return {
        async get() {
          const snap = await firestore.collection(path).get();
          return { docs: snap.docs.map((d) => ({ id: d.id, data: () => d.data() })) };
        },
      };
    },
  };
}

/** docs/STORE-ROSTER.md: four own stores, Padre Garcia a franchise, two test stores excluded. */
const OWN_V1_STORE_IDS: ReadonlySet<string> = new Set([
  'b9DzsnPbr1BUnY88lyT4', // Lipa
  'dZUyvX4q824JBSVDAfE9', // Malvar
  'iGOW7q2pZbeHWV832UNh', // Banay-Banay
  'eVYKj6wABdakk8RgEotW', // Davao
]);

function roleOf(storeId: string): 'own' | 'franchise' | 'exclude' {
  if (storeId === PADRE_GARCIA_V1_STORE_ID) return 'franchise';
  if (OWN_V1_STORE_IDS.has(storeId)) return 'own';
  return 'exclude'; // the two test stores, and any store not in the roster: Ian opts it in on stores.csv
}

type Rec = Record<string, unknown>;

/** A Firestore Timestamp (or its serialised form) becomes an ISO string; anything else passes through. */
function plain(v: unknown): unknown {
  if (v && typeof v === 'object') {
    const o = v as { toDate?: () => Date; _seconds?: number; seconds?: number };
    if (typeof o.toDate === 'function') return o.toDate().toISOString();
    const s = o._seconds ?? o.seconds;
    if (typeof s === 'number') return new Date(s * 1000).toISOString();
  }
  return v;
}

function pick(d: Rec, fields: readonly string[], into: Rec): Rec {
  for (const f of fields) if (d[f] !== undefined) into[f] = plain(d[f]);
  return into;
}

/** Never more than the last four digits; a number of fewer than eight digits is masked entirely. */
export const maskAccount = (n: unknown): string | undefined => {
  const digits = String(n ?? '').replace(/\D/g, '');
  if (!digits) return undefined;
  if (digits.length < 8) return '****';
  return `${'*'.repeat(digits.length - 4)}${digits.slice(-4)}`;
};

/** Only a contact's name and phone travel; nothing nested passes through. */
function contactList(v: unknown): Rec[] | undefined {
  const list = Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : undefined;
  if (!list) return undefined;
  const out: Rec[] = [];
  for (const c of list as Rec[]) {
    if (!c || typeof c !== 'object') continue;
    const o: Rec = {};
    if (typeof c.name === 'string') o.name = c.name;
    if (typeof c.phone === 'string' || typeof c.phone === 'number') o.phone = String(c.phone);
    if (Object.keys(o).length) out.push(o);
  }
  return out;
}

function firstBank(d: Rec): Rec | undefined {
  const list = d.bankAccounts;
  const b = (Array.isArray(list) ? list[0] : undefined) as Rec | undefined;
  if (!b) return undefined;
  const out: Rec = {};
  if (b.bankName !== undefined) out.bankName = b.bankName;
  if (b.accountName !== undefined) out.accountName = b.accountName;
  const masked = maskAccount(b.accountNumber);
  if (masked) out.accountNumberMasked = masked;
  return out;
}

const supplierRecord = (id: string, store: string, d: Rec): Rec => {
  const out = pick(
    d,
    ['businessName', 'classification', 'address', 'email', 'representative', 'vatStatus',
      'issuesOfficialReceipt', 'lastCreditDueDays', 'isActive', 'linkedStoreId', 'updatedAt'],
    { id, store },
  );
  if (d.vatRegistrationNo !== undefined) out.tin = d.vatRegistrationNo;
  const contacts = contactList(d.contacts);
  if (contacts) out.contacts = contacts;
  const bank = firstBank(d);
  if (bank) out.bankAccount = bank;
  return out;
};

const ITEM_FIELDS = ['name', 'kind', 'baseUnit', 'purchaseUnit', 'conversionFactor'] as const;
const AR_FIELDS = ['name', 'address', 'contactNo', 'classification', 'status', 'linkedStoreId', 'updatedAt'] as const;
const STAFF_FIELDS = ['staffCode', 'fullName', 'positions', 'employmentStatus', 'dateHired', 'isActive'] as const;

export interface RunExtractResult {
  storeCount: number;
}

const byStoreThenId = (a: Rec, b: Rec): number =>
  String(a.store).localeCompare(String(b.store)) || String(a.id).localeCompare(String(b.id));

export async function runExtract(
  client: ReadOnlyV1Client,
  opts: { outDir: string; ratesDir: string; env: Record<string, string | undefined> },
): Promise<RunExtractResult> {
  if (opts.env.NODE_ENV === 'production') {
    throw new Error('extract refuses to run under NODE_ENV=production: production holds no v1 credentials (R1). Run it on the owner machine.');
  }

  const outAbs = resolve(opts.outDir).toLowerCase();
  const ratesAbs = resolve(opts.ratesDir).toLowerCase();
  if (ratesAbs === outAbs || ratesAbs.startsWith(outAbs + sep)) {
    throw new Error('The pay-rates directory must be separate from --out (the snapshot directory is copied to the droplet).');
  }

  const stores = (await client.collection('stores').get()).docs.map((d) => ({ id: d.id, name: String(d.data().name ?? d.id) }));
  const items: Rec[] = [];
  const suppliers: Rec[] = [];
  const arCustomers: Rec[] = [];
  const staff: Rec[] = [];
  const rates: Array<Record<string, string>> = [];
  const cell = (v: unknown): string => (v === undefined || v === null ? '' : String(plain(v)));

  for (const s of stores) {
    for (const d of (await client.collection(`stores/${s.id}/items`).get()).docs) {
      items.push(pick(d.data(), ITEM_FIELDS, { id: d.id, store: s.id }));
    }
    for (const d of (await client.collection(`stores/${s.id}/suppliers`).get()).docs) {
      suppliers.push(supplierRecord(d.id, s.id, d.data()));
    }
    for (const d of (await client.collection(`stores/${s.id}/arCustomers`).get()).docs) {
      arCustomers.push(pick(d.data(), AR_FIELDS, { id: d.id, store: s.id }));
    }
    for (const d of (await client.collection(`stores/${s.id}/staff`).get()).docs) {
      const x = d.data();
      staff.push(pick(x, STAFF_FIELDS, { id: d.id, store: s.id }));
      rates.push({
        v1_store_id: s.id,
        v1_staff_id: d.id,
        staff_code: cell(x.staffCode),
        full_name: cell(x.fullName),
        pay_type: cell(x.payType),
        daily_rate: cell(x.dailyRate),
        hourly_rate: cell(x.hourlyRate),
        monthly_rate: cell(x.monthlyRate),
        hourly_rate_effective_from: cell(x.hourlyRateEffectiveFrom),
      });
    }
  }

  const staffIdentities = (await client.collection('staffIdentities').get()).docs.map((d) => {
    const refs = d.data().staffRefs;
    return {
      id: d.id,
      staffRefs: (Array.isArray(refs) ? (refs as Rec[]) : []).map((r) => ({ storeId: r.storeId, staffId: r.staffId })),
    };
  });

  for (const l of [items, suppliers, arCustomers, staff]) l.sort(byStoreThenId);
  rates.sort((a, b) => a.v1_store_id!.localeCompare(b.v1_store_id!) || a.v1_staff_id!.localeCompare(b.v1_staff_id!));
  staffIdentities.sort((a, b) => a.id.localeCompare(b.id));

  const snapshot = {
    version: 1,
    stores: stores.map((s) => ({ id: s.id, name: s.name })),
    items,
    suppliers,
    arCustomers,
    staff,
    staffIdentities,
  };
  const snapshotText = JSON.stringify(snapshot, null, 1) + '\n';
  const sha = createHash('sha256').update(snapshotText).digest('hex');

  const storesCsv = toCsv(
    ['v1_store_id', 'name', 'role', 'org_code', 'store_code'],
    stores.map((s) => ({ v1_store_id: s.id, name: s.name, role: roleOf(s.id), org_code: '', store_code: '' })),
  );
  const ratesCsv = toCsv(
    ['v1_store_id', 'v1_staff_id', 'staff_code', 'full_name', 'pay_type', 'daily_rate', 'hourly_rate', 'monthly_rate', 'hourly_rate_effective_from'],
    rates,
  );

  mkdirSync(opts.outDir, { recursive: true });
  const put = (name: string, text: string) => writeFileSync(join(opts.outDir, name), text, { mode: 0o600 });
  put('v1-snapshot.json', snapshotText);
  put('v1-snapshot.sha256', `${sha}  v1-snapshot.json\n`);
  put('stores.csv', storesCsv);
  mkdirSync(opts.ratesDir, { recursive: true });
  writeFileSync(join(opts.ratesDir, 'v1-staff-rates.local.csv'), ratesCsv, { mode: 0o600 });
  return { storeCount: stores.length };
}

/** The service account key as it sits in .env.local: JSON, or base64 of JSON. A bad value prints a fixed message. */
export function parseServiceAccountKey(raw: string): Record<string, unknown> {
  const fail = (): never => {
    throw new Error('The v1 service account key could not be read (expected JSON, or base64 of JSON).');
  };
  for (const text of [raw, undefined]) {
    try {
      const parsed: unknown = JSON.parse(text ?? Buffer.from(raw, 'base64').toString('utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      /* try the next encoding */
    }
  }
  return fail();
}

/** `run` reads the snapshot only after its hash matches the .sha256 written beside it. Returns the hash. */
export function verifySnapshotSha(snapshotPath: string): string {
  const shaPath = join(dirname(snapshotPath), 'v1-snapshot.sha256');
  if (!existsSync(shaPath)) throw new Error(`${shaPath} is missing: the snapshot cannot be verified. Refused.`);
  const expected = readFileSync(shaPath, 'utf8').trim().split(/\s+/)[0]!.toLowerCase();
  const actual = createHash('sha256').update(readFileSync(snapshotPath)).digest('hex');
  if (actual !== expected) throw new Error(`The snapshot does not match its sha256 (expected ${expected}, found ${actual}). Refused.`);
  return actual;
}
