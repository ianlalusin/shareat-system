/**
 * T-423 S2 - claiming and releasing a terminal number (Ruling 6).
 * Firestore is reached ONLY through an injected port (see `port.ts` for the real one), so this module imports nothing from
 * `firebase/firestore` at runtime and tests drive it with a fake.
 *
 * Shapes (additive, nothing v1 reads):
 *   stores/{storeId}/terminals/{TT}                    held:     { deviceId, claimedAt, claimedByUid, releaseEpoch }
 *                                                      released: { deviceId: null, releasedAt, releasedByUid, releaseEpoch }
 *   stores/{storeId}/receiptNumbers/{CODE-TT-NNNNNN}   written by payments, read here to find the highest number used.
 */
import { MAX_TERMINAL_SEQ, normalizeStoreCode, readTerminal, saveTerminalClaim } from '@/lib/terminal/counter';

/** The same-named functions of the modular `firebase/firestore` API, and the Firestore instance as `db`. */
export interface FirestorePort {
  db: unknown;
  doc: (...args: any[]) => any;
  collection: (...args: any[]) => any;
  getDoc: (ref: any) => Promise<any>;
  getDocs: (q: any) => Promise<any>;
  query: (...args: any[]) => any;
  where: (...args: any[]) => any;
  orderBy: (...args: any[]) => any;
  limit: (n: number) => any;
  documentId: () => any;
  runTransaction: <T>(db: any, fn: (tx: any) => Promise<T>) => Promise<T>;
  serverTimestamp: () => any;
}

/** After a release, the next holder starts this far above the highest number seen, so receipts a released tablet still holds offline cannot collide. */
export const RELEASE_GAP = 1000;

export const RF_CODE_MESSAGE = 'This store code cannot be used for receipt numbers; change the store code in ERP.';

const tt = (n: number) => String(n).padStart(2, '0');

function checkTerminalNo(terminalNo: number): void {
  if (!Number.isInteger(terminalNo) || terminalNo < 1 || terminalNo > 99) {
    throw new Error(`Terminal number must be a whole number from 1 to 99, got ${terminalNo}.`);
  }
}

/** Highest used sequence: at most 20 ascending range probes; no descending key scan or composite index. */
async function highestSeq(port: FirestorePort, storeId: string, code: string, terminalNo: number): Promise<number> {
  const prefix = `${code}-${tt(terminalNo)}-`;
  let lower = 0;
  let upper = MAX_TERMINAL_SEQ;
  while (lower < upper) {
    const mid = Math.ceil((lower + upper) / 2);
    const snap = await port.getDocs(
      port.query(
        port.collection(port.db, 'stores', storeId, 'receiptNumbers'),
        port.where(port.documentId(), '>=', `${prefix}${String(mid).padStart(6, '0')}`),
        port.where(port.documentId(), '<=', `${prefix}999999`),
        port.orderBy(port.documentId(), 'asc'),
        port.limit(1),
      ),
    );
    if (snap.docs.length > 0) lower = mid;
    else upper = mid - 1;
  }
  return lower;
}

