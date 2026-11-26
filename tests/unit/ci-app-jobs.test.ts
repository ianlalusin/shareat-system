/**
 * T-417 cases 9 and 13 / slices B3-B4 - the app CI jobs in `.github/workflows/ci.yml` and the
 * reusable `.github/workflows/app-build.yml`, plus guards that the ERP's own CI is untouched.
 *
 * Text-level checks (no YAML parser in the repo). The "untouched" guards pin a SHA-256 of the
 * exact text as it stood at 9c1704b (LF-normalised): the existing
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
  // T-604 S2: the old single `verify` job (9c1704b) was split into typecheck / unit / integration / build, and `verify`
  // became the gate that keeps the required check name. The gate's text is pinned; so are the properties that make it safe.
  it('the verify gate keeps the required check name and cannot be skipped. Mutant: drop `if: always()` or a job from needs', () => {
    const block = jobBlock(ci(), 'verify');
    expect(block, 'verify job not found').toBeDefined();
    expect(block).toMatch(/\n    name: typecheck, test, build\n/); // branch protection requires exactly this name
    expect(block).toMatch(/\n    if: always\(\)\n/); // a gate skipped after a failed job would report success
    expect(block).toMatch(/\n    needs: \[changes, typecheck, unit, integration, build\]\n/);
    expect(sha(block!.trimEnd())).toBe('74fbe3bbc632976ae494ac6a7c1b26d5c7905abe4c2b0548671cadd416b5c0a2');
  });

  it('unit has no job-level `if` (the documentation guards run on docs-only changes); the other three skip only on docs-only', () => {
    const unit = jobBlock(ci(), 'unit')!;
    expect(unit).toBeDefined();
    expect(unit).not.toMatch(/\n    if:/);
    for (const job of ['typecheck', 'integration', 'build']) {
      expect(jobBlock(ci(), job), job).toMatch(/\n    if: needs\.changes\.outputs\.docs_only != 'true'\n/);
    }
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

  // The customer lobby's steps live only between `# >>> Customer lobby` and `# <<< Customer lobby` markers; with those blocks
  // removed, every ERP byte is still 9c1704b's. (T-588: the POS v2 blocks were deleted with apps/pos; the pin is unchanged.)
  const stripBlocks = (s: string) => {
    const out: string[] = [];
    let skip = false;
    for (const line of s.split('\n')) {
      if (line.includes('# >>> Customer lobby')) { skip = true; continue; }
      if (line.includes('# <<< Customer lobby')) { skip = false; continue; }
      if (!skip) out.push(line);
    }
    return out.join('\n');
  };

  it('deploy.yml minus the customer lobby blocks is byte-identical to 9c1704b. Mutant: any ERP step edit', () => {
    expect(sha(stripBlocks(readLf(wf('deploy.yml'))))).toBe('13612895e9ee2e0e61e6df03a0edbf150c8cad0d88112c5fd411fa12977cd505');
  });

  it('a customer lobby failure can never block the ERP deploy. Mutant: fatal customer build or restart, or the success marker dropped', () => {
    const d = readLf(wf('deploy.yml'));
    expect(d.match(/# >>> Customer lobby/g)?.length).toBe(6);
    expect(d.match(/# <<< Customer lobby/g)?.length).toBe(6);
    expect(d).toMatch(/- name: Build customer lobby \(web\)\n\s+continue-on-error: true/);
    expect(d).toMatch(/if \[ -f apps\/customer\/\.customer-build-ok \]; then/); // gated on the success marker, not .next
    expect(d).toMatch(/restart shareat-customer\.service \|\| \{ CUSTOMER_UP=0; echo/);
    expect(d.indexOf('Confirm customer lobby is up')).toBeGreaterThan(d.indexOf('- name: Confirm the app is up'));
  });

  // T-588: apps/pos and its service are gone. Mutant: a POS build, restart or health probe is put back in the deploy.
  it('deploy.yml has no POS v2 build, service restart or health probe left', () => {
    const d = readLf(wf('deploy.yml'));
    expect(d).not.toMatch(/apps\/pos(?![A-Za-z-])/);
    expect(d).not.toContain('shareat-pos.service');
    expect(d).not.toContain('@shareat/pos');
    expect(d).not.toContain(':9009');
    expect(d).not.toContain('POS v2');
  });
});

describe('T-417 ci.yml: change detection and app jobs (case 9)', () => {
  it('the changes job exposes the customer output next to docs_only, and no pos output', () => {
    const changes = jobBlock(ci(), 'changes')!;
    expect(changes).toBeDefined();
    expect(changes).toMatch(/docs_only:\s*\$\{\{\s*steps\.check\.outputs\.docs_only\s*\}\}/);
    expect(changes).not.toMatch(/^\s+pos:/m); // T-588: apps/pos is retired
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

  it.each(['customer'])('app-%s: needs changes, gated on its own output, calls app-build.yml with app: %s and secrets: inherit', (app) => {
    const block = jobBlock(ci(), `app-${app}`);
    expect(block, `job app-${app} missing`).toBeDefined();
    expect(block).toMatch(/needs:\s*changes\b/);
    expect(block).toMatch(new RegExp(`if:\\s*needs\\.changes\\.outputs\\.${app}\\s*==\\s*'true'`));
    expect(block).toMatch(/uses:\s*\.\/\.github\/workflows\/app-build\.yml/);
    expect(block).toMatch(new RegExp(`^\\s+app:\\s*${app}\\s*$`, 'm'));
    expect(block).toMatch(/secrets:\s*inherit/);
  });

  it('there is no app-pos job and no job reads a pos output. Mutant: app-pos job back in ci.yml', () => {
    expect(jobBlock(ci(), 'app-pos')).toBeUndefined();
    expect(ci()).not.toMatch(/outputs\.pos(?![A-Za-z])/);
  });

  it('app jobs never use the self-hosted runner variable. Mutant: app job on vars.CI_RUNNER', () => {
    for (const app of ['customer']) {
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
