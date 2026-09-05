/**
 * The live POS sales fetch — T-210. Mirrors `usage-pull.ts`'s `fetchPosSoldItemsLive` exactly:
 * same env contract, same auth header, same "throws a named error when unconfigured" shape, same
 * injectable-function type alias so callers can test without a live POS.
 * docs/CROSS-APP-MAP.md §1 documents the exact response shape, verified against
 * `POS/src/app/api/external/sales/route.ts`.
 */
import { env } from '@shareat/core/env';

export interface PosDaySalesSnapshot {
  readonly found: boolean;
  readonly totalSales: string;
  readonly totalSessions: number;
}

export type FetchPosDaySales = (input: { storeId: string; businessDate: string }) => Promise<PosDaySalesSnapshot>;

/**
 * `GET {POS_API_URL}/api/external/sales?storeId=&date=` — `x-api-key` auth, matching
 * `fetchPosSoldItemsLive`. Throws when `POS_API_URL`/`POS_API_KEY` are unset (both declared
 * optional in `@shareat/core/env` — T-177's own reasoning: nothing calls this outside one
 * feature, and demanding it blocks local dev on a credential most work does not touch). Callers
 * that need a graceful "not configured" state (T-210's reconciliation screen) catch this
 * specific error rather than letting it 500 — see `pos-day-reconciliation.ts`.
 */
export async function fetchPosSalesLive(input: { storeId: string; businessDate: string }): Promise<PosDaySalesSnapshot> {
  const { POS_API_URL, POS_API_KEY } = env();
  if (!POS_API_URL || !POS_API_KEY) {
    throw new Error('fetchPosSalesLive: POS_API_URL or POS_API_KEY is not configured — see .env.example');
  }
  const res = await fetch(
    `${POS_API_URL}/api/external/sales?storeId=${encodeURIComponent(input.storeId)}&date=${encodeURIComponent(input.businessDate)}`,
    { headers: { 'x-api-key': POS_API_KEY }, cache: 'no-store' },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}) as Record<string, unknown>);
    throw new Error(typeof body.error === 'string' ? body.error : `POS API returned ${res.status}`);
  }
  const data = (await res.json()) as { found: boolean; totalSales?: number; totalSessions?: number };
  return {
    found: data.found,
    totalSales: String(data.totalSales ?? 0),
    totalSessions: Number(data.totalSessions ?? 0),
  };
}
