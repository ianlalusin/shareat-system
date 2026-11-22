/**
 * T-626 - writes a `MenuPlan` (see `plan-store-menu.ts`) into one store, ONLY through the audited domain functions, as the load's own actor. docs/tasks/626-lipa-pos-setup-from-v1.md.
 *
 * Idempotent and never an overwrite: a thing that is already there with the same value is counted and left; a thing that is there with a DIFFERENT value (a price, a
 * station, a window, a payment alias) is reported as a difference and left for Ian. Menu items, option groups, categories and dayparts are the ORGANISATION's, matched by
 * name; prices, routes, stations and tenders are the STORE's. Each unit of work runs in its own savepoint, so a refusal (in words) is named and skipped and the rest goes on.
 *
 * Two things the load must do to price anything, and both are reported so nothing is hidden: a new variant needs a depletion rule before it can have an offer, so it gets
 * "uses no stock" (listed under `noStockRule`: set the real stock use in the ERP), and a wallet payment method needs a money account, which the load never guesses (it is listed).
 */
import { kitchenRepo, menuRepo, posV1Repo, daypartsRepo, RefusalError, type Tx } from '@shareat/db';
import {
  addMenuVariant, addOptionValue, createDaypart, createKitchenStation, createMenuCategory, createMenuItem, createOptionGroup, createTender, linkOptionGroup,
  normalizePosV1Alias, setDepletionRule, setKitchenRoute, setMenuOffer, setOptionOffer, setPackageRefills, updateTender,
} from '@shareat/domain';
import { key, type MenuPlan, type PlannedSlot } from './plan-store-menu';

type Actor = Parameters<typeof createDaypart>[0];

export type MenuPart = 'stations' | 'hours' | 'categories' | 'refills' | 'flavours' | 'packages' | 'items' | 'prices' | 'refill links' | 'kitchen routes' | 'payment methods';
const PARTS: readonly MenuPart[] = ['stations', 'hours', 'categories', 'refills', 'flavours', 'packages', 'items', 'prices', 'refill links', 'kitchen routes', 'payment methods'];

export interface MenuSetupReport {
  /** What this run created (or, on a dry run, would create), by part, as names. */
  readonly created: Record<MenuPart, string[]>;
  /** How many things were already there with the same value. */
  unchanged: number;
  /** Already there with a different value: left as it is, for Ian. */
  readonly differences: string[];
  /** Refused in words by a domain rule, named and left out. */
  readonly refused: { name: string; reason: string }[];
  readonly skipped: string[];
  /** New menu things that got the placeholder "uses no stock" rule. */
  readonly noStockRule: string[];
  /** Wallet payment methods that need a money account before they can be made. */
  readonly walletsNeedAccount: string[];
  readonly notCopied: string[];
}

const peso = (s: string): string => `₱${s}`;
const slotLabel = (s: PlannedSlot): string => (s.daypart ?? 'all day');

