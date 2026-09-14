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
   * ⛔ DISCOVERED, REPORTED, NOT FIXED — `resolveScan` is outside slice A's scope (`lane.ts` is
   * capped at the one authorized line). `lane.ts:170` compares a scanned value against
   * `cardId || matchToken` as ONE flat namespace. Nothing stops a card's `cardId` from coinciding
   * with a DIFFERENT employment's `matchToken`: the two live in independent unique indexes
   * (`attendance_credentials_card_live_unique`, `attendance_credentials_token_live_unique`), each
   * scoped only to its own column — neither constrains the other. When the strings collide,
   * resolution is decided by ARRAY ORDER, not by kind: a fingerprint scan can resolve to a card
   * holder's employment, misattributing the punch to the wrong person. This test documents the
   * actual, current behavior rather than asserting a safe invariant that would fail — see the
   * lane's READY report for the finding.
   */
  it('DISCOVERED: a card cardId colliding with a different employment\'s matchToken resolves by array order, not by kind', () => {
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

    // Card listed first: the fingerprint's own token resolves to the CARD holder — wrong person.
    expect(resolveScan([cardHolder, fingerHolder], shared)?.employmentId).toBe('card-holder');
    // Same input, order flipped: the answer flips with it — decided by array position alone.
    expect(resolveScan([fingerHolder, cardHolder], shared)?.employmentId).toBe('finger-holder');
  });
});
