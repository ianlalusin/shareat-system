/**
 * Server-only loaders for the lane screen. T-162.
 *
 * ⭐ Thin by design. Every rule and every gate is in `packages/domain/src/sync/health.ts`; this file
 * only picks a store and hands the domain a transaction. A gate here would protect one caller — a
 * gate in the domain protects every caller there will ever be.
 */
import { laneHealth, listQuarantine, type LaneHealthReport, type QuarantineList } from '@shareat/domain';
import type { Actor } from '@shareat/auth';
import { withOrgPrincipal } from '../../expenses/lib';

export { listStores, withOrgPrincipal } from '../../expenses/lib';
export type { StoreOption } from '../../expenses/lib';

export async function loadHealth(actor: Actor, storeId: string): Promise<LaneHealthReport> {
  return withOrgPrincipal(actor.orgId, (tx) => laneHealth(tx, actor, { storeId }));
}

export async function loadQuarantine(actor: Actor, storeId: string): Promise<QuarantineList> {
  return withOrgPrincipal(actor.orgId, (tx) => listQuarantine(tx, actor, { storeId }));
}

/** Manila time, spelled out. A lane problem is read at a glance or not at all. */
const WHEN = new Intl.DateTimeFormat('en-PH', {
  timeZone: 'Asia/Manila',
  dateStyle: 'medium',
  timeStyle: 'short',
});

export function when(at: Date | string | null): string {
  if (!at) return '—';
  return WHEN.format(typeof at === 'string' ? new Date(at) : at);
}

/**
 * "3 days ago", "2 hours ago", "just now".
 *
 * ⚠️ Relative on its own is a trap — *"14 hours ago"* is unactionable without knowing whether that
 * is Tuesday lunchtime — so every place this is used prints the absolute time beside it.
 */
export function ago(at: Date | string | null, now: Date): string {
  if (!at) return 'never';
  const then = typeof at === 'string' ? new Date(at) : at;
  const minutes = Math.max(0, Math.floor((now.getTime() - then.getTime()) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

/** The raw event, pretty-printed. ⛔ Shown as received — never our reading of it. */
export function rawJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
