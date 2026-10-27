/**
 * T-398 S5e (J2 and M1) - the 06:30 Manila inter-entity reconciliation is a hosted, registered job, and its money code is float-free.
 * docs/tasks/398-s5/TESTS.md "S5e" J2 + standing invariant M1; S5-REFRESH.md section 5 (ops: `shareat-inter-entity-reconcile.{service,timer}`,
 * `ExecStart=/usr/bin/npm run inter-entity-reconcile`, root package.json script, `scripts/inter-entity-reconcile.ts`).
 *
 * TESTER. Red on HEAD: neither unit file, the npm script, the runner script nor the job function exists. Each case names the mutant it kills.
 * Line-based on purpose (no regex over the unit files), so a stray escape cannot make a check pass by accident.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCHEDULER_JOBS } from '@shareat/db';

const repoRoot = path.resolve(__dirname, '..', '..');
const OPS = path.join(repoRoot, 'docs', 'ops');
const SERVICE = path.join(OPS, 'shareat-inter-entity-reconcile.service');
const TIMER = path.join(OPS, 'shareat-inter-entity-reconcile.timer');
const SCRIPT = path.join(repoRoot, 'scripts', 'inter-entity-reconcile.ts');
const SCHEDULER = path.join(repoRoot, 'packages', 'domain', 'src', 'scheduler', 'index.ts');
const RECONCILE = path.join(repoRoot, 'packages', 'domain', 'src', 'trade', 'inter-entity-reconcile.ts');
const REPO = path.join(repoRoot, 'packages', 'db', 'src', 'repo', 'inter-entity.ts');

/** The non-comment lines of a unit file, trimmed. */
function lines(file: string): string[] {
  return readFileSync(file, 'utf8')
    .split(String.fromCharCode(10))
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}

/** The text of `export async function <name>` up to the next top-level export (or the end of the file). */
function functionText(source: string, name: string): string {
  const head = `export async function ${name}(`;
  const at = source.indexOf(head);
  if (at < 0) return '';
  const rest = source.slice(at + head.length);
  const next = rest.indexOf(String.fromCharCode(10) + 'export ');
  return next < 0 ? rest : rest.slice(0, next);
}

describe('T-398 S5e J2 - the 06:30 reconciliation is a registered, hosted job', () => {
  it('inter_entity_reconcile is in SCHEDULER_JOBS (so every run writes a scheduler_runs row). Mutant: left out of the registry', () => {
    expect(SCHEDULER_JOBS as readonly string[]).toContain('inter_entity_reconcile');
    expect(SCHEDULER_JOBS.length).toBe(15);
  });

  it('the timer fires daily at 06:30 ASIA/MANILA and is persistent. Mutants: the zone removed (UTC 06:30 = 14:30 Manila); no catch-up after a reboot', () => {
    expect(existsSync(TIMER), 'docs/ops/shareat-inter-entity-reconcile.timer exists').toBe(true);
    const t = lines(TIMER);
    expect(t).toContain('OnCalendar=*-*-* 06:30:00 Asia/Manila');
    expect(t).toContain('Persistent=true');
    expect(t, 'a [Install] section so `enable --now` works').toContain('WantedBy=timers.target');
    expect(t.some((l) => l.startsWith('OnCalendar=') && !l.endsWith('Asia/Manila')), 'every OnCalendar line names the zone').toBe(false);
  });

  it('the service is a oneshot that runs `npm run inter-entity-reconcile` as shareat in production mode, logs, and never builds. Mutant: a build step on the droplet', () => {
    expect(existsSync(SERVICE), 'docs/ops/shareat-inter-entity-reconcile.service exists').toBe(true);
    const s = lines(SERVICE);
    expect(s).toContain('Type=oneshot');
    expect(s).toContain('ExecStart=/usr/bin/npm run inter-entity-reconcile');
    expect(s.filter((l) => l.startsWith('Exec')).join(' '), 'no Exec line builds anything (bible 2.10)').not.toContain('build');
    expect(s).toContain('User=shareat');
    expect(s).toContain('WorkingDirectory=/srv/shareat');
    expect(s).toContain('Environment=NODE_ENV=production');
    expect(s.some((l) => l.startsWith('StandardOutput=append:/var/log/shareat/inter-entity-reconcile.log'))).toBe(true);
  });

  it('`npm run inter-entity-reconcile` exists and points at scripts/inter-entity-reconcile.ts, which calls the job and exits non-zero on a failure. Mutant: a unit pair with nothing behind it', () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['inter-entity-reconcile']).toBe('tsx scripts/inter-entity-reconcile.ts');
    expect(existsSync(SCRIPT), 'scripts/inter-entity-reconcile.ts exists').toBe(true);
    const src = readFileSync(SCRIPT, 'utf8');
    expect(src).toContain('runInterEntityReconcile(');
    expect(src, 'exit code is load-bearing: a failed org must make systemd show the unit failed').toContain('hadFailures');
    expect(src).toContain('--manual');
    expect(src).toContain('--org=');
  });

  it('S7 O7 input: the ExecStart script reaches listOrgsToRun (script -> runInterEntityReconcile -> listOrgsToRun) and runs each org through runJobForOrg as job inter_entity_reconcile. Mutant: a job that scans one org only', () => {
    expect(existsSync(SCRIPT)).toBe(true);
    expect(readFileSync(SCRIPT, 'utf8')).toContain('runInterEntityReconcile(');
    const body = functionText(readFileSync(SCHEDULER, 'utf8'), 'runInterEntityReconcile');
    expect(body, 'runInterEntityReconcile is exported from scheduler/index.ts').not.toBe('');
    expect(body).toContain('listOrgsToRun(');
    expect(body).toContain('runJobForOrg(');
    expect(body).toContain("'inter_entity_reconcile'");
    expect(body, 'never systemTransaction directly: the work runs under each org\'s own principal').not.toContain('systemTransaction(');
  });

  it('docs/ops/README.md has the job row, naming the command, the unit and the 06:30 Manila time', () => {
    const readme = readFileSync(path.join(OPS, 'README.md'), 'utf8');
    expect(readme).toContain('npm run inter-entity-reconcile');
    expect(readme).toContain('shareat-inter-entity-reconcile.timer');
    const row = readme.split(String.fromCharCode(10)).find((l) => l.includes('npm run inter-entity-reconcile')) ?? '';
    expect(row, 'the row says when it runs').toContain('06:30 Manila');
  });
});

