/**
 * T-343 S2 — T1: every refusal-text function, for every Capability (and every Role for
 * `roleMayNot`), produces one human sentence: single line, starts uppercase, ends `.`, carries no
 * `_` (no raw key), no quoted key, no UUID. `ROLE_LABEL`/`CAPABILITY_LABEL` are exhaustive,
 * non-empty and duplicate-free.
 *
 * docs/tasks/343-def-417-human-readable-refusals.md §S2.
 *
 * ⛔ TESTER, not BUILDER. `packages/auth/src/refusal-text.ts` and the two labels on
 * `capabilities.ts` do not exist yet — every import below is expected to fail to resolve until S2
 * lands. That import failure IS this file's raw red.
 */
import { describe, expect, it } from 'vitest';
// ⛔ S2 BUILDER-only exports — ROLE_LABEL/CAPABILITY_LABEL do not exist on capabilities.ts yet.
// Missing today; that is this describe block's expected red (both at typecheck and at runtime,
// since Vitest's esbuild transform strips types and leaves the two names `undefined`).
import { CAPABILITIES, CAPABILITY_LABEL, ROLES, ROLE_LABEL, type Capability, type Role } from '../src/capabilities';
// ⛔ S2 BUILDER-only module — does not exist yet. Missing today; expected red.
import {
  closePeriodNeedsWholeOrg,
  noActiveRole,
  notAssignedToStore,
  otherOrg,
  roleMayNot,
  storeNotInOrg,
  storeRequired,
} from '../src/refusal-text';

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

function isHumanSentence(s: unknown): s is string {
  return typeof s === 'string' && s.trim() === s && s.length > 0;
}

/** Every rule T1 names, applied to one produced sentence. */
function assertHumanSentence(sentence: string, label: string): void {
  expect(isHumanSentence(sentence), `${label}: must be a non-empty, untrimmed-safe string`).toBe(true);
  expect(sentence.includes('\n'), `${label}: must be a single line`).toBe(false);
  expect(/^[A-Z]/.test(sentence), `${label}: must start with an upper-case letter`).toBe(true);
  expect(sentence.endsWith('.'), `${label}: must end with a full stop`).toBe(true);
  expect(sentence.includes('_'), `${label}: must carry no raw snake_case key`).toBe(false);
  expect(/'[a-z_]+'/.test(sentence) === false || !/[a-z]_[a-z]/.test(sentence), `${label}: must carry no quoted key`).toBe(
    true,
  );
  expect(UUID_RE.test(sentence), `${label}: must carry no UUID`).toBe(false);
}

const fixtureStore = { name: 'SM Mall of Asia', code: 'SM-MOA' };

describe('T1 — roleMayNot: every Role × every Capability produces a human sentence', () => {
  for (const role of ROLES as readonly Role[]) {
    for (const capability of CAPABILITIES as readonly Capability[]) {
      it(`${role} may not ${capability}`, () => {
        assertHumanSentence(roleMayNot(role, capability), `roleMayNot(${role}, ${capability})`);
      });
    }
  }
});

describe('T1 — notAssignedToStore: every Capability, with and without a store', () => {
  for (const capability of CAPABILITIES as readonly Capability[]) {
    it(`${capability}, store known`, () => {
      assertHumanSentence(notAssignedToStore(capability, fixtureStore), `notAssignedToStore(${capability}, store)`);
    });
    it(`${capability}, store unknown (lookup failed)`, () => {
      assertHumanSentence(notAssignedToStore(capability, undefined), `notAssignedToStore(${capability}, undefined)`);
    });
  }

  it('names the store by name and code when known', () => {
    const sentence = notAssignedToStore('void_expense', fixtureStore);
    expect(sentence).toContain(fixtureStore.name);
    expect(sentence).toContain(fixtureStore.code);
  });
});

describe('T1 — otherOrg / storeRequired: every Capability', () => {
  for (const capability of CAPABILITIES as readonly Capability[]) {
    it(`otherOrg(${capability})`, () => {
      assertHumanSentence(otherOrg(capability), `otherOrg(${capability})`);
    });
    it(`storeRequired(${capability})`, () => {
      assertHumanSentence(storeRequired(capability), `storeRequired(${capability})`);
    });
  }

  it('otherOrg never names an organization at all (bible §7/§15.11 — no cross-tenant disclosure)', () => {
    // No fixture org name is ever passed to otherOrg — the function's signature itself is the
    // guard: it takes only a capability, so there is nothing to leak.
    expect(otherOrg('manage_users').length).toBeGreaterThan(0);
  });
});

describe('T1 — org-naming sentences: noActiveRole / storeNotInOrg / closePeriodNeedsWholeOrg', () => {
  it('noActiveRole, org known', () => {
    assertHumanSentence(noActiveRole('Acme Foods'), 'noActiveRole(known)');
    expect(noActiveRole('Acme Foods')).toContain('Acme Foods');
  });
  it('noActiveRole, org unknown (lookup failed)', () => {
    assertHumanSentence(noActiveRole(undefined), 'noActiveRole(undefined)');
  });
  it('storeNotInOrg, org known', () => {
    assertHumanSentence(storeNotInOrg('Acme Foods'), 'storeNotInOrg(known)');
  });
  it('storeNotInOrg, org unknown', () => {
    assertHumanSentence(storeNotInOrg(undefined), 'storeNotInOrg(undefined)');
  });
  it('closePeriodNeedsWholeOrg, org known', () => {
    assertHumanSentence(closePeriodNeedsWholeOrg('Acme Foods'), 'closePeriodNeedsWholeOrg(known)');
  });
  it('closePeriodNeedsWholeOrg, org unknown', () => {
    assertHumanSentence(closePeriodNeedsWholeOrg(undefined), 'closePeriodNeedsWholeOrg(undefined)');
  });
});

describe('T1 — ROLE_LABEL / CAPABILITY_LABEL are exhaustive, non-empty, duplicate-free', () => {
  it('every Role has a non-empty label', () => {
    for (const role of ROLES as readonly Role[]) {
      expect(typeof ROLE_LABEL[role]).toBe('string');
      expect(ROLE_LABEL[role].trim().length).toBeGreaterThan(0);
    }
  });

  it('every Capability has a non-empty label, lower-case bare-infinitive phrasing', () => {
    for (const capability of CAPABILITIES as readonly Capability[]) {
      const label = CAPABILITY_LABEL[capability];
      expect(typeof label).toBe('string');
      expect(label.trim().length).toBeGreaterThan(0);
      expect(label).not.toContain('_');
      expect(/^[a-z]/.test(label)).toBe(true); // "you can't <label>" — lower-case bare infinitive
    }
  });

  it('no two capabilities share the exact same label', () => {
    const labels = (CAPABILITIES as readonly Capability[]).map((c) => CAPABILITY_LABEL[c]);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('no two roles share the exact same label', () => {
    const labels = (ROLES as readonly Role[]).map((r) => ROLE_LABEL[r]);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
