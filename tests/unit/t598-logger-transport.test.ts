import { describe, expect, it } from 'vitest';
import { pickTransport } from '../../packages/core/src/logger';

/**
 * T-598 S9 / DEF-634 - the pretty transport only when `pino-pretty` is installed (it is a dev dependency, so a server built with
 * `--omit=dev` that does not set NODE_ENV=production must still log JSON, not crash on a missing module).
 * MUTANT: ignore `prettyAvailable` (`return isDev ? { transport } : {}`) -> the second case goes red.
 */
describe('pickTransport', () => {
  it('uses pino-pretty in development when it resolves', () => {
    expect(pickTransport(true, true)).toHaveProperty('transport.target', 'pino-pretty');
  });
  it('falls back to JSON in development when it does not resolve', () => {
    expect(pickTransport(true, false)).toEqual({});
  });
  it('is JSON in production whatever is installed', () => {
    expect(pickTransport(false, true)).toEqual({});
  });
});
