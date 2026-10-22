/**
 * Whether to draw a "View photo" link. T-369 S2 (DEF-198).
 *
 * `canReadFile` is a presentation aid - `/files/[fileId]` is what enforces access - so a fault while asking
 * it must never take the page down: the link is simply not drawn, and only the failure's KIND is logged
 * (never an id, path or URL).
 */
import { logger } from '@shareat/core/logger';
import type { Actor } from '@shareat/auth';
import { filesRepo } from '@shareat/db';
import { canReadFile } from '@shareat/domain';
import { withOrgPrincipal } from '../app/expenses/lib';

export async function canViewPhoto(actor: Actor, fileId: string | null): Promise<boolean> {
  if (!fileId) return false;
  try {
    return await withOrgPrincipal(actor.orgId, (tx) => canReadFile(tx, actor, fileId));
  } catch (err) {
    logger.error({ kind: 'fault', errorName: err instanceof Error ? err.name : typeof err }, 'photo link: could not check who may open a photo');
    return false;
  }
}

/**
 * The real kind of each stored file ('pdf' for application/pdf, else 'image'), for a thumbnail that must not guess.
 * Call it only for ids the screen's own read gate already allowed. A fault logs only its kind and falls back to 'image'.
 */
export async function photoKinds(actor: Actor, fileIds: readonly string[]): Promise<Map<string, 'image' | 'pdf'>> {
  const kinds = new Map<string, 'image' | 'pdf'>();
  if (fileIds.length === 0) return kinds;
  try {
    const rows = await withOrgPrincipal(actor.orgId, (tx) => filesRepo.getByIds(tx, actor.orgId, fileIds));
    for (const r of rows) kinds.set(r.id, r.contentType === 'application/pdf' ? 'pdf' : 'image');
  } catch (err) {
    logger.error({ kind: 'fault', errorName: err instanceof Error ? err.name : typeof err }, 'photo link: could not read a photo kind');
  }
  return kinds;
}
