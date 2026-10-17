import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCHEDULER_JOBS } from '@shareat/db';

/**
 * T-279 / DEF-309 — a scheduled job whose call graph never reaches `runJobForOrg` would run,
 * delete or post real things and leave NO `scheduler_runs` row, and neither existing guard
 * (`scheduler-job-hosting.test.ts`, `scheduler-jobs-have-callers.test.ts`) asks this question.
 *
 * ⭐ **Verified by `grep`, qualified to `schedulerRepo` and only to it (system32-85's DEF-301
 * caution): `schedulerRepo.startRun`/`finishRun`/`failRun` (`packages/db/src/repo/scheduler.ts`)
 * are called from exactly one place each in the whole of `packages/` — inside `runJobForOrg`
 * itself and its own private `closeFailedRun`.** `packages/db/src/repo/etl.ts` exports an
 * UNRELATED `startRun` for a different table (`etlRepo.startRun`, called from
 * `packages/etl/src/run.ts`) — a different namespace with the same bare name, exactly DEF-301's
 * shape. So "reaches `runJobForOrg`" ≡ "records a `scheduler_runs` row" today, and that is what
 * this file checks — but see "what this cannot see" below: the check itself matches identifiers
 * by BARE name, with no namespace awareness, which is harmless only because `runJobForOrg` itself
 * is unique (`grep`-confirmed: exactly one function in the repo has that name).
 *
 * ## ⛔ Why NOT "does the declaring file's source contain `runJobForOrg(`" — DEF-309's own remedy
 *
 * `scheduler/index.ts` holds seven of the eight job-entry exports (ten of the ten `SCHEDULER_JOBS`
 * kinds bar one). A whole-FILE substring check cannot tell "THIS entry's own call graph reaches
 * `runJobForOrg`" from "some OTHER entry sharing this file reaches it, and this one might not." It
 * would pass a ninth entry added tomorrow that never calls `runJobForOrg` anywhere in its own
 * reachable functions, purely because the file already contains ten other calls from siblings.
 * That is DEF-295/DEF-304's exact shape, found living inside the fix DEF-309 itself proposed —
 * confirmed by system32-85 independently (10 call sites, 8 of 10 kinds, one file).
 *
 * So this guard does per-EXPORT attribution: a bounded, same-file call-graph walk from each job
 * entry's own name, not a single substring test over an ever-larger shared file.
 *
 * ⭐ `trackedFiles()`/`codeOnly()`/`isTest()` below are copied from
 * `scheduler-jobs-have-callers.test.ts` (itself copied from `domain-actions-have-callers.test.ts`)
 * on purpose, not imported — that file's own header explains why: the two guards' populations are
 * different enough that reaching into either to share helpers would be an edit outside scope. Keep
 * them in sync by hand if the copying trap they guard against changes.
 */

const repoRoot = path.resolve(__dirname, '../..');
const DOMAIN_SRC_ROOT = 'packages/domain/src';

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
}

function isTest(f: string): boolean {
  return /\.test\.tsx?$/.test(f) || f.includes('/tests/');
}

function domainSourceFiles(): string[] {
  return trackedFiles().filter(
    (f) => f.startsWith(`${DOMAIN_SRC_ROOT}/`) && f.endsWith('.ts') && !isTest(f),
  );
}

function codeOnly(src: string): string {
  return src
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

const read = (repoRelative: string) =>
  codeOnly(readFileSync(path.join(repoRoot, repoRelative), 'utf8'));

/**
 * ⚠️ Same shape as `paramsFrom()` in the sibling guard, but balancing `{`/`}` from an already-
 * located opening brace rather than `(`/`)` from an opening paren — a regex cannot survive a
 * nested object literal or a template string's own braces any more than it survives a nested type.
 */
function braceBodyFrom(src: string, openBraceIndex: number): string {
  let depth = 0;
  for (let i = openBraceIndex; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(openBraceIndex + 1, i);
  }
  return '';
}

/**
 * name -> body, for every top-level `(export )?(async )?function <name>(...) {...}` declaration in
 * one file's source — exported or private, async or not. Deliberately wider than the sibling
 * guard's `jobEntryExports()`: this file needs every PRIVATE per-org helper too, not just the
 * job-shaped exports, because the whole point is walking INTO them.
 */
function functionBodies(src: string): Map<string, string> {
  const bodies = new Map<string, string>();
  const re = /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^>]*>)?\s*\(/g;
  for (const m of src.matchAll(re)) {
    const name = m[1]!;
    const openParen = m.index! + m[0].length - 1;
    let depth = 0;
    let i = openParen;
    for (; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')' && --depth === 0) {
        i++;
        break;
      }
    }
    // Skip a return-type annotation (`: Promise<X>`) up to the function's opening brace.
    while (i < src.length && src[i] !== '{' && src[i] !== ';') i++;
    if (src[i] !== '{') continue; // a `.d.ts`-style declaration with no body — none exist here
    bodies.set(name, braceBodyFrom(src, i));
  }
  return bodies;
}

