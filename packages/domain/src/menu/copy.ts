/**
 * T-611 - "Copy from another store": menu hours and store prices (S1), kitchen stations and routes (S2). docs/tasks/611-copy-settings-between-stores.md.
 *
 * ONE store pair at a time. `previewCopyToStore` reads and writes nothing; `copySettingsToStore` plans again in the caller's transaction, then
 * writes ONLY through the existing writers (`createDaypart` / `updateDaypart` / `setMenuOffer` / `setOptionOffer` / `createKitchenStation` / `setKitchenRoute`), so their gates, guards
 * (T-610 overlap, 0233 slot rules, pairing authority), effective dating and per-write audit rows stay in force. Never raw SQL.
 * The plan is one function (`planCopy`), so the preview counts and the apply cannot disagree.
 *
 * Additive by default: a missing row is added, an identical one is left, a different one is KEPT unless `replace`. A price replaced is a NEW
 * row effective now (history is never edited); a variant the source does not offer is never withdrawn at the target, so a copy removes nothing.
 * The caller (the ERP action) verifies the administrator PIN and gives each target its own transaction; a refusal here rolls that target back.
 */
import { authorize, can, type Actor, type Capability } from '@shareat/auth';
import { accessRepo, daypartsRepo, kitchenRepo, menuRepo, storesRepo, type Tx } from '@shareat/db';
import type { MenuChannel } from '@shareat/db/schema';
import { gone, refuse } from '../shared/refusal';
import { createKitchenStation, setKitchenRoute } from '../kitchen';
import { createDaypart, updateDaypart } from './dayparts';
import { setMenuOffer, setOptionOffer } from './pricing';
import { audit } from './shared';

export type CopyKind = 'hours' | 'prices' | 'kitchen';
export interface CopyInput {
  kind: CopyKind;
  sourceStoreId: string;
  targetStoreId: string;
  /** Off by default: a target value that differs from the source is kept. On: it is replaced (prices: by a new row effective now). */
  replace: boolean;
}
export type CopyLineStatus = 'add' | 'same' | 'different' | 'skip';
export interface CopyLine {
  status: CopyLineStatus;
  what: string;
  /** Why it is skipped, or what the target has instead. */
  note?: string;
}
export interface CopyCounts {
  /** Rows added at the target. */
  added: number;
  /** Rows replaced (a different value and `replace` on). */
  replaced: number;
  /** Everything left as it was: identical, kept different, or skipped with a reason. */
  skipped: number;
  same: number;
  /** Different at the target and kept (`replace` off); with `replace` on they are counted in `replaced`. */
  kept: number;
}
export interface CopyPreview {
  targetStoreId: string;
  targetName: string;
  counts: CopyCounts;
  lines: CopyLine[];
}

type Op =
  | { op: 'daypart_create'; name: string; days: number[]; start: string; end: string }
  | { op: 'daypart_update'; id: string; days: number[]; start: string; end: string }
  | { op: 'offer'; variantId: string; channel: MenuChannel; daypartId: string | null; row: menuRepo.OfferPriceFields }
  | { op: 'option'; optionValueId: string; channel: MenuChannel; priceDelta: string }
  | { op: 'station_create'; name: string; slaMinutes: number; printOnOutage: boolean; sortOrder: number }
  | { op: 'route'; menuItemId: string; stationName: string };

const CAPABILITY: Record<CopyKind, Capability> = {
  hours: 'manage_store_settings',
  prices: 'set_menu_price',
  kitchen: 'manage_store_settings',
};
const hhmm = (t: string): string => t.slice(0, 5);
const key = (name: string): string => name.trim().toLowerCase();
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const windowText = (w: { days: readonly number[]; start: string; end: string }): string =>
  `${[...w.days].sort((a, b) => a - b).map((d) => DAY_SHORT[d]).join(', ')} ${w.start}-${w.end}`;
