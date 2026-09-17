import { describe, it, expect } from 'vitest';
import { resolveScan, type MirroredCredential } from './lane';
import { generateMatchToken } from '@shareat/domain/attendance/fingerprint';

/**
 * T-314 slice A — the seam invariant the task doc calls "exactly where a port breaks": a token
 * minted by the imported fingerprint logic must resolve through the clock terminal's EXISTING
 * `resolveScan`, unchanged. This cannot live in `packages/domain` — RULES §1 rule 13 forbids a
 * package importing an app — so it sits here, on the app side, importing both halves of the seam.
 */
describe('T-314 seam — a slice-A token resolves through the existing resolveScan', () => {
  it('a freshly minted token matches its own mirrored credential and nothing else', () => {
    const token = generateMatchToken();
    const creds: MirroredCredential[] = [
      { credentialId: 'c1', employmentId: 'e1', kind: 'fingerprint', matchToken: token, templates: ['t1'] },
      { credentialId: 'c2', employmentId: 'e2', kind: 'card', cardId: 'CARD-1' },
    ];
    expect(resolveScan(creds, token)?.employmentId).toBe('e1');
    expect(resolveScan(creds, generateMatchToken())).toBeNull();
  });

  /**
   * ⛔⛔ T-321/DEF-363 — INVERTED. This test used to be titled "DISCOVERED: a card cardId
   * colliding with a different employment's matchToken resolves by array order, not by kind", and
   * it asserted the collision RESOLVED — to the card holder with one array order, to the
   * fingerprint holder with the other — proving array order decided who you are. That assertion
   * PASSED (green) against `lane.ts` as it stood before this task, which is exactly RULES §3.2's
   * warning made concrete: a test that documents broken behaviour and is green is not a red
   * control. It is inverted here, in the same file rather than deleted, so the shape of what was
   * wrong stays visible next to what replaced it.
   *
   * The database-level fix (T-321 Contract 1) makes this specific STORED state unreachable going
   * forward — a live card_id and a live match_token can no longer share a value in one org. This
   * test proves the SECOND, independent layer invariant 1 asks for by name: `resolveScan` itself
   * must never guess even if it is ever handed an ambiguous array (a migration gap, a mirror bug,
   * two credentials momentarily live during a revoke-then-reissue race) — it is a detector for a
   * state Contract 1 is supposed to make unreachable, not a substitute for it (bible §15.11, per
   * the spec's own framing).
   */
  it('a card cardId colliding with a different employment\'s matchToken resolves to NOBODY, in either array order', () => {
    const shared = generateMatchToken();
    const cardHolder: MirroredCredential = {
      credentialId: 'c-card',
      employmentId: 'card-holder',
      kind: 'card',
      cardId: shared,
    };
    const fingerHolder: MirroredCredential = {
      credentialId: 'c-finger',
      employmentId: 'finger-holder',
      kind: 'fingerprint',
      matchToken: shared,
      templates: ['t1'],
    };

    // ⭐ ORDER-INDEPENDENCE is the whole point of the inversion. The old test's title was "resolves
    // by array order" — this one must fail the instant anyone reintroduces a `find` that returns
    // the first match instead of refusing when more than one matches.
    expect(resolveScan([cardHolder, fingerHolder], shared)).toBeNull();
    expect(resolveScan([fingerHolder, cardHolder], shared)).toBeNull();
  });
});
