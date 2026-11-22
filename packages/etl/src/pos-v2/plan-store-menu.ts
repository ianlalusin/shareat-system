/**
 * T-626 - what POS v1 says one store sells, turned into what POS v2 should hold. PURE: no database, no Firestore. docs/tasks/626-lipa-pos-setup-from-v1.md.
 *
 * The loader (`load-store-menu.ts`) APPLIES this plan and the parity check (`check-store-setup.ts`) COMPARES the store with it, so both read one answer.
 * The v1 shapes are the read-only source's output (`V1MenuSetup`); v1 is read as REQUIREMENTS, never as design (bible 1.2d). The mapping table is at the top of
 * `load-store-setup.ts`. Names are the key everywhere (matched within the store, case-insensitive); v1 document ids only link v1 rows to each other and are never printed.
 */
import { normalizePosV1Alias } from '@shareat/domain';

export interface V1Station { readonly id: string; readonly name: string; readonly sortOrder: number; readonly isActive: boolean; readonly slaMinutes: number | null; readonly printOnOutage: boolean }
/** `days` are v1's full day names ("Monday"); empty = every day. */
export interface V1Schedule { readonly id: string; readonly name: string; readonly isActive: boolean; readonly isArchived: boolean; readonly days: readonly string[]; readonly startTime: string; readonly endTime: string }
export interface V1Package {
  readonly id: string; readonly name: string; readonly isEnabled: boolean; readonly pricePerHead: number | null; readonly stationId: string | null;
  /** Refill document ids the package allows; EMPTY means every enabled refill (v1's rule). */
  readonly refillIds: readonly string[]; readonly sortOrder: number; readonly scheduleId: string | null;
  readonly isBundle: boolean; readonly bundlePrice: number | null; readonly bundleMaxCap: number | null; readonly bundleExtraHeadPrice: number | null;
}
export interface V1Refill {
  readonly id: string; readonly name: string; readonly isEnabled: boolean; readonly isOther: boolean; readonly sortOrder: number; readonly stationId: string | null;
  /** False only when the global refill exists and is switched off (v1 fails open on a missing global). */
  readonly globallyActive: boolean; readonly requiresFlavor: boolean; readonly allowedFlavorIds: readonly string[];
}
export interface V1Flavor { readonly id: string; readonly name: string; readonly isEnabled: boolean; readonly sortOrder: number; readonly globallyActive: boolean }
/** One `stores/{id}/inventory` row: a thing the store sells beside its packages when `isAddon` (v1's add-on picker). */
export interface V1Item {
  readonly name: string; readonly groupName: string | null; readonly variantLabel: string | null; readonly kind: string | null; readonly subCategory: string | null;
  readonly sellingPrice: number | null; readonly isActive: boolean; readonly isArchived: boolean; readonly isAddon: boolean; readonly stationId: string | null;
  readonly customerEnabled: boolean; readonly hasModifiers: boolean;
}
export interface V1PayMode { readonly name: string; readonly type: string; readonly isActive: boolean; readonly isArchived: boolean }
export interface V1Charge { readonly name: string; readonly isActive: boolean }
export interface V1MenuSetup {
  readonly stations: readonly V1Station[]; readonly schedules: readonly V1Schedule[]; readonly packages: readonly V1Package[]; readonly refills: readonly V1Refill[];
  readonly flavors: readonly V1Flavor[]; readonly items: readonly V1Item[]; readonly payModes: readonly V1PayMode[]; readonly charges: readonly V1Charge[];
}

