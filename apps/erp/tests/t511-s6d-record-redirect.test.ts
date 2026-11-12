/**
 * T-511 S6d - where recordSettlementAction sends the person. A refused post lands back on /channel-settlements/record
 * (channel and day kept, so the form reopens on the same day, with the error banner); a good post goes to the overview.
 * The domain is replaced by a stand-in that throws or succeeds; the flash module records the redirect it is asked for.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Redirect { path: string; nav: Record<string, string>; flash: Record<string, unknown> | undefined }
let outcome: 'refuse' | 'post' = 'refuse';

vi.mock('../src/lib/flash', () => ({
  redirectWithFlash: async (path: string, nav: Record<string, string>, flash?: Record<string, unknown>) => {
    throw Object.assign(new Error('redirect'), { redirect: { path, nav, flash } satisfies Redirect });
  },
}));
vi.mock('../src/lib/session', () => ({ requireActor: async () => ({ orgId: 'org-1', personId: 'p-1' }) }));
vi.mock('../src/lib/constraint-messages', () => ({ errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)) }));
vi.mock('../src/app/channel-settlements/lib', () => ({
  withOrgPrincipal: async () => {
    if (outcome === 'refuse') throw new Error('The payout is short of the day.');
    return undefined;
  },
}));
vi.mock('@shareat/domain', () => ({ assertFieldRules: () => undefined, recordChannelSettlement: async () => undefined }));

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

async function run(fields: Record<string, string>): Promise<Redirect> {
  const { recordSettlementAction } = await import('../src/app/channel-settlements/actions');
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  try {
    await recordSettlementAction(fd);
  } catch (e) {
    const r = (e as { redirect?: Redirect }).redirect;
    if (r) return r;
    throw e;
  }
  throw new Error('recordSettlementAction returned without redirecting');
}

describe('recordSettlementAction redirect target', () => {
  beforeEach(() => { outcome = 'refuse'; });

  it('a refused post goes back to /channel-settlements/record with the channel, the day and the error', async () => {
    const r = await run({ channelId: UUID_A, salesDayId: UUID_B });
    expect(r.path).toBe('/channel-settlements/record');
    expect(r.nav).toEqual({ channel: UUID_A, day: UUID_B });
    expect(r.flash).toEqual({ error: 'The payout is short of the day.' });
  }, 120000);

  it('a refusal before any day is chosen keeps only what was chosen', async () => {
    const r = await run({ channelId: UUID_A });
    expect(r.path).toBe('/channel-settlements/record');
    expect(r.nav).toEqual({ channel: UUID_A });
  }, 120000);

  it('a good post still goes to the overview', async () => {
    outcome = 'post';
    const r = await run({ channelId: UUID_A, salesDayId: UUID_B });
    expect(r.path).toBe('/channel-settlements');
    expect(r.flash).toEqual({ ok: 'posted' });
  }, 120000);
});