const sameWindow = (a: { days: readonly number[]; start: string; end: string }, b: { days: readonly number[]; start: string; end: string }): boolean =>
  windowText(a) === windowText(b);

/** The price figures that make two offers "the same price". Both sides are the database's own text, so equal means equal. */
const figures = (r: menuRepo.OfferPriceFields): string =>
  [r.pricingMode, r.amount, r.bundleHeads, r.extraHeadAmount, r.markupPercent, r.fixedMarkupAmount].join('|');

/** The actor, the stores and the capability, checked before anything is read or written. Returns the target's name. */
async function requireCopyRight(trx: Tx, actor: Actor, input: CopyInput): Promise<string> {
  if (!(await accessRepo.personIsActiveAdmin(trx, actor.orgId, actor.personId))) {
    throw refuse('copyFromStore: the actor is not an administrator.', 'Only an administrator can copy settings from one store to another.');
  }
  if (input.sourceStoreId === input.targetStoreId) {
    throw refuse('copyFromStore: source and target are the same store.', 'Choose a different store to copy to. A store cannot be copied onto itself.');
  }
  // The org check, in the domain on purpose: a store of another organisation is "no such store" here, never a store this person may touch.
  const source = await storesRepo.getById(trx, actor.orgId, input.sourceStoreId);
  if (!source) throw gone(`copyFromStore: store ${input.sourceStoreId} does not exist in this organisation.`, 'store');
  const target = await storesRepo.getById(trx, actor.orgId, input.targetStoreId);
  if (!target) throw gone(`copyFromStore: store ${input.targetStoreId} does not exist in this organisation.`, 'store');
  if (!target.isActive) throw refuse(`copyFromStore: store ${target.id} is not active.`, `${target.name} is closed, so nothing can be copied to it.`);
  await authorize(trx, actor, CAPABILITY[input.kind], { storeId: target.id });
  return target.name;
}

async function planHours(trx: Tx, orgId: string, source: string, target: string, replace: boolean): Promise<{ ops: Op[]; lines: CopyLine[] }> {
  const active = (rows: daypartsRepo.MenuDaypartRow[]) => rows.filter((d) => d.status === 'active');
  const theirs = new Map(active(await daypartsRepo.listDaypartsOfStore(trx, orgId, target)).map((d) => [key(d.name), d]));
  const ops: Op[] = [];
  const lines: CopyLine[] = [];
  for (const s of active(await daypartsRepo.listDaypartsOfStore(trx, orgId, source))) {
    const w = { days: [...s.days].sort((a, b) => a - b), start: hhmm(s.startTime), end: hhmm(s.endTime) };
    const t = theirs.get(key(s.name));
    if (!t) {
      ops.push({ op: 'daypart_create', name: s.name, ...w });
      lines.push({ status: 'add', what: `${s.name}: ${windowText(w)}` });
    } else if (sameWindow(w, { days: t.days, start: hhmm(t.startTime), end: hhmm(t.endTime) })) {
      lines.push({ status: 'same', what: `${s.name}: ${windowText(w)}` });
    } else {
      const have = windowText({ days: t.days, start: hhmm(t.startTime), end: hhmm(t.endTime) });
      if (replace) ops.push({ op: 'daypart_update', id: t.id, ...w });
      lines.push({ status: 'different', what: `${s.name}: ${windowText(w)}`, note: `The store has ${have}.` });
    }
  }
  return { ops, lines };
}

