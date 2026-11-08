/**
 * T-529 R2 (row 447) - the Heads control on a server's phone: each open dine-in table with the count the server can confirm. `current` is the server's
 * own count once there is one, else the cashier's; `confirmed` says whether a server has counted. The bounds are the domain's (1 to 200).
 */
import { HEADS_MAX, HEADS_MIN } from '../_orders/payloads';

export interface HeadsSource {
  sessionId: string;
  standNumber: number | null;
  mode?: string;
  headsCashier: number;
  headsServer: number | null;
}
export interface HeadsRow {
  sessionId: string;
  standNumber: number;
  label: string;
  current: number;
  confirmed: boolean;
}

export function headsRows(rows: readonly HeadsSource[]): HeadsRow[] {
  return rows
    .flatMap((r) =>
      r.mode === 'take_out' || r.standNumber === null
        ? []
        : [{ sessionId: r.sessionId, standNumber: r.standNumber, label: `Stand ${r.standNumber}`, current: r.headsServer ?? r.headsCashier, confirmed: r.headsServer !== null }],
    )
    .sort((a, b) => a.standNumber - b.standNumber);
}

export const stepHeads = (n: number, delta: 1 | -1): number => Math.min(HEADS_MAX, Math.max(HEADS_MIN, n + delta));
