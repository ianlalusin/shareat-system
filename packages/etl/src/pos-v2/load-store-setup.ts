/**
 * T-533 S2 + T-626 - the one-time store setup load from POS v1. docs/tasks/533-pos-lipa-switch.md R2, docs/tasks/626-lipa-pos-setup-from-v1.md.
 *
 * Reads the store's stands (v1 `tables`), discount presets (v1 `storeDiscounts`) and, since T-626, its menu and kitchen through `V1StoreSetupSource`, which is READ-ONLY by
 * shape (list calls, no write member; the real one is `packages/etl-firestore/src/pos-store-setup-source.ts`), and writes them ONLY through the audited domain functions,
 * as the load's own actor. Idempotent: a second run writes nothing. `dryRun` runs the same path inside a savepoint it rolls back, so the counts are exactly what a real run
 * would do and nothing is kept. A value someone already set in the ERP is never overwritten: it is listed as a difference.
 *
 * It REPORTS and never fixes: tenders without `pos_v1_alias`, menu items without a kitchen station, packages without refill items, staff without a PIN. Nothing here prints
 * a Firestore document id: the report carries counts and names (a stand number, a discount name, a dish) only.
 *
 * v1 -> v2 mapping (v1 is read as requirements; planned in `plan-store-menu.ts`, written in `load-store-menu.ts`; all paths under `stores/{id}/` unless noted):
 *   kitchenLocations (name, slaMinutes, printOnOutage, sortOrder) -> kitchen station, same fields
 *   menuSchedules (days, startTime, endTime)                       -> store hours (daypart) of the same name, only if a package is priced in them; no times = a GAP, its
 *                                                                     packages go all-day (as v1); hours switched off = their packages are not on sale (a NOTE)
 *   storePackages (pricePerHead | bundlePrice+bundleMaxCap+bundleExtraHeadPrice, kitchenLocationId, refillsAllowed, menuScheduleId)
 *                                                                  -> ONE package item "base name" (LT-/DT- prefix dropped), per-head or bundle price per hours; two
 *                                                                     copies at one price = one all-day price; empty refillsAllowed = every enabled refill (a NOTE);
 *                                                                     disabled = not loaded; refill links only added to a package that has none
 *   storeRefills + root refills (isEnabled, requiresFlavor, allowedFlavorIds, kitchenLocationId) -> refill item (free offer) routed to its station
 *   storeFlavors + root flavors (isEnabled)                        -> option values of the refill's single-choice group "Flavour" (a store switch = an option offer, +0.00)
 *   inventory where isAddon (name, groupName+variantLabel, subCategory, sellingPrice, kitchenLocationId, customerEnabled)
 *                                                                  -> a-la-carte item sold alone and in a package session, category = subCategory ("Add-ons" if none)
 *   storeModesOfPayment (name, type)                               -> tender: cash = made; wallet = matched by v1 name and its alias filled, else listed (needs a money account)
 *   Not copied, reported: charges, reservation deposits, staff and PINs, printers, receipt text, online prices, modifier groups, packages' own flavour lists (v1 never enforced them).
 *
 * The actor is operator-supplied and trusted only as far as database access: the domain functions authorize it (it must be a super admin to add items and pair hours).
 */
import { menuRepo, posStoreSetupRepo, RefusalError, refuse, type Tx } from '@shareat/db';
import { toBusinessDate } from '@shareat/core/datetime';
import { upsertPosDiscountPreset, upsertPosStand } from '@shareat/domain';
import { applyMenuPlan, formatMenuSetupReport, type MenuSetupReport } from './load-store-menu';
import { planStoreMenu, type V1MenuSetup } from './plan-store-menu';

export type { V1MenuSetup } from './plan-store-menu';

type Actor = Parameters<typeof upsertPosStand>[1];

