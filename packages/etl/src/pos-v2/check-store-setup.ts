/**
 * T-626 - the parity check: is what POS v1 says one store sells really in POS v2, and does the tablet's own menu carry it? docs/tasks/626-lipa-pos-setup-from-v1.md.
 *
 * READ-ONLY: it writes nothing and no audit row. It reads v1 through the same source the load uses, makes the same `MenuPlan`, and compares the store with it kind by kind
 * (kitchen stations, hours, refills, flavours, packages, a-la-carte items, payment methods); then it reads the menu the TABLET gets (`buildPosSnapshot` when the store has a
 * live paired till, else `loadStoreMenu`) and checks that every copied item is in it, with the right price for the hours that are open now, and a kitchen route.
 * Every row is OK or a GAP; one gap fails the check (the script exits 1). Names and money only, never a Firestore id.
 */
import { kitchenRepo, menuRepo, daypartsRepo, posTabletPairingsRepo, posStoreSetupRepo, posV1Repo, posV2Repo, refuse, RefusalError, type Tx } from '@shareat/db';
import { buildPosSnapshot, daypartContains, loadStoreMenu, normalizePosV1Alias, type PosDeps } from '@shareat/domain';
import { key, planStoreMenu, type MenuPlan, type PlannedSlot } from './plan-store-menu';
import type { V1StoreSetupSource } from './load-store-setup';

export interface CheckRow { readonly kind: string; readonly name: string; readonly ok: boolean; readonly detail: string }
export interface StoreSetupCheck { readonly ok: boolean; readonly rows: CheckRow[]; readonly notes: string[] }

type Menu = Awaited<ReturnType<typeof loadStoreMenu>>['menu'];
const peso = (s: string): string => `₱${s}`;
const slotText = (s: PlannedSlot): string => `${s.daypart ?? 'all day'} ${peso(s.amount)}`;

