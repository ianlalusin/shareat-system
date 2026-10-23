import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

type Settings = { autoPrintAfterPayment?: unknown } | null;
const destination = async (read: () => Promise<Settings>, warn = vi.fn()) => {
  const path = './offline-payment-destination';
  const module = await import(/* @vite-ignore */ path);
  return module.offlinePaymentDestination('saved-receipt-17', read, warn);
};

describe('T-459 saved offline payment receipt destination', () => {
  it('cached true preserves automatic printing for the saved receipt', async () => {
    expect(await destination(async () => ({ autoPrintAfterPayment: true }))).toBe('/receipt?id=saved-receipt-17&autoprint=1');
  });
  it.each([null, {}, { autoPrintAfterPayment: false }])('missing/false preference uses the saved receipt with manual printing: %j', async settings => {
    expect(await destination(async () => settings)).toBe('/receipt?id=saved-receipt-17');
  });
  it.each(['unavailable', 'permission-denied'])('a %s preference error cannot turn a saved sale into payment failure', async code => {
    const error = Object.assign(new Error('preference read failed'), { code });
    const read = vi.fn(async () => { throw error; });
    const warn = vi.fn();
    expect(await destination(read, warn)).toBe('/receipt?id=saved-receipt-17');
    expect(read).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(error);
  });
  it('the actual offline modal saves once, then uses a cache-only preference and the saved id', () => {
    const source = readFileSync(new URL('../../components/cashier/payment-modal.tsx', import.meta.url), 'utf8');
    const offline = source.slice(source.indexOf('// --- OFFLINE ---'), source.indexOf('// --- ONLINE ---'));
    expect(offline.match(/await completePaymentOffline\(/g)).toHaveLength(1);
    expect(offline).toMatch(/await offlinePaymentDestination\(receiptId,/);
    expect(offline.indexOf('await offlinePaymentDestination')).toBeGreaterThan(offline.indexOf('await completePaymentOffline'));
    expect(offline).toMatch(/getDocFromCache\(/);
    expect(offline).not.toMatch(/await getDoc\(/);
    expect(offline).toMatch(/setPendingRedirect\(destination\)/);
    expect(offline).toMatch(/title: "Payment failed"/); // genuine save failures still have the failure path
  });
});