export interface PlannedStation { name: string; sortOrder: number; slaMinutes: number | null; printOnOutage: boolean }
export interface PlannedDaypart { name: string; days: number[]; start: string; end: string }
/** `daypart: null` is an all-day price. Money is text with two decimals. */
export interface PlannedSlot { daypart: string | null; amount: string; bundleHeads: number | null; extraHeadAmount: string | null }
export interface PlannedFlavour { group: string; values: { name: string; onAtStore: boolean }[] }
export interface PlannedRefill { name: string; sortOrder: number; stationName: string | null; flavour: PlannedFlavour | null }
export interface PlannedPackage { name: string; sortOrder: number; stationName: string | null; refillNames: string[]; slots: PlannedSlot[] }
export interface PlannedItem {
  name: string; category: string; sortOrder: number; stationName: string | null; dinerOrderable: boolean;
  variants: { label: string | null; amount: string }[];
}
export interface PlannedTender { name: string; kind: 'cash' | 'wallet'; alias: string }
export interface MenuPlan {
  stations: PlannedStation[]; dayparts: PlannedDaypart[]; refills: PlannedRefill[]; packages: PlannedPackage[]; items: PlannedItem[]; tenders: PlannedTender[];
  /** Things v1 has that the plan leaves out, each with the reason (names only). */
  skipped: string[];
  /**
   * T-626 audit (BOSS ruling 1, 5): the lines of `skipped` that are something v1 SELLS and POS v2 will not (a package or item with no usable or pairable price,
   * hours a package needs that cannot be set up, a sold thing with no kitchen station). The parity check prints each as a GAP and fails.
   */
  gaps: string[];
  /** T-626 audit (rulings 6, 7): plain facts the check prints as NOTE and never fails on. */
  notes: string[];
  /** Plain lines about what is never copied. */
  notCopied: string[];
}

export const key = (s: string): string => s.trim().toLowerCase();

/**
 * T-626 audit ruling 7: what an EMPTY v1 `refillsAllowed` lets the cashier add. v1's package type documents empty as "every refill" (docs/tasks/401 R8 and :54, read from
 * the POS repo); the refill modal (RefillPOSModal.tsx ~:484) was not on the builder's PC to re-read, so this is the one switch to flip if it says otherwise.
 */
export const EMPTY_REFILL_LIST_MEANS_ALL = true;

/**
 * T-626 audit ruling 4: what the loader does with a package's refill links. Links are ADDED only to a package that has none; a package that already has its own list here
 * keeps it, and the v1 refills missing from it are a difference for Ian.
 */
export function refillLinkStep(have: readonly string[], want: readonly string[]): { kind: 'same' } | { kind: 'add'; ids: string[] } | { kind: 'differ'; missing: string[] } {
  const missing = want.filter((id) => !have.includes(id));
  if (missing.length === 0) return { kind: 'same' };
  return have.length === 0 ? { kind: 'add', ids: [...missing] } : { kind: 'differ', missing };
}

/**
 * T-626 audit ruling 3: an item whose v1 rows are ALL labelled ("Iced Tea" Glass / Pitcher) must not keep the unlabelled default variant `createMenuItem` makes, which would
 * sit there with no price. The loader names that default after the first label instead of adding a new variant. Only an unlabelled, unpriced default is reused, and only
 * when no variant already carries the label. Returns the label to give the default, or null.
 */
export function defaultVariantLabel(
  planned: readonly { label: string | null }[],
  variants: readonly { label: string | null; isDefault: boolean; active: boolean; priced: boolean }[],
): string | null {
  const first = planned[0]?.label;
  if (!first || planned.some((v) => v.label === null)) return null;
  const def = variants.find((v) => v.isDefault && v.active);
  if (!def || def.label !== null || def.priced) return null;
  return variants.some((v) => v.label !== null && key(v.label) === key(first)) ? null : first;
}

/** T-626 audit ruling 1: one failing parity-check row per thing v1 sells that the plan leaves out (`plan.gaps`). */
export function planGapRows(plan: Pick<MenuPlan, 'gaps'>): { kind: string; name: string; ok: boolean; detail: string }[] {
  return plan.gaps.map((line) => ({ kind: 'Not loadable from v1', name: line, ok: false, detail: 'v1 sells it; POS v2 will not until it is fixed' }));
}

/** T-626 audit ruling 3: variants of a priced item that are on sale with NO price (the parity check fails on each). */
export function unpricedOrderable(variants: readonly { label: string | null; channels: { store: { orderable: boolean; amount?: string | null } } }[]): string[] {
  return variants.filter((v) => v.channels.store.orderable && (v.channels.store.amount ?? null) === null).map((v) => v.label ?? 'default');
}

