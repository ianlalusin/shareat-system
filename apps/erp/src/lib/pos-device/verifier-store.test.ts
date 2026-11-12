/**
 * T-530a — `verifier-store.ts`: opaque records in, opaque records out, and no secret handling here.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeIdb, type FakeIdbFactory } from '../../../tests/helpers/fake-idb';
import type { StoredVerifier } from './types';
import {
  deleteVerifier,
  getVerifierByEmployeeId,
  listVerifiers,
  putVerifier,
} from './verifier-store';

let fake: FakeIdbFactory;

const verifier = (over: Partial<StoredVerifier> = {}): StoredVerifier => ({
  personId: 'person-1',
  employeeId: 'EMP-1',
  salt: 'c2FsdA==',
  hash: 'aGFzaA==',
  iterations: 210_000,
  createdAtMs: 1_700_000_000_000,
  ...over,
});

beforeEach(() => {
  fake = createFakeIdb({ commitDelayMs: 2 });
  vi.stubGlobal('indexedDB', fake);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('T-530a — verifier records', () => {
  it('put, get by employee id, replace, delete, list', async () => {
    expect(await getVerifierByEmployeeId('EMP-1')).toBeNull();

    await putVerifier(verifier({ personId: 'person-1', employeeId: 'EMP-1' }));
    await putVerifier(verifier({ personId: 'person-2', employeeId: 'EMP-2' }));

    expect((await getVerifierByEmployeeId('EMP-1'))?.personId).toBe('person-1');
    expect(await getVerifierByEmployeeId('EMP-9')).toBeNull();
    expect((await listVerifiers()).map((v) => v.personId).sort()).toEqual(['person-1', 'person-2']);

    // A second put for the same person replaces the record; the old employee id stops matching.
    await putVerifier(verifier({ personId: 'person-1', employeeId: 'EMP-3', hash: 'bmV3' }));
    expect((await listVerifiers()).filter((v) => v.personId === 'person-1')).toHaveLength(1);
    expect((await getVerifierByEmployeeId('EMP-3'))?.hash).toBe('bmV3');
    expect(await getVerifierByEmployeeId('EMP-1')).toBeNull();

    await deleteVerifier('person-1');
    expect((await listVerifiers()).map((v) => v.personId)).toEqual(['person-2']);
  });

  it('the module does no secret handling of its own', () => {
    const source = readFileSync(new URL('./verifier-store.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/crypto|subtle/i);
    expect(source).not.toMatch(/pin/i);
  });
});
