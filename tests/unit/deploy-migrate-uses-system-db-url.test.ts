import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * T-298 / DEF-327 regression guard.
 *
 * `shareat_app_prod` (the role `DATABASE_URL` names in `/srv/shareat-shared/.env.local` since
 * the 2026-09-12 role change, docs/ops/README.md § "Status as of 2026-09-12") is
 * `NOCREATEDB NOCREATEROLE` and owns no table, so it cannot run `npm run db:migrate` — that is
 * the whole content of DEF-327 (`permission denied for database defaultdb`, 42501). The fix is a
 * few shell lines in `.github/workflows/deploy.yml`'s remote heredoc: feed the admin string
 * (`SYSTEM_DATABASE_URL`) into `DATABASE_URL` for that one command only, defensively unwrapped
 * (DEF-196/DEF-203: this file has a documented history of CRLF line endings and a BOM), the same
 * idiom the ops doc's manual recipe uses plus the defensive parsing it lacks.
 *
 * A GitHub Actions workflow cannot run locally (no SSH target, no self-hosted runner in this
 * repo), so this cannot exercise the deploy — it can only prove the YAML keeps the shape DEF-327
 * requires. That is deliberate and matches `tests/unit/app-boundaries.test.ts`'s own rationale:
 * dependency-free, reads the real file, and turns a silent regression (someone "simplifies" the
 * migrate line back to a bare `npm run db:migrate`, exactly how this defect happened once
 * already) into a red unit test instead of the next failed production deploy.
 */

const repoRoot = join(import.meta.dirname, '..', '..');
const workflow = readFileSync(join(repoRoot, '.github/workflows/deploy.yml'), 'utf8');

// The remote heredoc between `ssh ... <<'REMOTE'` and the closing `REMOTE` marker — scoping the
// assertions to it means a `DATABASE_URL=` mention anywhere else in the file (a build-time
// secret, a comment) can never satisfy this test by accident.
function remoteScript(stepName: string): string {
  const stepIdx = workflow.indexOf(stepName);
  expect(stepIdx, `step "${stepName}" not found in deploy.yml`).toBeGreaterThan(-1);
  const heredocStart = workflow.indexOf("<<'REMOTE'", stepIdx);
  expect(heredocStart, `no <<'REMOTE' heredoc after step "${stepName}"`).toBeGreaterThan(-1);
  const bodyStart = workflow.indexOf('\n', heredocStart) + 1;
  const bodyEnd = workflow.indexOf('\n          REMOTE', bodyStart);
  expect(bodyEnd, `no closing REMOTE marker after step "${stepName}"`).toBeGreaterThan(-1);
  return workflow.slice(bodyStart, bodyEnd);
}

describe('deploy.yml migrate step (DEF-327)', () => {
  const script = remoteScript('Unpack, migrate, restart');

  it('never runs db:migrate without an explicit DATABASE_URL override', () => {
    // A bare, unprefixed invocation is exactly the 42501 defect: it inherits DATABASE_URL from
    // .env.local, which names the app role.
    const bareInvocation = /(?<!DATABASE_URL=\S+\s+)npm run db:migrate/;
    expect(script).not.toMatch(bareInvocation);
    expect(script).toMatch(/DATABASE_URL="\$\w+"\s+npm run db:migrate/);
  });

  it('sources the override from SYSTEM_DATABASE_URL, not a hand-rolled admin string', () => {
    expect(script).toMatch(/SYSTEM_DATABASE_URL/);
    // Out of scope, hard: DEF-327's task doc and docs/ops/README.md both forbid granting the app
    // role DDL rights or table ownership as an alternative fix — this must never appear as a
    // workaround for the permission error instead of the SYSTEM_DATABASE_URL override.
    expect(script).not.toMatch(/GRANT\s+(CREATE|ALL)/i);
    expect(script).not.toMatch(/ALTER\s+(ROLE|TABLE)\s+.*OWNER/i);
  });

  it('fails loudly and accurately before migrating if the admin string is absent or empty', () => {
    // DEF-327's fourth instance of the DEF-315 class: an absent SYSTEM_DATABASE_URL must not
    // silently produce DATABASE_URL="" and let migrate.ts report the unrelated "DATABASE_URL is
    // not set" — it must be caught, named, and exited on before npm ever runs.
    const guardBeforeMigrate = /if \[ -z "\$\w+" \][\s\S]*?exit 1[\s\S]*?npm run db:migrate/;
    expect(script).toMatch(guardBeforeMigrate);
    expect(script).toMatch(/SYSTEM_DATABASE_URL/);
  });

  it('scopes the override to the migrate command only, never exporting or persisting it', () => {
    // export DATABASE_URL=... or a standalone `DATABASE_URL="$X"` assignment would leak the
    // admin string into every later command in the same remote shell (the symlink swap, the
    // restart) — the override belongs on the migrate line alone.
    expect(script).not.toMatch(/export DATABASE_URL/);
    expect(script).not.toMatch(/^\s*DATABASE_URL="\$\w+"\s*$/m);
  });

  it('strips a trailing CR and surrounding quotes before treating the value as absent', () => {
    // DEF-196 (a UTF-8 BOM found on this exact file, 2026-09-06) and DEF-203 (a glued line on
    // this exact file, same day) are this project's own evidence that
    // /srv/shareat-shared/.env.local gets decorated in ways a raw `cut` would pass straight
    // through. A quoted or CRLF-suffixed admin string must be unwrapped, not misread as empty
    // (which would trip the guard above for the wrong reason) or passed to postgres() intact.
    expect(script).toMatch(/\$'\\r'/);
    expect(script).toMatch(/case "\$SYSTEM_DB_URL" in/);
  });
});
