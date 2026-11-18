import { describe, expect, it } from 'vitest';
import { POS_TEST_BAND, testBandText } from '../src/app/pos/_shell/messages';

describe('T-601 S3 testBandText - only a TEST store says so', () => {
  it("'test' gives the sentence", () => {
    expect(testBandText('test')).toBe(POS_TEST_BAND);
    expect(POS_TEST_BAND).toContain('TEST MODE');
    expect(POS_TEST_BAND).toContain('Nothing here is a real sale');
  });

  it("'live', 'off' and an unknown mode give nothing", () => {
    expect(testBandText('live')).toBeNull();
    expect(testBandText('off')).toBeNull();
    expect(testBandText(undefined)).toBeNull();
  });
});
