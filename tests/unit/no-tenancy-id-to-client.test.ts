import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * T-304 test 13 / invariant 9 — no `orgId`/`storeId` reaches the client in any form: not a form
 * field, not a cookie, not a query parameter, not a JSON response field.
 *
 * ⛔ **Why this exists as its own guard rather than trusting review.** The orchestrator's carrier
 * ruling (2026-09-13) rejected a signed cookie carrying `{orgId, storeId}` specifically because
 * `tests/unit/no-client-supplied-actor.test.ts` (T-231's guard) cannot see that shape — it matches
 * `formData.get('orgId')` and body/query patterns, not a cookie payload. This test is what extends
 * the rule into that exact blind spot: it reads the client component and the server actions as
 * TEXT and asserts neither ever names a tenancy id as something sent to, or returned from, the
 * client — a cookie included, since the file is read as bytes, not executed.
 */
const repoRoot = join(import.meta.dirname, '..', '..');

const CLIENT_FILE = 'apps/erp/src/app/sign-in/TerminalSignInForm.tsx';
const ACTIONS_FILE = 'apps/erp/src/app/sign-in/actions.ts';

function read(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf8');
}

describe('T-304 test 13 — no tenancy id reaches the client in any form', () => {
  it('TerminalSignInForm never reads, stores, or forwards an orgId/storeId', () => {
    const text = read(CLIENT_FILE);
    expect(text).not.toMatch(/\borgId\b/);
    expect(text).not.toMatch(/\bstoreId\b/);
  });

  it('verifyTerminalAction returns only {ok} / {ok:false, message} — no tenancy id in the response', () => {
    const text = read(ACTIONS_FILE);
    const start = text.indexOf('export async function verifyTerminalAction');
    expect(start, 'verifyTerminalAction not found').toBeGreaterThan(-1);
    // Ends at the next doc comment (which precedes the next function) rather than the next
    // `export async function` itself — that line comes AFTER its own leading comment block, so
    // stopping there would swallow the next function's prose, which legitimately discusses org/
    // store in the abstract.
    const end = text.indexOf('\n/**', start + 1);
    const body = text.slice(start, end === -1 ? undefined : end);
    expect(body).not.toMatch(/\borgId\b/);
    expect(body).not.toMatch(/\bstoreId\b/);
  });

  it('setSessionCookie takes only a token and an expiry — no tenancy id can travel through it', () => {
    const text = read('apps/erp/src/lib/session.ts');
    const start = text.indexOf('export async function setSessionCookie');
    expect(start, 'setSessionCookie not found').toBeGreaterThan(-1);
    const signature = text.slice(start, text.indexOf(')', start) + 1);
    expect(signature).not.toMatch(/orgId|storeId/);
  });
});
