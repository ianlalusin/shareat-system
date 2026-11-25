import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * T-639 - an expense alert only nags: it never blocks an expense save, never writes, never holds a close. docs/tasks/639-expense-alerts.md "Never block".
 * Grep-shaped guards (precedent: tests/unit/findings-single-clock.test.ts). Each names the change that turns it red.
 */
const ROOT = join(__dirname, '..', '..', '..', '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');
const code = (src: string): string => src.replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('T-639 the detectors only read', () => {
  const src = code(read('packages/db/src/repo/expense-alerts.ts'));

  it('no write statement and no throw anywhere in the detector file [kills: a detector that inserts, updates, deletes or refuses]', () => {
    expect(src).not.toMatch(/\b(insert\s+into|update\s+[a-z_]+\s+set|delete\s+from)\b/i);
    expect(src).not.toMatch(/\bthrow\b/);
  });

  it("every finding is soft, so none can hold a month close [kills: a 'hard' severity]", () => {
    expect(src).not.toMatch(/'hard'/);
    expect(src.match(/severity: 'soft'/g)?.length).toBe(6);
  });
});

describe('T-639 nothing in the expense workflow can see an alert', () => {
  it('no file of the expense domain imports the alert detectors or the findings feed [kills: wiring an alert into create, approve or edit, where it would refuse a save]', () => {
    const dir = join(ROOT, 'packages/domain/src/expenses');
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
      const text = code(readFileSync(join(dir, name), 'utf8'));
      expect(text, name).not.toMatch(/expenseAlertsRepo|expense-alerts|listFindings|\.\.\/findings/);
    }
  });

  it('the expense and budget repos do not import the alert file either [kills: the data layer calling a detector on write]', () => {
    for (const f of ['expenses.ts', 'budgets.ts', 'expense-items.ts']) {
      expect(code(read(`packages/db/src/repo/${f}`)), f).not.toMatch(/expense-alerts/);
    }
  });
});
