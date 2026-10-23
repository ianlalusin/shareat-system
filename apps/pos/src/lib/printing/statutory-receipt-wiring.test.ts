import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it.each(['receipt', 'receipts'])('the real %s page forwards the receipt diner records to both preview and print data', page => {
  const source = readFileSync(new URL(`../../app/${page}/page.tsx`, import.meta.url), 'utf8');
  expect(/statutoryDiners:\s*receiptDocData\.statutoryDiners/.test(source), `${page} must forward statutoryDiners`).toBe(true);
});
