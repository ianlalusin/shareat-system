import { afterAll, describe, expect, it } from 'vitest';
import { initializeApp, deleteApp } from 'firebase/app';
import { Timestamp, serverTimestamp, doc, getFirestore } from 'firebase/firestore';
import { stripUndefined } from './utils';

// Construct real SDK values only. No read/write/auth operation or remote service is started.
const app = initializeApp({ projectId: 'demo-shareat-pos2', apiKey: 'emulator-only-not-a-real-key' }, 't460-values');
afterAll(() => deleteApp(app));

describe('T-460 undefined cleaner preserves SDK values', () => {
  it.each([
    ['Timestamp', Timestamp.fromMillis(1790000000123)],
    ['serverTimestamp', serverTimestamp()],
    ['DocumentReference', doc(getFirestore(app), 'test-values', 'reference')],
    ['Date', new Date(1790000000123)],
  ])('retains the actual %s instance inside nested maps and arrays', (_name, value) => {
    const cleaned = stripUndefined({ nested: [{ value, omit: undefined }], omit: undefined });
    expect(cleaned.nested[0]!.value).toBe(value);
    expect(cleaned).not.toHaveProperty('omit');
    expect(cleaned.nested[0]).not.toHaveProperty('omit');
  });
  it('continues cleaning plain/null-prototype objects and arrays without changing falsy values', () => {
    const plain = Object.assign(Object.create(null), { keep: 0, omit: undefined });
    expect(stripUndefined({ plain, array: [undefined, null, false, '', 0] })).toEqual({ plain: { keep: 0 }, array: [null, false, '', 0] });
  });
});
