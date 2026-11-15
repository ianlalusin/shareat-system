import { describe, expect, it } from 'vitest';
import { plural } from '../src/lib/plural';

describe('T-589 B3a plural helper', () => {
  it('one is singular; zero and many are plural', () => {
    expect(plural(1, 'field', 'fields')).toBe('field');
    expect(plural(0, 'field', 'fields')).toBe('fields');
    expect(plural(2, 'person', 'people')).toBe('people');
  });
});
