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
  /**
   * Set ONLY when this entry deliberately reuses another entry's `reasonCode` — names that other
   * entry's anchor and says why sharing is a decision, not a copy-paste. T-245's uniqueness rule
   * exists to catch an ACCIDENTAL duplicate; this is how a DELIBERATE one still passes without
   * disabling the guard. An entry whose `reasonCode` collides with another's and carries no
   * declaration here fails the manifest test below.
   */
  readonly sharesReasonCodeWith?: { readonly anchor: string; readonly why: string };
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
    anchor: 'That value is already enrolled',
    prerequisiteShaped: true,
    reasonCode: 'attendance.credential.already_enrolled_elsewhere',
    sharesReasonCodeWith: {
      anchor: 'That fingerprint minted a value already enrolled',
      why:
        'T-321/DEF-362 — enrolCard and enrolFingerprint hit the SAME PREREQUISITE (a scan value ' +
        'already live under this organisation) but a DIFFERENT REMEDY: this path\'s caller ' +
        'revokes the other credential; enrolFingerprint\'s caller just retries in the same flow ' +
        '(a fresh mint) and nothing is revoked. One reasonCode anyway, because the CONDITION is ' +
        'one condition, not the remedy — T-321 exists to remove the asymmetry between these two ' +
        'enrolment paths (DEF-362 is filed against exactly that asymmetry), and splitting one ' +
        'condition across two keys would recreate it in the audit trail: a query asking "how ' +
        'often was a value already enrolled elsewhere?" must not have to know to sum two codes.',
    },
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
  {
    // T-321/DEF-362 — enrolFingerprint's new catch, the 11th throw site. See the shared-reasonCode
    // declaration on 'That value is already enrolled' above for why this is the SAME code as
    // enrolCard's, not a new one.
    anchor: 'That fingerprint minted a value already enrolled',
    prerequisiteShaped: true,
    reasonCode: 'attendance.credential.already_enrolled_elsewhere',
    sharesReasonCodeWith: {
      anchor: 'That value is already enrolled',
      why:
        'Same PREREQUISITE as the sibling entry above (one scan-value-already-live condition) — ' +
        'but NOT the same remedy: see that entry\'s own sharesReasonCodeWith.why for the full ' +
        'reasoning on why one reasonCode still covers both.',
    },
    why:
      'The prerequisite is genuinely shared with enrolCard\'s collision (a scan value already ' +
      'live in this organisation) — the REMEDY IS NOT: retrying mints a fresh token in the same ' +
      'flow, nothing gets revoked. Classified prerequisiteShaped: true anyway, deliberately — ' +
      'trading taxonomic purity for the audit-trail pin this file\'s own scan-value-collision ' +
      'tests depend on (a durable `prerequisite_refusals` row is the only thing that would ' +
      'notice the tolerant catch failing open), rather than burying that tension.',
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

  it('every prerequisite-shaped entry declares a reasonCode, and a SHARED reasonCode is DECLARED, not accidental', () => {
    const bad = MANIFEST.filter((e) => e.prerequisiteShaped && !e.reasonCode).map((e) => e.anchor);
    expect(bad).toEqual([]);

    // A reasonCode used by more than one entry is not automatically a failure — but every entry
    // in that group must say so via `sharesReasonCodeWith`, pointing at a real sibling that
    // actually carries the same code. An UNDECLARED collision (a copy-paste accident, T-245's own
    // reason this guard exists) still fails here; a DECLARED one — like T-321's enrolCard and
    // enrolFingerprint sharing one code on purpose — passes.
    const byCode = new Map<string, ManifestEntry[]>();
    for (const e of MANIFEST) {
      if (!e.reasonCode) continue;
      byCode.set(e.reasonCode, [...(byCode.get(e.reasonCode) ?? []), e]);
    }

    for (const [code, entries] of byCode) {
      if (entries.length === 1) continue;
      for (const entry of entries) {
        expect(
          entry.sharesReasonCodeWith,
          `"${entry.anchor}" shares reasonCode "${code}" with ${entries.length - 1} other ` +
            `entr${entries.length - 1 === 1 ? 'y' : 'ies'} but does not declare it via sharesReasonCodeWith`,
        ).toBeDefined();
        const partner = MANIFEST.find((e) => e.anchor === entry.sharesReasonCodeWith!.anchor);
        expect(
          partner,
          `"${entry.anchor}"'s sharesReasonCodeWith points at an anchor not present in the manifest`,
        ).toBeDefined();
        expect(
          partner!.reasonCode,
          `"${entry.anchor}"'s sharesReasonCodeWith partner does not actually carry reasonCode "${code}"`,
        ).toBe(code);
      }
    }
  });

  it('the DISTINCT reasonCodes wired so far are exactly the ones the manifest declares', () => {
    const prerequisiteCodes = [
      ...new Set(MANIFEST.filter((e) => e.prerequisiteShaped).map((e) => e.reasonCode)),
    ].sort();
    expect(prerequisiteCodes).toEqual(
      ['attendance.credential.already_enrolled_elsewhere', 'attendance.credential.employment_ended'].sort(),
    );
  });
});
