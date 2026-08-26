/**
 * DEF-064's guard: **every page that reads the ledger must first establish who is asking.**
 *
 * ## The hole this closes
 *
 * `tests/unit/no-client-supplied-actor.test.ts` proves no server boundary accepts a
 * client-supplied ACTOR. It passed throughout DEF-064 — because the two report pages were not
 * accepting an actor, they were accepting an **org id**, from the query string, with no session
 * at all. `GET /reports/trial-balance?org=<uuid>` rendered any organisation's books to a visitor
 * who had never signed in.
 *
 * ⭐ The structural reason it happened: every MUTATION here is gated because `authorize()` lives
 * inside the domain services a mutation must call, so forgetting is impossible. A READ has no
 * such choke point — page → `getDb()` → SQL passes through no layer that has ever heard of an
 * actor. Reports were built before T-138 and nothing went back for them.
 *
 * So this guard is deliberately about READS, and it is crude on purpose: if a page imports a
 * database handle, it must also establish a session. It does not try to judge whether the
 * authorization is *correct* — only that the page cannot have skipped the question entirely,
 * which is the failure that actually occurred.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');

/** Ways a page can reach the database directly. */
const DB_HANDLES = ['getDb(', 'getSql(', "from '@shareat/db'", 'from "@shareat/db"'];

/** Ways a page can establish who is asking. Any one of these is enough. */
const SESSION_MARKERS = [
  'requireSession(',
  'requireActor(',
  'currentSession(',
  'reportScope(',
];

/** Strips comments before matching.
 *
 * ⚠️ Not fussiness — the first version of this guard tripped on the very comment explaining that
 * `sp.org` is deliberately ignored. A guard that fires on prose describing the fix is a guard
 * somebody eventually deletes, and then the real thing it was watching for goes unwatched.
 */
function codeOnly(src: string): string {
  const withoutBlocks = src.replace(/\/\*[\s\S]*?\*\//g, '');
  return withoutBlocks
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

function trackedPageFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' });
  return out
    .split('\0')
    .filter(Boolean)
    .filter((f) => /^apps\/[^/]+\/src\/app\/.*page\.tsx$/.test(f));
}

describe('DEF-064 — no read surface reaches the database without a session', () => {
  const files = trackedPageFiles();

  it('finds the app pages at all (a vacuous pass would hide everything)', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('⛔ every page touching the database also establishes a session', () => {
    const offenders: string[] = [];

    for (const file of files) {
      const src = codeOnly(readFileSync(path.join(repoRoot, file), 'utf8'));

      // The sign-in page is the one legitimate exception: it reads the store list precisely so
      // somebody with no session can choose where to sign in. It writes nothing and exposes no
      // financial figure — a store's existence is not a secret.
      if (file.endsWith('/sign-in/page.tsx')) continue;

      const touchesDb = DB_HANDLES.some((h) => src.includes(h));
      if (!touchesDb) continue;

      const hasSession = SESSION_MARKERS.some((m) => src.includes(m));
      if (!hasSession) offenders.push(file);
    }

    expect(
      offenders,
      `These pages read the database without establishing a session — the DEF-064 shape:\n` +
        offenders.map((f) => `  ${f}`).join('\n') +
        `\n\nCall requireSession() (or reportScope() for a report) as the FIRST thing the page does,\n` +
        `take the org from the returned actor, and never from searchParams.`,
    ).toEqual([]);
  });

  it('⛔ no page derives the org it reports on from the URL', () => {
    // The specific mechanic of DEF-064: `sp.org` chose whose books you saw, validated only as
    // "an org that exists" — an existence check wearing the clothes of an authorization check.
    const offenders: string[] = [];
    const ORG_FROM_URL = [
      /searchParams\s*\.\s*org\b/,
      /\bsp\s*\.\s*org\b/,
      /\borg\s*\?\s*:\s*string/,
    ];

    for (const file of files) {
      const src = codeOnly(readFileSync(path.join(repoRoot, file), 'utf8'));
      if (ORG_FROM_URL.some((re) => re.test(src))) offenders.push(file);
    }

    expect(
      offenders,
      `These pages still accept an org id from the URL:\n` +
        offenders.map((f) => `  ${f}`).join('\n') +
        `\n\nThe org comes from the session (actor.orgId). Which STORES a person may see comes\n` +
        `from person_store_scope — see apps/erp/src/app/reports/lib.ts.`,
    ).toEqual([]);
  });
});
