import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureRedirect, resetJar } from './helpers/flash-jar';

/**
 * T-511 S7b (BUILDER, 11 Nov 2026) - the closed nav key `ack` of the approve screen's reason round trip: `short-3000.00` or `over-3000.00` and nothing else. The real flash
 * module, not a mock. It only says what the person was shown; the domain works the difference out again when the form is posted.
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
  const signal = await captureRedirect(() => flash.redirectWithFlash('/channel-settlements/review', nav as never));
  return new URL(signal.url, 'http://x.test').searchParams;
};

describe('the ack nav key', () => {
  it('a well-shaped figure and direction survive the redirect, next to the day [kills: the question dropped by the closed nav set]', async () => {
    const q = await go({ day: '00000000-0000-4000-8000-0000000000a1', ack: 'short-3000.00' });
    expect(q.get('ack')).toBe('short-3000.00');
    expect(q.get('day')).toBe('00000000-0000-4000-8000-0000000000a1');
    expect((await go({ ack: 'over-0.50' })).get('ack')).toBe('over-0.50');
    expect((await go({ ack: 'over-123456789012.99' })).get('ack')).toBe('over-123456789012.99');
  });

  it('every other shape is dropped [kills: free text, a negative or a script in the address]', async () => {
    for (const bad of ['short', 'short-3000', 'short-3000.0', 'sideways-3000.00', 'short--3.00', 'SHORT-3.00', 'short-3000.00 ', 'short-3000.001', 'over-1234567890123.00', 'short-<b>.00', '']) {
      expect((await go({ ack: bad })).get('ack'), JSON.stringify(bad)).toBeNull();
    }
  });
});
