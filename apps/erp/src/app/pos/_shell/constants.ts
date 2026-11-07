/**
 * T-526 - the shell's protocol limits. None of these is a business setting: they are the offline design's own numbers (design A6) and
 * the polling rhythm, so they are named constants with a reason each, not owner-editable rules.
 */

/** A6, the offline limit stated in the design: no offline sign-in or sale on a snapshot older than a day. */
export const POS_OFFLINE_SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** A6: the paired tablet re-fetches its snapshot (menu, staff, rules) this often while it is online. */
export const POS_SNAPSHOT_REFRESH_MS = 5 * 60 * 1000;
/** R3: the state poll that drives the tab counts and the online pill; about 6 s to notice a drop after two misses. */
export const POS_POLL_INTERVAL_MS = 3000;
/** R3: how often an online tablet with waiting actions tries to send them. */
export const POS_DRAIN_INTERVAL_MS = 10_000;

/** sessionStorage key of the cashier who signed in on this tablet while offline (R5). Survives a reload, not a closed tab. */
export const POS_OFFLINE_ACTOR_KEY = 'shareat_pos_offline_actor';
/** Same rule as the tablet sign-in (T-464, bible row 381): 5 wrong PINs for one Employee ID pause that ID for 5 minutes. */
export const POS_PIN_MISS_LIMIT = 5;
export const POS_PIN_PAUSE_MS = 5 * 60 * 1000;

/** T-526 R4: the short-lived, non-secret flag the tablet-PIN sign-in sets (path /pos, 5 minutes) so only THAT sign-in can promote a pending verifier. */
export const POS_PROMOTE_COOKIE = 'shareat_pos_promote';
