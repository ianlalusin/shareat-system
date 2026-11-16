/**
 * T-591: the old /cutover links redirect (308) to /opening-balances. One explicit rule per path; the query string rides along
 * (Next appends it unless the destination names its own), so `/cutover/count?store=X&room=Y` keeps its store and room.
 */
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

type Rule = { source: string; destination: string; permanent: boolean };
const nextConfig = createRequire(import.meta.url)('../next.config.js') as { redirects: () => Promise<Rule[]> };

const EXPECTED: Record<string, string> = {
  '/cutover': '/opening-balances',
  '/cutover/count': '/opening-balances/stock-count',
  '/cutover/count/sheet': '/opening-balances/stock-count/sheet',
  '/cutover/opening': '/opening-balances/balance-sheet',
};

describe('T-591 old /cutover URLs redirect permanently to /opening-balances', () => {
  for (const [from, to] of Object.entries(EXPECTED)) {
    it(`${from} -> ${to}`, async () => {
      const rule = (await nextConfig.redirects()).find((r) => r.source === from);
      expect(rule, `no redirect rule for ${from}`).toBeDefined();
      expect(rule!.destination).toBe(to);
      expect(rule!.permanent).toBe(true);
      // No hard-coded query on the destination: Next then appends the incoming one, so ?store=X&room=Y survives.
      expect(rule!.destination).not.toContain('?');
    });
  }

  it('nothing else redirects, and no rule is a catch-all', async () => {
    const rules = await nextConfig.redirects();
    expect(rules.map((r) => r.source).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const r of rules) expect(r.source).not.toMatch(/[:*(]/);
  });
});
