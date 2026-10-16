/**
 * Online-ordering availability: is a store open for website orders *right now*?
 *
 * Two layers, mirrored server-side on the website (shareat-website
 * functions/index.js) which is the authority the public storefront reads:
 *  - `acceptsOnlineOrders` (master)  — the store is enrolled in online ordering.
 *  - open/closed                     — either follows the store's opening hours
 *                                      (`onlineOrderMode === "auto"`) or a manual
 *                                      override (`onlineOrderManualOpen`).
 *
 * Keep this in sync with the JS copy in the website's functions/index.js.
 */

export type OnlineOrderMode = "auto" | "manual";

export type OnlineAvailabilityInput = {
  acceptsOnlineOrders?: boolean;
  onlineOrderMode?: OnlineOrderMode;
  onlineOrderManualOpen?: boolean;
  openingTime?: string | null;
  closingTime?: string | null;
};

/**
 * True when the current Manila time is within [openingTime, closingTime).
 * Overnight windows (e.g. 18:00–02:00) are handled. No/!valid hours ⇒ always
 * open, so "Auto" with unconfigured hours never silently closes a store.
 * `now` is injectable for testing.
 */
export function isWithinStoreHours(
  openingTime?: string | null,
  closingTime?: string | null,
  now: Date = new Date()
): boolean {
  if (!openingTime || !closingTime) return true;
  const manila = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Manila" }));
  const cur = manila.getHours() * 60 + manila.getMinutes();
  const [oh, om] = openingTime.split(":").map(Number);
  const [ch, cm] = closingTime.split(":").map(Number);
  if ([oh, om, ch, cm].some((n) => Number.isNaN(n))) return true;
  const start = oh * 60 + om;
  const end = ch * 60 + cm;
  return start <= end ? cur >= start && cur < end : cur >= start || cur < end;
}

export type OnlineAvailability = {
  /** Master switch — the store participates in online ordering at all. */
  enrolled: boolean;
  mode: OnlineOrderMode;
  /** Effective: a customer can place an order on the website right now. */
  openNow: boolean;
  /** True when open/closed is driven by the schedule (mode === "auto"). */
  scheduleControlled: boolean;
};

/**
 * Resolve a store's effective online-ordering availability. An un-enrolled store
 * is always closed. Manual mode (the back-compat default) defaults to OPEN when
 * `onlineOrderManualOpen` is unset, matching the old boolean behaviour.
 */
export function computeOnlineAvailability(
  s: OnlineAvailabilityInput,
  now: Date = new Date()
): OnlineAvailability {
  const enrolled = s.acceptsOnlineOrders === true;
  const mode: OnlineOrderMode = s.onlineOrderMode === "auto" ? "auto" : "manual";
  let openNow: boolean;
  if (!enrolled) openNow = false;
  else if (mode === "auto") openNow = isWithinStoreHours(s.openingTime, s.closingTime, now);
  else openNow = s.onlineOrderManualOpen !== false;
  return { enrolled, mode, openNow, scheduleControlled: mode === "auto" };
}
