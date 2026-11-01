import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { money, add, type Money } from '@shareat/core/money';
import * as expenses from '../src/expenses';

/**
 * T-502 S12 / tests 10 (TESTER, red first) - `allocateBatchPayments(groups, payments)`, the pure function that splits a batch's payments
 * across its category groups, in order (docs/tasks/502-expense-item-catalog.md section 12 "Invoice page"). Money in, Money out, never floats.
 * The SAME function feeds the live preview under the form, so the page and the domain cannot disagree.
 *
 * SHAPES ASSUMED (spec does not fix them; orchestrator to rule): groups `{ key: string; amount: Money }[]`, payments
 * `{ method; moneyAccountId?; amount: Money }[]`; result `{ key, lines: { method; moneyAccountId?; amount: Money }[] }[]` in group order.
 * Refusals throw an Error carrying a plain `userMessage`.
 *
 * MUTANTS: a zero-amount line at a group boundary; rounding through floats (0.1 + 0.2); payments allowed to differ from the total;
 * groups taken out of table order; a payment row reordered.
 */
type Group = { key: string; amount: Money };
type Payment = { method: string; moneyAccountId?: string | null; amount: Money };
type Allocation = { key: string; lines: { method: string; moneyAccountId?: string | null; amount: Money }[] };
const allocate = (expenses as unknown as { allocateBatchPayments?: (g: Group[], p: Payment[]) => Allocation[] }).allocateBatchPayments;

const run = (groups: Group[], payments: Payment[]): Allocation[] => {
  if (!allocate) throw new Error('allocateBatchPayments is not exported from src/expenses');
  return allocate(groups, payments);
};
const g = (key: string, amount: string): Group => ({ key, amount: money(amount) });
const p = (method: string, amount: string, moneyAccountId: string | null = null): Payment => ({ method, moneyAccountId, amount: money(amount) });
const shape = (a: Allocation[]) => a.map((x) => ({ key: x.key, lines: x.lines.map((l) => ({ method: l.method, amount: l.amount })) }));

describe('T-502 S12 / 10 - allocateBatchPayments', () => {
  it('is exported', () => {
    expect(typeof allocate).toBe('function');
  });

  it("Ian's example: groups 100 and 50, payments 80 cash then 70 GCash -> group 1 = 80 cash + 20 GCash, group 2 = 50 GCash", () => {
    const out = run([g('meat', '100.00'), g('veg', '50.00')], [p('cash', '80.00', 'cash-acct'), p('online', '70.00', 'gcash-acct')]);
    expect(shape(out)).toEqual([
      { key: 'meat', lines: [{ method: 'cash', amount: '80.00' }, { method: 'online', amount: '20.00' }] },
      { key: 'veg', lines: [{ method: 'online', amount: '50.00' }] },
    ]);
    expect(out[0]!.lines[1]!.moneyAccountId, 'the source keeps its account').toBe('gcash-acct');
    expect(out[1]!.lines[0]!.moneyAccountId).toBe('gcash-acct');
  });

  it('one source covering every group -> each group gets exactly one line of its own amount', () => {
    const out = run([g('a', '100.00'), g('b', '50.00'), g('c', '25.50')], [p('cash', '175.50')]);
    expect(shape(out)).toEqual([
      { key: 'a', lines: [{ method: 'cash', amount: '100.00' }] },
      { key: 'b', lines: [{ method: 'cash', amount: '50.00' }] },
      { key: 'c', lines: [{ method: 'cash', amount: '25.50' }] },
    ]);
  });

  it('a source that ends EXACTLY at a group boundary leaves no zero-amount line (mutant: a 0.00 row)', () => {
    const out = run([g('a', '100.00'), g('b', '50.00')], [p('cash', '100.00'), p('online', '50.00')]);
    expect(shape(out)).toEqual([
      { key: 'a', lines: [{ method: 'cash', amount: '100.00' }] },
      { key: 'b', lines: [{ method: 'online', amount: '50.00' }] },
    ]);
    for (const grp of out) for (const l of grp.lines) expect(l.amount, 'no zero lines').not.toBe('0.00');
  });

  it('centavo amounts are exact (no float drift): 0.10 + 0.20 split 0.15 / 0.15', () => {
    const out = run([g('a', '0.15'), g('b', '0.15')], [p('cash', '0.10'), p('online', '0.20')]);
    expect(shape(out)).toEqual([
      { key: 'a', lines: [{ method: 'cash', amount: '0.10' }, { method: 'online', amount: '0.05' }] },
      { key: 'b', lines: [{ method: 'online', amount: '0.15' }] },
    ]);
  });

  it('the lines add back exactly: per group = the group amount, overall = the payments (mixed centavos, three sources)', () => {
    const groups = [g('a', '1234.56'), g('b', '0.07'), g('c', '999.99')];
    const payments = [p('cash', '500.01'), p('online', '700.00'), p('credit', '1034.61')];
    const out = run(groups, payments);
    out.forEach((grp, i) => expect(add(...grp.lines.map((l) => l.amount)), `group ${grp.key}`).toBe(groups[i]!.amount));
    expect(add(...out.flatMap((x) => x.lines.map((l) => l.amount)))).toBe(add(...payments.map((x) => x.amount)));
  });

  it('keeps group order and payment order exactly as given (not sorted by size)', () => {
    const out = run([g('small', '10.00'), g('big', '90.00')], [p('online', '30.00'), p('cash', '70.00')]);
    expect(out.map((x) => x.key)).toEqual(['small', 'big']);
    expect(shape(out)).toEqual([
      { key: 'small', lines: [{ method: 'online', amount: '10.00' }] },
      { key: 'big', lines: [{ method: 'online', amount: '20.00' }, { method: 'cash', amount: '70.00' }] },
    ]);
  });

  it('payments that do not equal the groups\' total are refused, short or over, with a plain sentence', () => {
    for (const total of ['149.99', '150.01', '0.00']) {
      let caught: unknown = null;
      try {
        run([g('a', '100.00'), g('b', '50.00')], [p('cash', total)]);
      } catch (e) {
        caught = e;
      }
      expect(caught, `payments ${total} vs groups 150.00`).not.toBeNull();
      const msg = (caught as { userMessage?: string }).userMessage;
      expect(msg, 'a sentence a person reads').toBeTruthy();
      expect(msg).not.toMatch(/is not exported|not a function/);
    }
  });
});

describe('T-502 S12 / 1 - the system-made-invoice callers say requireItemised:false explicitly (section 10 D)', () => {
  const src = (rel: string) => readFileSync(resolve(__dirname, '..', 'src', rel), 'utf8');

  it('the recurring-expense job passes requireItemised: false on its createExpense call', () => {
    const job = src('recurring-expenses/job.ts');
    const call = job.slice(job.indexOf('createExpense(tx, actor, {'));
    expect(call.slice(0, 900)).toMatch(/requireItemised:\s*false/);
  });

  it('createExpense and editExpense both know the option, defaulting to true', () => {
    for (const rel of ['expenses/create.ts', 'expenses/edit.ts']) {
      const text = src(rel);
      expect(text, `${rel} names the option`).toMatch(/requireItemised/);
      expect(text, `${rel} defaults it to true`).toMatch(/requireItemised\s*(\?\?|=)\s*true|requireItemised\s*!==\s*false/);
    }
  });
});