/** One v1 table as the source normalises it. `tableNumber` is v1's text ("12"). */
export interface V1Table {
  readonly tableNumber: string;
  readonly isActive: boolean;
}
/** One v1 store discount as the source reads it (unvalidated: the domain checks type and value). */
export interface V1Discount {
  readonly name: string;
  readonly type: unknown;
  readonly value: unknown;
  readonly isArchived: boolean;
  readonly isEnabled: boolean;
  readonly adminSuspended: boolean;
  /** A global discount's availability window (local YYYY-MM-DD, inclusive); absent on a store discount. */
  readonly startDate?: string;
  readonly endDate?: string;
}
export interface V1StoreSetupSource {
  listTables(posStoreId: string): Promise<readonly V1Table[]>;
  /** The store's own discounts (`stores/{id}/storeDiscounts`). */
  listDiscounts(posStoreId: string): Promise<readonly V1Discount[]>;
  /** Universal discounts that apply to this store (`globalDiscounts`, applicableStoreIds contains it, not archived): v1's screen merges them with the store's. */
  listGlobalDiscounts(posStoreId: string): Promise<readonly V1Discount[]>;
  /** T-626: the store's menu, kitchen, hours and payment methods. Optional so a source that only knows stands and discounts still works; the real one has it. */
  readMenu?(posStoreId: string): Promise<V1MenuSetup>;
}

export interface StoreSetupReport {
  readonly dryRun: boolean;
  readonly stands: { created: number[]; unchanged: number[]; keptRetired: number[]; skipped: string[] };
  readonly presets: { created: string[]; updated: string[]; unchanged: string[]; skipped: string[]; refused: { name: string; reason: string }[] };
  /** T-626: null when the source did not read a menu. */
  readonly menu: MenuSetupReport | null;
  readonly gaps: {
    tendersWithoutAlias: string[];
    itemsWithoutStation: string[];
    packagesWithoutRefills: string[];
    staffWithoutPin: { staffCode: string; displayName: string }[];
  };
}

class DryRunRollback extends Error {}

export async function loadStoreSetup(
  tx: Tx,
  actor: Actor,
  input: { storeId: string; dryRun: boolean; /** Tests only: the clock the global discounts' date windows are read against. */ now?: Date },
  source: V1StoreSetupSource,
): Promise<StoreSetupReport> {
  const posStoreId = await posStoreSetupRepo.getLivePosStoreId(tx, actor.orgId, input.storeId);
  if (!posStoreId) throw refuse(`loadStoreSetup: store ${input.storeId} has no live v1 link`, 'This store is not linked to POS v1, so there is nothing to load.');
  const tables = await source.listTables(posStoreId);
  const storeDiscounts = await source.listDiscounts(posStoreId);
  const globalDiscounts = await source.listGlobalDiscounts(posStoreId);
  const menuPlan = source.readMenu ? planStoreMenu(await source.readMenu(posStoreId)) : null;
  // One preset per name (the table's key is the lower-cased name): a store discount wins over a global of the same name, and a global outside its date window is left out.
  const key = (n: string) => n.trim().toLowerCase();
  const today = toBusinessDate(input.now ?? new Date());
  // Only a LOADABLE discount (not archived, switched off or suspended) claims its name. Of two loadable store discounts of one name the first (v1's document order)
  // is kept and the rest skipped, so a re-run cannot flip the value back and forth.
  const storeNames = new Set<string>();
  const discounts: { d: V1Discount; skip?: string }[] = storeDiscounts.map((d) => {
    if (d.isArchived || !d.isEnabled || d.adminSuspended) return { d };
    const dup = storeNames.has(key(d.name));
    storeNames.add(key(d.name));
    return dup ? { d, skip: 'store, duplicate name' } : { d };
  });
  const seenGlobal = new Set<string>();
  for (const d of globalDiscounts) {
    const skip = storeNames.has(key(d.name)) ? 'same name as a store discount, which wins'
      : seenGlobal.has(key(d.name)) ? 'same name as another global discount'
      : d.startDate && today < d.startDate ? 'not started yet'
      : d.endDate && today > d.endDate ? 'expired'
      : undefined;
    if (!skip) seenGlobal.add(key(d.name)); // only a global that will load blocks a later one of the same name
    discounts.push({ d, skip: skip && `global, ${skip}` });
  }

  const stands: StoreSetupReport['stands'] = { created: [], unchanged: [], keptRetired: [], skipped: [] };
  const presets: StoreSetupReport['presets'] = { created: [], updated: [], unchanged: [], skipped: [], refused: [] };

  let menu: MenuSetupReport | null = null;
  const writes = async (sp: Tx): Promise<void> => {
    for (const t of tables) {
      const number = /^\d{1,3}$/.test(t.tableNumber.trim()) ? Number(t.tableNumber.trim()) : NaN;
      if (!t.isActive) { stands.skipped.push(`Table ${t.tableNumber} (switched off in v1)`); continue; }
      if (!(number >= 1 && number <= 999)) { stands.skipped.push(`Table ${t.tableNumber} (not a number from 1 to 999)`); continue; }
      const r = await upsertPosStand(sp, actor, { storeId: input.storeId, number });
      (r.outcome === 'created' ? stands.created : r.outcome === 'unchanged' ? stands.unchanged : stands.keptRetired).push(number);
    }
    for (const { d, skip } of discounts) {
      if (skip) { presets.skipped.push(`${d.name} (${skip})`); continue; }
      if (d.isArchived || !d.isEnabled || d.adminSuspended) { presets.skipped.push(`${d.name} (${d.isArchived ? 'archived' : d.isEnabled ? 'suspended' : 'switched off'} in v1)`); continue; }
      try {
        const r = await upsertPosDiscountPreset(sp, actor, { storeId: input.storeId, name: d.name, valueType: d.type, value: d.value }, 'etl');
        presets[r.outcome].push(d.name.trim());
      } catch (e) {
        // A bad preset is named and left out, never "fixed"; the rule is checked before any SQL, so the transaction is still sound. Anything else aborts.
        if (!(e instanceof RefusalError)) throw e;
        presets.refused.push({ name: d.name, reason: e.userMessage });
      }
    }
    if (menuPlan) menu = await applyMenuPlan(sp, actor, input.storeId, menuPlan, await menuRepo.dbNow(sp));
  };
  if (input.dryRun) {
    try {
      await tx.transaction(async (sp) => {
        await writes(sp);
        throw new DryRunRollback();
      });
    } catch (e) {
      if (!(e instanceof DryRunRollback)) throw e;
    }
  } else {
    await writes(tx);
  }

  return {
    dryRun: input.dryRun,
    stands,
    presets,
    menu,
    gaps: {
      tendersWithoutAlias: await posStoreSetupRepo.listTendersWithoutAlias(tx, actor.orgId, input.storeId),
      itemsWithoutStation: await posStoreSetupRepo.listItemsWithoutStation(tx, actor.orgId, input.storeId),
      packagesWithoutRefills: await posStoreSetupRepo.listPackagesWithoutRefills(tx, actor.orgId, input.storeId),
      staffWithoutPin: await posStoreSetupRepo.listStaffWithoutPin(tx, actor.orgId, input.storeId),
    },
  };
}

