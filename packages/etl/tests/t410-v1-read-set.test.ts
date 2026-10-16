/**
 * T-410 S2 (R6) - the T-391 master-data snapshot reads EXACTLY the pinned v1 collections.
 *
 * v1 keeps two account records per worker (a local `users` record with a PIN, and a Firebase sign-in
 * user). The T-391 snapshot must never read them: a person comes from `staffIdentities` and the
 * store `staff` records, and a sign-in is never imported (bible row 322, one person one id).
 *
 * This pins the read set. Adding v1 `users` to the load fails here, so someone decides on purpose.
 * Reuses the fake-client shape of `t391-s2-extract.test.ts`; tests only, no production change.
 *
 * Mutant (temporary edit, reverted at once, shown red in the lane log): the fake records an extra `users` read.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { makeReadOnlyV1Client, runExtract } from '../src/master-data/snapshot';

/** The pinned read set, with each store id written as `*`. */
const PINNED_READS = [
  'staffIdentities',
  'stores',
  'stores/*/arCustomers',
  'stores/*/items',
  'stores/*/staff',
  'stores/*/suppliers',
];

type Doc = { id: string; data: Record<string, unknown> };

/** A v1-shaped fake. `users` holds two worker accounts so that reading it would be visible, not silent. */
const V1_DATA: Record<string, Doc[]> = {
  stores: [
    { id: 'L', data: { name: 'SharEat Lipa' } },
    { id: 'T1', data: { name: 'TEST' } },
  ],
  'stores/L/items': [{ id: 'i1', data: { name: 'Pork Belly', kind: 'raw_material' } }],
  'stores/L/suppliers': [{ id: 's1', data: { businessName: 'Acme Meats', isActive: true } }],
  'stores/L/arCustomers': [{ id: 'c1', data: { name: 'Corner Cafe', status: 'active' } }],
  'stores/L/staff': [{ id: 'st1', data: { fullName: 'Maria Santos', payType: 'daily', dailyRate: 613 } }],
  'stores/T1/items': [],
  'stores/T1/suppliers': [],
  'stores/T1/arCustomers': [],
  'stores/T1/staff': [],
  staffIdentities: [{ id: 'g1', data: { staffRefs: [{ storeId: 'L', staffId: 'st1' }] } }],
  users: [
    { id: 'u1', data: { accountId: 'A1', pin: 'PIN_SENTINEL' } },
    { id: 'u2', data: { accountId: 'A2', pin: 'PIN_SENTINEL_2' } },
  ],
};

function fakeV1(reads: string[]) {
  return {
    collection(path: string) {
      return {
        get: async () => {
          reads.push(path);
          return { docs: (V1_DATA[path] ?? []).map((d) => ({ id: d.id, data: () => d.data })) };
        },
      };
    },
  };
}

const outDirs: string[] = [];
afterAll(() => {
  for (const d of outDirs) {
    rmSync(d, { recursive: true, force: true });
    rmSync(`${d}-rates`, { recursive: true, force: true });
  }
});

describe('T-410 S2 - the T-391 master-data snapshot reads exactly the pinned v1 collections', () => {
  it('runExtract reads only the pinned collections (stores/*/ normalised), never v1 users', async () => {
    const reads: string[] = [];
    const dir = mkdtempSync(join(tmpdir(), 't410-read-set-'));
    outDirs.push(dir);
    await runExtract(makeReadOnlyV1Client(fakeV1(reads)), {
      outDir: dir,
      ratesDir: `${dir}-rates`,
      env: { NODE_ENV: 'development' },
    });

    const normalised = [...new Set(reads.map((p) => p.replace(/^stores\/[^/]+\//, 'stores/*/')))].sort();
    expect(normalised, 'the snapshot read set changed; a new v1 collection needs a decision (bible row 322)').toEqual(
      [...PINNED_READS].sort(),
    );
    expect(reads.some((p) => p === 'users' || p.endsWith('/users'))).toBe(false);
  });
});
