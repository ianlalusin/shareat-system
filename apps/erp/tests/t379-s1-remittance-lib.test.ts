import { describe, expect, it, vi } from 'vitest';

/**
 * T-379 S1 (DEF-570) - `cashCustodyFindings` asks the domain for the three cash kinds only, never for the full feed
 * (about sixty detectors, run on every /remittance load). `docs/tasks/379-erp-small-follow-ups.md` S1, L1.
 *
 *   L1  `@shareat/domain` is mocked: `listFindings` throws 'full feed called'; `listCashCustodyFindings` returns A, B and an
 *       org-wide finding. cashCustodyFindings(org, 'A') returns A and org-wide, not B.
 *       Mutants: the lib still calls listFindings -> red (throws); the store filter is dropped -> red (B comes back);
 *                the org-wide arm (`storeId === null`) is dropped -> red.
 */
const cash = (key: string, storeId: string | null) => ({
  key, kind: 'unremittedCeilingBreached', storeId, severity: 'soft', detail: key, status: 'open',
  acknowledgedBy: null, acknowledgedAt: null, acknowledgementExpiresAt: null, acknowledgementAgeDays: null,
});

vi.mock('@shareat/domain', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    listFindings: () => {
      throw new Error('full feed called');
    },
    listCashCustodyFindings: async () => ({
      findings: [cash('A-finding', 'store-A'), cash('B-finding', 'store-B'), cash('org-finding', null)],
      openCount: 3, acknowledgedCount: 0, hardCount: 0,
    }),
  };
});
vi.mock('../src/app/expenses/lib', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, withOrgPrincipal: async (_org: string, fn: (tx: unknown) => unknown) => fn({}) };
});

import { cashCustodyFindings } from '../src/app/remittance/lib';

describe('cashCustodyFindings (T-379 S1 L1)', () => {
  it('returns store A and the org-wide finding, not B, and never calls the full feed', async () => {
    const got = await cashCustodyFindings('org-1', 'store-A');
    expect(got.map((f) => f.key)).toEqual(['A-finding', 'org-finding']);
  });
});
