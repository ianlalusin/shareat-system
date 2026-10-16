/** T-423 audit fixes: RF store code refused; claiming a new terminal number releases this device's old one. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeFirestore, type FakeFirestore } from '@/test-helpers/fakeFirestore';
import { createFakeIdb } from '@/test-helpers/fakeIdb';
import * as claim from '@/lib/terminal/claim';

let fs: FakeFirestore;
const S = 'store1';
const A = { storeId: S, storeCode: 'sht', uid: 'm', deviceId: 'DEV-A', terminalNo: 1 };
beforeEach(() => { fs = createFakeFirestore(); vi.stubGlobal('indexedDB', createFakeIdb({ commitDelayMs: 5 })); });
afterEach(() => vi.unstubAllGlobals());

describe('claim audit fixes', () => {
  it('refuses a store code that normalises to RF, writing nothing', async () => {
    await expect(claim.claimTerminal(fs.port, { ...A, storeCode: ' r-f ' })).rejects.toThrow('This store code cannot be used for receipt numbers; change the store code in ERP.');
    expect(fs.commits).toHaveLength(0);
  });

  it('moving to another terminal number releases the old terminal doc of this device', async () => {
    await claim.claimTerminal(fs.port, A);
    await claim.claimTerminal(fs.port, { ...A, terminalNo: 2 });
    expect(fs.get(`stores/${S}/terminals/01`)?.deviceId ?? null).toBeNull();
    expect(fs.get(`stores/${S}/terminals/01`)?.releaseEpoch).toBe(1);
    expect(fs.get(`stores/${S}/terminals/02`)).toMatchObject({ deviceId: 'DEV-A' });
  });

  it('does not release the old terminal if another device holds it now', async () => {
    await claim.claimTerminal(fs.port, A);
    fs.seed(`stores/${S}/terminals/01`, { deviceId: 'DEV-B', releaseEpoch: 1 });
    await claim.claimTerminal(fs.port, { ...A, terminalNo: 2 });
    expect(fs.get(`stores/${S}/terminals/01`)).toMatchObject({ deviceId: 'DEV-B' });
  });
});