export async function checkStoreSetup(
  tx: Tx,
  input: { orgId: string; storeId: string; /** Tests only: the instant "now's hours" are judged at (and the menu is read at). */ now?: Date; /** Tests only: the snapshot's injectable rule reader. */ deps?: PosDeps },
  source: V1StoreSetupSource,
): Promise<StoreSetupCheck> {
  const { orgId, storeId } = input;
  const posStoreId = await posStoreSetupRepo.getLivePosStoreId(tx, orgId, storeId);
  if (!posStoreId) throw refuse(`checkStoreSetup: store ${storeId} has no live v1 link`, 'This store is not linked to POS v1, so there is nothing to compare.');
  if (!source.readMenu) throw refuse('checkStoreSetup: source cannot read a menu', 'The v1 reader cannot read the menu.');
  const plan: MenuPlan = planStoreMenu(await source.readMenu(posStoreId));
  const rows: CheckRow[] = [];
  const notes: string[] = [];
  const row = (kind: string, name: string, problems: string[], good: string): void => { rows.push({ kind, name, ok: problems.length === 0, detail: problems.length ? problems.join('; ') : good }); };

  const at = input.now ?? (await menuRepo.dbNow(tx));
  const catalog = await menuRepo.catalogOfOrg(tx, orgId);
  const stations = await kitchenRepo.listStations(tx, orgId, storeId);
  const routes = new Map((await kitchenRepo.listRoutes(tx, orgId, storeId)).map((r) => [r.menuItemId, r.stationId]));
  const live = (await menuRepo.offersInForce(tx, storeId, await menuRepo.dbNow(tx))).filter((o) => o.channel === 'store' && !o.withdrawn);
  const flavoursOn = new Set((await menuRepo.optionOffersInForce(tx, storeId, await menuRepo.dbNow(tx))).filter((o) => o.channel === 'store').map((o) => o.optionValueId));
  const dayparts = (await daypartsRepo.listDaypartsOfStore(tx, orgId, storeId)).filter((d) => d.status === 'active');
  const daypartId = (name: string): string | undefined => dayparts.find((d) => key(d.name) === key(name))?.id;
  const stationName = (id: string | undefined): string => stations.find((s) => s.id === id)?.name ?? 'none';

  for (const s of plan.stations) {
    const have = stations.find((x) => key(x.name) === key(s.name));
    const p: string[] = [];
    if (!have) p.push('missing here');
    else {
      if (s.slaMinutes !== null && s.slaMinutes !== have.slaMinutes) p.push(`serve time ${s.slaMinutes} min in v1, ${have.slaMinutes} here`);
      if (s.printOnOutage !== have.printOnOutage) p.push('print-when-offline differs');
    }
    row('Kitchen station', s.name, p, `${have?.slaMinutes ?? '?'} min`);
  }
  for (const d of plan.dayparts) {
    const have = dayparts.find((x) => key(x.name) === key(d.name));
    const win = (days: readonly number[], a: string, b: string) => `${[...days].sort((x, y) => x - y).join('')} ${a.slice(0, 5)}-${b.slice(0, 5)}`;
    const p = !have ? ['missing here'] : win(have.days, have.startTime, have.endTime) !== win(d.days, d.start, d.end) ? [`${d.start}-${d.end} in v1, ${have.startTime.slice(0, 5)}-${have.endTime.slice(0, 5)} here`] : [];
    row('Hours', d.name, p, `${d.start}-${d.end}`);
  }

  const itemOf = (type: 'package' | 'refill' | 'a_la_carte', name: string) => catalog.items.find((i) => i.itemType === type && i.status === 'active' && key(i.name) === key(name));
  const variantsOf = (itemId: string) => catalog.variants.filter((v) => v.menuItemId === itemId && v.status === 'active');
  const routeProblem = (itemId: string, planned: string | null): string[] => {
    if (!planned) return [];
    const sid = routes.get(itemId);
    return !sid ? [`no kitchen station (v1: ${planned})`] : key(stationName(sid)) !== key(planned) ? [`station ${planned} in v1, ${stationName(sid)} here`] : [];
  };
  const priceProblems = (variantId: string, slots: PlannedSlot[], what: string): string[] => {
    const p: string[] = [];
    for (const s of slots) {
      const dp = s.daypart === null ? null : daypartId(s.daypart) ?? undefined;
      const here = dp === undefined ? undefined : live.find((o) => o.variantId === variantId && o.daypartId === dp);
      if (!here) p.push(`${what} ${s.daypart ?? 'all-day'} price missing (${peso(s.amount)} in v1)`);
      else if (here.amount !== s.amount || here.bundleHeads !== s.bundleHeads || (s.bundleHeads !== null && here.extraHeadAmount !== s.extraHeadAmount)) p.push(`${what} ${s.daypart ?? 'all-day'}: ${peso(s.amount)} in v1, ${here.amount === null ? 'none' : peso(here.amount)} here`);
    }
    return p;
  };

  for (const r of plan.refills) {
    const it = itemOf('refill', r.name);
    const p: string[] = [];
    if (!it) p.push('missing here');
    else {
      const v = variantsOf(it.id)[0];
      if (!v || !live.some((o) => o.variantId === v.id)) p.push('not on sale here');
      p.push(...routeProblem(it.id, r.stationName));
      if (r.flavour) {
        const f = r.flavour;
        const group = catalog.optionGroups.find((g) => g.status === 'active' && key(g.name) === key(f.group));
        if (!group || !catalog.optionGroupLinks.some((l) => l.optionGroupId === group.id && l.menuItemId === it.id)) p.push(`flavour group ${f.group} is not linked`);
        else {
          for (const val of f.values.filter((x) => x.onAtStore)) {
            const have = catalog.optionValues.find((x) => x.optionGroupId === group.id && x.status === 'active' && key(x.name) === key(val.name));
            if (!have || !flavoursOn.has(have.id)) p.push(`flavour ${val.name} is not on`);
          }
        }
      }
    }
    row('Refill', r.name, p, r.flavour ? `${r.flavour.values.filter((v) => v.onAtStore).length} flavours` : 'on sale');
  }

  for (const pk of plan.packages) {
    const it = itemOf('package', pk.name);
    const p: string[] = [];
    if (!it) p.push('missing here');
    else {
      const v = variantsOf(it.id).find((x) => x.isDefault);
      if (!v) p.push('no default variant');
      else {
        p.push(...priceProblems(v.id, pk.slots, ''));
        const have = new Set(catalog.packageRefills.filter((l) => l.packageVariantId === v.id && l.status === 'active').map((l) => l.refillItemId));
        for (const n of pk.refillNames) {
          const ri = itemOf('refill', n);
          if (!ri || !have.has(ri.id)) p.push(`refill link to ${n} missing`);
        }
      }
      p.push(...routeProblem(it.id, pk.stationName));
    }
    row('Package', pk.name, p, `${pk.slots.map(slotText).join(', ')}; ${pk.refillNames.length} refills`);
  }

  for (const i of plan.items) {
    const it = itemOf('a_la_carte', i.name);
    const p: string[] = [];
    if (!it) p.push('missing here');
    else {
      for (const v of i.variants) {
        const have = v.label === null ? variantsOf(it.id).find((x) => x.isDefault) : variantsOf(it.id).find((x) => x.label !== null && key(x.label) === key(v.label!));
        if (!have) p.push(`${v.label ?? 'item'} variant missing`);
        else p.push(...priceProblems(have.id, [{ daypart: null, amount: v.amount, bundleHeads: null, extraHeadAmount: null }], v.label ?? ''));
      }
      p.push(...routeProblem(it.id, i.stationName));
    }
    row('Item', i.name, p, i.variants.map((v) => `${v.label ? `${v.label} ` : ''}${peso(v.amount)}`).join(', '));
  }

  const tenders = (await posV1Repo.listTendersByStore(tx, orgId, storeId)).filter((t) => t.isActive);
  for (const t of plan.tenders) {
    const have = tenders.find((x) => x.posV1Alias !== null && normalizePosV1Alias(x.posV1Alias) === normalizePosV1Alias(t.alias));
    row('Payment method', t.name, !have ? ['no active payment method here answers to this v1 name'] : have.kind !== t.kind ? [`${t.kind} in v1, ${have.kind} here`] : [], have?.name ?? '');
  }

  // ---- what the TABLET gets -------------------------------------------------------------------------------------------------------
  let menu: Menu | undefined;
  let snapshotTenders: string[] | null = null;
  const timeZone = (await daypartsRepo.storeTimezone(tx, storeId)) ?? 'Asia/Manila';
  const pairing = input.now ? undefined : (await posTabletPairingsRepo.listForStores(tx, orgId, [storeId])).find((x) => x.revokedAt === null);
  const terminal = pairing ? await posV2Repo.getTerminalForPairing(tx, orgId, storeId, pairing.id) : undefined;
  if (pairing && terminal) {
    try {
      const snap = await buildPosSnapshot(tx, { pairing: { orgId, storeId, pairingId: pairing.id } }, input.deps);
      menu = snap.body.menu.menu;
      snapshotTenders = snap.body.tenders.map((t) => t.name);
      row('Tablet snapshot', 'stands', snap.body.stands.length === 0 ? ['no stands'] : [], `${snap.body.stands.length} stands`);
    } catch (e) {
      if (!(e instanceof RefusalError)) throw e;
      notes.push(`The tablet snapshot could not be built (${e.userMessage}), so the menu was read with the loader the tablet uses.`);
    }
  }
  if (!menu) {
    menu = (await loadStoreMenu(tx, orgId, storeId, input.now)).menu;
    if (!notes.length) notes.push(input.now ? 'The menu was read as of the time given.' : 'No paired tablet with a till at this store: the menu was read with the same loader the tablet uses, but no snapshot was built.');
  }
  const tablet: Menu = menu;
  if (snapshotTenders) for (const t of plan.tenders) row('Tablet snapshot', `payment method ${t.name}`, snapshotTenders.some((n) => key(n) === key(t.name)) ? [] : ['not in the tablet snapshot'], 'in the snapshot');

  const open = (d: string): boolean => {
    const w = plan.dayparts.find((x) => key(x.name) === key(d));
    return !!w && daypartContains({ id: '', days: w.days, start: w.start, end: w.end }, at, timeZone);
  };
  const onTablet = (type: 'package' | 'refill' | 'a_la_carte', name: string) => tablet.items.find((i) => i.itemType === type && key(i.name) === key(name));
  const tabletRow = (kind: string, name: string, type: 'package' | 'refill' | 'a_la_carte', slots: { label: string | null; slots: PlannedSlot[] }[], station: string | null): void => {
    const it = onTablet(type, name);
    const p: string[] = [];
    if (!it) p.push('not in the tablet menu');
    else {
      if (station && !it.stationId) p.push('no kitchen route, so it stays off the tablet');
      for (const want of slots) {
        const v = it.variants.find((x) => (want.label === null ? x.isDefault : x.label !== null && key(x.label) === key(want.label)));
        const now = want.slots.length === 1 && want.slots[0]!.daypart === null ? want.slots[0] : want.slots.find((s) => s.daypart !== null && open(s.daypart));
        if (!v) p.push(`${want.label ?? 'item'} not in the tablet menu`);
        else if (!now) { if (v.channels.store.orderable) p.push(`${want.label ?? name} is on sale now but v1 has no price for these hours`); }
        else if (!v.channels.store.orderable) p.push(`${want.label ?? name} is not on sale now (expected ${peso(now.amount)} for ${now.daypart ?? 'all day'})`);
        else if (type !== 'refill' && v.channels.store.amount !== now.amount) p.push(`${want.label ?? name} shows ${(v.channels.store.amount === null ? 'no price' : peso(v.channels.store.amount))} now, v1 says ${peso(now.amount)} for ${now.daypart ?? 'all day'}`);
      }
    }
    row(kind, name, p, 'in the tablet menu at the right price');
  };
  for (const r of plan.refills) tabletRow('Tablet menu: refill', r.name, 'refill', [{ label: null, slots: [{ daypart: null, amount: '0.00', bundleHeads: null, extraHeadAmount: null }] }], r.stationName);
  for (const pk of plan.packages) tabletRow('Tablet menu: package', pk.name, 'package', [{ label: null, slots: pk.slots }], pk.stationName);
  for (const i of plan.items) tabletRow('Tablet menu: item', i.name, 'a_la_carte', i.variants.map((v) => ({ label: v.label, slots: [{ daypart: null, amount: v.amount, bundleHeads: null, extraHeadAmount: null }] })), i.stationName);

  return { ok: rows.every((r) => r.ok), rows, notes };
}

/** The check as a plain table, one row per line, gaps first in the summary. */
export function formatStoreSetupCheck(c: StoreSetupCheck): string[] {
  const gaps = c.rows.filter((r) => !r.ok);
  return [
    ...c.rows.map((r) => `${r.ok ? 'OK ' : 'GAP'}  ${r.kind.padEnd(24)} ${r.name}: ${r.detail}`),
    ...c.notes.map((n) => `NOTE ${n}`),
    c.ok ? `ALL ${c.rows.length} CHECKS PASS.` : `${gaps.length} OF ${c.rows.length} CHECKS FAILED.`,
  ];
}
