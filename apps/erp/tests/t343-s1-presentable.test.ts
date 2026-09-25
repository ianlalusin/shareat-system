/**
 * T-343 S1 — the choke point never returns a UUID; presentable errors win.
 * docs/tasks/343-def-417-human-readable-refusals.md §S1, as corrected by Amendment R1.
 *
 * ⛔ **Amendment R1 changes the shape of this file from the spec's literal S1 Red list.** S1's own
 * text said R1/R3/R4 resolve to `UNPRESENTABLE_FALLBACK` (the whole sentence blanked). R1 (binding,
 * 2026-09-25) overrides that: every UUID in the candidate is replaced by `[hidden]` IN PLACE and the
 * rest of the sentence survives; the fallback is used only when the candidate is a dump
 * (`looksLikeADump`) or empty after redaction. R1/R3/R4 below assert the REDACTED form, not the
 * fallback — this is the ruled behaviour, not a weakening of the original cases.
 *
 * TESTER, not BUILDER — see `docs/tasks/343-def-417-human-readable-refusals.md`. `UUID_SHAPE`,
 * `containsIdentifier`, `isPresentable` do not exist in `../src/lib/error-shape` yet: importing them
 * is expected to fail to resolve until S1 lands — that is the raw red for this whole file, not a
 * defect in the test.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@shareat/core/logger';
import { AuthorizationError } from '@shareat/auth/errors';
import { errorMessage } from '../src/lib/constraint-messages';
// ⛔ S1 BUILDER-only exports — see the file header. Missing today; that is the expected red.
import { containsIdentifier, isPresentable, UUID_SHAPE } from '../src/lib/error-shape';
import { preSessionMessage, SETUP_POLICY } from '../src/lib/pre-session-message';

afterEach(() => {
  vi.restoreAllMocks();
});

const U = '0190a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b';
const V = '0190ffff-0000-7000-8000-000000000001';

// ---------------------------------------------------------------------------------------------
// R1 (amended) — a non-presentable Error whose raw text carries two UUIDs is redacted in place,
// not blanked to the fallback. "Red: raw text" — today `errorMessage` returns the UUIDs verbatim.
// ---------------------------------------------------------------------------------------------
describe('R1 — a codeless plain Error carrying UUIDs is redacted in place, not blanked', () => {
  it('replaces every UUID with [hidden] and keeps the rest of the sentence', () => {
    const message = errorMessage(new Error(`authorize: store ${U} does not belong to org ${V}`));
    expect(message).not.toContain(U);
    expect(message).not.toContain(V);
    expect(message).toContain('[hidden]');
    // ⛔ The whole point of Amendment R1: this is NOT the blanket fallback sentence.
    expect(message).not.toBe(
      'That could not be done, and the reason is not one this screen can show yet. It has been logged for your admin.',
    );
    expect(message).toContain('does not belong to org');
  });
});

// ---------------------------------------------------------------------------------------------
// R2 — a presentable Error (own, non-empty `userMessage`, no UUID in it) wins outright, even
// though the raw `.message` underneath carries a UUID. Unaffected by Amendment R1.
// ---------------------------------------------------------------------------------------------
describe('R2 — a presentable error returns exactly its userMessage', () => {
  it("Object.assign'd userMessage wins over the raw message, verbatim", () => {
    const err = Object.assign(new Error(`raw ${U}`), {
      userMessage: "Your role (Manager) can't close an accounting period.",
    });
    expect(errorMessage(err)).toBe("Your role (Manager) can't close an accounting period.");
  });
});

// ---------------------------------------------------------------------------------------------
// R3 (amended) — a P0001 hand-authored RAISE carrying a UUID is redacted in place; the rest of a
// precise accounting sentence (DEF-279's own population) must survive untouched.
// ---------------------------------------------------------------------------------------------
describe('R3 — a P0001 application raise with an id is redacted, the rest survives', () => {
  it('keeps the sentence, hides only the id', () => {
    const err = Object.assign(new Error(`cash request ${U} is not approved`), { code: 'P0001' });
    const message = errorMessage(err);
    expect(message).not.toContain(U);
    expect(message).toBe('cash request [hidden] is not approved');
  });
});

// ---------------------------------------------------------------------------------------------
// R4 (amended) — a presentable error whose OWN userMessage carries a UUID is also redacted in
// place, never blanked to the fallback (the userMessage is the whole point of being presentable).
// ---------------------------------------------------------------------------------------------
describe('R4 — a presentable userMessage that itself carries a UUID is redacted, not discarded', () => {
  it('redacts the id inside userMessage and keeps the rest', () => {
    const err = Object.assign(new Error('irrelevant raw text, never shown'), {
      userMessage: `Cannot delete store ${U} because it has open transactions.`,
    });
    const message = errorMessage(err);
    expect(message).not.toContain(U);
    expect(message).toBe('Cannot delete store [hidden] because it has open transactions.');
  });
});

// ---------------------------------------------------------------------------------------------
// R5 — every redaction is LOGGED once with the whole `err` and the raw text (invariant 3:
// sanitising is not discarding).
// ---------------------------------------------------------------------------------------------
describe('R5 — a redacted identifier is logged exactly once, with the raw text', () => {
  it('logger.warn is called once, carrying { err, raw } (Amendment R3 item 3 — WARN, not ERROR)', () => {
    const spy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const raw = `authorize: store ${U} does not belong to org ${V}`;
    errorMessage(new Error(raw));
    expect(spy).toHaveBeenCalledTimes(1);
    const [payload] = spy.mock.calls[0] ?? [];
    expect(payload).toMatchObject({ raw });
  });
});

// ---------------------------------------------------------------------------------------------
// R6 (amended, Amendment R1 §2) — `/setup` has no admin yet. The ONE production caller
// (`apps/erp/src/app/setup/actions.ts:115`) passes `errorMessage(err)` EXPLICITLY as the third
// argument, not the default `err.message`. This tests THAT path, not merely the default.
// ---------------------------------------------------------------------------------------------
describe('R6 — the explicit-argument path used by setup/actions.ts:115 never leaks a raw id', () => {
  it('an AuthorizationError carrying a UUID never reaches the /setup URL with that UUID intact, in production', () => {
    const err = new AuthorizationError(
      `authorize: person ${U} has no active role in org ${U}`,
      'manage_users',
    );
    // Mirrors the real call site exactly: preSessionMessage(err, SETUP_POLICY, errorMessage(err)).
    const explicitMessage = errorMessage(err);
    const original = process.env.NODE_ENV;
    (process.env as { NODE_ENV?: string }).NODE_ENV = 'production';
    try {
      const shown = preSessionMessage(err, SETUP_POLICY, explicitMessage);
      expect(shown).not.toContain(U);
    } finally {
      (process.env as { NODE_ENV?: string }).NODE_ENV = original;
    }
  });

  // A pin, not a new red: SETUP_POLICY.opaque is already admin-free today. Guards Amendment R1 §2's
  // wording rule ("must not say 'logged for your admin'" — /setup has no admin) from regressing if a
  // future edit reaches for the shared, admin-flavoured fallback wording instead of this policy's own.
  it('SETUP_POLICY.opaque never mentions an admin — /setup has none yet (pin)', () => {
    expect(SETUP_POLICY.opaque.toLowerCase()).not.toContain('admin');
  });
});

// ---------------------------------------------------------------------------------------------
// N2 — sanity for the new shared predicate: dates, peso amounts, store codes and a bare 12-digit
// number are NOT identifiers. Not one of S1's numbered Red cases, but `containsIdentifier` is a
// brand-new predicate this file is the first to exercise directly.
// ---------------------------------------------------------------------------------------------
describe('N2 — containsIdentifier / UUID_SHAPE do not fire on ordinary business text', () => {
  it('a UUID matches', () => {
    expect(UUID_SHAPE.test(U)).toBe(true);
    expect(containsIdentifier(`order ${U} was voided`)).toBe(true);
  });

  it('a date, a peso amount, a store code and a 12-digit number do not match', () => {
    expect(containsIdentifier('closed on 2026-09-25')).toBe(false);
    expect(containsIdentifier('the total is ₱12,345.67')).toBe(false);
    expect(containsIdentifier('store SM-MOA is over ceiling')).toBe(false);
    expect(containsIdentifier('reference 123456789012')).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// N3 — `isPresentable` rejects an empty or whitespace-only userMessage, and a multi-line one.
// ---------------------------------------------------------------------------------------------
describe('N3 — isPresentable rejects a dump or an empty userMessage', () => {
  it('an empty userMessage is not presentable', () => {
    const err = Object.assign(new Error('raw'), { userMessage: '' });
    expect(isPresentable(err)).toBe(false);
  });

  it('a multi-line userMessage is not presentable (it is a dump, not a sentence)', () => {
    const err = Object.assign(new Error('raw'), { userMessage: 'a\nb' });
    expect(isPresentable(err)).toBe(false);
  });

  it('a DB error with a string code never jumps its mapped sentence via userMessage (Amendment R1 §4)', () => {
    const err = Object.assign(new Error('raw'), { userMessage: 'looks fine', code: '23514' });
    expect(isPresentable(err)).toBe(false);
  });
});
