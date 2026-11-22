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
  /** Plain lines about what is never copied. */
  notCopied: string[];
}

export const key = (s: string): string => s.trim().toLowerCase();

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
  const stationById = new Map(v1.stations.filter((s) => s.isActive).map((s) => [s.id, s.name.trim()]));
  const stationOf = (id: string | null): string | null => (id ? stationById.get(id) ?? null : null);

  const stations: PlannedStation[] = [];
  for (const s of v1.stations) {
    if (!s.isActive) { skipped.push(`Kitchen station ${s.name} (switched off in v1)`); continue; }
    const sla = s.slaMinutes !== null && Number.isInteger(s.slaMinutes) && s.slaMinutes >= 1 && s.slaMinutes <= 240 ? s.slaMinutes : null;
    stations.push({ name: s.name.trim(), sortOrder: s.sortOrder, slaMinutes: sla, printOnOutage: s.printOnOutage });
  }

  const dayparts: PlannedDaypart[] = [];
  const daypartOfSchedule = new Map<string, string>();
  for (const s of v1.schedules) {
    if (!s.isActive || s.isArchived) continue;
    const d = planDaypart(s);
    if ('skip' in d) { skipped.push(`Hours ${d.skip}`); continue; }
    dayparts.push(d.ok);
    daypartOfSchedule.set(s.id, d.ok.name);
  }

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
    refills.push({ name: r.name.trim(), sortOrder: r.sortOrder, stationName: stationOf(r.stationId), flavour });
  }

  // Packages: pair the lunch and dinner copies by name, then price them (ruled by Ian, rows 441-442).
  const rows = new Map<string, { name: string; rows: { r: V1Package; slot: PlannedSlot }[] }>();
  for (const p of v1.packages) {
    if (!p.isEnabled) { skipped.push(`Package ${p.name} (switched off in v1)`); continue; }
    const bundle = p.isBundle;
    const amount = pesoText(bundle ? p.bundlePrice : p.pricePerHead);
    const extra = bundle ? pesoText(p.bundleExtraHeadPrice ?? 0) : null;
    const heads = bundle && p.bundleMaxCap !== null && Number.isInteger(p.bundleMaxCap) && p.bundleMaxCap >= 1 ? p.bundleMaxCap : null;
    if (amount === null || amount === '0.00' || (bundle && (heads === null || extra === null))) { skipped.push(`Package ${p.name} (no usable price in v1)`); continue; }
    const scheduleName = p.scheduleId ? daypartOfSchedule.get(p.scheduleId) ?? null : null;
    if (p.scheduleId && scheduleName === null) skipped.push(`Package ${p.name}: its hours are not loadable, so it is priced all day (v1 did the same)`);
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
        skipped.push(`Package ${g.name} (its copies have different prices but not one window each: pair them by hand)`);
        continue;
      }
      slots = g.rows.map((x) => x.slot);
    }
    const wantsAll = g.rows.some((x) => x.r.refillIds.length === 0);
    const refillNames = wantsAll ? [...refillNameById.values()] : [...new Set(g.rows.flatMap((x) => x.r.refillIds).map((id) => refillNameById.get(id)).filter((n): n is string => !!n))];
    const station = g.rows.map((x) => stationOf(x.r.stationId)).find((n) => n !== null) ?? null;
    packages.push({ name: g.name, sortOrder: Math.min(...g.rows.map((x) => x.r.sortOrder)), stationName: station, refillNames, slots });
  }

  // À la carte: v1's add-ons (an inventory row switched on as an add-on). Grouped rows ("Soda" 8oz / 12oz) become one item with variants.
  const itemRows = new Map<string, PlannedItem>();
  let withModifiers = 0;
  for (const i of v1.items) {
    if (!i.isAddon) continue;
    if (!i.isActive || i.isArchived) { skipped.push(`Item ${i.name} (switched off or archived in v1)`); continue; }
    const amount = pesoText(i.sellingPrice);
    if (amount === null || amount === '0.00') { skipped.push(`Item ${i.name} (no usable price in v1)`); continue; }
    const grouped = i.kind === 'variant' && !!i.groupName?.trim() && !!i.variantLabel?.trim();
    const name = grouped ? i.groupName!.trim() : i.variantLabel?.trim() ? `${i.name.trim()} (${i.variantLabel.trim()})` : i.name.trim();
    const label = grouped ? i.variantLabel!.trim() : null;
    if (i.hasModifiers) withModifiers++;
    const cur = itemRows.get(key(name)) ?? { name, category: i.subCategory?.trim() || 'Add-ons', sortOrder: 0, stationName: null, dinerOrderable: false, variants: [] };
    if (cur.variants.some((v) => (v.label === null ? '' : key(v.label)) === (label === null ? '' : key(label)))) { skipped.push(`Item ${i.name} (same name twice in v1)`); continue; }
    cur.variants.push({ label, amount });
    cur.stationName ??= stationOf(i.stationId);
    cur.dinerOrderable ||= i.customerEnabled;
    itemRows.set(key(name), cur);
  }

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

  return { stations, dayparts, refills, packages, items: [...itemRows.values()], tenders, skipped, notCopied };
}
