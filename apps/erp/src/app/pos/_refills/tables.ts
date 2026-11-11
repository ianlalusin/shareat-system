/**
 * T-529 R2 - the stands the refill picker offers: OPEN DINE-IN tables that hold a PACKAGE (a refill belongs to a package), by stand number.
 * The rows are T-524 `listRefillableTables` (already package tables); `packageVariantBySession` lets a caller judge plain `listOpenStands` rows instead.
 */
export interface RefillTableSource {
  sessionId: string;
  standNumber: number | null;
  mode?: string;
  packageVariantId?: string | null;
  /** Every package variant the table holds (T-524 `listRefillableTables`). Absent: just `packageVariantId`. */
  packageVariantIds?: string[];
}
export interface RefillTable {
  sessionId: string;
  standNumber: number;
  label: string;
  packageVariantId: string;
  /** Present when the server listed every package on the table; the picker offers the meats of ALL of them. */
  packageVariantIds?: string[];
}

export function refillTables(rows: readonly RefillTableSource[], packageVariantBySession?: Readonly<Record<string, string | null | undefined>>): RefillTable[] {
  const out: RefillTable[] = [];
  for (const r of rows) {
    const packageVariantId = packageVariantBySession ? packageVariantBySession[r.sessionId] : r.packageVariantId;
    if (r.mode === 'take_out' || r.standNumber === null || !packageVariantId) continue;
    const all = !packageVariantBySession && r.packageVariantIds && r.packageVariantIds.length > 0 ? { packageVariantIds: r.packageVariantIds } : {};
    out.push({ sessionId: r.sessionId, standNumber: r.standNumber, label: `Stand ${r.standNumber}`, packageVariantId, ...all });
  }
  return out.sort((a, b) => a.standNumber - b.standNumber);
}
