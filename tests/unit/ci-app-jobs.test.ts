/**
 * T-417 cases 9 and 13 / slices B3-B4 - the app CI jobs in `.github/workflows/ci.yml` and the
 * reusable `.github/workflows/app-build.yml`, plus guards that the ERP's own CI is untouched.
 *
 * Text-level checks (no YAML parser in the repo). The "untouched" guards pin a SHA-256 of the
 * exact text as it stood at 9c1704b (LF-normalised): the `verify` job, the existing
 * `Determine docs-only` step, and all of `deploy.yml`. A deliberate edit to any of them must
 * update the pin in the same commit, which is the point.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');
const wf = (name: string) => path.join(repoRoot, '.github', 'workflows', name);
const readLf = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

const ci = () => readLf(wf('ci.yml'));
const appBuild = () => readLf(wf('app-build.yml'));

/** Lines of a top-level job (2-space key) up to the next job key or EOF. */
function jobBlock(text: string, job: string): string | undefined {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l === `  ${job}:`);
  if (start < 0) return undefined;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^  [A-Za-z][\w-]*:/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

describe('T-417 ERP CI is untouched (case 13)', () => {
  it('the verify job is byte-identical to 9c1704b. Mutant: any ERP job edit or reorder', () => {
    const block = jobBlock(ci(), 'verify');
    expect(block, 'verify job not found').toBeDefined();
    expect(sha(block!.trimEnd())).toBe('2ffcc4ac79eb6ad768c12af9e61f7f33068baec2e2832b992efec2ba8fa13753');
  });

  it('the existing "Determine docs-only" step text is untouched', () => {
    const lines = ci().split('\n');
    const s = lines.findIndex((l) => l === '      - name: Determine docs-only');
    expect(s).toBeGreaterThan(-1);
    let e = lines.length;
    for (let i = s + 1; i < lines.length; i++) {
      if (/^      - /.test(lines[i]!) || /^  \S/.test(lines[i]!)) {
        e = i;
        break;
      }
    }
    expect(sha(lines.slice(s, e).join('\n').trimEnd())).toBe('0b3420dc93bec889ec9c1abca2f48b3cbca1cf1727f1d14ffda250c135e830a0');
  });

  // Bible row 378: POS v2 ships beside the ERP. Its steps live only between `# >>> POS v2` and
  // `# <<< POS v2` markers; with those blocks removed, every ERP byte is still 9c1704b's.
  const stripPos = (s: string) => {
    const out: string[] = [];
    let skip = false;
    for (const line of s.split('\n')) {
      if (line.includes('# >>> POS v2')) { skip = true; continue; }
      if (line.includes('# <<< POS v2')) { skip = false; continue; }
      if (!skip) out.push(line);
    }
    return out.join('\n');
  };

  it('deploy.yml minus the POS v2 blocks is byte-identical to 9c1704b. Mutant: any ERP step edit', () => {
    expect(sha(stripPos(readLf(wf('deploy.yml'))))).toBe('13612895e9ee2e0e61e6df03a0edbf150c8cad0d88112c5fd411fa12977cd505');
  });

  it('a POS v2 failure can never block the ERP deploy. Mutant: fatal POS build or restart', () => {
    const d = readLf(wf('deploy.yml'));
    const opens = d.match(/# >>> POS v2/g)?.length ?? 0;
    expect(opens).toBe(5); // T-473 / DEF-753 added the carry-forward block
    expect(d.match(/# <<< POS v2/g)?.length).toBe(5);
    expect(d).toMatch(/- name: Build POS v2 \(web\)\n\s+continue-on-error: true/);
    expect(d).toMatch(/if \[ -f apps\/pos\/\.pos-build-ok \]; then/); // gated on the success marker, not .next
    expect(d).toMatch(/restart shareat-pos\.service \|\| echo/);
    expect(d.indexOf('Confirm POS v2 is up')).toBeGreaterThan(d.indexOf('- name: Confirm the app is up'));
  });

  // 22 Oct: `next start` crashed on the box because next.config.mjs imports ./config/*, which the
  // artifact did not ship. Every local file next.config.mjs imports must be in the POS PATHS.
  it('the artifact ships every local file apps/pos/next.config.mjs imports. Mutant: drop apps/pos/config', () => {
    const cfg = readLf(path.join(repoRoot, 'apps', 'pos', 'next.config.mjs'));
    const local = [...cfg.matchAll(/from\s+['"]\.\/([^'"]+)['"]/g)].map((m) => m[1]!);
    expect(local.length, 'next.config.mjs imports nothing local: re-check this guard').toBeGreaterThan(0);
    const pathsLine = readLf(wf('deploy.yml')).split('\n').find((l) => l.includes('PATHS="$PATHS apps/pos/.next'));
    expect(pathsLine, 'POS PATHS line not found').toBeDefined();
    const shipped = pathsLine!.match(/apps\/pos\/[^\s"]+/g) ?? [];
    for (const rel of local) {
      const top = `apps/pos/${rel.split('/')[0]}`;
      expect(shipped, `${top} is imported by next.config.mjs but not shipped`).toContain(top);
    }
  });
});

describe('T-417 ci.yml: change detection and app jobs (case 9)', () => {
  it('the changes job exposes pos and customer outputs next to docs_only', () => {
    const changes = jobBlock(ci(), 'changes')!;
    expect(changes).toBeDefined();
    expect(changes).toMatch(/docs_only:\s*\$\{\{\s*steps\.check\.outputs\.docs_only\s*\}\}/);
    expect(changes).toMatch(/^\s+pos:\s*\$\{\{\s*steps\.\w+\.outputs\.pos\s*\}\}/m);
    expect(changes).toMatch(/^\s+customer:\s*\$\{\{\s*steps\.\w+\.outputs\.customer\s*\}\}/m);
  });

  it('ONE new step AFTER "Determine docs-only" pipes the diff into scripts/ci-affected-apps.mjs and repeats the BEFORE/AFTER logic', () => {
    const changes = jobBlock(ci(), 'changes')!;
    const iDocs = changes.indexOf('- name: Determine docs-only');
    const iScript = changes.indexOf('scripts/ci-affected-apps.mjs');
    expect(iDocs).toBeGreaterThan(-1);
    expect(iScript, 'ci-affected-apps.mjs not invoked in changes').toBeGreaterThan(iDocs);
    expect(changes.match(/scripts\/ci-affected-apps\.mjs/g)!.length).toBe(1);
    const tail = changes.slice(iDocs);
    expect(tail).toContain('github.event.pull_request.base.sha');
    expect(tail).toContain('UNKNOWN');
    // It must write both outputs the jobs read.
    expect(tail).toMatch(/GITHUB_OUTPUT/);
  });

  it.each(['pos', 'customer'])('app-%s: needs changes, gated on its own output, calls app-build.yml with app: %s and secrets: inherit', (app) => {
    const block = jobBlock(ci(), `app-${app}`);
    expect(block, `job app-${app} missing`).toBeDefined();
    expect(block).toMatch(/needs:\s*changes\b/);
    expect(block).toMatch(new RegExp(`if:\\s*needs\\.changes\\.outputs\\.${app}\\s*==\\s*'true'`));
    expect(block).toMatch(/uses:\s*\.\/\.github\/workflows\/app-build\.yml/);
    expect(block).toMatch(new RegExp(`^\\s+app:\\s*${app}\\s*$`, 'm'));
    expect(block).toMatch(/secrets:\s*inherit/);
  });

  it('an app job reads only its OWN output (pos job never keys off customer, and vice versa)', () => {
    expect(jobBlock(ci(), 'app-pos')).not.toMatch(/outputs\.customer/);
    expect(jobBlock(ci(), 'app-customer')).not.toMatch(/outputs\.pos/);
  });

  it('app jobs never use the self-hosted runner variable. Mutant: app job on vars.CI_RUNNER', () => {
    for (const app of ['pos', 'customer']) {
      const block = jobBlock(ci(), `app-${app}`);
      expect(block, `job app-${app} missing`).toBeDefined();
      expect(block).not.toContain('CI_RUNNER');
      expect(block).not.toMatch(/runs-on:/); // a reusable-workflow job takes its runner from app-build.yml
    }
  });
});

describe('T-417 app-build.yml (cases 9, 15, 17)', () => {
  it('exists, is reusable (workflow_call) and takes an `app` input', () => {
    expect(existsSync(wf('app-build.yml'))).toBe(true);
    const t = appBuild();
    expect(t).toMatch(/^on:\s*\n\s+workflow_call:/m);
    expect(t).toMatch(/inputs:\s*\n\s+app:/);
  });

  it('runs on ubuntu-latest and never references vars.CI_RUNNER. Mutant: app job on the self-hosted runner', () => {
    const t = appBuild();
    expect(t).toMatch(/runs-on:\s*ubuntu-latest\s*$/m);
    expect(t).not.toContain('CI_RUNNER');
    expect(t).not.toMatch(/runs-on:\s*\$\{\{/);
  });

  it('no `run:` line (or run block body) contains secrets. - secrets reach scripts only through env:', () => {
    const lines = appBuild().split('\n');
    const bad: string[] = [];
    let inRun = false;
    let runIndent = 0;
    for (const line of lines) {
      const indent = line.length - line.trimStart().length;
      const m = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(line);
      if (m) {
        runIndent = m[1]!.length + (line.trimStart().startsWith('- ') ? 2 : 0);
        inRun = m[2] === '|' || m[2] === '>' || m[2] === '|-' || m[2] === '>-';
        if (/secrets\./.test(m[2]!)) bad.push(line.trim());
        continue;
      }
      if (inRun) {
        if (line.trim() === '' || indent > runIndent) {
          if (/secrets\./.test(line)) bad.push(line.trim());
        } else {
          inRun = false;
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('the four keystore secrets are wired through env: to the signing gate', () => {
    const t = appBuild();
    for (const v of ['ANDROID_KEYSTORE_BASE64', 'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD']) {
      expect(t, v).toMatch(new RegExp(`${v}:\\s*\\$\\{\\{\\s*secrets\\.${v}\\s*\\}\\}`));
    }
    expect(t).toContain('node scripts/apk-signing-gate.mjs');
  });

  it('runs the web gates for the chosen app: node 22 with npm cache, npm ci, app tsc, server build, capacitor build', () => {
    const t = appBuild();
    expect(t).toMatch(/node-version:\s*'?22'?/);
    expect(t).toMatch(/cache:\s*npm/);
    expect(t).toContain('npm ci');
    expect(t).toMatch(/npx tsc -p apps\/\$\{\{\s*inputs\.app\s*\}\}\/tsconfig\.json --noEmit/);
    expect(t).toMatch(/npm run build -w @shareat\/\$\{\{\s*inputs\.app\s*\}\}/);
    expect(t).toMatch(/npm run build:cap -w @shareat\/\$\{\{\s*inputs\.app\s*\}\}/);
  });

  it('the APK steps (java 17, keystore decode, cap sync, assembleRelease, artifact) only run when signing == release', () => {
    const t = appBuild();
    expect(t).toMatch(/java-version:\s*'?17'?/);
    expect(t).toContain('npx cap sync android');
    expect(t).toMatch(/\.\/gradlew assembleRelease\s+-PversionCode=\$\{\{\s*github\.run_number\s*\}\}\s+-PversionName=0\.1\.\$\{\{\s*github\.run_number\s*\}\}/);
    expect(t).toMatch(/apps\/\$\{\{\s*inputs\.app\s*\}\}\/android\/app\/release\.jks/);
    expect(t).toMatch(/\$\{\{\s*inputs\.app\s*\}\}-v2-\$\{\{\s*github\.run_number\s*\}\}\.apk/);
    // Every APK-only step is guarded: split into steps and check each.
    const steps = t.split(/\n\s+- (?=name:|uses:|run:)/);
    const apkOnly = steps.filter((s) => /setup-java|cap sync|gradlew|release\.jks|upload-artifact/.test(s));
    expect(apkOnly.length).toBeGreaterThanOrEqual(4);
    for (const s of apkOnly) {
      expect(s, s.slice(0, 80)).toMatch(/if:\s*steps\.[\w-]+\.outputs\.signing\s*==\s*'release'/);
    }
  });
});
