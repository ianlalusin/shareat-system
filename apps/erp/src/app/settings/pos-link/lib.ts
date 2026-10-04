/**
 * Server-only reads for `/settings/pos-link`. T-375 S1.
 *
 * The page gate (`requirePageAccess('/settings/pos-link')`, `manage_chart_of_accounts`) is the READ control; the
 * write gate is `linkStoreToPos`'s own `authorize()`. Plain reads here carry no second gate, the house rule of
 * `/settings/sales-channels/lib.ts`.
 */
import { moneyAccountsRepo, posV1Repo } from '@shareat/db';
import { fetchPosV1PaymentMethods, fetchPosV1Stores, normalizePosV1Alias, type PosV1StoreOption } from '@shareat/domain';
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

// ---------------------------------------------------------------------------------------------
// Tenders (T-375 S2)
// ---------------------------------------------------------------------------------------------
export interface TenderAdminRow {
  readonly id: string;
  readonly name: string;
  readonly kind: 'cash' | 'wallet';
  readonly moneyAccountId: string | null;
  readonly moneyAccountName: string | null;
  readonly posV1Alias: string | null;
  readonly isActive: boolean;
}

export interface StoreTenders {
  readonly tenders: readonly TenderAdminRow[];
  /** The store's ACTIVE money accounts: the only kind a wallet tender may point at. */
  readonly accounts: readonly { id: string; name: string }[];
  /** POS methods with no active alias here, or null when POS is not configured / not answering. */
  readonly unmapped: readonly string[] | null;
}

/** One store's tenders, its wallets' accounts, and POS's methods nothing answers to yet. Never throws on POS. */
export async function storeTenders(actor: Actor, storeId: string, posStoreId: string | null): Promise<StoreTenders> {
  const { rows, accounts } = await withOrgPrincipal(actor.orgId, async (tx) => ({
    rows: await posV1Repo.listTendersByStore(tx, actor.orgId, storeId),
    accounts: await moneyAccountsRepo.listMoneyAccounts(tx, actor.orgId, { storeId }),
  }));
  const names = new Map(accounts.map((a) => [a.id, a.name]));
  let unmapped: string[] | null = null;
  if (posStoreId) {
    try {
      const methods = await fetchPosV1PaymentMethods(posStoreId);
      const active = new Set(rows.filter((t) => t.isActive && t.posV1Alias).map((t) => normalizePosV1Alias(t.posV1Alias ?? '')));
      unmapped = methods.filter((m) => !active.has(normalizePosV1Alias(m)));
    } catch {
      unmapped = null;
    }
  }
  return {
    tenders: rows.map((t) => ({
      id: t.id,
      name: t.name,
      kind: t.kind,
      moneyAccountId: t.moneyAccountId,
      moneyAccountName: t.moneyAccountId ? (names.get(t.moneyAccountId) ?? null) : null,
      posV1Alias: t.posV1Alias,
      isActive: t.isActive,
    })),
    accounts: accounts.map((a) => ({ id: a.id, name: a.name })),
    unmapped,
  };
}
