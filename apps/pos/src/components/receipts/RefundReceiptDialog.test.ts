/**
 * T-470 slice T - wiring of the refund dialog (DEF-731, Rulings 2 and 3). The POS vitest project runs in node with no React renderer, so this
 * reads the source (comments stripped), like tests/unit/pos-v2-offline-guards.test.ts. Each test names the mutant it kills.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const raw = readFileSync(path.join(__dirname, 'RefundReceiptDialog.tsx'), 'utf8');
const code = raw
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');

describe('RefundReceiptDialog reserves through the sale ledger (T-470)', () => {
  it('does not use reserveNext (mutant: number from the bare counter, kept only in screen memory)', () => {
    expect(code).not.toMatch(/\breserveNext\b/);
  });
  it('reserves with reserveOnlineEvent kind refund, imported from the ledger', () => {
    expect(code).toMatch(/from\s+['"]@\/lib\/outbox\/ledger['"]/);
    expect(code).toMatch(/await\s+reserveOnlineEvent\s*\(\s*\{[^}]*kind:\s*['"]refund['"]/s);
  });
  it('writes the parent receipt id, the refund amount, the chosen tender and computeLinesHash(asked) to the row', () => {
    expect(code).toMatch(/computeLinesHash\s*\(\s*asked\s*\)/);
    expect(code).toMatch(/from\s+['"]@\/lib\/outbox\/linesHash['"]/);
    expect(code).toMatch(/totalCentavos:\s*refundCentavos/);
    expect(code).toMatch(/centavos:\s*refundCentavos/);
    expect(code).toMatch(/method:\s*chosenTender/);
    expect(code).toMatch(/receiptId:\s*receipt\.receiptId\s*\?\?\s*receipt\.id/);
  });
  it('keeps the same-key reuse rule and the store check', () => {
    expect(code).toMatch(/!reserved\.current\s*\|\|\s*reserved\.current\.key\s*!==\s*key/);
    expect(code).toMatch(/storeId\s*!==\s*receipt\.storeId/);
  });
  it('a 409 clears the held number', () => {
    expect(code).toMatch(/status\s*===\s*409\)\s*reserved\.current\s*=\s*null/);
  });
  it('success acknowledges the ledger row AFTER the server call and not in the catch (mutant: row stays reserved forever / acknowledged before the server has it)', () => {
    const post = code.search(/await\s+postPos2\s*[<(]/);
    const ack = code.search(/await\s+markAcknowledged\s*\(/);
    const catchAt = code.search(/\}\s*catch\s*\(/);
    expect(post).toBeGreaterThan(-1);
    expect(ack).toBeGreaterThan(post);
    expect(catchAt).toBeGreaterThan(ack); // so it sits in the try body, after the post, never in the catch block
    expect(code.slice(catchAt)).not.toMatch(/markAcknowledged/);
    expect(code.match(/markAcknowledged\s*\(/g)).toHaveLength(1);
  });
  it('the dialog NEVER calls markSkipped (only reconcile, reading the server, may say a number carries no money)', () => {
    expect(code).not.toMatch(/\bmarkSkipped\b/);
  });
  it('a ledger write failure after success is logged, not shown as "Refund not done"', () => {
    expect(code).toMatch(/markAcknowledged\([^)]*\)\s*\.catch\s*\(|try\s*\{[^}]*markAcknowledged[^}]*\}\s*catch/s);
  });
});
