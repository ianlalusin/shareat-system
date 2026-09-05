/**
 * getStorePLComparison — T-209c. Calls `getIncomeStatement` once per store and assembles the
 * results side by side. No new repo function and no re-derived figure (phase-6 plan §2.1: a
 * dashboard tile or a comparison screen calls the SAME named query a statement does, never a
 * second definition of the same number).
 */
import type { Executor } from '@shareat/db';
import { getIncomeStatement, type IncomeStatementResult } from './income-statement';

export interface StorePLComparisonInput {
  orgId: string;
  storeIds: string[];
  fromDate: string;
  toDate: string;
  includeYearClose?: boolean;
}

export interface StorePLComparisonRow {
  storeId: string;
  statement: IncomeStatementResult;
}

export interface StorePLComparisonBasis {
  orgId: string;
  storeIds: string[];
  fromDate: string;
  toDate: string;
  includeYearClose: boolean;
}

export interface StorePLComparisonResult {
  stores: StorePLComparisonRow[];
  basis: StorePLComparisonBasis;
}

export async function getStorePLComparison(ex: Executor, input: StorePLComparisonInput): Promise<StorePLComparisonResult> {
  const includeYearClose = input.includeYearClose ?? false;

  const statements = await Promise.all(
    input.storeIds.map((storeId) =>
      getIncomeStatement(ex, { orgId: input.orgId, storeId, fromDate: input.fromDate, toDate: input.toDate, includeYearClose }),
    ),
  );

  const stores: StorePLComparisonRow[] = input.storeIds.map((storeId, i) => ({ storeId, statement: statements[i]! }));

  return {
    stores,
    basis: { orgId: input.orgId, storeIds: input.storeIds, fromDate: input.fromDate, toDate: input.toDate, includeYearClose },
  };
}
