import { afterEach, describe, expect, it, vi } from 'vitest';
import { jobResult, logger } from '../src/logger';

/**
 * T-495 S3 / DEF-793 - jobResult: counts are mandatory (bible 15.6) and a failure counter can never be hidden by a zero one.
 * Before: `jobResult('j', {})` logged "finished" at info, and `{ failed: 0, errors: 1 }` logged info because `failed ?? errors` kept the zero.
 */
describe('T-495 S3 - jobResult', () => {
  afterEach(() => vi.restoreAllMocks());

  function spy() {
    return { info: vi.spyOn(logger, 'info').mockImplementation(() => undefined), error: vi.spyOn(logger, 'error').mockImplementation(() => undefined) };
  }

  it('refuses an empty counts object, naming the job, and logs nothing', () => {
    const s = spy();
    expect(() => jobResult('audit-empty-counts', {})).toThrow(/audit-empty-counts/);
    expect(s.info).not.toHaveBeenCalled();
    expect(s.error).not.toHaveBeenCalled();
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['negative', -1],
  ])('refuses a %s count', (_l, v) => {
    const s = spy();
    expect(() => jobResult('j', { processed: v })).toThrow(/count/i);
    expect(s.info).not.toHaveBeenCalled();
  });

  it('accepts real counts, zero included: info when nothing failed', () => {
    const s = spy();
    jobResult('mirror-publisher', { processed: 128, skipped: 3, failed: 0 });
    jobResult('idle-job', { processed: 0 });
    expect(s.info).toHaveBeenCalledTimes(2);
    expect(s.error).not.toHaveBeenCalled();
  });

  it('failed > 0 logs an error', () => {
    const s = spy();
    jobResult('j', { processed: 5, failed: 2 });
    expect(s.error).toHaveBeenCalledTimes(1);
    expect(s.info).not.toHaveBeenCalled();
  });

  it('errors > 0 logs an error even when failed is 0 (independent indicators)', () => {
    const s = spy();
    jobResult('j', { failed: 0, errors: 1 });
    expect(s.error).toHaveBeenCalledTimes(1);
    expect(s.info).not.toHaveBeenCalled();
  });

  it('extra context is carried on the line', () => {
    const s = spy();
    jobResult('j', { processed: 1 }, { storeId: 's1' });
    expect(s.info).toHaveBeenCalledWith(expect.objectContaining({ job: 'j', processed: 1, storeId: 's1' }), 'j finished');
  });
});
