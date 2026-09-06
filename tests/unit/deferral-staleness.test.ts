/**
 * T-220 / DEF-185 — **a deferral is a promise with a precondition, and nothing was watching
 * preconditions.**
 *
 * The coverage sweep (`docs/discovery/27-coverage-claims-sweep.md`) found four detectors promised by
 * shipped tasks and absent from code. Every one was deferred **honestly**, in writing, naming a real
 * blocker. Three of those blockers had since been removed by later tasks, and nothing re-triggered
 * the work: **T-166 shipped delivery documents with no idea it owed T-163 a detector.**
 *
 * ⭐ That is the whole failure. A deferral is correct the day it is written and quietly false
 * forever after — and because the reasoning reads well, the next reader agrees with it and moves on.
 * Same structure as v1's comment arguing no receiving backstop was needed because *"disputes get
 * resolved"*: true when written, **44% false when someone finally counted**.
 *
 * ## The convention
 *
 * A task doc's deferral may name its blocker on one line, in a form a machine can check:
 *
 * ```
 * <!-- STALE-IF-EXISTS: apps/erp/src/app/inventory/low-stock -->
 * ```
 *
 * **The deferral claims something does not exist. This test fails when it does.** At that point the
 * doc is out of date and someone must either do the deferred work or say plainly that it was done
 * elsewhere — which is exactly the moment nobody was catching.
 *
 * ⚠️ **Adopt by example, not by retrofit.** Only deferrals written or revisited from here carry a
 * marker. ⛔ The ~40 existing ones are deliberately NOT back-filled: a convention proves itself on
 * new writing, and back-filling forty markers would manufacture precisely the unearned assurance
 * this line of work exists to remove (sweep §Recommendations 4).
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TASKS_DIR = join(REPO_ROOT, 'docs', 'tasks');

const MARKER = /<!--\s*STALE-IF-EXISTS:\s*([^\s>]+)\s*-->/g;

interface Marker {
  readonly file: string;
  readonly line: number;
  readonly path: string;
}

function markers(): Marker[] {
  const found: Marker[] = [];
  for (const file of readdirSync(TASKS_DIR).filter((f) => f.endsWith('.md')).sort()) {
    // ⛔ Normalise CRLF before any line-oriented work — this repo checks out CRLF and JavaScript's
    // `.` does not match `\r` (DEF-179). Splitting on '\n' alone leaves a trailing '\r' on every
    // line, which would end up inside the captured path and make every marker miss.
    const text = readFileSync(join(TASKS_DIR, file), 'utf8').replace(/\r\n/g, '\n');
    // ⚠️ **Skip fenced code blocks, and this is not a nicety.** The task doc that INTRODUCES this
    // convention shows the marker in a ``` block as a worked example, naming a path that exists —
    // so without this the guard fails on its own documentation. ⛔ A guard that punishes explaining
    // it teaches people to stop explaining it, and the marker only means anything in prose anyway.
    let inFence = false;
    text.split('\n').forEach((line, i) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return;
      }
      if (inFence) return;
      for (const m of line.matchAll(MARKER)) {
        found.push({ file, line: i + 1, path: m[1]! });
      }
    });
  }
  return found;
}

describe('T-220 / DEF-185 — no deferral outlives the reason it was deferred', () => {
  it('⛔ every STALE-IF-EXISTS path is still absent — a deferral whose blocker is gone is stale', () => {
    const stale = markers()
      .filter((m) => existsSync(join(REPO_ROOT, m.path)))
      .map(
        (m) =>
          `${m.file}:${m.line} — deferral says \`${m.path}\` does not exist, but it DOES. ` +
          'Either do the deferred work or correct the doc; do not delete the marker to silence this.',
      );
    expect(stale).toEqual([]);
  });

  it('⭐ at least one marker exists — a guard watching nothing is the failure it is guarding against', () => {
    // ⚠️ The non-vacuity check, and it is not ceremony. T-161 refused to register a detector that
    // could not fail ("T-134's own vacuous-pass lesson"); a staleness guard with zero markers is the
    // same thing wearing a green tick. If resolving the last live deferral empties this, the right
    // response is to mark the next real one, never to delete this assertion.
    expect(markers().length).toBeGreaterThan(0);
  });

  it('⚠️ every marker points at a repo-relative path, not an absolute or escaping one', () => {
    const bad = markers()
      .filter((m) => m.path.startsWith('/') || m.path.includes('..') || /^[A-Za-z]:/.test(m.path))
      .map((m) => `${m.file}:${m.line} — \`${m.path}\` is not repo-relative`);
    expect(bad).toEqual([]);
  });
});