/** Every bare identifier immediately followed by `(` in a function body — a call, not merely a
 *  mention (same discipline as the sibling guard's `isCalled()`: an import alone must not count,
 *  and here a NAME alone, with no open paren, must not either). */
function calledIdentifiers(body: string): Set<string> {
  const found = new Set<string>();
  for (const m of body.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) found.add(m[1]!);
  return found;
}

interface CallGraphResult {
  entry: string;
  reached: boolean;
  hops: number | null; // null when not reached
  path: string[]; // intermediate function names, entry-to-target order, [] when direct
}

/**
 * Same-file BFS from `entryName`'s own body through `bodies`' local call graph, looking for
 * `targetName` as a called identifier. `maxDepth` (default 6 — today's deepest real chain is 3;
 * the cap exists to bound a pathological or mutually-recursive chain, not because 6 is meaningful)
 * FAILS CLOSED: exceeding it reports `reached: false`, identically to never finding the target at
 * all — never a silent pass. Never resolves an import; a callee not present in `bodies` (a
 * different file, a library, a method on an object) is a dead end for this walk, by design — see
 * the file's own header for what that means it cannot see.
 */
function reachesLocally(
  entryName: string,
  targetName: string,
  bodies: Map<string, string>,
  maxDepth = 6,
): CallGraphResult {
  const entryBody = bodies.get(entryName);
  if (entryBody === undefined) return { entry: entryName, reached: false, hops: null, path: [] };

  const visited = new Set<string>([entryName]);
  let level: { name: string; path: string[] }[] = [{ name: entryName, path: [] }];

  for (let depth = 1; depth <= maxDepth && level.length > 0; depth++) {
    const next: { name: string; path: string[] }[] = [];
    for (const node of level) {
      const body = bodies.get(node.name);
      if (body === undefined) continue;
      const calls = calledIdentifiers(body);
      if (calls.has(targetName)) {
        return { entry: entryName, reached: true, hops: depth, path: node.path };
      }
      for (const callee of calls) {
        if (visited.has(callee) || !bodies.has(callee)) continue;
        visited.add(callee);
        next.push({ name: callee, path: [...node.path, callee] });
      }
    }
    level = next;
  }
  return { entry: entryName, reached: false, hops: null, path: [] };
}

// =====================================================================================
// Pass A — synthetic-source plant proof. No `packages/**` file needed: every state below feeds a
// fabricated source string straight to `functionBodies`/`reachesLocally`, the same technique
// `scheduler-jobs-have-callers.test.ts`'s own "requires an invocation, not just an import" test
// already uses for `isCalled()`. All states are EXECUTED, not reasoned about.
// =====================================================================================

