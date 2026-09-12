/**
 * T-295 — the ratchet `docs/discovery/32-production-caller-census.md` §6 recommended on
 * 2026-09-10 and nobody wired. `scripts/production-caller-census.mjs` already finds every
 * exported function/const-arrow across the whole repo with zero production callers, with real
 * controls; `docs/production-caller-baseline.txt` already exists, written from that exact
 * recommendation. This file is the missing third piece: fail the build only when a NEW name joins
 * the zero-caller set, never on the ~110 that are already there.
 *
 * T-293's assessment (`docs/tasks/293-declared-but-never-read-guard.md`) measured why a HARD RULE
 * ("every export needs a caller") is the wrong shape here: doc 32 §6.2 already found that a naive
 * rule fires 111 times on day one, ~90% wrong, and "is suppressed within a day." This is a RATCHET
 * instead — it never asks "is this name okay," only "did the set change since the baseline was
 * last regenerated." Whether a new name is okay is a human/task-level judgement (the same one
 * `domain-actions-have-callers.test.ts`'s `EXEMPT` list already makes for its own, narrower
 * population) — this file reports the drift and cross-references that list where it overlaps, it
 * does not decide.
 *
 * ⛔ **HOW TO REGENERATE THE BASELINE — the ONLY sanctioned way to update it. Never hand-edit
 * `docs/production-caller-baseline.txt`.** (DEF-240: a hand-maintained list beside a generated one
 * is the half that rots.)
 *
 *     node scripts/production-caller-census.mjs --names > docs/production-caller-baseline.txt
 *
 * Run it, look at the diff, and only commit it once every ADDED name is either given a real
 * caller instead, or is a deliberate, explainable gap (cite the task/defect in the commit message —
 * this file does not carry per-name reasons; the register and `EXEMPT` lists elsewhere do). Every
 * REMOVED name means something got a real caller — that is progress; regenerating captures it.
 *
 * ⚠️ **This guard and `domain-actions-have-callers.test.ts` are NOT the same population and must
 * not be merged.** That guard's population is one narrow, human-relevant shape —
 * `(tx, …, actor: Actor, …)` exports under `packages/domain/src` only — chosen precisely so its
 * ~30-orphan list stays small enough to read. This one is unfiltered and repo-wide (every export,
 * every package, every script): the two overlap (T-293 measured 3 of today's new names already
 * living in that guard's `EXEMPT`) without one being a subset of the other — `domain-actions` also
 * flags exports this one is structurally blind to (nothing there requires an `actor` param), and
 * this one flags scripts/ and packages/auth/etc. that guard never scans at all.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const BASELINE_PATH = 'docs/production-caller-baseline.txt';
const CENSUS_SCRIPT = 'scripts/production-caller-census.mjs';

/** Names `domain-actions-have-callers.test.ts` already tracks — read, never duplicated by hand,
 *  so the two guards can't silently drift apart on the same name. */
function domainActionsExemptNames(): Set<string> {
  const src = readFileSync(
    path.join(repoRoot, 'tests/unit/domain-actions-have-callers.test.ts'),
    'utf8',
  );
  const match = /const EXEMPT: Record<string, string> = \{([\s\S]*?)\n\};/.exec(src);
  if (!match) return new Set();
  const names = new Set<string>();
  for (const m of match[1]!.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:/gm)) names.add(m[1]!);
  return names;
}

