import 'server-only';
import { logger } from '@shareat/core/logger';
/**
 * T-455 S3 - the lobby route log. A line carries the route, the HTTP status and (when there is one) the entry id. NEVER a name, note,
 * phone, ID number, raw ip, cookie value, hand-off link, secret, request body or error message (a database error can echo its parameters).
 */
export function logReply(route: string, status: number, entryId?: string): void {
  const line = { route, status, ...(entryId ? { entryId } : {}) };
  if (status >= 500) logger.error(line, 'lobby reply');
  else logger.info(line, 'lobby reply');
}

/** An unexpected failure: only the error CLASS name is kept. */
export function logFault(route: string, err: unknown): void {
  logger.error({ route, errorName: err instanceof Error ? err.name : 'non-error' }, 'lobby unexpected failure');
}

/** The proxy did not send x-real-ip. One line, no address. */
export function logMissingIp(route: string): void {
  logger.error({ route }, 'lobby request without x-real-ip; the proxy must set it');
}
