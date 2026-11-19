/**
 * T-595 (DEF-878, DEF-879) - source scan of the lock order. No database. Comments are stripped before scanning code.
 * The order everywhere is: customer row (`lockForCredit`), THEN charge rows (`lockChargesForAllocation`). A caller that takes the
 * charge first and then reaches `recordCollection` (which takes the customer) deadlocks against a direct collection on the same charge.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');
const stripComments = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
const code = (rel: string): string => stripComments(readFileSync(join(ROOT, rel), 'utf8'));

function bodyOf(src: string, fn: string): string {
  const start = src.indexOf(`export async function ${fn}(`);
  expect(start, `${fn} not found`).toBeGreaterThan(-1);
  const next = src.indexOf('\nexport ', start + 10);
  return src.slice(start, next === -1 ? undefined : next);
}

describe('T-595 lock order: customer row before charge rows', () => {
  it('applyCredit takes lockForCredit( before lockChargesForAllocation( [kills: the charge-then-customer inversion]', () => {
    const body = bodyOf(code('packages/domain/src/trade/returns.ts'), 'applyCredit');
    const cust = body.search(/lockForCredit\(/);
    const charge = body.search(/lockChargesForAllocation\(/);
    expect(cust).toBeGreaterThan(-1);
    expect(charge).toBeGreaterThan(cust);
  });
  it('recordCollection takes lockForCredit( before it reads creditBalanceOf( [kills: two collections spending one credit]', () => {
    const body = bodyOf(code('packages/domain/src/ar/index.ts'), 'recordCollection');
    const lock = body.search(/lockForCredit\(/);
    const read = body.search(/creditBalanceOf\(|spendableStoreCredit\(/);
    expect(lock).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(lock);
  });
  it('voidCollection takes lockForCredit( before reverseEntry( [kills: a void racing a spend of the credit it created]', () => {
    const body = bodyOf(code('packages/domain/src/ar/index.ts'), 'voidCollection');
    const lock = body.search(/lockForCredit\(/);
    const reverse = body.search(/reverseEntry\(/);
    expect(lock).toBeGreaterThan(-1);
    expect(reverse).toBeGreaterThan(lock);
  });
});