export async function claimTerminal(
  port: FirestorePort,
  args: { storeId: string; storeCode: string; terminalNo: number; deviceId: string; uid: string },
): Promise<{ terminalNo: number; nextSeq: number }> {
  const { storeId, terminalNo, deviceId, uid } = args;
  checkTerminalNo(terminalNo);
  const code = normalizeStoreCode(args.storeCode);
  if (!code) throw new Error('This store has no code, so a terminal cannot be set up. Set the store code first.');
  // receipt-view.tsx treats any number starting "RF-" as a refund, so that store code can never be used.
  if (code === 'RF') throw new Error(RF_CODE_MESSAGE);
  const prefix = `${code}-${tt(terminalNo)}-`;
  const terminalRef = port.doc(port.db, 'stores', storeId, 'terminals', tt(terminalNo));

  // First claim of this prefix: v1's free-text receipt format must not already be producing the same numbers.
  const existing = await port.getDoc(terminalRef);
  if (!existing.exists()) {
    const upper = `${code}-${tt(terminalNo)}.`; // '.' sorts right after '-', so [prefix, upper) is every number starting with the prefix
    const clash = await port.getDocs(
      port.query(
        port.collection(port.db, 'stores', storeId, 'receipts'),
        port.where('receiptNumber', '>=', prefix),
        port.where('receiptNumber', '<', upper),
      ),
    );
    const foreign = clash.docs.find((d: any) => typeof d.data()?.terminalNo !== 'number');
    if (foreign) {
      throw new Error(
        `Receipt numbers starting with ${prefix} already exist from the old numbering (for example ${String(foreign.data()?.receiptNumber)}). Pick another terminal number.`,
      );
    }
  }

  // The terminal this tablet held before (if different): released in the same transaction, only if it still holds this device.
  const before = await readTerminal().catch(() => null);
  const oldNo = before && before.storeId === storeId && before.deviceId === deviceId && before.terminalNo !== terminalNo ? before.terminalNo : null;
  const oldRef = oldNo !== null ? port.doc(port.db, 'stores', storeId, 'terminals', tt(oldNo)) : null;

  const maxSeq = await highestSeq(port, storeId, code, terminalNo);

  const nextSeq = await port.runTransaction(port.db, async (tx: any) => {
    const snap = await tx.get(terminalRef);
    const oldSnap = oldRef ? await tx.get(oldRef) : null;
    const prev = snap.exists() ? (snap.data() as { deviceId?: string | null; releaseEpoch?: number }) : null;
    if (prev?.deviceId && prev.deviceId !== deviceId) {
      throw new Error(`Terminal ${tt(terminalNo)} is already used by another tablet. Ask a manager to release it.`);
    }
    const releaseEpoch = Number(prev?.releaseEpoch ?? 0);
    const afterRelease = !!prev && !prev.deviceId && releaseEpoch >= 1;
    if (oldRef && oldSnap?.exists() && oldSnap.data()?.deviceId === deviceId) {
      tx.set(oldRef, { deviceId: null, releasedAt: port.serverTimestamp(), releasedByUid: uid, releaseEpoch: Number(oldSnap.data()?.releaseEpoch ?? 0) + 1 });
    }
    tx.set(terminalRef, { deviceId, claimedAt: port.serverTimestamp(), claimedByUid: uid, releaseEpoch });
    return maxSeq + (afterRelease ? RELEASE_GAP : 1);
  });

  // A counter already on this tablet for the same terminal may be ahead of Firestore (numbers reserved offline, not yet synced): never go backwards.
  const local = await readTerminal().catch(() => null);
  const sameCounter = !!local && local.storeId === storeId && local.terminalNo === terminalNo && local.deviceId === deviceId;
  const finalSeq = sameCounter ? Math.max(nextSeq, local!.nextSeq) : nextSeq;

  await saveTerminalClaim({ storeId, terminalNo, deviceId, nextSeq: finalSeq });
  return { terminalNo, nextSeq: finalSeq };
}

/** Manager action: clears the holder. Never deletes receiptNumbers. Safe on a terminal nobody holds. */
export async function releaseTerminal(
  port: FirestorePort,
  args: { storeId: string; terminalNo: number; uid: string },
): Promise<void> {
  checkTerminalNo(args.terminalNo);
  const ref = port.doc(port.db, 'stores', args.storeId, 'terminals', tt(args.terminalNo));
  await port.runTransaction(port.db, async (tx: any) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) return;
    const prev = snap.data() as { deviceId?: string | null; releaseEpoch?: number };
    if (!prev.deviceId) return; // already released
    tx.set(ref, {
      deviceId: null,
      releasedAt: port.serverTimestamp(),
      releasedByUid: args.uid,
      releaseEpoch: Number(prev.releaseEpoch ?? 0) + 1,
    });
  });
}

/** Who holds the terminal now: this device, another one, or nobody. */
export async function checkTerminalHolder(
  port: FirestorePort,
  args: { storeId: string; terminalNo: number; deviceId: string },
): Promise<'mine' | 'other' | 'unclaimed'> {
  const snap = await port.getDoc(port.doc(port.db, 'stores', args.storeId, 'terminals', tt(args.terminalNo)));
  if (!snap.exists()) return 'unclaimed';
  const holder = (snap.data() as { deviceId?: string | null }).deviceId;
  if (!holder) return 'unclaimed';
  return holder === args.deviceId ? 'mine' : 'other';
}
