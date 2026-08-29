import { describe, expect, it } from 'vitest';
import {
  assertUsageSource,
  defaultsToClear,
  normaliseRole,
  resolveReceivingLocation,
  singleRoomViolation,
  type LocationLike,
} from '../../src/stock-locations/rules';

/**
 * T-160 §7 — the pure half of the room model.
 *
 * ⚠️ Written BEFORE `rules.ts` existed (bible §3.2) and confirmed failing for the right reason.
 *
 * ⭐ These five rules are the ones a database constraint cannot express on its own: the DB can
 * refuse a second Receiving room, but it cannot decide which room a receive falls back to, nor
 * what an unknown legacy role should become. Those are decisions, and decisions get tests.
 */

function loc(over: Partial<LocationLike> & { id: string }): LocationLike {
  return {
    role: 'storage',
    purpose: 'normal',
    isDefault: false,
    status: 'active',
    ...over,
  };
}

describe('resolveReceivingLocation — where an undecided line parks', () => {
  const receiving = loc({ id: 'RCV', purpose: 'receiving' });
  const defaultRoom = loc({ id: 'DEF', isDefault: true });
  const other = loc({ id: 'OTH' });

  it('⭐ prefers the Receiving room when the store has one', () => {
    expect(resolveReceivingLocation([other, defaultRoom, receiving])).toBe('RCV');
  });

  it('⭐ falls back to the default room ONLY when no Receiving location exists', () => {
    // v1's exact ordering (`receive-allocation.ts:14-22`), and the reason is in its own comment:
    // "so stock is never lost". Guessing a room is worse than parking; losing it is worse still.
    expect(resolveReceivingLocation([other, defaultRoom])).toBe('DEF');
  });

  it('⛔ never returns null when the store has any active room at all', () => {
    // The last resort is *a* room, not nothing. A receive that resolves to null drops stock.
    expect(resolveReceivingLocation([other])).toBe('OTH');
  });

  it('ignores inactive rooms, including an inactive Receiving', () => {
    const retiredReceiving = loc({ id: 'OLD', purpose: 'receiving', status: 'inactive' });
    expect(resolveReceivingLocation([retiredReceiving, defaultRoom])).toBe('DEF');
  });

  it('returns null only when there is genuinely nowhere to put it', () => {
    expect(resolveReceivingLocation([])).toBeNull();
    expect(resolveReceivingLocation([loc({ id: 'X', status: 'inactive' })])).toBeNull();
  });
});

describe('assertUsageSource — a storage room can never drain stock', () => {
  it('⛔ refuses a storage room', () => {
    const result = assertUsageSource(loc({ id: 'STK', role: 'storage' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('storage');
  });

  it('allows an operating room', () => {
    expect(assertUsageSource(loc({ id: 'KIT', role: 'operating' })).ok).toBe(true);
  });

  it('⛔ refuses an inactive room even when its role is operating', () => {
    // A retired kitchen is not a usage source. The role says what it WAS for; the status says
    // whether it is still in play, and both have to hold.
    expect(assertUsageSource(loc({ id: 'KIT', role: 'operating', status: 'inactive' })).ok).toBe(
      false,
    );
  });

  it('⛔ refuses the Receiving room, which is a parking spot and not a kitchen', () => {
    expect(assertUsageSource(loc({ id: 'RCV', purpose: 'receiving' })).ok).toBe(false);
  });
});

describe('normaliseRole — the fail-safe direction is a decision, not a default', () => {
  it('⭐ an unknown or missing role becomes storage, never operating', () => {
    // v1: "a mis-migrated location can't silently drain stock." Under-permitting is recoverable
    // by a human; over-permitting drains stock nobody counted.
    expect(normaliseRole(undefined)).toBe('storage');
    expect(normaliseRole(null)).toBe('storage');
    expect(normaliseRole('')).toBe('storage');
    expect(normaliseRole('kitchen')).toBe('storage');
    expect(normaliseRole('OPERATING')).toBe('storage');
  });

  it('passes the two real roles through unchanged', () => {
    expect(normaliseRole('storage')).toBe('storage');
    expect(normaliseRole('operating')).toBe('operating');
  });
});

describe('defaultsToClear — exactly one default room per store', () => {
  it('names every other default when a new one is set', () => {
    const rooms = [loc({ id: 'A', isDefault: true }), loc({ id: 'B' }), loc({ id: 'C', isDefault: true })];
    expect(defaultsToClear(rooms, 'B')).toEqual(['A', 'C']);
  });

  it('clears nothing when the incoming room is already the only default', () => {
    const rooms = [loc({ id: 'A', isDefault: true }), loc({ id: 'B' })];
    expect(defaultsToClear(rooms, 'A')).toEqual([]);
  });

  it('⚠️ clears an INACTIVE default too — a retired room must not keep the flag', () => {
    // Otherwise reactivating it silently produces two defaults, and the partial unique index
    // rejects the reactivation for a reason nobody can see from the form.
    const rooms = [loc({ id: 'OLD', isDefault: true, status: 'inactive' }), loc({ id: 'NEW' })];
    expect(defaultsToClear(rooms, 'NEW')).toEqual(['OLD']);
  });
});

describe('singleRoomViolation — v1 shipped a repair tool; this is the invariant instead', () => {
  const room = loc({ id: 'R1' });
  const receiving = loc({ id: 'RCV', purpose: 'receiving' });

  it('⭐ a single_room store may hold exactly one non-Receiving room', () => {
    expect(singleRoomViolation('single_room', [room, receiving])).toBeNull();
  });

  it('⭐ a second non-Receiving room in a single_room store is a violation', () => {
    // This is precisely the drift `branch-stock-reconcile.actions.ts` existed to repair —
    // floor negative balances, move everything to a canonical room, delete the strays. Made
    // structural, the tool has nothing left to do.
    const violation = singleRoomViolation('single_room', [room, loc({ id: 'R2' }), receiving]);
    expect(violation).not.toBeNull();
    expect(violation).toContain('R2');
  });

  it('does not count the Receiving room against the limit', () => {
    expect(singleRoomViolation('single_room', [room])).toBeNull();
    expect(singleRoomViolation('single_room', [receiving])).toBeNull();
  });

  it('does not count INACTIVE rooms against the limit', () => {
    const retired = loc({ id: 'OLD', status: 'inactive' });
    expect(singleRoomViolation('single_room', [room, retired])).toBeNull();
  });

  it('a multi_room store is unconstrained', () => {
    expect(
      singleRoomViolation('multi_room', [room, loc({ id: 'R2' }), loc({ id: 'R3' }), receiving]),
    ).toBeNull();
  });
});
