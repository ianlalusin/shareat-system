/**
 * T-343 S6a — capabilityTitle(name), the capitalised form of CAPABILITY_LABEL for lists and
 * banners (S6 design rule 2). docs/tasks/343-def-417-human-readable-refusals.md §S6a.
 *
 * ⛔ TESTER, not BUILDER. `capabilityTitle` does not exist on capabilities.ts yet — the import
 * below is expected to leave it `undefined` until S6a lands. Imported from the defining file, not
 * the `@shareat/auth` barrel, so a missing barrel export line cannot mask or fake a red (spec's
 * own TESTER-paths note).
 */
import { describe, expect, it } from 'vitest';
import { CAPABILITIES, CAPABILITY_LABEL, capabilityTitle, type Capability } from '../src/capabilities';

describe('L4 — capabilityTitle is CAPABILITY_LABEL upper-cased at the first character, for every Capability', () => {
  it('every Capability', () => {
    for (const c of CAPABILITIES as readonly Capability[]) {
      const label = CAPABILITY_LABEL[c];
      expect(capabilityTitle(c)).toBe(label[0]!.toUpperCase() + label.slice(1));
    }
  });

  it("capabilityTitle('record_sale') === 'Record a sale'", () => {
    expect(capabilityTitle('record_sale')).toBe('Record a sale');
  });

  it("capabilityTitle('retired_power') === 'Retired power' (unknown name, humanised, never throws)", () => {
    expect(capabilityTitle('retired_power')).toBe('Retired power');
  });
});

describe('L5 — form: every capabilityTitle(c) is one line, starts upper-case, no underscore', () => {
  it('every Capability', () => {
    for (const c of CAPABILITIES as readonly Capability[]) {
      const title = capabilityTitle(c);
      expect(title.includes('\n')).toBe(false);
      expect(/^[A-Z]/.test(title)).toBe(true);
      expect(title.includes('_')).toBe(false);
    }
  });
});
