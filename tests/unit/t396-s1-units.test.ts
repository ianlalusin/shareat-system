/**
 * T-396 S1 (test 16) - the 06:00 Manila POS day-import is a registered, hosted job:
 * `docs/tasks/396-link-remaining-stores-and-morning-import.md` D2.
 *
 * TESTER. Red on HEAD: the job is not in `SCHEDULER_JOBS`, and neither unit file, the npm script nor the runner script
 * exists. Each case names the mutant it kills.
 *
 * Deliberately NOT here: a count bump of `scheduler-jobs-have-callers.test.ts`' `KNOWN_JOB_NAMES`. That guard extracts
 * `export async function run*` entries; `posDayImportSweep` (like `usageAutoPostSweep`, which is not in the list
 * either) does not start with `run`, so the list does not move. Reported to the orchestrator as a spec defect.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCHEDULER_JOBS } from '@shareat/db';

const repoRoot = path.resolve(__dirname, '..', '..');
const OPS = path.join(repoRoot, 'docs', 'ops');
const SERVICE = path.join(OPS, 'shareat-pos-day-import.service');
const TIMER = path.join(OPS, 'shareat-pos-day-import.timer');

describe('T-396 S1 - the POS day import is a registered, hosted job', () => {
  it('pos_day_import is in SCHEDULER_JOBS (so every run writes a scheduler_runs row). Mutant: left out of the registry', () => {
    expect(SCHEDULER_JOBS as readonly string[]).toContain('pos_day_import');
  });

  it('the timer fires daily at 06:00 ASIA/MANILA and is persistent. Mutants: wrong time zone (UTC 06:00 = 14:00 Manila); no catch-up after a reboot', () => {
    expect(existsSync(TIMER), 'docs/ops/shareat-pos-day-import.timer exists').toBe(true);
    const t = readFileSync(TIMER, 'utf8');
    expect(t).toMatch(/^OnCalendar=\*-\*-\* 06:00:00 Asia\/Manila\s*$/m);
    expect(t).toMatch(/^Persistent=true\s*$/m);
    expect(t).toMatch(/^AccuracySec=1min\s*$/m);
    expect(t, 'a [Install] section so `enable --now` works').toMatch(/^WantedBy=timers\.target\s*$/m);
  });

  it('the service is a oneshot that runs `npm run pos-day-import` as shareat in production mode - and never builds. Mutant: a build step on the 4 GB droplet', () => {
    expect(existsSync(SERVICE), 'docs/ops/shareat-pos-day-import.service exists').toBe(true);
    const s = readFileSync(SERVICE, 'utf8');
    expect(s).toMatch(/^Type=oneshot\s*$/m);
    expect(s).toMatch(/^ExecStart=.*npm run pos-day-import\s*$/m);
    const execLines = s.split('\n').filter((l) => /^Exec\w*=/.test(l));
    expect(execLines.join('\n'), 'no Exec line builds anything (bible 2.10)').not.toMatch(/\bbuild\b/);
    expect(s).toMatch(/^User=shareat\s*$/m);
    expect(s).toMatch(/^WorkingDirectory=\/srv\/shareat\s*$/m);
    expect(s).toMatch(/^Environment=NODE_ENV=production\s*$/m);
    expect(s).toMatch(/^TimeoutStartSec=15min\s*$/m);
    expect(s).toMatch(/\/var\/log\/shareat\/pos-day-import\.log/);
  });

  it('`npm run pos-day-import` exists and points at scripts/pos-day-import.ts, which exists and calls the sweep. Mutant: a unit pair with nothing behind it', () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['pos-day-import']).toBe('tsx scripts/pos-day-import.ts');
    const script = path.join(repoRoot, 'scripts', 'pos-day-import.ts');
    expect(existsSync(script), 'scripts/pos-day-import.ts exists').toBe(true);
    expect(readFileSync(script, 'utf8')).toMatch(/\bposDayImportSweep\s*\(/);
  });

  it('the runner honours --org=, --manual and --dry-run and exits 1 on a failure or zero orgs (same shape as usage-auto-post). Mutant: a dry run that cannot be asked for', () => {
    const script = path.join(repoRoot, 'scripts', 'pos-day-import.ts');
    expect(existsSync(script)).toBe(true);
    const src = readFileSync(script, 'utf8');
    expect(src).toMatch(/--manual/);
    expect(src).toMatch(/--dry-run/);
    expect(src).toMatch(/arg\(\s*['"]org['"]\s*\)/);
    expect(src, 'exit code is load-bearing').toMatch(/hadFailures/);
    expect(src).toMatch(/return 1/);
  });

  it('docs/ops/README.md has the job row, naming the command and the 06:00 Manila time', () => {
    const readme = readFileSync(path.join(OPS, 'README.md'), 'utf8');
    expect(readme).toMatch(/npm run pos-day-import/);
    expect(readme).toMatch(/06:00 Manila/);
    expect(readme).toMatch(/shareat-pos-day-import\.timer/);
  });
});