/** The report as plain lines for the CLI: counts and names only. */
export function formatStoreSetupReport(r: StoreSetupReport): string[] {
  const list = (xs: readonly unknown[]) => (xs.length ? xs.map((x) => (typeof x === 'string' || typeof x === 'number' ? String(x) : JSON.stringify(x))).join(', ') : '-');
  const verb = r.dryRun ? 'would be' : 'were';
  return [
    r.dryRun ? 'DRY RUN: nothing was written.' : 'LOAD DONE.',
    `Stands ${verb} created: ${r.stands.created.length} (${list(r.stands.created)}); already there: ${r.stands.unchanged.length}; kept retired: ${r.stands.keptRetired.length}`,
    `Stands skipped: ${r.stands.skipped.length} (${list(r.stands.skipped)})`,
    `Discounts ${verb} created: ${r.presets.created.length} (${list(r.presets.created)}); changed: ${r.presets.updated.length} (${list(r.presets.updated)}); already there: ${r.presets.unchanged.length}`,
    `Discounts skipped: ${r.presets.skipped.length} (${list(r.presets.skipped)})`,
    `Discounts refused: ${r.presets.refused.length}${r.presets.refused.map((x) => `\n  ${x.name}: ${x.reason}`).join('')}`,
    ...(r.menu ? formatMenuSetupReport(r.menu, r.dryRun) : []),
    'GAPS (reported, not fixed):',
    `  tenders without a v1 alias: ${r.gaps.tendersWithoutAlias.length} (${list(r.gaps.tendersWithoutAlias)})`,
    `  menu items without a kitchen station: ${r.gaps.itemsWithoutStation.length} (${list(r.gaps.itemsWithoutStation)})`,
    `  packages without refill items: ${r.gaps.packagesWithoutRefills.length} (${list(r.gaps.packagesWithoutRefills)})`,
    `  staff without a PIN: ${r.gaps.staffWithoutPin.length} (${list(r.gaps.staffWithoutPin.map((s) => `${s.staffCode} ${s.displayName}`))})`,
  ];
}
