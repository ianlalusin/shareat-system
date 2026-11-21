/**
 * T-601 S5 - the snapshot carries the store code, so the tablet can print the number the server writes (`<store code>-<terminal 2>-<seq 6>`). Real Postgres; runs in CI.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { buildPosSnapshot } from '../../src/pos/snapshot';
import { asOrg, closeAll, fixture, RATES } from './_fixtures/t525-pos';

afterAll(closeAll);

describe('T-601 S5 - the snapshot store.code', () => {
  it('is this store\'s own code, the one the server puts in the receipt number', async () => {
    const f = await fixture('test');
    const s = await asOrg(f.orgId, (tx) => buildPosSnapshot(tx, { pairing: { pairingId: f.pairingId, orgId: f.orgId, storeId: f.storeId } }, RATES));
    expect(s.body.store.code).toBe(f.storeCode);
    expect(s.body.store.code).not.toBe('');
  });
});
