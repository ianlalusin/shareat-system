/**
 * getArAgingReport — the service layer over `arRepo.aging`/`arRepo.orgAgingTotal`. Mirrors
 * `ap-aging.ts` pointed the other way (customers, not suppliers). See that file's top comment
 * for the shared reasoning. docs/tasks/209-reporting-read-model-and-statements.md (T-209b).
 */
import { arRepo, type Tx } from '@shareat/db';
import { add, equals, money, type Money } from '@shareat/core/money';

export interface ArAgingInput {
  orgId: string;
  storeId?: string | null;
  asOfDate: string;
}

export interface ArAgingRow {
  customerId: string;
  storeId: string;
  current: Money;
  d1to30: Money;
  d31to60: Money;
  d61to90: Money;
  d90plus: Money;
  total: Money;
}

export interface ArAgingTotals {
  current: Money;
  d1to30: Money;
  d31to60: Money;
  d61to90: Money;
  d90plus: Money;
  total: Money;
}

export interface ArAgingBasis {
  orgId: string;
  storeId: string | null;
  asOfDate: string;
}

/** T-507 - one delivery platform (a sales channel on its receivable account) and what it still owes. */
export interface PlatformAgingRow extends ArAgingTotals {
  channelId: string;
  channelName: string;
  storeId: string;
  receivableAccountCode: string;
}

export interface PlatformAgingSection {
  rows: PlatformAgingRow[];
  totals: ArAgingTotals;
  controlBalance: Money;
  reconciles: boolean;
  /** Days not yet verified that carry a platform amount: sales that are not receivables yet. */
  waitingForVerification: number;
}

export interface ArAgingResult {
  platform: PlatformAgingSection;
  rows: ArAgingRow[];
  totals: ArAgingTotals;
  controlBalance: Money;
  /** `totals.total === controlBalance`, to the centavo — no tolerance. */
  reconciles: boolean;
  basis: ArAgingBasis;
}

export async function getArAgingReport(tx: Tx, input: ArAgingInput): Promise<ArAgingResult> {
  const storeId = input.storeId ?? null;

  const [buckets, controlBalanceStr, platformBuckets, platformControlStr, waiting] = await Promise.all([
    arRepo.aging(tx, input.orgId, input.asOfDate, storeId ?? undefined),
    arRepo.orgAgingTotal(tx, input.orgId, storeId ?? undefined),
    arRepo.platformAging(tx, input.orgId, input.asOfDate, storeId ?? undefined),
    arRepo.platformControlBalance(tx, input.orgId, storeId ?? undefined),
    arRepo.daysWaitingForVerification(tx, input.orgId, storeId ?? undefined),
  ]);

  const platformRows: PlatformAgingRow[] = platformBuckets.map((b) => {
    const current = money(b.current);
    const d1to30 = money(b.d1to30);
    const d31to60 = money(b.d31to60);
    const d61to90 = money(b.d61to90);
    const d90plus = money(b.d90plus);
    return {
      channelId: b.channelId,
      channelName: b.channelName,
      storeId: b.storeId,
      receivableAccountCode: b.receivableAccountCode,
      current,
      d1to30,
      d31to60,
      d61to90,
      d90plus,
      total: add(current, d1to30, d31to60, d61to90, d90plus),
    };
  });
  const platformTotals: ArAgingTotals = {
    current: add(...platformRows.map((r) => r.current)),
    d1to30: add(...platformRows.map((r) => r.d1to30)),
    d31to60: add(...platformRows.map((r) => r.d31to60)),
    d61to90: add(...platformRows.map((r) => r.d61to90)),
    d90plus: add(...platformRows.map((r) => r.d90plus)),
    total: add(...platformRows.map((r) => r.total)),
  };
  const platformControl = money(platformControlStr);

  const rows: ArAgingRow[] = buckets.map((b) => {
    const current = money(b.current);
    const d1to30 = money(b.d1to30);
    const d31to60 = money(b.d31to60);
    const d61to90 = money(b.d61to90);
    const d90plus = money(b.d90plus);
    return {
      customerId: b.customerId,
      storeId: b.storeId,
      current,
      d1to30,
      d31to60,
      d61to90,
      d90plus,
      total: add(current, d1to30, d31to60, d61to90, d90plus),
    };
  });

  const totals: ArAgingTotals = {
    current: add(...rows.map((r) => r.current)),
    d1to30: add(...rows.map((r) => r.d1to30)),
    d31to60: add(...rows.map((r) => r.d31to60)),
    d61to90: add(...rows.map((r) => r.d61to90)),
    d90plus: add(...rows.map((r) => r.d90plus)),
    total: add(...rows.map((r) => r.total)),
  };

  const controlBalance = money(controlBalanceStr);

  return {
    platform: {
      rows: platformRows,
      totals: platformTotals,
      controlBalance: platformControl,
      reconciles: equals(platformTotals.total, platformControl),
      waitingForVerification: waiting,
    },
    rows,
    totals,
    controlBalance,
    reconciles: equals(totals.total, controlBalance),
    basis: { orgId: input.orgId, storeId, asOfDate: input.asOfDate },
  };
}
