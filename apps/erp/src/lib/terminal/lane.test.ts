import { describe, it, expect } from 'vitest';
import { resolveScan, type MirroredCredential } from './lane';

/**
 * T-321/DEF-363 — `resolveScan` must refuse ambiguity rather than guess. Contract 3:
 * "when a scanned value matches more than one credential it returns null — the same
 * 'not recognised' outcome as an unknown badge, never the first match."
 *
 * ⛔ Written and watched RED before any change to `lane.ts` exists (RULES §3.2).
 */
describe('resolveScan — refuses ambiguity instead of guessing (Contract 3)', () => {
  it('returns null when a value matches MORE THAN ONE credential, in either array order', () => {
    const shared = 'COLLIDING-VALUE';
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

    // ⭐ ORDER-INDEPENDENCE, asserted explicitly. The old behaviour's whole defect was that order
    // decided the answer — this must fail if anyone reintroduces a `find`/`filter`-first pattern
    // that silently picks whichever came first instead of counting how many matched.
    expect(resolveScan([cardHolder, fingerHolder], shared)).toBeNull();
    expect(resolveScan([fingerHolder, cardHolder], shared)).toBeNull();
  });

  it('still resolves a UNIQUE card and a UNIQUE token, unchanged — the refusal must not be over-broad', () => {
    const creds: MirroredCredential[] = [
      { credentialId: 'c1', employmentId: 'e1', kind: 'card', cardId: 'CARD-1' },
      { credentialId: 'c2', employmentId: 'e2', kind: 'fingerprint', matchToken: 'TOKEN-1', templates: ['t1'] },
    ];
    expect(resolveScan(creds, 'CARD-1')?.employmentId).toBe('e1');
    expect(resolveScan(creds, 'TOKEN-1')?.employmentId).toBe('e2');
    expect(resolveScan(creds, 'NOTHING-MATCHES-THIS')).toBeNull();
  });
});
