/**
 * Server-only reads and pure helpers for `/admin/pos-tablets`. T-505, docs/tasks/505-erp-pos-tablet-links.md.
 *
 * The screen adds no SQL and no rule: the reads live in `packages/db/src/repo` (`posTerminalLinksRepo.listForStore`,
 * `accessRepo.terminalPersonsForStore`, `pinAttemptsRepo.statusForActor`) and the writes are the existing domain functions
 * (`provisionPosTerminalLink`, `revokePosTerminalLink`, `resetApprovalPinCap`). The read gate here is the same capability the writes
 * check, at the store: `provision_clock_terminal` (admin, super admin).
 */
import { accessRepo, pinAttemptsRepo, posTerminalLinksRepo, posV2Repo } from '@shareat/db';
import { authorize, can, type Actor } from '@shareat/auth';
import { listPosTerminals } from '@shareat/domain';
import { withOrgPrincipal } from '../../expenses/lib';
import { copyChoicesFor } from '../../copy-from-store/lib';

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

/** T-546: the store's tills and the live tablets still free to choose. `listPosTerminals` authorizes at the store itself (`pair_pos_tablet`). */
export async function loadTills(actor: Actor, storeId: string) {
  return withOrgPrincipal(actor.orgId, (tx) => listPosTerminals(tx, actor, { storeId }));
}

/** T-611 S3: the stores the discounts Copy window offers, or null when the button is not drawn (not an administrator, or no other active store). */
export async function loadCopyStores(actor: Actor, storeId: string) {
  return withOrgPrincipal(actor.orgId, (tx) => copyChoicesFor(tx, actor, storeId));
}

export interface DiscountPresetView {
  readonly id: string;
  readonly name: string;
  readonly valueType: 'percent' | 'fixed';
  /** Two decimals, as stored. */
  readonly value: string;
}

/**
 * T-622: the store's active named discounts for the Discounts section. `canManage` (`manage_store_settings` at the store, asked with the
 * non-logging `can`) only decides whether Add, Change and Retire are drawn; every write is gated again in the domain.
 */
export async function loadDiscounts(actor: Actor, storeId: string): Promise<{ presets: DiscountPresetView[]; canManage: boolean }> {
  return withOrgPrincipal(actor.orgId, async (tx) => {
    const rows = await posV2Repo.listActivePresets(tx, actor.orgId, storeId);
    return {
      canManage: await can(tx, actor, 'manage_store_settings', { storeId }),
      presets: rows.map((p) => ({ id: p.id, name: p.name, valueType: p.valueType, value: p.value })),
    };
  });
}

export interface ChargePresetView {
  readonly id: string;
  readonly name: string;
  /** Two decimals, as stored. */
  readonly amount: string;
  readonly perUnit: boolean;
}

/** T-627: the store's active named charges for the Charges section; `canManage` as in `loadDiscounts`. */
export async function loadCharges(actor: Actor, storeId: string): Promise<{ presets: ChargePresetView[]; canManage: boolean }> {
  return withOrgPrincipal(actor.orgId, async (tx) => {
    const rows = await posV2Repo.listActiveChargePresets(tx, actor.orgId, storeId);
    return {
      canManage: await can(tx, actor, 'manage_store_settings', { storeId }),
      presets: rows.map((p) => ({ id: p.id, name: p.name, amount: p.amount, perUnit: p.perUnit })),
    };
  });
}

/** "150.00 each" or "150.00 once per bill" (display only; `peso` is the caller's money formatter). */
export function chargeText(p: Pick<ChargePresetView, 'amount' | 'perUnit'>, peso: (v: string) => string): string {
  return p.perUnit ? `${peso(p.amount)} each` : `${peso(p.amount)} once per bill`;
}

/** "20%" or "50.00 off each" (display only; `peso` is the caller's money formatter). A percent drops trailing zeros: 12.50 reads "12.5%". */
export function presetText(p: Pick<DiscountPresetView, 'valueType' | 'value'>, peso: (v: string) => string): string {
  return p.valueType === 'fixed' ? `${peso(p.value)} off each` : `${Number(p.value)}%`;
}

/** The number the Add till box starts at: the first number from 1 that no till of the store uses (1 to 99; 1 when the store is full, the domain then refuses). */
export function nextFreeTillNo(used: readonly number[]): number {
  for (let n = 1; n <= 99; n++) if (!used.includes(n)) return n;
  return 1;
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
