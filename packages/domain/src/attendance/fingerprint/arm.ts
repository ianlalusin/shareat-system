// Decides what setup a fingerprint arm actually needs. Pure so the terminal's
// effect stays thin and this logic is testable without a device. Ported from v1's
// fingerprint-arm.ts (T-314 slice A); only `planFingerprintArm` is renamed, to `planArm`,
// per the slice A contract.
//
// The terminal used to close the reader and rebuild the matcher DB after EVERY
// punch: a USB re-open, a full template fetch, and a full re-marshal across the
// Capacitor bridge — none of which had changed between two consecutive punches.
// Presses landing during that rebuild are silently dropped by the native plugin
// (it ignores a capture when nothing is armed), which reads to staff as "the
// scanner didn't take". Keeping a warm reader warm removes both costs.

export type FingerprintArmState = {
  readerOpen: boolean;
  /** Which template set is currently loaded into the native matcher, if any. */
  dbLoadedFor: 'online' | 'offline' | null;
};

export type ArmPlan = { openReader: boolean; loadDb: boolean };

/** Frozen so a caller that assigns it directly (rather than spreading a copy)
 *  fails loudly instead of quietly corrupting the shared constant. */
export const FRESH_ARM_STATE: FingerprintArmState = Object.freeze({
  readerOpen: false,
  dbLoadedFor: null,
});

/** Open the reader only if it isn't already; reload the matcher DB only if the
 *  loaded set doesn't match the mode we're arming for. A re-arm right after a
 *  punch is therefore free. */
export function planArm(state: FingerprintArmState, mode: 'online' | 'offline'): ArmPlan {
  return {
    openReader: !state.readerOpen,
    loadDb: state.dbLoadedFor !== mode,
  };
}
