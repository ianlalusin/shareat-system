/**
 * Server-only reads for the clock-terminal admin screen — T-203, closing DEF-133.
 *
 * `docs/tasks/203-terminal-and-credential-admin-ui.md`. `provisionTerminal` / `activateTerminal` /
 * `revokeTerminal` / `mintTerminalToken` (`packages/domain/src/attendance/terminals.ts`, T-159)
 * were fully built and tested with **zero callers outside their own tests** until this screen —
 * `createFirestoreTerminalDriver()` (`packages/sync-firestore`) was imported nowhere in `apps/`.
 *
 * ⭐ `listTerminals` already calls `authorize(tx, actor, 'manage_attendance', { storeId })` itself —
 * this file adds no second gate, the same discipline every other `lib.ts` in this app follows
 * (`items/lib.ts`, `commissary/catalogue/lib.ts`).
 */
import { isReady, listTerminals } from '@shareat/domain';
import type { Actor } from '@shareat/auth';
import type { ClockTerminalRow } from '@shareat/db';
import { listStores, withOrgPrincipal } from '../../expenses/lib';

export { listStores, withOrgPrincipal, isReady };
export type { StoreOption } from '../../expenses/lib';
export type { ClockTerminalRow };

/**
 * Live terminals (provisioned, not revoked) at one store.
 *
 * ⚠️ **A revoked terminal disappears from this list, not just from a "revoked" column** —
 * `clockTerminalsRepo.listForStore` (T-159) filters `where revoked_at is null` at the query, so
 * `listTerminals` never returns a revoked row at all. The row still exists in Postgres, still
 * readable by id, just not through this listing. See this task's report for why that is left as
 * designed rather than worked around here (T-159/`terminals.ts` is out of this task's scope).
 */
export async function terminalsForStore(
  orgId: string,
  actor: Actor,
  storeId: string,
): Promise<ClockTerminalRow[]> {
  return withOrgPrincipal(orgId, (tx) => listTerminals(tx, actor, { storeId }));
}
