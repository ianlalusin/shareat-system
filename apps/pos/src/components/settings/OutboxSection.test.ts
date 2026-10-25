/**
 * T-470 audit follow-ups 3a / 3b. Source check (the POS vitest project has no React renderer), like RefundReceiptDialog.test.ts.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const code = readFileSync(path.join(__dirname, 'OutboxSection.tsx'), 'utf8');

describe('OutboxSection refund rows', () => {
  it('3a: a refund row is labelled "Refund", not "Sale"', () => {
    expect(code).toMatch(/ev\.kind === "refund" \? "Refund"/);
  });
  it('3b: a reserved refund row with a lastError (receipt-number conflict) is listed for the manager with a clear label', () => {
    expect(code).toMatch(/e\.kind === "refund" && e\.status === "reserved" && e\.lastError/);
    expect(code).toContain('Refund number conflict');
    expect(code).toContain('ask the manager');
  });
});
