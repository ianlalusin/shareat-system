import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * **T-138 invariant 1, made structural: no server action accepts an actor identity as a
 * parameter** (`PROJECT_BIBLE.md` §7.1, binding).
 *
 * ## Why a repo-wide scan rather than a unit test
 *
 * v1's failure was not one function getting it wrong — it was **~24 server actions each taking an
 * `actorUid` that the server could not verify**. A test that checked one call site would have
 * passed throughout. The only assertion that means anything here is one that reads every file.
 *
 * ## What "actor identity as a parameter" means, precisely
 *
 * A **server action** (`'use server'`) or an **API route** that reads a person id out of its own
 * input — a `FormData` field, a request body, a query string. That is the spoofable shape: the
 * browser names who it is, and the server believes it.
 *
 * ⚠️ **Passing an `Actor` DOWN into the domain is fine and is the whole design.** Every domain
 * function takes `(tx, actor, …)`, and that actor came from `resolveActor` at the boundary. The
 * rule is about where an actor is *born*, not where it travels.
 *
 * ## The current exemption, and why it is written down rather than silent
 *
 * `apps/erp/src/app/{expenses,sales-days}` still carry the "acting as" picker T-122 and T-123
 * shipped with, documented in their own `lib.ts` as a knowing, temporary departure. **They are
 * listed here by name, so the exemption is a visible debt with an owner rather than a hole.**
 * Removing a path from this list is how that debt gets paid, and the test then holds it closed.
 */

const repoRoot = join(import.meta.dirname, '..', '..');

/** Field names that name a person. Reading one of these out of client input is the defect. */
const ACTOR_FIELDS = ['actorPersonId', 'actingPersonId', 'actorUid', 'actorId', 'currentPersonId'] as const;

/**
 * ⚠️ KNOWN DEBT, not permission. Each entry is a screen still using the pre-T-138 picker, and each
 * is expected to disappear once its screens read the session instead. **A path listed here must be
 * a real path** — the test below fails if an exemption stops matching anything, so a stale entry
 * cannot quietly grant cover to something else.
 */
const KNOWN_PICKER_PATHS = [
  'apps/erp/src/app/expenses/',
  'apps/erp/src/app/sales-days/',
] as const;

function trackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split('\0')
    .filter((f) => f.length > 0)
    .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
    .filter((f) => !f.includes('/tests/') && !f.startsWith('tests/'));
}

/** Reads a person id out of client-supplied input, in any of the shapes that actually occur. */
function readsActorFromInput(content: string): string[] {
  const hits: string[] = [];
  for (const field of ACTOR_FIELDS) {
    // formData.get('actingPersonId') / str(formData, 'actingPersonId') / body.actorUid
    const patterns = [
      new RegExp(`formData\\.get\\(\\s*['"\`]${field}['"\`]`),
      new RegExp(`\\bstr\\(\\s*\\w+\\s*,\\s*['"\`]${field}['"\`]`),
      new RegExp(`\\bbody\\.${field}\\b`),
      new RegExp(`searchParams\\.get\\(\\s*['"\`]${field}['"\`]`),
    ];
    if (patterns.some((p) => p.test(content))) hits.push(field);
  }
  return hits;
}

describe('§7.1 — no server action accepts an actor identity as a parameter', () => {
  it('the scanned set is non-empty — a vacuous pass would prove nothing', () => {
    expect(trackedFiles().length).toBeGreaterThan(50);
  });

  it('every known exemption still matches a real file — a stale entry cannot grant cover', () => {
    // An exemption that stops matching anything is worse than none: it looks like the rule is
    // narrower than it is, and the next person widens it by adding a neighbour.
    const files = trackedFiles();
    for (const prefix of KNOWN_PICKER_PATHS) {
      expect(files.some((f) => f.startsWith(prefix)), `exemption "${prefix}" matches no file`).toBe(true);
    }
  });

  it('no NEW code reads a person id out of client input', () => {
    const offenders: string[] = [];

    for (const rel of trackedFiles()) {
      if (KNOWN_PICKER_PATHS.some((p) => rel.startsWith(p))) continue;
      let content: string;
      try {
        content = readFileSync(join(repoRoot, rel), 'utf8');
      } catch {
        continue; // tracked but absent (sparse checkout)
      }
      // Only files that actually handle a request can commit this defect.
      const isBoundary = content.includes("'use server'") || rel.includes('/api/') || rel.endsWith('route.ts');
      if (!isBoundary) continue;

      const hits = readsActorFromInput(content);
      if (hits.length > 0) offenders.push(`${rel} — reads ${hits.join(', ')} from client input`);
    }

    expect(
      offenders,
      offenders.length === 0
        ? ''
        : `Server boundaries reading a client-supplied actor identity:\n  ${offenders.join('\n  ')}\n\n` +
            'PROJECT_BIBLE.md §7.1: the acting identity is read from the SESSION, server-side.\n' +
            'A browser that names who it is can name anyone — which is what made v1 unable to\n' +
            'enforce any segregation of duties.\n\n' +
            'Use resolveActor(tx, token) at the boundary and pass the Actor down.',
    ).toEqual([]);
  });
});
