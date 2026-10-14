/**
 * Server-only reads for `/settings/pos-link`. T-375 S1.
 *
 * The page gate (`requirePageAccess('/settings/pos-link')`, `manage_chart_of_accounts`) is the READ control; the
 * write gate is `linkStoreToPos`'s own `authorize()`. Plain reads here carry no second gate, the house rule of
 * `/settings/sales-channels/lib.ts`.
 */
import { moneyAccountsRepo, personsRepo, posV1Repo } from '@shareat/db';
import { fetchPosV1PaymentMethods, fetchPosV1Stores, normalizePosV1Alias, type PosV1StoreOption } from '@shareat/domain';
import { authorize, type Actor, can } from '@shareat/auth';
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
  /** T-382: set when the store WAS linked and was unlinked (it is typed again; `link` is null). Who, when, why. */
  readonly unlinked: { readonly at: Date; readonly byName: string | null; readonly reason: string } | null;
  /** T-382 R13: verified imported days (the confirm sentence's count) and R3's open or submitted ones (block the unlink). */
  readonly importedDays: number;
  readonly unverifiedImportedDates: readonly string[];
  /** Active channels whose money is remitted daily: the only kind a link may name. */
  readonly channels: readonly Pick<SalesChannelAdminRow, 'id' | 'name'>[];
}

/**
 * T-382 R13: does this viewer hold `unlink_store_from_pos` (super admin only)? One `authorize` probe, caught to a
 * boolean, the house pattern of the other settings loaders. It only decides whether the section is SHOWN; the action
 * and `unlinkStoreFromPos` authorize again.
 */
export async function canUnlink(actor: Actor): Promise<boolean> {
  return withOrgPrincipal(actor.orgId, (tx) => can(tx, actor, 'unlink_store_from_pos', {}));
}

