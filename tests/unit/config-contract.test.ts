import { describe, expect, it } from 'vitest';
import { checkValuesMatch } from '../../scripts/lib/config-contract';

/**
 * T-292 / DEF-315 — `checkValuesMatch`, the inverse of `checkValuesDiffer`. Offline, pure, no
 * fixtures beyond the literal arguments each test passes.
 */
describe('checkValuesMatch', () => {
  it('matching values → ok', () => {
    const result = checkValuesMatch(
      { envVar: 'A', value: 'x' },
      { envVar: 'B', value: 'x' },
      'some-doc:1',
      'something would go wrong',
    );
    expect(result.ok).toBe(true);
  });

  it('mismatched values → not ok, message names both variables and the citation', () => {
    const result = checkValuesMatch(
      { envVar: 'A', value: 'x' },
      { envVar: 'B', value: 'y' },
      'some-doc:1',
      'something would go wrong',
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain('A');
    expect(result.message).toContain('B');
    expect(result.message).toContain('"x"');
    expect(result.message).toContain('"y"');
    expect(result.message).toContain('some-doc:1');
    expect(result.message).toContain('something would go wrong');
  });

  it('an ABSENT counterpart is treated as nothing to compare, not a mismatch — the control that proves this is safe to call unconditionally', () => {
    const result = checkValuesMatch(
      { envVar: 'A', value: 'x' },
      { envVar: 'B', value: undefined },
      'some-doc:1',
      'something would go wrong',
    );
    expect(result.ok).toBe(true);
  });
});
