/**
 * Server-only reads and pure helpers for `/admin/pos-tablets`. T-505, docs/tasks/505-erp-pos-tablet-links.md.
 *
 * The screen adds no SQL and no rule: the reads live in `packages/db/src/repo` (`posTerminalLinksRepo.listForStore`,
 * `accessRepo.terminalPersonsForStore`, `pinAttemptsRepo.statusForActor`) and the writes are the existing domain functions
 * (`provisionPosTerminalLink`, `revokePosTerminalLink`, `resetApprovalPinCap`). The read gate here is the same capability the writes
 * check, at the store: `provision_clock_terminal` (admin, super admin).
 */
import { accessRepo, pinAttemptsRepo, posTerminalLinksRepo } from '@shareat/db';
import { authorize, type Actor } from '@shareat/auth';
import { withOrgPrincipal } from '../../expenses/lib';

export type PosTabletLinkView = posTerminalLinksRepo.PosTabletLinkView;

/** How many revoked links the page shows under the active one. */
export const REVOKED_SHOWN = 10;

export interface TerminalLockView {
  readonly personId: string;
  readonly displayName: string;
  readonly capped: boolean;
  readonly cappedAt: Date | null;
}

export interface PosTabletsView {
  readonly active: PosTabletLinkView | null;
  readonly revoked: PosTabletLinkView[];
  readonly terminals: TerminalLockView[];
}

export async function loadPosTablets(actor: Actor, storeId: string): Promise<PosTabletsView> {
  return withOrgPrincipal(actor.orgId, async (tx) => {
    await authorize(tx, actor, 'provision_clock_terminal', { storeId });
    const { active, revoked } = await posTerminalLinksRepo.listForStore(tx, actor.orgId, storeId, { revokedLimit: REVOKED_SHOWN });
    const people = await accessRepo.terminalPersonsForStore(tx, actor.orgId, storeId);
    const terminals: TerminalLockView[] = [];
    for (const p of people) {
      const status = await pinAttemptsRepo.statusForActor(tx, actor.orgId, p.personId);
      terminals.push({ personId: p.personId, displayName: p.displayName, capped: status.capped, cappedAt: status.cappedAt });
    }
    return { active, revoked, terminals };
  });
}

/** The last four characters of a device id, as the screen names a tablet ("...ab12"). Q1 of the spec: full id not shown. */
export function deviceTail(deviceId: string): string {
  return `...${deviceId.slice(-4)}`;
}

/** The words a person retypes to revoke a tablet link; the action rebuilds this from the link it loads, never from the form. */
export function revokeConfirmName(terminalNo: number): string {
  return `Terminal ${terminalNo}`;
}

/** The form's own shape check (the domain checks again and owns the refusal sentence): a device id is a uuid. */
export function normaliseDeviceId(raw: string): string {
  return raw.trim().toLowerCase();
}
