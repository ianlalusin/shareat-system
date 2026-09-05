/**
 * getApAgingReport — the service layer over `apRepo.aging`/`apRepo.orgAgingTotal`.
 * docs/tasks/209-reporting-read-model-and-statements.md (T-209b).
 *
 * ⚠️ Takes `Tx`, not `Executor` — unlike `getBalanceSheet`/`getIncomeStatement`, which only ever
 * touch `reportsRepo` (a view, `Executor`-typed), this calls `apRepo` directly, same as
 * `packages/domain/src/ap/index.ts` already does for every other AP figure.
 *
 * This file's only job: sum `apRepo.aging()`'s per-party buckets into totals, fetch the
 * independent control-account total from `apRepo.orgAgingTotal`, and assert they agree —
 * the exit-gate condition (phase-6 plan §9 item 2), rendered rather than only tested.
 */
import { apRepo, type Tx } from '@shareat/db';
import { add, equals, money, type Money } from '@shareat/core/money';

export interface ApAgingInput {
  orgId: string;
  /** Omit or pass null/undefined for "every store". */
  storeId?: string | null;
  asOfDate: string;
}

export interface ApAgingRow {
  supplierId: string;
  storeId: string;
  current: Money;
  d1to30: Money;
  d31to60: Money;
  d61to90: Money;
  d90plus: Money;
  total: Money;
}

export interface ApAgingTotals {
  current: Money;
  d1to30: Money;
  d31to60: Money;
  d61to90: Money;
  d90plus: Money;
  total: Money;
}

export interface ApAgingBasis {
  orgId: string;
  storeId: string | null;
  asOfDate: string;
}

export interface ApAgingResult {
  rows: ApAgingRow[];
  totals: ApAgingTotals;
  controlBalance: Money;
  /** `totals.total === controlBalance`, to the centavo — no tolerance. */
  reconciles: boolean;
  basis: ApAgingBasis;
}

export async function getApAgingReport(tx: Tx, input: ApAgingInput): Promise<ApAgingResult> {
  const storeId = input.storeId ?? null;

  const [buckets, controlBalanceStr] = await Promise.all([
    apRepo.aging(tx, input.orgId, input.asOfDate, storeId ?? undefined),
    apRepo.orgAgingTotal(tx, input.orgId, storeId ?? undefined),
  ]);

  const rows: ApAgingRow[] = buckets.map((b) => {
    const current = money(b.current);
    const d1to30 = money(b.d1to30);
    const d31to60 = money(b.d31to60);
    const d61to90 = money(b.d61to90);
    const d90plus = money(b.d90plus);
    return {
      supplierId: b.supplierId,
      storeId: b.storeId,
      current,
      d1to30,
      d31to60,
      d61to90,
      d90plus,
      total: add(current, d1to30, d31to60, d61to90, d90plus),
    };
  });

  const totals: ApAgingTotals = {
    current: add(...rows.map((r) => r.current)),
    d1to30: add(...rows.map((r) => r.d1to30)),
    d31to60: add(...rows.map((r) => r.d31to60)),
    d61to90: add(...rows.map((r) => r.d61to90)),
    d90plus: add(...rows.map((r) => r.d90plus)),
    total: add(...rows.map((r) => r.total)),
  };

  const controlBalance = money(controlBalanceStr);

  return {
    rows,
    totals,
    controlBalance,
    reconciles: equals(totals.total, controlBalance),
    basis: { orgId: input.orgId, storeId, asOfDate: input.asOfDate },
  };
}