/** The one number-to-text edge, as v1-methods R4: whole centavos only (within 0.001), never negative; null otherwise. */
export function pesoText(n: number | null | undefined): string | null {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
  const scaled = n * 100;
  const c = Math.round(scaled);
  if (Math.abs(scaled - c) > 0.001) return null;
  return `${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;
}

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function planDaypart(s: V1Schedule): { ok: PlannedDaypart } | { skip: string } {
  const days: number[] = [];
  for (const raw of s.days) {
    const d = DAY_NAMES.findIndex((n) => n === key(raw) || n.slice(0, 3) === key(raw));
    if (d < 0) return { skip: `${s.name} (a day v1 spells "${raw}" is not a weekday)` };
    if (!days.includes(d)) days.push(d);
  }
  const time = (t: string): string | null => (/^\d{1,2}:\d{2}$/.test(t.trim()) && Number(t.split(':')[0]) < 24 && Number(t.split(':')[1]) < 60 ? t.trim().padStart(5, '0') : null);
  const start = time(s.startTime);
  const end = time(s.endTime);
  if (!start || !end) return { skip: `${s.name} (no usable start and end time in v1, where it meant all day)` };
  if (start === end) return { skip: `${s.name} (start and end are the same time)` };
  return { ok: { name: s.name.trim(), days: (days.length ? days : [0, 1, 2, 3, 4, 5, 6]).sort((a, b) => a - b), start, end } };
}

/** "LT-Pork and Chicken", "DT_Pork and Beef" -> "Pork and Chicken": v1 kept a lunch copy and a dinner copy of each package (bible rows 441-442). */
const baseName = (n: string): string => n.replace(/^\s*(?:LT|DT)\s*[-_]\s*/i, '').trim();

const sameSlot = (a: PlannedSlot, b: PlannedSlot): boolean => a.amount === b.amount && a.bundleHeads === b.bundleHeads && a.extraHeadAmount === b.extraHeadAmount;

export function planStoreMenu(v1: V1MenuSetup): MenuPlan {
  const skipped: string[] = [];
  const gaps: string[] = [];
  const notes: string[] = [];
  /** Left out AND something v1 sells: the check fails on it (ruling 1). */
  const gap = (line: string): void => { skipped.push(line); gaps.push(line); };
  const stationById = new Map(v1.stations.filter((s) => s.isActive).map((s) => [s.id, s.name.trim()]));
  const anyStationById = new Map(v1.stations.map((s) => [s.id, s.name.trim()]));
  const stationOf = (id: string | null): string | null => (id ? stationById.get(id) ?? null : null);
  /** Ruling 5: a sold thing whose v1 station is unset or switched off gets no route; it is named as a GAP, never left silent. */
  const stationFor = (what: string, ids: readonly (string | null)[]): string | null => {
    const found = ids.map(stationOf).find((n) => n !== null) ?? null;
    if (found === null) {
      const off = ids.map((id) => (id ? anyStationById.get(id) : undefined)).find((n) => n !== undefined);
      gap(`${what}: no kitchen station in v1 (${off ? `its station ${off} is switched off` : 'none set'}), so it has no route`);
    }
    return found;
  };

  const stations: PlannedStation[] = [];
  for (const s of v1.stations) {
    if (!s.isActive) { skipped.push(`Kitchen station ${s.name} (switched off in v1)`); continue; }
    const sla = s.slaMinutes !== null && Number.isInteger(s.slaMinutes) && s.slaMinutes >= 1 && s.slaMinutes <= 240 ? s.slaMinutes : null;
    stations.push({ name: s.name.trim(), sortOrder: s.sortOrder, slaMinutes: sla, printOnOutage: s.printOnOutage });
  }

  // Hours: worked out per schedule now, but only the ones a package ends up priced in are set up (ruling 2, after the packages below).
  const scheduleById = new Map(v1.schedules.map((s) => [s.id, s]));
  const loadable = new Map<string, PlannedDaypart>();
  const unloadable = new Map<string, string>();
  for (const s of v1.schedules) {
    if (!s.isActive || s.isArchived) continue;
    const d = planDaypart(s);
    if ('skip' in d) unloadable.set(s.id, d.skip);
    else loadable.set(s.id, d.ok);
  }
  const hoursGapped = new Set<string>();

  // Flavours: one value per flavour a refill may take; a store's switch is an offer on the value (v2 flavours are option values of the refill's group).
  const flavourById = new Map(v1.flavors.filter((f) => f.globallyActive).map((f) => [f.id, f]));
  const refills: PlannedRefill[] = [];
  const refillNameById = new Map<string, string>();
  for (const r of v1.refills) {
    if (!r.isEnabled || !r.globallyActive) { skipped.push(`Refill ${r.name} (switched off in v1)`); continue; }
    refillNameById.set(r.id, r.name.trim());
    let flavour: PlannedFlavour | null = null;
    if (r.requiresFlavor) {
      const ids = r.allowedFlavorIds.length ? r.allowedFlavorIds.filter((id) => flavourById.has(id)) : [...flavourById.keys()];
      const picked = ids.map((id) => flavourById.get(id)!).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
      if (picked.length) flavour = { group: r.allowedFlavorIds.length ? `Flavour - ${r.name.trim()}` : 'Flavour', values: picked.map((f) => ({ name: f.name.trim(), onAtStore: f.isEnabled })) };
    }
    refills.push({ name: r.name.trim(), sortOrder: r.sortOrder, stationName: stationFor(`Refill ${r.name.trim()}`, [r.stationId]), flavour });
  }

  // Packages: pair the lunch and dinner copies by name, then price them (ruled by Ian, rows 441-442).
  const rows = new Map<string, { name: string; rows: { r: V1Package; slot: PlannedSlot }[] }>();
  for (const p of v1.packages) {
    if (!p.isEnabled) { skipped.push(`Package ${p.name} (switched off in v1)`); continue; }
    // Ruling 6: a package tied to hours that are switched off (or archived) in v1 is not on sale there; it is not priced all day here.
    const sched = p.scheduleId ? scheduleById.get(p.scheduleId) : undefined;
    if (sched && (!sched.isActive || sched.isArchived)) {
      const line = `Package ${p.name}: not on sale in v1 (its hours are off)`;
      skipped.push(line);
      notes.push(line);
      continue;
    }
    const bundle = p.isBundle;
    const amount = pesoText(bundle ? p.bundlePrice : p.pricePerHead);
    const extra = bundle ? pesoText(p.bundleExtraHeadPrice ?? 0) : null;
    const heads = bundle && p.bundleMaxCap !== null && Number.isInteger(p.bundleMaxCap) && p.bundleMaxCap >= 1 ? p.bundleMaxCap : null;
    if (amount === null || amount === '0.00' || (bundle && (heads === null || extra === null))) { gap(`Package ${p.name} (no usable price in v1)`); continue; }
    const scheduleName = p.scheduleId ? loadable.get(p.scheduleId)?.name ?? null : null;
    if (p.scheduleId && scheduleName === null) {
      const why = unloadable.get(p.scheduleId);
      if (why !== undefined && !hoursGapped.has(p.scheduleId)) { hoursGapped.add(p.scheduleId); gap(`Hours ${why}`); }
      gap(`Package ${p.name}: its hours are not loadable, so it is priced all day (v1 did the same)`);
    }
    const name = baseName(p.name) || p.name.trim();
    const g = rows.get(key(name)) ?? { name, rows: [] };
    g.rows.push({ r: p, slot: { daypart: scheduleName, amount, bundleHeads: heads, extraHeadAmount: extra } });
    rows.set(key(name), g);
  }
  const packages: PlannedPackage[] = [];
  for (const g of rows.values()) {
    let slots: PlannedSlot[];
    if (g.rows.every((x) => sameSlot(x.slot, g.rows[0]!.slot))) {
      // One price (or one copy): a single all-day price when there are two copies at the same price, else the copy's own window.
      slots = g.rows.length === 1 ? [g.rows[0]!.slot] : [{ ...g.rows[0]!.slot, daypart: null }];
    } else {
      const names = g.rows.map((x) => x.slot.daypart);
      if (names.some((n) => n === null) || new Set(names.map((n) => key(n!))).size !== names.length) {
        gap(`Package ${g.name} (its copies have different prices but not one window each: pair them by hand)`);
        continue;
      }
      slots = g.rows.map((x) => x.slot);
    }
    const wantsAll = g.rows.some((x) => x.r.refillIds.length === 0);
    if (wantsAll) notes.push(`Package ${g.name}: v1 lists no refills for it, so it gets ${EMPTY_REFILL_LIST_MEANS_ALL ? 'every enabled refill' : 'none'} (as v1's cashier screen)`);
    const listed = [...new Set(g.rows.flatMap((x) => x.r.refillIds).map((id) => refillNameById.get(id)).filter((n): n is string => !!n))];
    const refillNames = wantsAll && EMPTY_REFILL_LIST_MEANS_ALL ? [...refillNameById.values()] : listed;
    const station = stationFor(`Package ${g.name}`, g.rows.map((x) => x.r.stationId));
    packages.push({ name: g.name, sortOrder: Math.min(...g.rows.map((x) => x.r.sortOrder)), stationName: station, refillNames, slots });
  }

  // Ruling 2: only the hours some package is priced in are set up; the rest are named and left out.
  const used = new Set(packages.flatMap((p) => p.slots.flatMap((s) => (s.daypart === null ? [] : [key(s.daypart)]))));
  const dayparts: PlannedDaypart[] = [];
  for (const d of loadable.values()) {
    if (dayparts.some((x) => key(x.name) === key(d.name))) continue;
    if (used.has(key(d.name))) dayparts.push(d);
    else skipped.push(`Hours ${d.name} (no package on sale is priced in them, so they are not set up)`);
  }
  for (const [id, why] of unloadable) if (!hoursGapped.has(id)) skipped.push(`Hours ${why}`);

  // À la carte: v1's add-ons (an inventory row switched on as an add-on). Grouped rows ("Soda" 8oz / 12oz) become one item with variants.
  const itemRows = new Map<string, PlannedItem>();
  const itemStationIds = new Map<string, (string | null)[]>();
  let withModifiers = 0;
  for (const i of v1.items) {
    if (!i.isAddon) continue;
    if (!i.isActive || i.isArchived) { skipped.push(`Item ${i.name} (switched off or archived in v1)`); continue; }
    const amount = pesoText(i.sellingPrice);
    if (amount === null || amount === '0.00') { gap(`Item ${i.name} (no usable price in v1)`); continue; }
    const grouped = i.kind === 'variant' && !!i.groupName?.trim() && !!i.variantLabel?.trim();
    const name = grouped ? i.groupName!.trim() : i.variantLabel?.trim() ? `${i.name.trim()} (${i.variantLabel.trim()})` : i.name.trim();
    const label = grouped ? i.variantLabel!.trim() : null;
    if (i.hasModifiers) withModifiers++;
    const cur = itemRows.get(key(name)) ?? { name, category: i.subCategory?.trim() || 'Add-ons', sortOrder: 0, stationName: null, dinerOrderable: false, variants: [] };
    if (cur.variants.some((v) => (v.label === null ? '' : key(v.label)) === (label === null ? '' : key(label)))) { gap(`Item ${i.name} (same name twice in v1)`); continue; }
    cur.variants.push({ label, amount });
    itemStationIds.set(key(name), [...(itemStationIds.get(key(name)) ?? []), i.stationId]);
    cur.dinerOrderable ||= i.customerEnabled;
    itemRows.set(key(name), cur);
  }
  for (const it of itemRows.values()) it.stationName = stationFor(`Item ${it.name}`, itemStationIds.get(key(it.name)) ?? []);

  const tenders: PlannedTender[] = [];
  for (const m of v1.payModes) {
    if (!m.isActive || m.isArchived) { skipped.push(`Payment method ${m.name} (switched off or archived in v1)`); continue; }
    if (!normalizePosV1Alias(m.name)) { skipped.push(`Payment method ${m.name} (no letters or digits in its name)`); continue; }
    tenders.push({ name: m.name.trim(), kind: m.type === 'cash' ? 'cash' : 'wallet', alias: m.name.trim() });
  }

  const charges = v1.charges.filter((c) => c.isActive).map((c) => c.name.trim());
  const notCopied = [
    `Service and other charges in v1: ${charges.length}${charges.length ? ` (${charges.join(', ')})` : ''}. Not copied: Ian decides.`,
    'Reservation deposits: not copied, Ian decides.',
    'Staff and their PINs, printers (set per tablet) and receipt text (organisation and store settings): not copied.',
    `Online prices and the customer app are not copied.${withModifiers ? ` ${withModifiers} item${withModifiers === 1 ? ' has' : 's have'} modifier groups in v1; those are not copied.` : ''}`,
    ...(v1.refills.some((r) => r.isOther) ? ['v1 lists some refills under "Other refills"; v2 has no such flag, so they sit with the rest.'] : []),
  ];

  return { stations, dayparts, refills, packages, items: [...itemRows.values()], tenders, skipped, gaps, notes, notCopied };
}