export async function posLinkRows(actor: Actor, stores: readonly { id: string; name: string }[]): Promise<PosLinkStoreRow[]> {
  const links = await withOrgPrincipal(actor.orgId, (tx) => posV1Repo.listLinks(tx, actor.orgId));
  const byStore = new Map(links.map((l) => [l.storeId, l]));
  const out: PosLinkStoreRow[] = [];
  for (const s of stores) {
    const channels = await channelsForStore(actor, s.id);
    const l = byStore.get(s.id);
    const live = l && !l.unlinkedAt ? l : undefined;
    const extra = await withOrgPrincipal(actor.orgId, async (tx) => ({
      byName: l?.unlinkedBy ? ((await personsRepo.getPersonById(tx, actor.orgId, l.unlinkedBy))?.displayName ?? null) : null,
      importedDays: live ? await posV1Repo.countVerifiedFeedDays(tx, actor.orgId, s.id) : 0,
      unverified: live ? await posV1Repo.unverifiedFeedDates(tx, actor.orgId, s.id) : [],
    }));
    out.push({
      storeId: s.id,
      storeName: s.name,
      link: live
        ? { posStoreId: live.posStoreId, posStoreName: live.posStoreName, salesChannelId: live.salesChannelId, posTaxType: live.posTaxType }
        : null,
      unlinked: l && l.unlinkedAt ? { at: l.unlinkedAt, byName: extra.byName, reason: l.unlinkReason ?? '' } : null,
      importedDays: extra.importedDays,
      unverifiedImportedDates: extra.unverified,
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
  /** Optimistic-lock token (TenderRow.version); posted back by the edit and Retire/Restore forms. */
  readonly version: string;
}

export interface StoreTenders {
  readonly tenders: readonly TenderAdminRow[];
  /** The store's ACTIVE bank and e-wallet accounts (never a cash drawer): the only kind a wallet tender may point at (R6). */
  readonly accounts: readonly { id: string; name: string }[];
  /** POS's payment methods for the linked store, or null when the store is not linked or POS is not answering. */
  readonly methods: readonly string[] | null;
}

/** One store's tenders, its wallets' accounts, and POS's methods nothing answers to yet. Never throws on POS. */
export async function storeTenders(actor: Actor, storeId: string, posStoreId: string | null): Promise<StoreTenders> {
  const { rows, accounts } = await withOrgPrincipal(actor.orgId, async (tx) => ({
    rows: await posV1Repo.listTendersByStore(tx, actor.orgId, storeId),
    accounts: await moneyAccountsRepo.listMoneyAccounts(tx, actor.orgId, { storeId }),
  }));
  const names = new Map(accounts.map((a) => [a.id, a.name]));
  let methods: string[] | null = null;
  if (posStoreId) {
    try {
      methods = [...(await fetchPosV1PaymentMethods(posStoreId))];
    } catch {
      methods = null;
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
      version: t.version,
    })),
    // R6 (DEF-611): the screen is a convenience; the domain's own account check stays the rule.
    accounts: accounts.filter((a) => a.instrument !== 'cash').map((a) => ({ id: a.id, name: a.name })),
    methods,
  };
}

// ---------------------------------------------------------------------------------------------
// R9: how POS's payment methods land. Pure; no database.
// ---------------------------------------------------------------------------------------------
export type TenderMappingStatus =
  | 'mapped' //            an active tender answers to this POS method
  | 'not_mapped' //        POS lists this method and no active tender answers to it
  | 'pos_does_not_list' // an active tender has a POS name that no listed POS method matches
  | 'no_pos_name' //       an active tender has no POS name
  | 'unchecked'; //        POS's methods are not known (store not linked, or POS not answering)

/**
 * One row of the mapping table. Columns: POS method, Tender, Kind, Money account, Status.
 * A POS-method row has `posMethod` set; a tender-only row has `posMethod: null`. `tenderId`, `tenderName`, `kind` and
 * `moneyAccountName` are null on a POS method row that no tender answers (status `not_mapped`) and `moneyAccountName`
 * is null for a cash tender. `statusText` is the words the table prints.
 */
export interface TenderMappingRow {
  readonly posMethod: string | null;
  readonly tenderId: string | null;
  readonly tenderName: string | null;
  readonly kind: 'cash' | 'wallet' | null;
  readonly moneyAccountName: string | null;
  readonly status: TenderMappingStatus;
  readonly statusText: string;
}

const STATUS_TEXT: Record<TenderMappingStatus, string> = {
  mapped: 'Mapped',
  not_mapped: 'Not mapped — days that use it cannot be imported',
  pos_does_not_list: "POS doesn't list this name",
  no_pos_name: 'No POS name',
  unchecked: 'Not checked against POS',
};

/**
 * R9. Matches by `normalizePosV1Alias` (case and punctuation do not matter). Only ACTIVE tenders ever map. With POS's
 * methods: one row per method, then one row per active tender that no method names. Without them (`null`): one row per
 * active tender. Money accounts are read off the tender, falling back to `accounts` by id.
 */
export function tenderMapping(
  methods: readonly string[] | null,
  tenders: readonly TenderAdminRow[],
  accounts: readonly { id: string; name: string }[],
): TenderMappingRow[] {
  const active = tenders.filter((t) => t.isActive);
  const accountName = (t: TenderAdminRow): string | null =>
    t.kind === 'cash' ? null : (t.moneyAccountName ?? accounts.find((a) => a.id === t.moneyAccountId)?.name ?? null);
  const tenderCells = (t: TenderAdminRow) => ({ tenderId: t.id, tenderName: t.name, kind: t.kind, moneyAccountName: accountName(t) });
  const aliasOf = (t: TenderAdminRow): string => (t.posV1Alias ? normalizePosV1Alias(t.posV1Alias) : '');

  const rows: TenderMappingRow[] = [];
  const named = new Set<string>();
  if (methods) {
    for (const m of methods) {
      const key = normalizePosV1Alias(m);
      named.add(key);
      const hit = key ? active.find((t) => aliasOf(t) === key) : undefined;
      rows.push(
        hit
          ? { posMethod: m, ...tenderCells(hit), status: 'mapped', statusText: STATUS_TEXT.mapped }
          : { posMethod: m, tenderId: null, tenderName: null, kind: null, moneyAccountName: null, status: 'not_mapped', statusText: STATUS_TEXT.not_mapped },
      );
    }
  }
  for (const t of active) {
    const key = aliasOf(t);
    if (methods && key && named.has(key)) continue; // already shown on its POS method's row
    const status: TenderMappingStatus = !key ? 'no_pos_name' : methods ? 'pos_does_not_list' : 'unchecked';
    rows.push({ posMethod: null, ...tenderCells(t), status, statusText: STATUS_TEXT[status] });
  }
  return rows;
}
