/**
 * T-392 S4 test fixture: a v1 `salesDays` document as it sits on the wire. The remitted-package field carries its real v1
 * name here, in the one place the glossary guard (tests/unit/glossary-trap-names.test.ts) lets a test name it: packages/etl.
 * v2 tests build their snapshot days through this builder and never write the field name themselves.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export function v1SalesDay(storeId: string, date: string, remitted: number, extra: Record<string, any> = {}): any {
  return { id: date, storeId, status: 'verified', dineInSales: remitted, onlineBreakdown: {}, creditSales: 0, otherPaymentSales: 0, ...extra };
}