async function planPrices(trx: Tx, actor: Actor, source: string, target: string, targetName: string, replace: boolean): Promise<{ ops: Op[]; lines: CopyLine[] }> {
  const orgId = actor.orgId;
  const now = await menuRepo.dbNow(trx);
  const cat = await menuRepo.catalogOfOrg(trx, orgId);
  const items = new Map(cat.items.map((i) => [i.id, i]));
  const variants = new Map(cat.variants.map((v) => [v.id, v]));
  const groups = new Map(cat.optionGroups.map((g) => [g.id, g]));
  const values = new Map(cat.optionValues.map((v) => [v.id, v]));
  // Retired items, variants and options are not part of the live menu: they are never copied, and not listed.
  const variantLabel = (id: string): string | null => {
    const v = variants.get(id);
    const i = v ? items.get(v.menuItemId) : undefined;
    return !v || !i || v.status !== 'active' || i.status !== 'active' ? null : `${i.name}${v.label ? ` - ${v.label}` : ''}`;
  };
  const optionLabel = (id: string): string | null => {
    const v = values.get(id);
    const g = v ? groups.get(v.optionGroupId) : undefined;
    return !v || !g || v.status !== 'active' || g.status !== 'active' ? null : `${g.name}: ${v.name}`;
  };

  const hours = async (storeId: string) => (await daypartsRepo.listDaypartsOfStore(trx, orgId, storeId)).filter((d) => d.status === 'active');
  const sourceHours = new Map((await hours(source)).map((d) => [d.id, d]));
  const targetHours = new Map((await hours(target)).map((d) => [key(d.name), d]));
  const theirs = (await menuRepo.offersInForce(trx, target, now)).filter((o) => !o.withdrawn);
  const slot = (v: string, c: string, d: string | null) => `${v}|${c}|${d ?? ''}`;
  const theirSlots = new Map(theirs.map((o) => [slot(o.variantId, o.channel, o.daypartId), o]));
  const canPair = await can(trx, actor, 'pair_menu_dayparts', {});

  const ops: Op[] = [];
  const lines: CopyLine[] = [];
  for (const o of (await menuRepo.offersInForce(trx, source, now)).filter((x) => !x.withdrawn)) {
    const label = variantLabel(o.variantId);
    if (!label) continue;
    const sh = o.daypartId ? sourceHours.get(o.daypartId) : undefined;
    const what = `${label} (${o.channel}${sh ? `, ${sh.name}` : ''})`;
    if (o.daypartId && !sh) continue; // its hours are retired or gone: not a live price
    const th = sh ? targetHours.get(key(sh.name)) : undefined;
    if (sh && !th) {
      lines.push({ status: 'skip', what, note: `${targetName} has no hours called ${sh.name}. Copy the menu hours first.` });
      continue;
    }
    const to = th?.id ?? null;
    const have = theirSlots.get(slot(o.variantId, o.channel, to));
    const sameKey = (x: { variantId: string; channel: string }) => x.variantId === o.variantId && x.channel === o.channel;
    if (!have) {
      // The 0233 slot rule and the pairing rule would refuse these; say so as a skip instead of failing the whole store.
      if (to === null && theirs.some((x) => sameKey(x) && x.daypartId !== null)) {
        lines.push({ status: 'skip', what, note: `${targetName} prices this by time of day. Withdraw those prices first.` });
        continue;
      }
      if (to !== null && theirs.some((x) => sameKey(x) && x.daypartId === null)) {
        lines.push({ status: 'skip', what, note: `${targetName} has an all-day price for this. Withdraw it first.` });
        continue;
      }
      if (to !== null && !canPair) {
        lines.push({ status: 'skip', what, note: 'Only a super admin can set a new price by time of day.' });
        continue;
      }
      ops.push({ op: 'offer', variantId: o.variantId, channel: o.channel, daypartId: to, row: o });
      lines.push({ status: 'add', what });
    } else if (figures(have) === figures(o)) {
      lines.push({ status: 'same', what });
    } else {
      if (replace) ops.push({ op: 'offer', variantId: o.variantId, channel: o.channel, daypartId: to, row: o });
      lines.push({ status: 'different', what, note: `${targetName} has ${have.amount ?? have.pricingMode}.` });
    }
  }

  const theirOptions = new Map((await menuRepo.optionOffersInForce(trx, target, now)).map((o) => [`${o.optionValueId}|${o.channel}`, o]));
  for (const o of await menuRepo.optionOffersInForce(trx, source, now)) {
    const label = optionLabel(o.optionValueId);
    if (!label) continue;
    const what = `${label} (${o.channel})`;
    const have = theirOptions.get(`${o.optionValueId}|${o.channel}`);
    if (!have) {
      ops.push({ op: 'option', optionValueId: o.optionValueId, channel: o.channel, priceDelta: o.priceDelta });
      lines.push({ status: 'add', what });
    } else if (have.priceDelta === o.priceDelta) lines.push({ status: 'same', what });
    else {
      if (replace) ops.push({ op: 'option', optionValueId: o.optionValueId, channel: o.channel, priceDelta: o.priceDelta });
      lines.push({ status: 'different', what, note: `${targetName} has ${have.priceDelta}.` });
    }
  }
  return { ops, lines };
}

