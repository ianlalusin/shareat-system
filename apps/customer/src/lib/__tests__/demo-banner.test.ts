import { describe, expect, it } from 'vitest';
import { showDemoBanner } from '@/lib/demo-banner';

/** T-581 R3: the "Demo - sample data" banner is true on the fixture screens and false on the live lobby. */
describe('showDemoBanner', () => {
  it('shows on the fixture pages', () => {
    for (const p of ['/menu', '/cart', '/orders', '/bill', '/join', '/']) expect(showDemoBanner(p), p).toBe(true);
  });
  it('hidden on /lobby and everything under it', () => {
    for (const p of ['/lobby', '/lobby/check-in', '/lobby/birthday']) expect(showDemoBanner(p), p).toBe(false);
  });
  it('shows when the path is unknown (null)', () => {
    expect(showDemoBanner(null)).toBe(true);
  });
});
