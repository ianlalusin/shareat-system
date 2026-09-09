import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * T-245 — the guard for design question 4: "what stops the next domain refusal being written
 * without a decision." docs/tasks/245-prerequisite-refusal-counter.md §6.
 *
 * ⛔ This is a SOURCE SCAN, not a behavioural test: it reads `credentials.ts` as text and asserts
 * every `throw new CredentialError(` site is accounted for in the manifest below, anchored on a
 * fragment of the throw's own message rather than a line number (line numbers shift; a message
 * fragment does not, and a genuine wording change is exactly the moment to re-examine the
 * classification anyway). A throw added to this file with no matching manifest entry — or an
 * anchor that no longer matches because the message changed — fails this test. That is the point:
 * the decision (prerequisite-shaped or not) has to be made explicitly, not skipped.
 *
 * Same shape as `tests/unit/nav-route-reachability.test.ts`'s `UNLINKED_BY_DESIGN` and T-241's own
 * guard: enumerated from a checked-in list, never trusted from a live grep alone.
 */

const CREDENTIALS_FILE = path.join(__dirname, 'credentials.ts');

interface ManifestEntry {
  /** A fragment of the throw's message, unique within the file. */
  readonly anchor: string;
  readonly prerequisiteShaped: boolean;
  /** Required when prerequisiteShaped is true — the stable key recorded in prerequisite_refusals. */
  readonly reasonCode?: string;
  /** One line: why this classification, per §1's rule. */
  readonly why: string;
}

const MANIFEST: readonly ManifestEntry[] = [
  {
    anchor: 'A card needs an id',
    prerequisiteShaped: false,
    why: 'Validation on the current request — fixed by typing a label into the same form.',
  },
  {
    anchor: 'That card is already enrolled',
    prerequisiteShaped: true,
    reasonCode: 'attendance.credential.already_enrolled_elsewhere',
    why: 'A different credential\'s state must change first (revoke it there) — a separate action.',
  },
  {
    anchor: 'A fingerprint enrolment needs',
    prerequisiteShaped: false,
    why: 'Validation — capture more templates in the same enrolment flow.',
  },
  {
    anchor: 'fingers per staffer',
    prerequisiteShaped: false,
    why: 'Validation — submit fewer templates in the same request.',
  },
  {
    anchor: 'No credential ',
    prerequisiteShaped: false,
    why: 'Not-found: a stale/bad id, not a business order-of-operations lesson.',
  },
  {
    anchor: 'That credential was already revoked on',
    prerequisiteShaped: false,
    why: 'Closed-path/immutability — no "do X first" remedy, the record reached a terminal state.',
  },
  {
    anchor: 'Revoking a credential needs a reason',
    prerequisiteShaped: false,
    why: 'Validation — supply a reason in the same request.',
  },
  {
    anchor: 'That credential was revoked by somebody else',
    prerequisiteShaped: false,
    why: 'Closed-path via a race — same category as an already-revoked conflict.',
  },
  {
    anchor: 'No employment ',
    prerequisiteShaped: false,
    why: 'Not-found: a stale/bad id.',
  },
  {
    anchor: 'That employment has ended',
    prerequisiteShaped: true,
    reasonCode: 'attendance.credential.employment_ended',
    why: 'Employment (a different domain module) must be active first — order of operations.',
  },
];

describe('T-245 — credentials.ts throw classification manifest agrees with the live source', () => {
  const source = readFileSync(CREDENTIALS_FILE, 'utf8');

  it('⭐ finds throw sites at all — a scan matching nothing must not pass as zero (bible §12)', () => {
    const matches = [...source.matchAll(/throw new CredentialError\(/g)];
    expect(matches.length).toBeGreaterThan(0);
  });

  it('every `throw new CredentialError(` site is exactly the manifest — no more, no fewer', () => {
    const liveCount = [...source.matchAll(/throw new CredentialError\(/g)].length;
    expect(liveCount).toBe(MANIFEST.length);
  });

  it('every manifest anchor matches exactly one throw message in the live source', () => {
    const missing: string[] = [];
    for (const entry of MANIFEST) {
      const re = new RegExp(
        `throw new CredentialError\\([\\s\\S]{0,40}?${entry.anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
      );
      if (!re.test(source)) missing.push(entry.anchor);
    }
    expect(missing).toEqual([]);
  });

  it('every prerequisite-shaped entry declares a reasonCode, and every reasonCode is unique', () => {
    const bad = MANIFEST.filter((e) => e.prerequisiteShaped && !e.reasonCode).map((e) => e.anchor);
    expect(bad).toEqual([]);
    const codes = MANIFEST.filter((e) => e.reasonCode).map((e) => e.reasonCode);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('the two reasonCodes wired in slice 1 are exactly the ones the manifest declares', () => {
    const prerequisiteCodes = MANIFEST.filter((e) => e.prerequisiteShaped).map((e) => e.reasonCode).sort();
    expect(prerequisiteCodes).toEqual(
      ['attendance.credential.already_enrolled_elsewhere', 'attendance.credential.employment_ended'].sort(),
    );
  });
});
