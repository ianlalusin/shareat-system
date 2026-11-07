import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RULE_REGISTRY } from '../../../packages/domain/src/business-rules/registry';

vi.mock('../src/app/expenses/lib', () => ({ withOrgPrincipal: vi.fn() }));
vi.mock('@shareat/domain', () => ({ listBusinessRules: vi.fn() }));

import { fromWords, sharedDayWinners } from '../src/app/settings/business-rules/lib';

/**
 * T-512 FIXER (6 Nov 2026) - the audit's screen findings: the large-difference marker, plain words on the rules screen, and the winner among rows that share a start day.
 */
const ROOT = join(__dirname, '..', '..', '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

describe('T-512 fixes - "Large difference" is shown wherever the difference is', () => {
  it('the list row, the phone card (same cell) and the day detail each show the marker from differenceLarge, with the house Badge [kills: a flag computed and never shown]', () => {
    const list = read('apps/erp/src/app/channel-settlements/review/page.tsx');
    const detail = read('apps/erp/src/app/channel-settlements/review/DayDetail.tsx');
    expect(list).toMatch(/row\.differenceLarge[\s\S]{0,240}<Badge tone="warning" label="Large difference"/);
    expect(detail).toMatch(/large=\{detail\.differenceLarge\}/);
    expect(detail).toMatch(/<Badge tone="warning" label="Large difference"/);
  });

  it('large is informational: the list still flags every non-zero difference by isNonZero, never by differenceLarge alone', () => {
    const list = read('apps/erp/src/app/channel-settlements/review/page.tsx');
    expect(list).toMatch(/const differs = isNonZero\(row\.difference\)/);
    expect(list).not.toMatch(/differs\s*=\s*row\.differenceLarge/);
  });
});

describe('T-512 fixes - plain words for an owner', () => {
  const JARGON = /\b(variance|tolerance|slice|migration|registry|basis point)\b/i;
  it('no rule label or help uses jargon', () => {
    for (const [key, def] of Object.entries(RULE_REGISTRY)) {
      expect(def.label, key).not.toMatch(JARGON);
      expect(def.help, key).not.toMatch(JARGON);
    }
  });

  it('the starting value reads "Starting value" and "since the start", never a migration or a year 2000 date', () => {
    const sql = read('packages/db/migrations/0239_t511_business_rule_values.sql');
    expect(sql).toMatch(/NULL, 'Starting value'/);
    expect(sql).not.toMatch(/'starting value \(migration/i);
    expect(fromWords({ id: 'a', value: '50.000000', effectiveFrom: '2000-01-01', createdAt: new Date(), setByName: null, reason: 'Starting value' })).toBe('since the start');
    expect(fromWords({ id: 'b', value: '60.000000', effectiveFrom: '2026-12-01', createdAt: new Date(), setByName: 'Ana', reason: 'x' })).toBe('from Dec 1, 2026');
  });
});

describe('T-512 fixes - which row wins a shared start day', () => {
  const row = (id: string, effectiveFrom: string) => ({ id, value: '1', effectiveFrom, createdAt: new Date(), setByName: 'Ana', reason: 'r' });
  it('the newest of several rows with one start day is marked (history is newest first); a day with one row marks nothing', () => {
    const item = { history: [row('c', '2026-12-05'), row('b2', '2026-12-01'), row('b1', '2026-12-01'), row('a', '2000-01-01')] } as never;
    expect([...sharedDayWinners(item)]).toEqual(['b2']);
    expect(sharedDayWinners({ history: [row('x', '2026-12-01')] } as never).size).toBe(0);
  });
});
