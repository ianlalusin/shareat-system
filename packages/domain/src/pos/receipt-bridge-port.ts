/**
 * receipt-bridge-port.ts - what the nightly receipt bridge needs from POS's Firebase (T-472 S2, Ruling 1).
 *
 * `packages/domain` has no `firebase-admin`: the bridge job reads receipts through THIS port, and the adapter that
 * implements it lives in `packages/etl-firestore` (`PosReceiptBridgeAdapter`, built on the read-only reader). Every
 * method here only READS. There is no write member to call, and `tests/unit/t472-s2-bridge-guards.test.ts` fails the
 * build if the job, this port or the adapter names a Firestore write.
 *
 * The receipts arrive already MAPPED (the adapter runs `mapPosReceipt`): money as exact `Money` strings with a
 * `moneyFlag` where POS's float was not a whole centavo, tenders already normalised, personal fields already stripped
 * from `raw`, and `docHash` over the fixed list of copied fields. The structural types below are the subset of the
 * mapper's output the job uses, so the mapper's own types stay in `etl-firestore` (which imports domain, not the reverse).
 */
import type { Money } from '@shareat/core/money';

export interface BridgeSourceHeader {
  readonly firestoreDocId: string;
  readonly kind: 'sale' | 'refund';
  readonly status: string | null;
  readonly createdAtClientMs: number | null;
  /** Manila calendar day (YYYY-MM-DD): client time first, server time as the fallback. Null when POS stamped neither. */
  readonly posCalendarDate: string | null;
  readonly receiptNumber: string | null;
  readonly terminalNo: number | null;
  readonly parentReceiptId: string | null;
  readonly total: Money | null;
  readonly discountsTotal: Money | null;
  /** ISO instant, when the receipt was voided. */
  readonly voidedAt: string | null;
  readonly moneyFlag: boolean;
  /** The document minus personal fields (the job scrubs again before writing). */
  readonly raw: Record<string, unknown>;
}

export interface BridgeSourceLine {
  readonly lineNo: number;
  readonly itemId: string | null;
  readonly itemName: string | null;
  readonly unitPrice: Money | null;
  readonly qtyOrdered: number | null;
  readonly voidedQty: number | null;
  readonly freeQty: number | null;
  readonly discountType: string | null;
  readonly discountFixed: Money | null;
  readonly discountPercent: number | null;
  readonly discountQty: number | null;
  readonly modifiersTotal: Money | null;
  readonly moneyFlag: boolean;
}

export interface BridgeSourceTender {
  /** The method name as POS wrote it. */
  readonly methodName: string;
  /** `normalizePosV1Alias(methodName)`. */
  readonly alias: string;
  readonly amount: Money;
  readonly moneyFlag: boolean;
}

export interface BridgeSourceReceipt {
  /** The Firestore document id. */
  readonly id: string;
  readonly header: BridgeSourceHeader;
  readonly lines: readonly BridgeSourceLine[];
  readonly tenders: readonly BridgeSourceTender[];
  /** sha256 hex over the copied fields only. */
  readonly docHash: string;
}

export interface BridgeDayCrossCheck {
  /** Aggregate count by client time. Drift information. */
  readonly byClientMs: number;
  /** Aggregate count by server `createdAt`. Drift information. */
  readonly byServerCreatedAt: number;
  readonly missingClientMs: number;
  /** Ids of the receipts with a server day but no usable client time: `listDay` never returns them. */
  readonly missingClientMsIds: readonly string[];
}

export type BridgeChangeField = 'voidedAt' | 'editedAt' | 'createdAt';

export interface PosReceiptBridgePort {
  /** Receipts of one store for one Manila day, by client time. */
  listDay(posStoreId: string, businessDate: string): AsyncIterable<BridgeSourceReceipt>;
  /** Receipts whose server `createdAt` is in the day but which have no usable client time (T-478 / DEF-775). */
  listMissingClientTime(posStoreId: string, businessDate: string): AsyncIterable<BridgeSourceReceipt>;
  crossCheckDay(posStoreId: string, businessDate: string): Promise<BridgeDayCrossCheck>;
  /** Receipts whose `voidedAt`, `editedAt` or server `createdAt` is after `since`. */
  listChangedSince(posStoreId: string, field: BridgeChangeField, since: Date): AsyncIterable<BridgeSourceReceipt>;
}
