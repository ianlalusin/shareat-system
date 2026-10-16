/**
 * T-423 slice T - claiming and releasing a terminal number. Ruling 6, Acceptance 7, 12, 13 (claim half).
 *
 * CONTRACT for the builder (S2) - file `apps/pos/src/lib/terminal/claim.ts`. Firestore is reached ONLY through an injected port, so the
 * module imports nothing from `firebase/firestore` at runtime (types only) and tests drive it with `createFakeFirestore().port`.
 *   type FirestorePort = { db; doc; collection; getDoc; getDocs; query; where; orderBy; limit; documentId; runTransaction; serverTimestamp }
 *       (the same-named functions of the modular `firebase/firestore` API, `db` being the Firestore instance)
 *   claimTerminal(port, { storeId, storeCode, terminalNo, deviceId, uid }): Promise<{ terminalNo: number; nextSeq: number }>
 *   releaseTerminal(port, { storeId, terminalNo, uid }): Promise<void>
 *   checkTerminalHolder(port, { storeId, terminalNo, deviceId }): Promise<'mine' | 'other' | 'unclaimed'>
 * Firestore shapes (additive, nothing v1 reads):
 *   stores/{storeId}/terminals/{TT}     TT = two digits. Held:     { deviceId, claimedAt, claimedByUid, releaseEpoch }
 *                                       Released:                  { deviceId: null, releasedAt, releasedByUid, releaseEpoch: previous + 1 }
 *   stores/{storeId}/receiptNumbers/{CODE-TT-NNNNNN}   (written by payments, read here)
 * Behaviour:
 *   - validates BEFORE touching Firestore: terminalNo integer 1..99 and a non-empty normalised store code, else throws (nothing written).
 *   - a terminal doc held by ANOTHER deviceId => throws Error("Terminal 01 is already used by another tablet. Ask a manager to release it.")
 *     (TT zero padded); the same deviceId may re-claim (reinstall with the same browser profile). Decided inside runTransaction.
 *   - on success writes the doc and then `saveTerminalClaim({storeId, terminalNo, deviceId, nextSeq})` (counter.ts) to IndexedDB.
 *   - nextSeq = 1 + highest seq found by a document-id RANGE query on stores/{s}/receiptNumbers between `CODE-TT-000000` and
 *     `CODE-TT-999999`, orderBy documentId desc, limit 1 (0 when there is none). That query must run on a Firestore that refuses
 *     undeclared composite indexes (the fake does).
 *   - when the previous terminal doc carries a release (releaseEpoch >= 1 and deviceId null), nextSeq = highest seq + 1000 instead.
 *   - the FIRST claim of a prefix (no terminal doc yet) first queries stores/{s}/receipts where receiptNumber >= `CODE-TT-` and
 *     < `CODE-TT-`; any receipt found WITHOUT a numeric `terminalNo` means v1's free-text format already uses that prefix: throw
 *     an Error whose message contains the prefix (e.g. "SHT-01-").
 *   - releaseTerminal: only ever clears a doc (never deletes the receiptNumbers); safe on a terminal nobody holds.
 *   - checkTerminalHolder: 'unclaimed' when the doc is missing or deviceId is null.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeFirestore, type FakeFirestore } from '@/test-helpers/fakeFirestore';
import { createFakeIdb } from '@/test-helpers/fakeIdb';
import * as counter from '@/lib/terminal/counter';
import * as claim from '@/lib/terminal/claim';

let fs: FakeFirestore;
const S = 'store1';
const base = { storeId: S, storeCode: 'sht', uid: 'mgr1' };
const A = { ...base, terminalNo: 1, deviceId: 'DEV-A' };
const B = { ...base, terminalNo: 1, deviceId: 'DEV-B' };
const seedNumber = (n: string) => fs.seed(`stores/${S}/receiptNumbers/${n}`, { terminalNo: 1, terminalSeq: Number(n.slice(-6)) });

beforeEach(() => {
  fs = createFakeFirestore();
  vi.stubGlobal('indexedDB', createFakeIdb({ commitDelayMs: 5 }));
});
afterEach(() => vi.unstubAllGlobals());

describe('the fake enforces the index rule (harness check for Acceptance 12)', () => {
  it('refuses an equality + orderBy on two different fields, allows a document-id range, allows a one-field range', async () => {
    const coll = fs.collection(fs.db, 'stores', S, 'receiptNumbers');
    await expect(fs.getDocs(fs.query(coll, fs.where('terminalNo', '==', 1), fs.orderBy('terminalSeq', 'desc'), fs.limit(1)))).rejects.toThrow(/index/i);
    await expect(
      fs.getDocs(fs.query(coll, fs.where(fs.documentId(), '>=', 'A'), fs.where(fs.documentId(), '<=', 'B'), fs.orderBy(fs.documentId(), 'desc'), fs.limit(1))),
    ).resolves.toBeTruthy();
    const rc = fs.collection(fs.db, 'stores', S, 'receipts');
    await expect(fs.getDocs(fs.query(rc, fs.where('receiptNumber', '>=', 'A'), fs.where('receiptNumber', '<', 'B')))).resolves.toBeTruthy();
    fs.declareIndex(['terminalNo', 'terminalSeq']);
    await expect(fs.getDocs(fs.query(coll, fs.where('terminalNo', '==', 1), fs.orderBy('terminalSeq', 'desc')))).resolves.toBeTruthy();
  });
});

describe('claimTerminal', () => {
  it('a fresh claim starts at 1, writes the terminal doc, and stores the record in IndexedDB', async () => {
    const r = await claim.claimTerminal(fs.port, A);
    expect(r).toEqual({ terminalNo: 1, nextSeq: 1 });
    const doc = fs.get(`stores/${S}/terminals/01`);
    expect(doc).toMatchObject({ deviceId: 'DEV-A', claimedByUid: 'mgr1' });
    expect(doc?.claimedAt).toBeTruthy();
    expect(await counter.readTerminal()).toEqual({ storeId: S, terminalNo: 1, deviceId: 'DEV-A', nextSeq: 1 });
  });

  it('a terminal held by another device is refused with the plain message and nothing changes (Acceptance 7)', async () => {
    await claim.claimTerminal(fs.port, A);
    const before = fs.get(`stores/${S}/terminals/01`);
    await expect(claim.claimTerminal(fs.port, B)).rejects.toThrow('Terminal 01 is already used by another tablet. Ask a manager to release it.');
    expect(fs.get(`stores/${S}/terminals/01`)).toEqual(before);
  });

  it('two tablets claiming at the same instant: exactly one wins (kills: two tablets on one series)', async () => {
    const results = await Promise.allSettled([claim.claimTerminal(fs.port, A), claim.claimTerminal(fs.port, B)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });

  it('a different terminal number on the same store is independent', async () => {
    await claim.claimTerminal(fs.port, A);
    await expect(claim.claimTerminal(fs.port, { ...B, terminalNo: 2 })).resolves.toMatchObject({ terminalNo: 2, nextSeq: 1 });
  });

  it('a counter wiped and re-claimed by the same device resumes at max+1 of receiptNumbers, ignoring other terminals, prefixes and stores (Acceptance 5/12)', async () => {
    await claim.claimTerminal(fs.port, A);
    for (const n of ['SHT-01-000003', 'SHT-01-000012', 'SHT-01-000007']) seedNumber(n);
    seedNumber('SHT-02-000099'); // another terminal
    seedNumber('SHX-01-000500'); // another store code
    fs.seed('stores/other/receiptNumbers/SHT-01-000777', {}); // another store
    vi.stubGlobal('indexedDB', createFakeIdb({ commitDelayMs: 5 })); // reinstall: IndexedDB is gone, the device id survives
    const r = await claim.claimTerminal(fs.port, A);
    expect(r.nextSeq).toBe(13);
    expect((await counter.readTerminal())?.nextSeq).toBe(13);
  });

  it('the store code is normalised before it is used as a prefix', async () => {
    seedNumber('SHT1-01-000004');
    const r = await claim.claimTerminal(fs.port, { ...A, storeCode: ' sh-t1 ' });
    expect(r.nextSeq).toBe(5);
  });

  it('refuses an empty store code and a bad terminal number before touching Firestore', async () => {
    await expect(claim.claimTerminal(fs.port, { ...A, storeCode: '' })).rejects.toThrow();
    await expect(claim.claimTerminal(fs.port, { ...A, storeCode: '--' })).rejects.toThrow();
    await expect(claim.claimTerminal(fs.port, { ...A, terminalNo: 0 })).rejects.toThrow();
    await expect(claim.claimTerminal(fs.port, { ...A, terminalNo: 100 })).rejects.toThrow();
    await expect(claim.claimTerminal(fs.port, { ...A, terminalNo: 1.5 })).rejects.toThrow();
    expect(fs.commits).toHaveLength(0);
    expect(await counter.readTerminal()).toBeNull();
  });

  it("refuses a prefix v1's free-text format already uses: a receipt with that number but no terminalNo (Ruling 6)", async () => {
    fs.seed(`stores/${S}/receipts/r1`, { receiptNumber: 'SHT-01-000001', total: 100 });
    await expect(claim.claimTerminal(fs.port, A)).rejects.toThrow(/SHT-01-/);
    expect(fs.has(`stores/${S}/terminals/01`)).toBe(false);
    expect(await counter.readTerminal()).toBeNull();
  });

  it('accepts the prefix when its receipts carry terminalNo (they are ours), and ignores other prefixes', async () => {
    fs.seed(`stores/${S}/receipts/r1`, { receiptNumber: 'SHT-01-000001', terminalNo: 1, total: 100 });
    fs.seed(`stores/${S}/receipts/r2`, { receiptNumber: 'SELIP-000045', total: 100 });
    fs.seed(`stores/${S}/receipts/r3`, { receiptNumber: 'SHT-02-000001', total: 100 });
    await expect(claim.claimTerminal(fs.port, A)).resolves.toBeTruthy();
  });

  it('writes nothing to IndexedDB when the claim is refused', async () => {
    await claim.claimTerminal(fs.port, A);
    vi.stubGlobal('indexedDB', createFakeIdb({ commitDelayMs: 5 }));
    await expect(claim.claimTerminal(fs.port, B)).rejects.toThrow();
    expect(await counter.readTerminal()).toBeNull();
  });
});

describe('releaseTerminal and re-claim (Acceptance 7, 13)', () => {
  it('release clears the holder, writes releasedAt, bumps releaseEpoch, and keeps every receipt number', async () => {
    await claim.claimTerminal(fs.port, A);
    seedNumber('SHT-01-000004');
    await claim.releaseTerminal(fs.port, { storeId: S, terminalNo: 1, uid: 'mgr2' });
    const doc = fs.get(`stores/${S}/terminals/01`);
    expect(doc?.deviceId ?? null).toBeNull();
    expect(doc?.releasedAt).toBeTruthy();
    expect(doc?.releaseEpoch).toBe(1);
    expect(fs.has(`stores/${S}/receiptNumbers/SHT-01-000004`)).toBe(true);
  });

  it('after a release another tablet can claim, and starts at max + 1,000 (kills: number reuse from a released tablet\'s offline receipts)', async () => {
    await claim.claimTerminal(fs.port, A);
    seedNumber('SHT-01-000020');
    await claim.releaseTerminal(fs.port, { storeId: S, terminalNo: 1, uid: 'mgr2' });
    const r = await claim.claimTerminal(fs.port, B);
    expect(r.nextSeq).toBe(1020);
    expect(fs.get(`stores/${S}/terminals/01`)).toMatchObject({ deviceId: 'DEV-B' });
    expect((await counter.readTerminal())?.nextSeq).toBe(1020);
  });

  it('release of a terminal nobody holds does not throw', async () => {
    await expect(claim.releaseTerminal(fs.port, { storeId: S, terminalNo: 7, uid: 'mgr2' })).resolves.toBeUndefined();
  });
});

describe('checkTerminalHolder (a released tablet back online must stop taking payment)', () => {
  it("is 'unclaimed' before any claim and after a release, 'mine' for the holder, 'other' for everyone else", async () => {
    const q = { storeId: S, terminalNo: 1 };
    expect(await claim.checkTerminalHolder(fs.port, { ...q, deviceId: 'DEV-A' })).toBe('unclaimed');
    await claim.claimTerminal(fs.port, A);
    expect(await claim.checkTerminalHolder(fs.port, { ...q, deviceId: 'DEV-A' })).toBe('mine');
    expect(await claim.checkTerminalHolder(fs.port, { ...q, deviceId: 'DEV-B' })).toBe('other');
    await claim.releaseTerminal(fs.port, { ...q, uid: 'mgr' });
    expect(await claim.checkTerminalHolder(fs.port, { ...q, deviceId: 'DEV-A' })).toBe('unclaimed');
    await claim.claimTerminal(fs.port, B);
    expect(await claim.checkTerminalHolder(fs.port, { ...q, deviceId: 'DEV-A' })).toBe('other');
  });
});
