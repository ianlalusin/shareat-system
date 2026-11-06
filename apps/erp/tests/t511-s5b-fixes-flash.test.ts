import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureRedirect, resetJar } from './helpers/flash-jar';

/**
 * T-511 S5b FIXER (2026-11-05), P3-14 - the real `redirectWithFlash` keeps the review page's `platform` and `needs` filters in the address (they are not typed
 * text: a closed word and a flag), and still drops anything of another shape. The real flash module, not a mock.
 */
vi.mock('next/headers', async () => (await import('./helpers/flash-jar-core')).nextHeadersMock());
vi.mock('next/navigation', async () => (await import('./helpers/flash-jar-core')).nextNavigationMock());

type Flash = typeof import('../src/lib/flash');
let flash: Flash;

beforeAll(async () => {
  process.env = { ...process.env, DATABASE_URL: 'postgresql://postgres:pw@localhost:5435/shareat_dev', SESSION_SECRET: 'x'.repeat(48), APP_TIMEZONE: 'Asia/Manila' } as unknown as NodeJS.ProcessEnv;
  flash = await import('../src/lib/flash');
}, 60_000);
beforeEach(() => resetJar());

const go = async (nav: Record<string, string>) => {
  const signal = await captureRedirect(() => flash.redirectWithFlash('/channel-settlements/review', nav as never, { error: 'No.' }));
  return new URL(signal.url, 'http://x.test').searchParams;
};

describe('P3-14 flash navigation keys of the review screen', () => {
  it('platform (grab or foodpanda) and needs (1) survive the redirect [kills: filters dropped by the closed nav set]', async () => {
    const q = await go({ day: '00000000-0000-4000-8000-0000000000a1', platform: 'grab', needs: '1', period: '2026-10', store: '00000000-0000-4000-8000-0000000000b2' });
    expect([q.get('platform'), q.get('needs'), q.get('period')]).toEqual(['grab', '1', '2026-10']);
    expect((await go({ platform: 'foodpanda' })).get('platform')).toBe('foodpanda');
  });

  it('any other platform word or needs value is dropped [kills: free text in the address]', async () => {
    const q = await go({ platform: 'a typed sentence', needs: 'yes' });
    expect(q.get('platform')).toBeNull();
    expect(q.get('needs')).toBeNull();
  });
});
