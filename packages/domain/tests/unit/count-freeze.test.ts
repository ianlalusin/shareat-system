import { describe, expect, it } from 'vitest';
import { isFrozenBySessions } from '../../src/stock/count-workflow';

/**
 * T-169 §7 invariant 2 — the pure half of the freeze. The real enforcement is
 * `stock_movements_check_not_frozen_trg` (migration 0068); this predicate exists only so a screen
 * can show a "frozen" badge without a second query per room. ⭐ It must fail CLOSED on anything
 * malformed and never throw — a predicate that threw on a bad row would take the badge (and
 * whatever calls it) down with it.
 */
describe('isFrozenBySessions', () => {
  const OPEN = 'open';
  const COUNTING = 'counting';
  const REVIEWING = 'reviewing';
  const CLOSED = 'closed';
  const CANCELLED = 'cancelled';

  it('is true when an open session holds the room', () => {
    expect(isFrozenBySessions([{ status: OPEN, locationIds: ['A', 'B'] }], 'A')).toBe(true);
  });

  it('is true for counting and reviewing too — all three freeze', () => {
    expect(isFrozenBySessions([{ status: COUNTING, locationIds: ['A'] }], 'A')).toBe(true);
    expect(isFrozenBySessions([{ status: REVIEWING, locationIds: ['A'] }], 'A')).toBe(true);
  });

  it('is false once a session is closed or cancelled', () => {
    expect(isFrozenBySessions([{ status: CLOSED, locationIds: ['A'] }], 'A')).toBe(false);
    expect(isFrozenBySessions([{ status: CANCELLED, locationIds: ['A'] }], 'A')).toBe(false);
  });

  it('is false for a room no active session names', () => {
    expect(isFrozenBySessions([{ status: OPEN, locationIds: ['A'] }], 'Z')).toBe(false);
  });

  it('is false, never throws, for an empty row set', () => {
    expect(isFrozenBySessions([], 'A')).toBe(false);
  });

  // ⭐ The three malformed cases spec test 3 asks for — a NULL status, an unknown status, and no
  // locations at all — and NONE of them may throw.
  it('⛔ fails CLOSED on a NULL status', () => {
    expect(() => isFrozenBySessions([{ status: null, locationIds: ['A'] }], 'A')).not.toThrow();
    expect(isFrozenBySessions([{ status: null, locationIds: ['A'] }], 'A')).toBe(false);
  });

  it('⛔ fails CLOSED on an unknown status', () => {
    expect(() => isFrozenBySessions([{ status: 'quantum', locationIds: ['A'] }], 'A')).not.toThrow();
    expect(isFrozenBySessions([{ status: 'quantum', locationIds: ['A'] }], 'A')).toBe(false);
  });

  it('⛔ fails CLOSED on a missing or non-array location list', () => {
    expect(() => isFrozenBySessions([{ status: OPEN, locationIds: undefined }], 'A')).not.toThrow();
    expect(isFrozenBySessions([{ status: OPEN, locationIds: undefined }], 'A')).toBe(false);
    expect(isFrozenBySessions([{ status: OPEN, locationIds: 'A' }], 'A')).toBe(false);
    expect(isFrozenBySessions([{ status: OPEN, locationIds: null }], 'A')).toBe(false);
  });

  it('one malformed row does not hide a real freeze from a well-formed one beside it', () => {
    const rows = [
      { status: null, locationIds: ['A'] },
      { status: OPEN, locationIds: ['A'] },
    ];
    expect(isFrozenBySessions(rows, 'A')).toBe(true);
  });
});
