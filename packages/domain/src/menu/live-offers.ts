/**
 * T-510 S1b - which offers a store shows RIGHT NOW, when a variant can hold several live offers at once (one per daypart).
 * docs/tasks/510-menu-dayparts.md R4.
 *
 * `menuRepo.offersInForce` returns RAW rows: per variant and channel, every live daypart slot, or one withdrawn row. A reader that
 * keeps "the last row" would show the wrong price. Production code resolves through here instead, so a cashier is never shown or
 * served a price whose window is closed, and never a fallback price when the answer is unclear (fail closed).
 *
 * The time logic is `resolveLiveOffer` in ./daypart; this file only groups rows, calls it and re-links the online basis.
 */
import { daypartsRepo, menuRepo, type Tx } from '@shareat/db';
import { nextDaypartBoundary, resolveLiveOffer, type DaypartWindow, type LiveOfferInvalidReason } from './daypart';

type Row = menuRepo.OfferInForce;
type Channel = Row['channel'];

export interface NotOfferedNow {
  readonly variantId: string;
  readonly channel: Channel;
  /** Store-local 'HH:MM' of the next opening; null when nothing will open. */
  readonly availableFrom: string | null;
  readonly availableAt: Date | null;
  /** Store-local weekday of that opening, 0 = Sunday; null when nothing will open. */
  readonly availableDay: number | null;
}

export interface LiveOfferFault {
  readonly variantId: string;
  readonly channel: Channel;
  readonly reason: LiveOfferInvalidReason;
}

export interface LiveStoreOffers {
  /** At most one row per variant and channel. A withdrawn row stays here (it reads as "withdrawn"). */
  readonly offers: Row[];
  /** Live dayparted offers exist but no window holds now. */
  readonly notOfferedNow: NotOfferedNow[];
  /** Rows that cannot be resolved (mixed all-day and dayparted, overlap, unknown daypart, bad zone). They show no price. */
  readonly faults: LiveOfferFault[];
  /**
   * T-510 S4: the next instant a window used by this store's live dayparted offers opens or closes (the menu must be re-read then).
   * Null when no live offer is dayparted, or the zone is unusable. Windows no live offer uses are ignored, so they cause no refetch.
   */
  readonly nextBoundaryAt: Date | null;
}

const priceFieldsOf = (o: Row): menuRepo.OfferPriceFields => ({
  withdrawn: o.withdrawn,
  pricingMode: o.pricingMode,
  amount: o.amount,
  bundleHeads: o.bundleHeads,
  extraHeadAmount: o.extraHeadAmount,
  markupPercent: o.markupPercent,
  fixedMarkupAmount: o.fixedMarkupAmount,
});

// UTF-16 code-unit order by the default sort, no relational operator (same as project.ts `cmp`; the numeric write guard).
const byStr = (a: string, b: string): number => (a === b ? 0 : [a, b].sort()[0] === a ? -1 : 1);

/** The newest withdrawn row, ties: dayparted before all-day, then id (the same pick the SQL function makes). Deterministic for any input order. */
function pickWithdrawn(rows: readonly Row[]): Row {
  return [...rows].sort(
    (a, b) =>
      b.effectiveFrom.getTime() - a.effectiveFrom.getTime() ||
      (a.daypartId === null ? 1 : 0) - (b.daypartId === null ? 1 : 0) ||
      byStr(a.id, b.id),
  )[0]!;
}

/** Pure. Output is sorted by variant then channel, so the input order never shows. */
export function resolveStoreOffers(rows: readonly Row[], dayparts: readonly DaypartWindow[], at: Date, timeZone: string): LiveStoreOffers {
  const groups = new Map<string, { variantId: string; channel: Channel; rows: Row[] }>();
  for (const r of rows) {
    const k = `${r.variantId}|${r.channel}`;
    const g = groups.get(k);
    if (g) g.rows.push(r);
    else groups.set(k, { variantId: r.variantId, channel: r.channel, rows: [r] });
  }

  const offers: Row[] = [];
  const notOfferedNow: NotOfferedNow[] = [];
  const faults: LiveOfferFault[] = [];
  const ordered = [...groups.values()].sort((a, b) => byStr(a.variantId, b.variantId) || byStr(a.channel, b.channel));
  for (const g of ordered) {
    // The zone only matters to a daypart window; a variant with no dayparted row must not depend on `stores.timezone` (free text).
    const res = resolveLiveOffer(g.rows, dayparts, at, g.rows.some((r) => r.daypartId !== null) ? timeZone : 'UTC');
    if (res.kind === 'offer') offers.push(res.offer);
    else if (res.kind === 'invalid') faults.push({ variantId: g.variantId, channel: g.channel, reason: res.reason });
    else if (res.availableFrom !== null) {
      notOfferedNow.push({ variantId: g.variantId, channel: g.channel, availableFrom: res.availableFrom, availableAt: res.availableAt, availableDay: res.availableDay });
    } else if (g.rows.every((r) => r.withdrawn)) {
      offers.push(pickWithdrawn(g.rows)); // the old single-row contract: a withdrawn row still says "withdrawn"
    } else {
      notOfferedNow.push({ variantId: g.variantId, channel: g.channel, availableFrom: null, availableAt: null, availableDay: null });
    }
  }

  // `offersInForce` already keeps one row per daypart slot, so a non-withdrawn dayparted row in `rows` is a standing one.
  const usedWindowIds = new Set(rows.filter((r) => r.daypartId !== null && !r.withdrawn).map((r) => r.daypartId));
  const nextBoundaryAt = nextDaypartBoundary(dayparts.filter((d) => usedWindowIds.has(d.id)), at, timeZone);

  // An online rule follows the STORE offer live at this same moment, not the repo's slot-matched join.
  const storeOf = new Map(offers.filter((o) => o.channel === 'store').map((o) => [o.variantId, o]));
  return {
    offers: offers.map((o) => {
      if (o.channel !== 'online') return o;
      const store = storeOf.get(o.variantId);
      return { ...o, basis: store ? priceFieldsOf(store) : null };
    }),
    notOfferedNow,
    faults,
    nextBoundaryAt,
  };
}

/** Reads the store's raw in-force rows, its dayparts and timezone, and resolves what is live at `at`. */
export async function loadLiveStoreOffers(tx: Tx, orgId: string, storeId: string, at: Date): Promise<LiveStoreOffers> {
  const [rows, dayparts, timeZone] = await Promise.all([
    menuRepo.offersInForce(tx, storeId, at),
    daypartsRepo.listDaypartsOfStore(tx, orgId, storeId),
    daypartsRepo.storeTimezone(tx, storeId),
  ]);
  const windows: DaypartWindow[] = dayparts.map((d) => ({
    id: d.id,
    days: d.days,
    start: d.startTime.slice(0, 5),
    end: d.endTime.slice(0, 5),
  }));
  // A store the caller cannot see has no timezone and no rows; the resolver reports an unusable zone as a fault, never a price.
  return resolveStoreOffers(rows, windows, at, timeZone ?? '');
}