export async function applyMenuPlan(sp: Tx, actor: Actor, storeId: string, plan: MenuPlan, now: Date): Promise<MenuSetupReport> {
  const { orgId } = actor;
  const report: MenuSetupReport = {
    created: Object.fromEntries(PARTS.map((p) => [p, [] as string[]])) as Record<MenuPart, string[]>,
    unchanged: 0, differences: [], refused: [], skipped: [...plan.skipped], noStockRule: [], walletsNeedAccount: [], notCopied: [...plan.notCopied],
  };
  const made = (part: MenuPart, name: string): void => { report.created[part].push(name); };
  const same = (): void => { report.unchanged++; };
  const differ = (line: string): void => { report.differences.push(line); };
  /** One unit of work in its own savepoint: a refusal in words is named and the rest carries on; anything else stops the load. */
  const step = async <T>(name: string, run: (t: Tx) => Promise<T>): Promise<T | undefined> => {
    try {
      return await sp.transaction(run);
    } catch (e) {
      if (!(e instanceof RefusalError)) throw e;
      report.refused.push({ name, reason: e.userMessage });
      return undefined;
    }
  };

  // ---- kitchen stations ------------------------------------------------------------------------------------------------------------
  const stationId: Record<string, string> = {};
  for (const s of await kitchenRepo.listStations(sp, orgId, storeId)) stationId[key(s.name)] = s.id;
  for (const s of plan.stations) {
    const have = (await kitchenRepo.listStations(sp, orgId, storeId)).find((x) => key(x.name) === key(s.name));
    if (have) {
      stationId[key(s.name)] = have.id;
      const diffs = [
        ...(s.slaMinutes !== null && s.slaMinutes !== have.slaMinutes ? [`serve time ${s.slaMinutes} min in v1, ${have.slaMinutes} here`] : []),
        ...(s.printOnOutage !== have.printOnOutage ? [`print when the internet is down: ${s.printOnOutage ? 'yes' : 'no'} in v1, ${have.printOnOutage ? 'yes' : 'no'} here`] : []),
      ];
      if (diffs.length) differ(`Kitchen station ${s.name}: ${diffs.join('; ')}`); else same();
      continue;
    }
    const r = await step(`Kitchen station ${s.name}`, (t) => createKitchenStation(t, actor, { storeId, name: s.name, sortOrder: s.sortOrder, printOnOutage: s.printOnOutage, ...(s.slaMinutes === null ? {} : { slaMinutes: s.slaMinutes }) }));
    if (r) { stationId[key(s.name)] = r.stationId; made('stations', s.name); }
  }

  // ---- hours (dayparts) ------------------------------------------------------------------------------------------------------------
  const daypartId: Record<string, string> = {};
  for (const d of plan.dayparts) {
    const have = (await daypartsRepo.listDaypartsOfStore(sp, orgId, storeId)).find((x) => x.status === 'active' && key(x.name) === key(d.name));
    if (have) {
      daypartId[key(d.name)] = have.id;
      const window = (days: readonly number[], a: string, b: string) => `${[...days].sort((x, y) => x - y).join('')} ${a.slice(0, 5)}-${b.slice(0, 5)}`;
      if (window(have.days, have.startTime, have.endTime) === window(d.days, d.start, d.end)) same();
      else differ(`Hours ${d.name}: ${d.start}-${d.end} in v1, ${have.startTime.slice(0, 5)}-${have.endTime.slice(0, 5)} here`);
      continue;
    }
    const r = await step(`Hours ${d.name}`, (t) => createDaypart(actor, { storeId, name: d.name, days: d.days, start: d.start, end: d.end }, t));
    if (r) { daypartId[key(d.name)] = r.id; made('hours', `${d.name} ${d.start}-${d.end}`); }
  }

  // ---- helpers over the organisation's menu ----------------------------------------------------------------------------------------
  const categoryId: Record<string, string> = {};
  const ensureCategory = async (name: string): Promise<string | undefined> => {
    if (categoryId[key(name)]) return categoryId[key(name)];
    const have = await menuRepo.findCategoryByName(sp, orgId, name);
    if (have) { categoryId[key(name)] = have.id; return have.id; }
    const r = await step(`Category ${name}`, (t) => createMenuCategory(actor, { name }, t));
    if (!r) return undefined;
    categoryId[key(name)] = r.id;
    made('categories', name);
    return r.id;
  };
  const routes = new Map<string, string>(); // item id -> station id (read once, kept current)
  for (const r of await kitchenRepo.listRoutes(sp, orgId, storeId)) routes.set(r.menuItemId, r.stationId);
  const route = async (itemId: string, name: string, stationName: string | null): Promise<void> => {
    if (!stationName) return;
    const sid = stationId[key(stationName)];
    if (!sid) { report.skipped.push(`${name}: its kitchen station ${stationName} could not be set up, so it has no route`); return; }
    const cur = routes.get(itemId);
    if (cur === sid) { same(); return; }
    if (cur) { differ(`${name}: kitchen station ${stationName} in v1, a different one here`); return; }
    if (await step(`Kitchen route for ${name}`, (t) => setKitchenRoute(t, actor, { storeId, menuItemId: itemId, stationId: sid }))) { routes.set(itemId, sid); made('kitchen routes', `${name} -> ${stationName}`); }
  };
  type Sellable = { itemId: string; variantId: string };
  const ensureItem = async (type: 'package' | 'refill' | 'a_la_carte', name: string, category: string, sortOrder: number, flags: { soldALaCarte: boolean; soldInPackageSession: boolean; dinerOrderable: boolean }, part: MenuPart): Promise<Sellable | undefined> => {
    const have = await menuRepo.findItemByTypeAndName(sp, orgId, type, name);
    if (have) {
      if (have.status !== 'active') { report.refused.push({ name, reason: 'An item with this name exists but is retired here. It was not brought back.' }); return undefined; }
      const def = (await menuRepo.variantsOfItem(sp, orgId, have.id)).find((v) => v.isDefault && v.status === 'active');
      if (!def) { report.refused.push({ name, reason: 'This item has no active default variant here.' }); return undefined; }
      same();
      return { itemId: have.id, variantId: def.id };
    }
    const cat = await ensureCategory(category);
    if (!cat) { report.skipped.push(`${name} (its category could not be made)`); return undefined; }
    const r = await step(name, (t) => createMenuItem(actor, { categoryId: cat, name, itemType: type, sortOrder, ...flags }, t));
    if (!r) return undefined;
    made(part, name);
    return { itemId: r.id, variantId: r.defaultVariantId };
  };
  /** A new variant cannot take an offer without a depletion rule: give it "uses no stock" and say so. */
  const ensureRule = async (variantId: string, name: string): Promise<boolean> => {
    if ((await menuRepo.rulesInForce(sp, orgId, [variantId])).has(variantId)) return true;
    const r = await step(`Stock rule for ${name}`, (t) => setDepletionRule(actor, { variantId, mode: 'no_stock' }, t));
    if (r) report.noStockRule.push(name);
    return !!r;
  };
  /** `free`: a refill's offer carries no price. */
  const ensureOffers = async (variantId: string, name: string, slots: PlannedSlot[], free = false): Promise<void> => {
    if (!(await ensureRule(variantId, name))) return;
    const live = (await menuRepo.offersInForce(sp, storeId, now)).filter((o) => o.variantId === variantId && o.channel === 'store');
    for (const slot of slots) {
      const dp = slot.daypart === null ? null : daypartId[key(slot.daypart)] ?? undefined;
      if (dp === undefined) { report.skipped.push(`${name}: no price for ${slotLabel(slot)} (those hours could not be set up)`); continue; }
      const here = live.find((o) => o.daypartId === dp);
      if (here) {
        if (here.withdrawn) differ(`${name} (${slotLabel(slot)}): switched off here, so v1's price was not set`);
        else if (free || (here.amount === slot.amount && here.bundleHeads === slot.bundleHeads && here.extraHeadAmount === slot.extraHeadAmount)) same();
        else differ(`${name} (${slotLabel(slot)}): ${peso(slot.amount)} in v1, ${here.amount === null ? 'no price' : peso(here.amount)} here`);
        continue;
      }
      if (live.some((o) => (o.daypartId === null) !== (dp === null))) { differ(`${name}: priced ${dp === null ? 'by hours' : 'all day'} here and ${dp === null ? 'all day' : 'by hours'} in v1`); continue; }
      const r = await step(`Price for ${name} (${slotLabel(slot)})`, (t) => setMenuOffer(actor, {
        storeId, variantId, channel: 'store', daypartId: dp,
        ...(free ? {} : { amount: slot.amount }),
        ...(slot.bundleHeads === null ? {} : { bundleHeads: slot.bundleHeads, extraHeadAmount: slot.extraHeadAmount ?? '0.00' }),
      }, t));
      if (r) made('prices', free ? `${name} (refill, free)` : `${name} ${slotLabel(slot)} ${peso(slot.amount)}`);
    }
  };

  // ---- refills and their flavours --------------------------------------------------------------------------------------------------
  const refillItem: Record<string, Sellable> = {};
  const flavoursOn = await menuRepo.optionOffersInForce(sp, storeId, now);
  const flavoursOff = await menuRepo.withdrawnOptionValueIds(sp, storeId, now);
  for (const r of plan.refills) {
    const it = await ensureItem('refill', r.name, 'Refills', r.sortOrder, { soldALaCarte: false, soldInPackageSession: false, dinerOrderable: true }, 'refills');
    if (!it) continue;
    refillItem[key(r.name)] = it;
    await ensureOffers(it.variantId, r.name, [{ daypart: null, amount: '0.00', bundleHeads: null, extraHeadAmount: null }], true);
    await route(it.itemId, r.name, r.stationName);
    if (!r.flavour) continue;
    const f = r.flavour;
    const catalog = await menuRepo.catalogOfOrg(sp, orgId);
    let group = catalog.optionGroups.find((g) => g.status === 'active' && key(g.name) === key(f.group));
    if (!group) {
      const made1 = await step(`Flavour group ${f.group}`, (t) => createOptionGroup(actor, { name: f.group, selectionMode: 'single', minSelections: 1, maxSelections: 1 }, t));
      if (!made1) continue;
      made('flavours', f.group);
      group = (await menuRepo.getOptionGroup(sp, orgId, made1.id))!;
    }
    const gid = group.id;
    const values = (await menuRepo.catalogOfOrg(sp, orgId)).optionValues.filter((v) => v.optionGroupId === gid);
    let order = 0;
    for (const v of f.values) {
      order++;
      let value = values.find((x) => x.status === 'active' && key(x.name) === key(v.name));
      if (!value) {
        const added = await step(`Flavour ${v.name}`, (t) => addOptionValue(actor, { optionGroupId: gid, name: v.name, sortOrder: order }, t));
        if (!added) continue;
        made('flavours', `${f.group}: ${v.name}`);
        value = (await menuRepo.getOptionValue(sp, orgId, added.id))!;
      }
      const vid = value.id;
      const on = flavoursOn.some((o) => o.optionValueId === vid && o.channel === 'store');
      if (v.onAtStore && !on && !flavoursOff.has(vid)) {
        if (await step(`Flavour ${v.name} on at the store`, (t) => setOptionOffer(actor, { storeId, optionValueId: vid, channel: 'store', priceDelta: '0.00' }, t))) made('flavours', `${v.name} on for ${r.name}`);
      } else if (!v.onAtStore && on) differ(`Flavour ${v.name}: off in v1, on here`);
      else if (v.onAtStore && flavoursOff.has(vid)) differ(`Flavour ${v.name}: on in v1, switched off here`);
      else same();
    }
    const linked = (await menuRepo.catalogOfOrg(sp, orgId)).optionGroupLinks.some((l) => l.optionGroupId === gid && l.menuItemId === it.itemId);
    if (linked) same();
    else if (await step(`Flavour group for ${r.name}`, (t) => linkOptionGroup(actor, { optionGroupId: gid, menuItemId: it.itemId }, t))) made('flavours', `${f.group} linked to ${r.name}`);
  }

  // ---- packages --------------------------------------------------------------------------------------------------------------------
  for (const p of plan.packages) {
    const it = await ensureItem('package', p.name, 'Packages', p.sortOrder, { soldALaCarte: false, soldInPackageSession: false, dinerOrderable: true }, 'packages');
    if (!it) continue;
    await ensureOffers(it.variantId, p.name, p.slots);
    await route(it.itemId, p.name, p.stationName);
    const want = p.refillNames.map((n) => refillItem[key(n)]?.itemId).filter((x): x is string => !!x);
    const have = await menuRepo.refillItemIdsOfPackage(sp, orgId, it.variantId);
    const missing = want.filter((id) => !have.includes(id));
    if (want.length < p.refillNames.length) report.skipped.push(`${p.name}: some refills in v1's list could not be set up, so they are not linked`);
    if (missing.length === 0) { same(); continue; }
    if (await step(`Refills for ${p.name}`, (t) => setPackageRefills(actor, { packageVariantId: it.variantId, refillItemIds: [...have, ...missing] }, t))) made('refill links', `${p.name}: ${missing.length} refill${missing.length === 1 ? '' : 's'}`);
  }

  // ---- à la carte ------------------------------------------------------------------------------------------------------------------
  for (const i of plan.items) {
    const it = await ensureItem('a_la_carte', i.name, i.category, i.sortOrder, { soldALaCarte: true, soldInPackageSession: true, dinerOrderable: i.dinerOrderable }, 'items');
    if (!it) continue;
    for (const v of i.variants) {
      let variantId = it.variantId;
      if (v.label !== null) {
        const have = (await menuRepo.variantsOfItem(sp, orgId, it.itemId)).find((x) => x.label !== null && key(x.label) === key(v.label!));
        if (have) variantId = have.id;
        else {
          const added = await step(`${i.name} ${v.label}`, (t) => addMenuVariant(actor, { menuItemId: it.itemId, label: v.label!, sortOrder: 0 }, t));
          if (!added) continue;
          variantId = added.id;
          made('items', `${i.name} ${v.label}`);
        }
      }
      await ensureOffers(variantId, v.label === null ? i.name : `${i.name} ${v.label}`, [{ daypart: null, amount: v.amount, bundleHeads: null, extraHeadAmount: null }]);
    }
    await route(it.itemId, i.name, i.stationName);
  }

  // ---- payment methods -------------------------------------------------------------------------------------------------------------
  for (const t of plan.tenders) {
    const all = await posV1Repo.listTendersByStore(sp, orgId, storeId);
    const alias = normalizePosV1Alias(t.alias);
    const have = all.find((x) => x.isActive && x.posV1Alias !== null && normalizePosV1Alias(x.posV1Alias) === alias) ?? all.find((x) => x.isActive && key(x.name) === key(t.name));
    if (have) {
      if (have.posV1Alias === null) {
        if (await step(`Payment method ${t.name}`, async (tx) => { await updateTender(tx, actor, { tenderId: have.id, posV1Alias: t.alias }); return true; })) made('payment methods', `${t.name}: v1 name filled in`);
      } else if (normalizePosV1Alias(have.posV1Alias) !== alias) differ(`Payment method ${t.name}: its v1 name is "${have.posV1Alias}" here`);
      else same();
      continue;
    }
    if (t.kind === 'wallet') { report.walletsNeedAccount.push(t.name); continue; }
    if (await step(`Payment method ${t.name}`, (tx) => createTender(tx, actor, { storeId, name: t.name, kind: 'cash', posV1Alias: t.alias }))) made('payment methods', t.name);
  }

  return report;
}

