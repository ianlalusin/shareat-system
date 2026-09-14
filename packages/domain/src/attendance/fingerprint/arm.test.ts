import { describe, it, expect } from 'vitest';
import { planArm, FRESH_ARM_STATE, type FingerprintArmState } from './arm';

// Carried across from v1's fingerprint-arm.test.ts unchanged, aside from the renamed import
// (`planFingerprintArm` -> `planArm`, per the slice A contract).
//
// The terminal used to close the reader and rebuild the whole matcher DB after
// EVERY punch — a USB re-open, a full template fetch, and a full re-marshal
// across the Capacitor bridge, none of which had changed. Worse, presses landing
// during that rebuild are silently dropped by the native plugin, which reads to
// staff as "the scanner didn't take". This planner is what keeps a warm reader
// warm; the wiring in the terminal is thin on purpose.

describe('planArm', () => {
  it('does everything on a cold start', () => {
    expect(planArm(FRESH_ARM_STATE, 'online')).toEqual({ openReader: true, loadDb: true });
  });

  it('does NOTHING when re-arming after a punch with the reader already warm', () => {
    const warm: FingerprintArmState = { readerOpen: true, dbLoadedFor: 'online' };
    expect(planArm(warm, 'online')).toEqual({ openReader: false, loadDb: false });
  });

  it('reloads the matcher DB when the device drops offline, without reopening the reader', () => {
    const warm: FingerprintArmState = { readerOpen: true, dbLoadedFor: 'online' };
    expect(planArm(warm, 'offline')).toEqual({ openReader: false, loadDb: true });
  });

  it('reloads the matcher DB when the device comes back online', () => {
    const warm: FingerprintArmState = { readerOpen: true, dbLoadedFor: 'offline' };
    expect(planArm(warm, 'online')).toEqual({ openReader: false, loadDb: true });
  });

  it('loads the DB when the reader is open but nothing has been loaded yet', () => {
    const opened: FingerprintArmState = { readerOpen: true, dbLoadedFor: null };
    expect(planArm(opened, 'online')).toEqual({ openReader: false, loadDb: true });
  });

  it('rebuilds everything after a fault resets the state', () => {
    // A hard reader fault must not leave us believing the reader is still open —
    // the old accidental closeReader() was what recovered a wedged reader, so
    // dropping it means a fault has to reset explicitly.
    expect(planArm(FRESH_ARM_STATE, 'offline')).toEqual({ openReader: true, loadDb: true });
  });

  it('freezes FRESH_ARM_STATE so assigning it by reference cannot corrupt it', () => {
    expect(Object.isFrozen(FRESH_ARM_STATE)).toBe(true);
  });
});
