/**
 * T-602 S2 - `readinessOf(feed)`: the one close-verdict rule, shared by `closeReadiness` and the findings screen.
 * An acknowledged HARD finding still blocks; a soft one never does.
 */
import { describe, expect, it } from 'vitest';
import { readinessOf, type Finding, type FindingsFeed } from '../../src/findings';

const finding = (severity: 'hard' | 'soft', status: 'open' | 'acknowledged', key: string): Finding => ({
  kind: key, key, storeId: null, severity, detail: '', status,
  acknowledgedBy: status === 'acknowledged' ? 'p' : null, acknowledgedAt: null, acknowledgementExpiresAt: null, acknowledgementAgeDays: null,
});
const feedOf = (findings: Finding[]): FindingsFeed => ({
  findings,
  openCount: findings.filter((f) => f.status === 'open').length,
  acknowledgedCount: findings.filter((f) => f.status === 'acknowledged').length,
  hardCount: findings.filter((f) => f.severity === 'hard').length,
});

describe('readinessOf', () => {
  it('an acknowledged hard finding still blocks', () => {
    const r = readinessOf(feedOf([finding('hard', 'acknowledged', 'a')]), true);
    expect(r.ready).toBe(false);
    expect(r.blocking.map((f) => f.key)).toEqual(['a']);
  });
  it('a soft finding never blocks, open or acknowledged', () => {
    expect(readinessOf(feedOf([finding('soft', 'open', 'a'), finding('soft', 'acknowledged', 'b')]), true)).toEqual({ ready: true, blocking: [], noOpenPeriod: false });
  });
  it('an empty feed is ready', () => {
    expect(readinessOf(feedOf([]), true)).toEqual({ ready: true, blocking: [], noOpenPeriod: false });
  });
  it('DEF-439: a clean feed with no open period is not ready', () => {
    expect(readinessOf(feedOf([]), false)).toEqual({ ready: false, blocking: [], noOpenPeriod: true });
  });
});