/** The menu part of the report as plain lines: counts and names only. */
export function formatMenuSetupReport(r: MenuSetupReport, dryRun: boolean): string[] {
  const verb = dryRun ? 'would be created' : 'created';
  const list = (xs: readonly string[]) => (xs.length ? xs.join(', ') : '-');
  const lines = ['MENU AND KITCHEN:'];
  for (const p of PARTS) lines.push(`  ${p} ${verb}: ${r.created[p].length} (${list(r.created[p])})`);
  lines.push(`  already there with the same value: ${r.unchanged}`);
  lines.push(`  DIFFERENT here, left as they are (Ian decides): ${r.differences.length}${r.differences.map((d) => `\n    ${d}`).join('')}`);
  lines.push(`  refused in words: ${r.refused.length}${r.refused.map((x) => `\n    ${x.name}: ${x.reason}`).join('')}`);
  lines.push(`  left out of v1: ${r.skipped.length}${r.skipped.map((s) => `\n    ${s}`).join('')}`);
  lines.push(`  given the placeholder "uses no stock" (set the real stock use in the ERP): ${r.noStockRule.length} (${list(r.noStockRule)})`);
  lines.push(`  wallet payment methods that need a money account first (add them in POS link settings): ${r.walletsNeedAccount.length} (${list(r.walletsNeedAccount)})`);
  lines.push('NOT COPIED (reported only):', ...r.notCopied.map((n) => `  ${n}`));
  return lines;
}
