/**
 * ⭐ T-371 S3 — the stock module's one entry parse for a typed quantity.
 *
 * Every stock entry (`recordCount`, `transferNow`/`saveDraft`, `recordReturn`, `saveUsageDraft`, `addUsageLine`) takes
 * the quantity as the raw string the screen read, and parses it HERE, after `authorize()` (R5), into the branded
 * `Quantity` its writer needs. A malformed or out-of-range value is `parseQuantityInput`'s presentable refusal, with
 * its sentences unchanged.
 *
 * R6 — a blank follows its column. Every quantity column these entries write (`count_lines.counted_quantity`,
 * `stock_transfer_lines.quantity`, `supplier_return_lines.quantity`, `stock_usage_lines.quantity`) is NOT NULL with no
 * default, so a blank is REFUSED with its own sentence. `'0'` is never invented.
 */
import { parseQuantityInput } from '../shared/quantity-input';
import { refuse } from '../shared/refusal';
import type { Quantity } from './quantity';

export function parseRequiredQuantity(raw: string | null | undefined, rawLabel: string, humanLabel: string): Quantity {
  if (raw == null || String(raw).trim() === '') {
    throw refuse(
      `${rawLabel} — a quantity is required and was left blank.`,
      `${humanLabel} — can't be left blank. Enter a quantity.`,
    );
  }
  return parseQuantityInput(raw, rawLabel, humanLabel);
}