function runCensus(): { exitCode: number; names: string[]; stderr: string } {
  try {
    const out = execFileSync('node', [CENSUS_SCRIPT, '--names'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    return { exitCode: 0, names: out.split('\n').map((l) => l.trim()).filter(Boolean), stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      exitCode: e.status ?? 1,
      names: (e.stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean),
      stderr: e.stderr ?? '',
    };
  }
}

function readBaseline(): string[] {
  return readFileSync(path.join(repoRoot, BASELINE_PATH), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * ⛔ Computed ONCE, at `describe`-body-eval time, and shared by every `it()` below — the same
 * pattern all four existing caller guards already use for their own expensive scans (`jobs`,
 * `appSource`, `scannable()`'s callers, etc. are each built once outside the `it()` callbacks
 * they're read from). Calling `runCensus()` fresh inside each `it()` re-spawns a full repo-wide
 * scan (856+ files) up to four times in one file, comfortably exceeding the `unit` project's
 * default 5s `testTimeout` (`vitest.config.mts`'s `unit` block sets none, unlike `integration`,
 * which has its own reasons — T-285/DEF-313 — to run longer). One census, four assertions on it.
 */
const CENSUS = runCensus();
const BASELINE = readBaseline();
const EXEMPT_NAMES = domainActionsExemptNames();

describe('T-295 — the production-caller census is a ratchet, not a one-time report', () => {
  it('⭐ the census script runs and its own controls pass — a broken scanner must not read as "no drift"', () => {
    expect(CENSUS.exitCode, `census script exited ${CENSUS.exitCode}, controls likely failing:\n${CENSUS.stderr}`).toBe(0);
    // Floor, not ceremony: matches the script's own FLOOR_EXPORTS-derived expectation that the
    // combined testOnly+noRefs population is a real, non-trivial list — collapses to near-zero if
    // the walker or the DECL regex breaks (bible §13 row 181 — a scan of nothing passes).
    expect(CENSUS.names.length).toBeGreaterThan(50);
  });

  it('⛔ no NEW name has joined the zero-production-caller set since the baseline was regenerated', () => {
    const current = CENSUS.names;
    const baselineSet = new Set(BASELINE);
    const exempt = EXEMPT_NAMES;

    const added = current.filter((n) => !baselineSet.has(n)).sort();

    if (added.length === 0) {
      expect(added).toEqual([]);
      return;
    }

    const annotated = added.map((n) =>
      exempt.has(n)
        ? `${n} — already tracked in domain-actions-have-callers.test.ts's EXEMPT list (agreement, not a new problem on its own — but it IS new to this baseline and the baseline still needs regenerating)`
        : `${n} — NOT tracked anywhere else. Give it a real caller, or confirm the gap is known and cite where before regenerating the baseline.`,
    );

    expect(
      added,
      `${added.length} name(s) newly joined the zero-production-caller set:\n  ${annotated.join('\n  ')}\n\n` +
        `Regenerate with:\n  node ${CENSUS_SCRIPT} --names > ${BASELINE_PATH}\n` +
        'Only after confirming each addition above is either fixed (given a caller) or a known, ' +
        'cited gap — never as a way to silence this failure without looking at the list.',
    ).toEqual([]);
  });

  it('⚠️ no name in the baseline has gone stale — a REMOVED name means it got a real caller; regenerate to capture that', () => {
    const currentSet = new Set(CENSUS.names);

    const removed = BASELINE.filter((n) => !currentSet.has(n)).sort();

    expect(
      removed,
      removed.length === 0
        ? ''
        : `${removed.length} baseline name(s) are no longer zero-production-caller (they got a real ` +
            `caller since the baseline was last regenerated): ${removed.join(', ')}\n\n` +
            `Regenerate with:\n  node ${CENSUS_SCRIPT} --names > ${BASELINE_PATH}\n` +
            'This is good news, not a defect — a stale baseline just means the ratchet is one commit ' +
            'behind reality (DEF-240\'s lesson: a hand-maintained list beside a generated one rots; ' +
            'the fix is to regenerate, never to hand-delete the stale line).',
    ).toEqual([]);
  });

  it('⭐ domain-actions-have-callers\' EXEMPT names that ARE in the census population are a subset check, not a duplicate list', () => {
    // Positive control on the cross-reference itself: if EXEMPT parsing ever returns empty while
    // the file demonstrably has entries, the "agreement" annotation above would silently stop
    // meaning anything.
    expect(EXEMPT_NAMES.size).toBeGreaterThan(10);
  });
});
