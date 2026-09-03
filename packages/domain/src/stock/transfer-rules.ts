/**
 * Pure validation for a stock-transfer request — T-167.
 *
 * Mirrors the database's own checks (different locations, positive quantities, one line per item)
 * so a malformed request fails with a readable message before it reaches a transaction, and is
 * unit-testable without a database. ⛔ The database checks remain the authority for anything that
 * matters — this is a courtesy for the caller, never a second copy of a numeric rule.
 */
import { isPositiveQuantity, type Quantity } from './quantity';

export interface TransferLineRequest {
  readonly itemId: string;
  readonly quantity: Quantity;
}

export interface TransferRequest {
  readonly fromLocationId: string;
  readonly toLocationId: string;
  readonly lines: readonly TransferLineRequest[];
}

export type ValidationOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export function validateTransferRequest(input: TransferRequest): ValidationOutcome {
  if (input.fromLocationId === input.toLocationId) {
    return { ok: false, reason: 'a transfer must name two different locations' };
  }
  if (input.lines.length === 0) {
    return { ok: false, reason: 'a transfer with no lines moves nothing' };
  }
  for (const line of input.lines) {
    if (!isPositiveQuantity(line.quantity)) {
      return { ok: false, reason: `the quantity for item ${line.itemId} must be greater than zero` };
    }
  }
  // ⭐ One line per item — `stock_reservations` carries a UNIQUE (transfer_id, item_id), so a
  // duplicate here would collide at commit with a message that does not say why.
  const seen = new Set<string>();
  for (const line of input.lines) {
    if (seen.has(line.itemId)) {
      return {
        ok: false,
        reason: `item ${line.itemId} appears on more than one line — combine it into one`,
      };
    }
    seen.add(line.itemId);
  }
  return { ok: true };
}

/** v1's own default. A per-store report, not a cross-store scan (§ "What v1 gets right"). */
export const DEFAULT_STUCK_TRANSFER_THRESHOLD_DAYS = 3;
