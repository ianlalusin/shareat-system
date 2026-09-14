import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * T-311 / DEF-346 regression guard.
 *
 * `.github/workflows/deploy.yml`'s leading comment names the GitHub Secrets this workflow reads.
 * DEF-346 (measured 2026-09-14): that comment named ELEVEN, the workflow actually read SEVEN —
 * four names (`DATABASE_URL`, `SESSION_SECRET`, `FIREBASE_PROJECT_ID`,
 * `FIREBASE_SERVICE_ACCOUNT_KEY_FILE`) are runtime values in `/srv/shareat-shared/.env.local`, not
 * GitHub Secrets, and were conflated with them. A corrected comment is still only a comment
 * (DEF-311, DEF-315, DEF-329, DEF-338 are four prior proofs of exactly that) — so this test greps
 * the file for what it actually claims and what it actually reads, and fails on disagreement in
 * EITHER direction: a name claimed but never read, or a name read but never claimed.
 */

const repoRoot = join(import.meta.dirname, '..', '..');
const workflow = readFileSync(join(repoRoot, '.github/workflows/deploy.yml'), 'utf8');

// NAMEs, not positions (bible §13 row 204) — both anchors are literal substrings from the comment
// itself, so they survive any edit above or below this block. `extractClaimed` is scoped to the
// text BETWEEN the two anchors, and only that text, so the "NOT GitHub Secrets" disclaimer
// paragraph's own tokens (DATABASE_URL, SESSION_SECRET, FIREBASE_PROJECT_ID,
// FIREBASE_SERVICE_ACCOUNT_KEY_FILE) are never double-counted as claims.
const CLAIMS_START = 'GitHub Secrets this workflow reads';
const CLAIMS_END = 'NOT GitHub Secrets';

function extractClaimed(text: string): string[] {
  const slice = text.slice(text.indexOf(CLAIMS_START), text.indexOf(CLAIMS_END));
  // DEF-179: no `.` anywhere in this pattern — immune to a CRLF checkout by construction, not by
  // luck (verified below against a synthetic \r\n copy of the real file).
  return [...new Set(slice.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) ?? [])];
}

function extractRead(text: string): string[] {
  // The literal `secrets.NAME` interpolation syntax — cannot appear in an English sentence by
  // accident, so no comment-vs-code disambiguation is needed here (DEF-346's own design).
  // A guard, not `!`, over the capture group (bible §13 row 206 — noUncheckedIndexedAccess is on
  // deliberately): the group is non-optional in the pattern, so it is always captured when the
  // whole match succeeds, but its indexed type is still `string | undefined`.
  const names = [...text.matchAll(/secrets\.([A-Z0-9_]+)/g)]
    .map((m) => m[1])
    .filter((name): name is string => name !== undefined);
  return [...new Set(names)];
}

function diffBothWays(claimed: string[], read: string[]) {
  const claimedSet = new Set(claimed);
  const readSet = new Set(read);
  return {
    claimedButUnread: claimed.filter((n) => !readSet.has(n)),
    readButUnclaimed: read.filter((n) => !claimedSet.has(n)),
  };
}

describe('deploy.yml Secrets list (DEF-346)', () => {
  it('the extractors find a real, non-trivial population (not silently empty — DEF-179 precedent)', () => {
    expect(extractClaimed(workflow).length).toBeGreaterThanOrEqual(5);
    expect(extractRead(workflow).length).toBeGreaterThanOrEqual(5);
  });

  it('every claimed secret is read, and every read secret is claimed — both directions', () => {
    const claimed = extractClaimed(workflow);
    const read = extractRead(workflow);
    const { claimedButUnread, readButUnclaimed } = diffBothWays(claimed, read);
    expect(
      claimedButUnread,
      `named in the comment but never read as secrets.*: ${claimedButUnread.join(', ')}`,
    ).toEqual([]);
    expect(
      readButUnclaimed,
      `read via secrets.* but not named in the comment: ${readButUnclaimed.join(', ')}`,
    ).toEqual([]);
  });

  it('the runtime-values disclaimer sentence is never counted as a Secrets claim', () => {
    const claimed = extractClaimed(workflow);
    expect(claimed).not.toContain('DATABASE_URL');
    expect(claimed).not.toContain('SESSION_SECRET');
    expect(claimed).not.toContain('FIREBASE_PROJECT_ID');
    expect(claimed).not.toContain('FIREBASE_SERVICE_ACCOUNT_KEY_FILE');
  });

  it('CONTROL — a name claimed in the comment but never read as secrets.* is caught', () => {
    const synthetic = [
      '# GitHub Secrets this workflow reads: DEPLOY_HOST, PHANTOM_UNREAD_SECRET.',
      '#',
      '# NOT GitHub Secrets — runtime values: DATABASE_URL.',
      '${{ secrets.DEPLOY_HOST }}',
    ].join('\n');
    const { claimedButUnread, readButUnclaimed } = diffBothWays(
      extractClaimed(synthetic),
      extractRead(synthetic),
    );
    expect(claimedButUnread).toEqual(['PHANTOM_UNREAD_SECRET']);
    expect(readButUnclaimed).toEqual([]);
  });

  it('CONTROL — a secrets.* reference with no matching name in the comment is caught', () => {
    const synthetic = [
      '# GitHub Secrets this workflow reads: DEPLOY_HOST.',
      '#',
      '# NOT GitHub Secrets — runtime values: DATABASE_URL.',
      '${{ secrets.DEPLOY_HOST }}',
      '${{ secrets.SURPRISE_UNCLAIMED_TOKEN }}',
    ].join('\n');
    const { claimedButUnread, readButUnclaimed } = diffBothWays(
      extractClaimed(synthetic),
      extractRead(synthetic),
    );
    expect(claimedButUnread).toEqual([]);
    expect(readButUnclaimed).toEqual(['SURPRISE_UNCLAIMED_TOKEN']);
  });

  it('extraction is unaffected by CRLF line endings (DEF-179 — this repo checks out CRLF)', () => {
    const crlf = workflow.replace(/\n/g, '\r\n');
    expect(extractClaimed(crlf)).toEqual(extractClaimed(workflow));
    expect(extractRead(crlf)).toEqual(extractRead(workflow));
  });

  it('the stale "do not exist yet" bootstrap premise is removed, not refreshed', () => {
    expect(workflow).not.toMatch(/do not exist yet/i);
    expect(workflow).not.toMatch(/until they exist this workflow fails/i);
  });
});