describe('Pass A — the call-graph walk itself, proven against fabricated source', () => {
  it('State 1 — a direct call (depth 1) is found', () => {
    const src = `
      async function entry() {
        await runJobForOrg(org, 'x', period, trigger, async () => ({}));
      }
    `;
    const result = reachesLocally('entry', 'runJobForOrg', functionBodies(src));
    expect(result).toMatchObject({ reached: true, hops: 1, path: [] });
  });

  it("State 2 — a two-hop chain is found, matching runMonthEnd's real shape", () => {
    const src = `
      async function entry() {
        await helperA(org, period, trigger);
      }
      async function helperA(org, period, trigger) {
        return runJobForOrg(org, 'x', period, trigger, async () => ({}));
      }
    `;
    const result = reachesLocally('entry', 'runJobForOrg', functionBodies(src));
    expect(result).toMatchObject({ reached: true, hops: 2, path: ['helperA'] });
  });

  it("State 3 — a three-hop chain is found, matching inbox_relay's real shape", () => {
    const src = `
      async function entry() {
        await helperA(org, period, trigger);
      }
      async function helperA(org, period, trigger) {
        return helperB(org, period, trigger);
      }
      async function helperB(org, period, trigger) {
        return runJobForOrg(org, 'x', period, trigger, async () => ({}));
      }
    `;
    const result = reachesLocally('entry', 'runJobForOrg', functionBodies(src));
    expect(result).toMatchObject({ reached: true, hops: 3, path: ['helperA', 'helperB'] });
  });

  it("State 4 — RED, the guard's whole point: an entry whose reachable functions never call the target is reported unreached", () => {
    const src = `
      async function entry() {
        await helperA(org, period, trigger);
      }
      async function helperA(org, period, trigger) {
        return doSomethingElse(org, period, trigger);
      }
      async function doSomethingElse() {
        return null;
      }
    `;
    const result = reachesLocally('entry', 'runJobForOrg', functionBodies(src));
    expect(result.reached).toBe(false);
    expect(result.hops).toBeNull();
  });

  it('State 5 — per-entry attribution: a sibling in the SAME file reaching the target does not cover for one that does not', () => {
    // The concrete, executed counter-example to "a whole-file-contains check would have passed
    // entryBad too": both entries live in ONE synthetic file (one `bodies` map), entryGood's own
    // chain reaches the target and entryBad's does not, and the two must be told apart.
    const src = `
      async function entryGood() {
        await helperGood(org, period, trigger);
      }
      async function helperGood(org, period, trigger) {
        return runJobForOrg(org, 'x', period, trigger, async () => ({}));
      }
      async function entryBad() {
        await helperBad(org, period, trigger);
      }
      async function helperBad(org, period, trigger) {
        return doSomethingElse(org, period, trigger);
      }
      async function doSomethingElse() {
        return null;
      }
    `;
    const bodies = functionBodies(src);
    expect(reachesLocally('entryGood', 'runJobForOrg', bodies).reached).toBe(true);
    expect(reachesLocally('entryBad', 'runJobForOrg', bodies).reached).toBe(false);
  });

  it('State 6 — mutual recursion terminates without hanging or falsely reaching the target', () => {
    const src = `
      async function entry() {
        await helperA(org, period, trigger);
      }
      async function helperA(org, period, trigger) {
        return helperB(org, period, trigger);
      }
      async function helperB(org, period, trigger) {
        return helperA(org, period, trigger);
      }
    `;
    const start = Date.now();
    const result = reachesLocally('entry', 'runJobForOrg', functionBodies(src));
    expect(result.reached).toBe(false);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('State 7 — PINNED: the depth cap fails CLOSED, never open', () => {
    // A straight-line chain 8 functions deep, genuinely reaching the target if depth were
    // unlimited. Run with maxDepth 6 — a cap that failed open would report `reached: true` here,
    // which is the same bug DEF-309 is about, with a number attached instead of a missing call.
    const hops = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7'];
    const lines = ['async function entry() { await h1(org, period, trigger); }'];
    for (let i = 0; i < hops.length; i++) {
      const next = i + 1 < hops.length ? `${hops[i + 1]}(org, period, trigger)` : `runJobForOrg(org, 'x', period, trigger, async () => ({}))`;
      lines.push(`async function ${hops[i]}(org, period, trigger) { return ${next}; }`);
    }
    const result = reachesLocally('entry', 'runJobForOrg', functionBodies(lines.join('\n')), 6);
    expect(result.reached).toBe(false); // NOT true — the target is 8 hops away, cap is 6
    // Raising the cap to a sufficient depth finds it — proving the false above is the CAP acting,
    // not a bug in the walk itself.
    const uncapped = reachesLocally('entry', 'runJobForOrg', functionBodies(lines.join('\n')), 8);
    expect(uncapped.reached).toBe(true);
    expect(uncapped.hops).toBe(8);
  });
});

// =====================================================================================
// Pass B — the real-repo positive control. Reported as its OWN number (10/10), never folded into
// Pass A's count: this is the only pass that says anything about TODAY'S actual jobs rather than
// about the checking logic. Multi-kind entries (runMonthEnd covers depreciation+amortisation;
// runFirestoreRelay covers mirror_publish+inbox_relay) are walked from the SPECIFIC first-hop
// helper named in the trace table, not from the shared entry, so a break in ONE kind's branch
// cannot be masked by the other kind's branch still working — the same per-entry-attribution
// principle as Pass A's State 5, one level in.
// =====================================================================================

interface PinnedKind {
  kind: string;
  entry: string;
  file: string;
  /** BFS starting point for THIS kind specifically — the entry itself for a direct call, or the
   *  first private helper that disambiguates this kind from a sibling kind sharing the entry. */
  walkFrom: string;
  /** Hops counted from the EXPORTED ENTRY, not from `walkFrom` — see `totalHops` below. */
  expectedHopsFromEntry: number;
  expectedPathFromEntry: string[];
}

const PINNED: PinnedKind[] = [
  {
    kind: 'depreciation',
    entry: 'runMonthEnd',
    file: 'packages/domain/src/scheduler/index.ts',
    walkFrom: 'runDepreciationJob',
    expectedHopsFromEntry: 2,
    expectedPathFromEntry: ['runDepreciationJob'],
  },
  {
    kind: 'amortisation',
    entry: 'runMonthEnd',
    file: 'packages/domain/src/scheduler/index.ts',
    walkFrom: 'runAmortisationJob',
    expectedHopsFromEntry: 2,
    expectedPathFromEntry: ['runAmortisationJob'],
  },
  {
    kind: 'attendance_sweep',
    entry: 'runAttendanceSweep',
    file: 'packages/domain/src/scheduler/index.ts',
    walkFrom: 'runAttendanceSweep',
    expectedHopsFromEntry: 2,
    expectedPathFromEntry: ['runSweepForOrg'],
  },
  {
    kind: 'mirror_publish',
    entry: 'runFirestoreRelay',
    file: 'packages/domain/src/scheduler/index.ts',
    walkFrom: 'runMirrorPublishJob',
    expectedHopsFromEntry: 2,
    expectedPathFromEntry: ['runMirrorPublishJob'],
  },
  {
    kind: 'inbox_relay',
    entry: 'runFirestoreRelay',
    file: 'packages/domain/src/scheduler/index.ts',
    // Walked from the shared node both real paths pass through, so this does not depend on which
    // of the two (runInboxRelayForOrg, the main loop; failedInboxRun, the early-error path) a
    // BFS happens to visit first — both are equally valid evidence and this pins the fact common
    // to both rather than guessing iteration order.
    walkFrom: 'runInboxRelayJobs',
    expectedHopsFromEntry: 3,
    expectedPathFromEntry: [], // asserted separately below — two valid paths, not one
  },
  {
    kind: 'order_wastage_backstop',
    entry: 'runOrderWastageBackstopSweep',
    file: 'packages/domain/src/scheduler/index.ts',
    walkFrom: 'runOrderWastageBackstopForOrg',
    expectedHopsFromEntry: 2,
    expectedPathFromEntry: ['runOrderWastageBackstopForOrg'],
  },
  {
    kind: 'finding_observation',
    entry: 'runFindingObservation',
    file: 'packages/domain/src/scheduler/index.ts',
    walkFrom: 'runFindingObservation',
    expectedHopsFromEntry: 1,
    expectedPathFromEntry: [],
  },
  {
    kind: 'budget_reissue',
    entry: 'runBudgetReissue',
    file: 'packages/domain/src/scheduler/index.ts',
    walkFrom: 'runBudgetReissue',
    expectedHopsFromEntry: 1,
    expectedPathFromEntry: [],
  },
  {
    kind: 'orphan_file_sweep',
    entry: 'runOrphanFileSweep',
    file: 'packages/domain/src/scheduler/index.ts',
    walkFrom: 'runOrphanFileSweepForOrg',
    expectedHopsFromEntry: 2,
    expectedPathFromEntry: ['runOrphanFileSweepForOrg'],
  },
  {
    kind: 'recurring_expenses',
    entry: 'runRecurringExpenses',
    file: 'packages/domain/src/recurring-expenses/job.ts',
    walkFrom: 'runRecurringExpenses',
    expectedHopsFromEntry: 1,
    expectedPathFromEntry: [],
  },
  {
    kind: 'fiscal_period_seed',
    entry: 'runFiscalPeriodSeed',
    file: 'packages/domain/src/scheduler/index.ts',
    walkFrom: 'runFiscalPeriodSeedForOrg',
    expectedHopsFromEntry: 2,
    expectedPathFromEntry: ['runFiscalPeriodSeedForOrg'],
  },
  {
    kind: 'usage_auto_post',
    entry: 'usageAutoPostSweep',
    file: 'packages/domain/src/scheduler/index.ts',
    walkFrom: 'usageAutoPostSweep',
    expectedHopsFromEntry: 1,
    expectedPathFromEntry: [],
  },
  {
    // T-396 S1: the 06:00 Manila POS day-import. Its own file; the entry calls `runJobForOrg` directly.
    kind: 'pos_day_import',
    entry: 'posDayImportSweep',
    file: 'packages/domain/src/pos/day-import-job.ts',
    walkFrom: 'posDayImportSweep',
    expectedHopsFromEntry: 1,
    expectedPathFromEntry: [],
  },
];

describe('Pass B — every registered SCHEDULER_JOBS kind reaches runJobForOrg, in the REAL repo', () => {
  it('⭐ finds the two files at all (a scan of nothing must not pass)', () => {
    expect(domainSourceFiles().length).toBeGreaterThan(20);
    expect(domainSourceFiles()).toContain('packages/domain/src/scheduler/index.ts');
    expect(domainSourceFiles()).toContain('packages/domain/src/recurring-expenses/job.ts');
  });

  it('⭐ PASS B COUNT: all 13 pinned SCHEDULER_JOBS kinds are reachable — reported separately from Pass A', () => {
    const results = PINNED.map((row) => {
      const bodies = functionBodies(read(row.file));
      // The entry must actually call `walkFrom` directly (or walkFrom IS the entry, for a direct
      // call) — this is the "entry calls the disambiguating helper" half; the walk below is the
      // "that helper's own chain reaches the target" half. Together they equal the full path.
      const entryCallsWalkFrom =
        row.walkFrom === row.entry || calledIdentifiers(bodies.get(row.entry) ?? '').has(row.walkFrom);
      const fromWalkFrom = reachesLocally(row.walkFrom, 'runJobForOrg', bodies);
      const totalHops = row.walkFrom === row.entry ? fromWalkFrom.hops : (fromWalkFrom.hops ?? 0) + 1;
      const totalPath =
        row.walkFrom === row.entry ? fromWalkFrom.path : [row.walkFrom, ...fromWalkFrom.path];
      return {
        kind: row.kind,
        reached: entryCallsWalkFrom && fromWalkFrom.reached,
        hops: totalHops,
        path: totalPath,
      };
    });

    const unreached = results.filter((r) => !r.reached).map((r) => r.kind);
    expect(unreached).toEqual([]); // every one of the 13 must be reached — no exemptions exist

    const reachedCount = results.filter((r) => r.reached).length;
    expect(reachedCount).toBe(13); // was 10/10 (system32-85); 11/11 since T-276's fiscal_period_seed; 12/12 since T-401 S6's usage_auto_post; 13/13 since T-396 S1's pos_day_import
  });

  it('⭐ PINNED kinds are exactly SCHEDULER_JOBS, sorted — a new job updates PINNED too, not just KNOWN_JOB_NAMES', () => {
    expect(PINNED.map((row) => row.kind).sort()).toEqual([...SCHEDULER_JOBS].sort());
  });

  it('⭐ PINNED: hop count and path for each kind match the trace table literally', () => {
    for (const row of PINNED) {
      const bodies = functionBodies(read(row.file));
      const fromWalkFrom = reachesLocally(row.walkFrom, 'runJobForOrg', bodies);
      const totalHops =
        row.walkFrom === row.entry ? fromWalkFrom.hops : (fromWalkFrom.hops ?? 0) + 1;
      const totalPath =
        row.walkFrom === row.entry ? fromWalkFrom.path : [row.walkFrom, ...fromWalkFrom.path];

      if (row.kind === 'inbox_relay') {
        // Two equally valid real paths exist (the main loop and the early-error path); pin the
        // fact common to both — 3 hops, reached — rather than the specific intermediate, which
        // depends on traversal order and is not the fact worth pinning.
        expect(totalHops, row.kind).toBe(3);
        continue;
      }
      expect(totalHops, row.kind).toBe(row.expectedHopsFromEntry);
      expect(totalPath, row.kind).toEqual(row.expectedPathFromEntry);
    }
  });
});
