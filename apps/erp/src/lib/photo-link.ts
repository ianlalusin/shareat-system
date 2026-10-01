/**
 * Whether to draw a "View photo" link. T-369 S2 (DEF-198).
 *
 * `canReadFile` is a presentation aid - `/files/[fileId]` is what enforces access - so a fault while asking
 * it must never take the page down: the link is simply not drawn, and only the failure's KIND is logged
 * (never an id, path or URL).
 */
import { logger } from '@shareat/core/logger';
import type { Actor } from '@shareat/auth';
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
