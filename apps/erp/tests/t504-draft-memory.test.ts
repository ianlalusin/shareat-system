/**
 * T-504 item 10 (TESTER) - the browser-side draft memory, as a PURE helper (spec: "keyed by person + store + business date,
 * localStorage, wrapped in try/catch, works when storage is unavailable").
 *
 * CONTRACT PINNED HERE (the spec names no file; the builder matches, or asks):
 *   apps/erp/src/app/sales-days/draft-memory.ts exports
 *     draftKey(personId, storeId, businessDate): string
 *     saveDraft(storage, key, fields: Record<string, string>, now?: Date): void        never throws
 *     loadDraft(storage, key): { fields: Record<string, string>; savedAt: string } | null   never throws; savedAt is an ISO time
 *     clearDraft(storage, key): void                                                   never throws
 *   `storage` is Storage-like ({ getItem, setItem, removeItem }) or null/undefined (no storage at all).
 */
import { describe, expect, it } from 'vitest';
import { clearDraft, draftKey, loadDraft, saveDraft } from '../src/app/sales-days/draft-memory';

function memory(): Storage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage & { map: Map<string, string> };
}
const throwing = (): Storage =>
  ({
    getItem: () => {
      throw new Error('SecurityError');
    },
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
    removeItem: () => {
      throw new Error('SecurityError');
    },
  }) as unknown as Storage;

const KEY = draftKey('person-1', 'store-1', '2027-01-10');
const FIELDS = { totalSales: '1,000', channel_a: '16,980', nosales_b: 'on' };

describe('draftKey', () => {
  it('carries person, store and date, and differs when any one differs', () => {
    expect(KEY).toContain('person-1');
    expect(KEY).toContain('store-1');
    expect(KEY).toContain('2027-01-10');
    const others = [draftKey('person-2', 'store-1', '2027-01-10'), draftKey('person-1', 'store-2', '2027-01-10'), draftKey('person-1', 'store-1', '2027-01-11')];
    for (const k of others) expect(k).not.toBe(KEY);
    expect(new Set([KEY, ...others]).size).toBe(4);
  });
  it('is stable for the same inputs', () => {
    expect(draftKey('person-1', 'store-1', '2027-01-10')).toBe(KEY);
  });
});

describe('save / load / clear', () => {
  it('restores exactly what was typed, with the time it was kept', () => {
    const s = memory();
    saveDraft(s, KEY, FIELDS, new Date('2027-01-10T08:30:00.000Z'));
    const got = loadDraft(s, KEY);
    expect(got?.fields).toEqual(FIELDS);
    expect(new Date(got!.savedAt).toISOString()).toBe('2027-01-10T08:30:00.000Z');
  });
  it('a later save replaces the earlier one', () => {
    const s = memory();
    saveDraft(s, KEY, FIELDS, new Date('2027-01-10T08:30:00.000Z'));
    saveDraft(s, KEY, { totalSales: '2,000' }, new Date('2027-01-10T09:00:00.000Z'));
    expect(loadDraft(s, KEY)?.fields).toEqual({ totalSales: '2,000' });
  });
  it('another person / store / date does not see it', () => {
    const s = memory();
    saveDraft(s, KEY, FIELDS);
    expect(loadDraft(s, draftKey('person-2', 'store-1', '2027-01-10'))).toBeNull();
    expect(loadDraft(s, draftKey('person-1', 'store-1', '2027-01-11'))).toBeNull();
  });
  it('clear removes it (a successful Save or Submit)', () => {
    const s = memory();
    saveDraft(s, KEY, FIELDS);
    clearDraft(s, KEY);
    expect(loadDraft(s, KEY)).toBeNull();
    expect(s.map.size).toBe(0);
  });
  it('nothing saved gives null', () => {
    expect(loadDraft(memory(), KEY)).toBeNull();
  });
  it('a corrupt stored value gives null, not a throw', () => {
    const s = memory();
    s.setItem(KEY, '{not json');
    expect(loadDraft(s, KEY)).toBeNull();
    s.setItem(KEY, JSON.stringify({ fields: 'nope' }));
    expect(loadDraft(s, KEY)).toBeNull();
  });
});

describe('storage unavailable: the form still works, just without memory', () => {
  it('a throwing storage never throws out of save, load or clear', () => {
    const s = throwing();
    expect(() => saveDraft(s, KEY, FIELDS)).not.toThrow();
    expect(loadDraft(s, KEY)).toBeNull();
    expect(() => clearDraft(s, KEY)).not.toThrow();
  });
  it('no storage at all (null / undefined) is the same', () => {
    for (const s of [null, undefined]) {
      expect(() => saveDraft(s as never, KEY, FIELDS)).not.toThrow();
      expect(loadDraft(s as never, KEY)).toBeNull();
      expect(() => clearDraft(s as never, KEY)).not.toThrow();
    }
  });
});
