import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T-635 S2 - the clock kiosk asks "Working today as: Slicer / Regular staff" ONLY of a slicer clocking in, and the choice rides on the punch event.
 * (The kiosk is offline and Firebase-only: this file reads `lane.ts`, which imports the client SDK only; the route-is-client-only guard covers the page.)
 */
const setDoc = vi.fn(async (..._args: unknown[]) => {});
vi.mock('firebase/firestore', () => ({
  collection: vi.fn(), doc: vi.fn((_db: unknown, path: string, id: string) => `${path}/${id}`), getDocs: vi.fn(), onSnapshot: vi.fn(), query: vi.fn(), where: vi.fn(),
  setDoc: (...a: unknown[]) => setDoc(...a),
}));

import { mustChooseWorkedAs, writePunch } from '../src/lib/terminal/lane';

const db = {} as never;
const base = { db, deviceId: 'd1', storeId: 's1', credentialKind: 'card' as const, credentialRef: 'c', method: 'qr' as const };
beforeEach(() => setDoc.mockClear());

describe('T-635 S2 who the kiosk asks', () => {
  it('asks only a slicer clocking IN: not a regular staff member, not an old roster row without the field, not a clock-out', () => {
    expect(mustChooseWorkedAs('in', { isSlicer: true })).toBe(true);
    expect(mustChooseWorkedAs('in', { isSlicer: false })).toBe(false);
    expect(mustChooseWorkedAs('in', {})).toBe(false); // a mirror document written before S2
    expect(mustChooseWorkedAs('in', undefined)).toBe(false);
    expect(mustChooseWorkedAs('out', { isSlicer: true })).toBe(false);
  });
});

describe('T-635 S2 the choice rides on the punch event', () => {
  it('a chosen value is written on the event; no choice leaves the key OUT entirely (Firestore refuses undefined, and the server reads a missing value as regular)', () => {
    writePunch({ ...base, assertedIntent: 'in', workedAs: 'slicer' });
    expect(setDoc.mock.calls[0]![1]).toMatchObject({ workedAs: 'slicer', assertedIntent: 'in' });
    writePunch({ ...base, assertedIntent: 'in', workedAs: 'regular' });
    expect(setDoc.mock.calls[1]![1]).toMatchObject({ workedAs: 'regular' });
    writePunch({ ...base, assertedIntent: 'out' });
    expect('workedAs' in (setDoc.mock.calls[2]![1] as object)).toBe(false);
  });
});