/**
 * Stations by name (a missing one is created with the source's minutes, screen order and print-on-outage; one that exists is left as it is), then
 * routes item -> station by the item and the station's NAME. Retired items and stations are not part of the live setup and are not copied.
 */
async function planKitchen(trx: Tx, orgId: string, source: string, target: string, replace: boolean): Promise<{ ops: Op[]; lines: CopyLine[] }> {
  const sStations = await kitchenRepo.listStations(trx, orgId, source);
  const tStations = await kitchenRepo.listStations(trx, orgId, target);
  const tByKey = new Map(tStations.map((s) => [key(s.name), s]));
  const ops: Op[] = [];
  const lines: CopyLine[] = [];
  for (const s of sStations) {
    if (tByKey.has(key(s.name))) lines.push({ status: 'same', what: `Station ${s.name}` });
    else {
      ops.push({ op: 'station_create', name: s.name, slaMinutes: s.slaMinutes, printOnOutage: s.printOnOutage, sortOrder: s.sortOrder });
      lines.push({ status: 'add', what: `Station ${s.name}` });
    }
  }
  const sName = new Map(sStations.map((s) => [s.id, s.name]));
  const tName = new Map(tStations.map((s) => [s.id, s.name]));
  const items = new Map((await menuRepo.catalogOfOrg(trx, orgId)).items.map((i) => [i.id, i]));
  const theirs = new Map((await kitchenRepo.listRoutes(trx, orgId, target)).map((r) => [r.menuItemId, r.stationId]));
  for (const r of await kitchenRepo.listRoutes(trx, orgId, source)) {
    const item = items.get(r.menuItemId);
    const station = sName.get(r.stationId);
    if (!item || item.status !== 'active' || !station) continue;
    const what = `${item.name} cooks at ${station}`;
    const haveId = theirs.get(r.menuItemId);
    const have = haveId ? tName.get(haveId) : undefined;
    if (!have) {
      ops.push({ op: 'route', menuItemId: r.menuItemId, stationName: station });
      lines.push({ status: 'add', what });
    } else if (key(have) === key(station)) lines.push({ status: 'same', what });
    else {
      if (replace) ops.push({ op: 'route', menuItemId: r.menuItemId, stationName: station });
      lines.push({ status: 'different', what, note: `The store has it at ${have}.` });
    }
  }
  return { ops, lines };
}

function countsOf(lines: CopyLine[], replace: boolean): CopyCounts {
  const n = (s: CopyLineStatus) => lines.filter((l) => l.status === s).length;
  const different = n('different');
  return {
    added: n('add'),
    replaced: replace ? different : 0,
    skipped: n('same') + n('skip') + (replace ? 0 : different),
    same: n('same'),
    kept: replace ? 0 : different,
  };
}

