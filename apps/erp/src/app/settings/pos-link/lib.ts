/**
 * Server-only reads for `/settings/pos-link`. T-375 S1.
 *
 * The page gate (`requirePageAccess('/settings/pos-link')`, `manage_chart_of_accounts`) is the READ control; the
 * write gate is `linkStoreToPos`'s own `authorize()`. Plain reads here carry no second gate, the house rule of
 * `/settings/sales-channels/lib.ts`.
 */
import { posV1Repo } from '@shareat/db';
import { fetchPosV1Stores, type PosV1StoreOption } from '@shareat/domain';
import type { Actor } from '@shareat/auth';
import { withOrgPrincipal } from '../../expenses/lib';
import { channelsForStore, type SalesChannelAdminRow } from '../sales-channels/lib';

export { withOrgPrincipal };

export interface PosLinkStoreRow {
  readonly storeId: string;
  readonly storeName: string;
  readonly link: {
    readonly posStoreId: string;
    readonly posStoreName: string;
    readonly salesChannelId: string;
    readonly posTaxType: 'vat_inclusive' | 'vat_exclusive' | 'non_vat';
  } | null;
  /** Active channels whose money is remitted daily: the only kind a link may name. */
  readonly channels: readonly Pick<SalesChannelAdminRow, 'id' | 'name'>[];
}

export async function posLinkRows(actor: Actor, stores: readonly { id: string; name: string }[]): Promise<PosLinkStoreRow[]> {
  const links = await withOrgPrincipal(actor.orgId, (tx) => posV1Repo.listLinks(tx, actor.orgId));
  const byStore = new Map(links.map((l) => [l.storeId, l]));
  const out: PosLinkStoreRow[] = [];
  for (const s of stores) {
    const channels = await channelsForStore(actor, s.id);
    const l = byStore.get(s.id);
    out.push({
      storeId: s.id,
      storeName: s.name,
      link: l
        ? { posStoreId: l.posStoreId, posStoreName: l.posStoreName, salesChannelId: l.salesChannelId, posTaxType: l.posTaxType }
        : null,
      channels: channels.filter((c) => c.isActive && c.isRemittedDaily).map((c) => ({ id: c.id, name: c.name })),
    });
  }
  return out;
}

/**
 * POS's stores for the picker, or `null` when the bridge is not configured or not answering - the screen then
 * offers a text box with a note. Never throws: an unreachable POS must not take the settings screen down.
 */
export async function posStoreOptions(): Promise<PosV1StoreOption[] | null> {
  try {
    return await fetchPosV1Stores();
  } catch {
    return null;
  }
}
