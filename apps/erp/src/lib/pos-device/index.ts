/**
 * T-530a — the POS v2 **device store** public surface.
 *
 * Everything the tablet needs to keep selling without a connection: the outbox that queues till
 * actions, the snapshot that lets it sell from the last good menu, the counter that numbers receipts,
 * the opaque verifier records, and a small keyed scratchpad. No React, no network, no money rules.
 */
export type {
  CachedSnapshot,
  DrainReport,
  NewPosEvent,
  PosEvent,
  PosEventKind,
  PosEventResult,
  PosEventResultStatus,
  SendOutcome,
  StoredVerifier,
} from './types';

export { DB_NAME, DB_VERSION, openDeviceDb } from './db';

export {
  MAX_BATCH_SIZE,
  applyResults,
  countPending,
  drain,
  enqueue,
  listPending,
  reserveTerminalSeq,
  resumeAbove,
} from './outbox';

export { isSnapshotUsable, readSnapshot, saveSnapshot, touchSnapshot } from './snapshot-cache';

export { deleteVerifier, getVerifierByEmployeeId, listVerifiers, putVerifier } from './verifier-store';

export { getMeta, setMeta } from './meta';