describe('T-398 S5e M1 - no float arithmetic on money in the files S5e adds or edits', () => {
  it('trade/inter-entity-reconcile.ts exists, and neither it nor repo/inter-entity.ts calls Number( / parseFloat( / parseInt( (money is Money / decimal strings). Mutant: a float sum', () => {
    expect(existsSync(RECONCILE), 'packages/domain/src/trade/inter-entity-reconcile.ts exists').toBe(true);
    for (const f of [RECONCILE, REPO]) {
      const src = readFileSync(f, 'utf8');
      for (const bad of ['Number(', 'parseFloat(', 'parseInt(']) {
        expect(src.includes(bad), `${path.basename(f)} uses ${bad}`).toBe(false);
      }
    }
  });

  it('the reconcile reads run under the org principal, never systemTransaction (the job must not bypass RLS to look at another company)', () => {
    expect(existsSync(RECONCILE)).toBe(true);
    expect(readFileSync(RECONCILE, 'utf8').includes('systemTransaction')).toBe(false);
  });
});

describe('T-398 S5e L5 - the "Post credit note" control is gated by resolve_trade_discrepancy', () => {
  const PAGE = path.join(repoRoot, 'apps', 'erp', 'src', 'app', 'trade', 'orders', '[id]', 'page.tsx');
  const LIB = path.join(repoRoot, 'apps', 'erp', 'src', 'app', 'trade', 'orders', 'lib.ts');

  it('orderDetail decides canPostCredit from can(resolve_trade_discrepancy) at the order store, and the page renders the credit form only when it is true. Mutant: the control shows for every viewer of the order', () => {
    const lib = readFileSync(LIB, 'utf8');
    expect(lib, 'lib.ts asks can(...) for resolve_trade_discrepancy').toContain("'resolve_trade_discrepancy'");
    expect(lib, 'the loader exposes canPostCredit').toContain('canPostCredit');
    const page = readFileSync(PAGE, 'utf8');
    const at = page.indexOf('postFranchiseCreditAction}');
    expect(at, 'the credit form is on the page').toBeGreaterThan(0);
    const guard = page.slice(Math.max(0, at - 400), at);
    expect(guard, 'the form sits behind the capability flag').toContain('canPostCredit');
  });
});
