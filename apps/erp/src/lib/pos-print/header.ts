import type { ReceiptHeader } from './types';

/**
 * T-585 R2/R3 - the one place a receipt or slip header is built. The issuer identity (legal name, address, TIN) arrives in the cached snapshot; a snapshot from before
 * T-585 has none, and anything malformed is treated the same way: the store name alone, never a crash and never a placeholder.
 */
export function receiptHeaderOf(s: { name: string; vatRegistered: boolean; identity?: unknown; /** T-601 S4: the POS mode of the store; `test` puts the TEST line on the paper. */ mode?: string }): ReceiptHeader {
  const test = s.mode === 'test' ? { test: true } : {};
  const i = (s.identity ?? {}) as { businessName?: unknown; addressLines?: unknown; tin?: unknown };
  const { businessName, addressLines, tin } = i;
  if (typeof businessName !== 'string' || businessName.trim() === '' || !Array.isArray(addressLines) || !addressLines.every((l) => typeof l === 'string') || (tin !== null && typeof tin !== 'string')) {
    return { businessName: s.name, addressLines: [], tin: null, vatRegistered: s.vatRegistered, ...test };
  }
  return { businessName, addressLines: (addressLines as string[]).filter((l) => l.trim() !== ''), tin: tin ? tin : null, vatRegistered: s.vatRegistered, ...test };
}