async function planCopy(trx: Tx, actor: Actor, input: CopyInput) {
  const targetName = await requireCopyRight(trx, actor, input);
  const { sourceStoreId: from, targetStoreId: to, replace } = input;
  const { ops, lines } =
    input.kind === 'hours'
      ? await planHours(trx, actor.orgId, from, to, replace)
      : input.kind === 'kitchen'
        ? await planKitchen(trx, actor.orgId, from, to, replace)
        : await planPrices(trx, actor, from, to, targetName, replace);
  return { targetName, ops, lines, counts: countsOf(lines, input.replace) };
}

/** What a copy to this store would do. Read-only; checks the same gates the copy does. Run inside the caller's transaction. */
export async function previewCopyToStore(actor: Actor, input: CopyInput, tx: Tx): Promise<CopyPreview> {
  const p = await planCopy(tx, actor, input);
  return { targetStoreId: input.targetStoreId, targetName: p.targetName, counts: p.counts, lines: p.lines };
}

/**
 * Copies to ONE target inside the caller's transaction (the caller gives each target its own, so one target's refusal never undoes another's) and
 * writes one `settings.copied` row with the counts. The administrator PIN is the caller's to verify before this runs.
 */
export async function copySettingsToStore(actor: Actor, input: CopyInput & { approverPersonId: string }, tx: Tx): Promise<CopyPreview> {
  const p = await planCopy(tx, actor, input);
  const to = input.targetStoreId;
  // Stations first: a route may point at a station this same copy creates.
  for (const o of p.ops) {
    if (o.op === 'station_create') await createKitchenStation(tx, actor, { storeId: to, name: o.name, slaMinutes: o.slaMinutes, printOnOutage: o.printOnOutage, sortOrder: o.sortOrder });
  }
  const stationIds = new Map<string, string>();
  if (p.ops.some((o) => o.op === 'route')) for (const s of await kitchenRepo.listStations(tx, actor.orgId, to)) stationIds.set(key(s.name), s.id);
  for (const o of p.ops) {
    if (o.op === 'station_create') continue;
    if (o.op === 'route') {
      const stationId = stationIds.get(key(o.stationName));
      if (!stationId) throw refuse(`copyFromStore: station ${o.stationName} missing after create`, `The kitchen station ${o.stationName} could not be found at ${p.targetName}.`);
      await setKitchenRoute(tx, actor, { storeId: to, menuItemId: o.menuItemId, stationId });
    } else if (o.op === 'daypart_create') await createDaypart(actor, { storeId: to, name: o.name, days: o.days, start: o.start, end: o.end }, tx);
    else if (o.op === 'daypart_update') await updateDaypart(actor, { id: o.id, days: o.days, start: o.start, end: o.end }, tx);
    else if (o.op === 'option') await setOptionOffer(actor, { storeId: to, optionValueId: o.optionValueId, channel: o.channel, priceDelta: o.priceDelta }, tx);
    else {
      const r = o.row;
      await setMenuOffer(
        actor,
        {
          storeId: to,
          variantId: o.variantId,
          channel: o.channel,
          daypartId: o.daypartId,
          pricingMode: r.pricingMode,
          ...(r.amount !== null ? { amount: r.amount } : {}),
          ...(r.markupPercent !== null ? { markupPercent: r.markupPercent } : {}),
          ...(r.fixedMarkupAmount !== null ? { fixedMarkupAmount: r.fixedMarkupAmount } : {}),
          ...(r.bundleHeads !== null ? { bundleHeads: r.bundleHeads } : {}),
          ...(r.extraHeadAmount !== null ? { extraHeadAmount: r.extraHeadAmount } : {}),
        },
        tx,
      );
    }
  }
  const { added, replaced, skipped } = p.counts;
  await audit(tx, actor, 'settings.copied', to, to, null, {
    kind: input.kind,
    sourceStoreId: input.sourceStoreId,
    replace: input.replace,
    added,
    replaced,
    skipped,
    approverPersonId: input.approverPersonId,
  });
  return { targetStoreId: to, targetName: p.targetName, counts: p.counts, lines: p.lines };
}
