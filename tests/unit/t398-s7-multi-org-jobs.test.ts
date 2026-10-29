/**
 * T-398 S7e (TESTER) - O7: every systemd unit in docs/ops/*.service runs per organisation, or is on the pinned allow-list.
 * docs/tasks/398-s7/S7-REFRESH.md s7 (scan), s2 K6 (16 ExecStarts, no dual-run service, three jobs reach the loop INSIDE their domain sweep).
 *
 * The scan: ExecStart -> `npm run <script>` -> package.json script -> scripts/*.ts -> every `@shareat/domain` name it imports -> that function in
 * packages/domain/src, FOLLOWED through the domain functions it calls (depth-limited) -> must reach `listOrgsToRun`. Else the unit must be on the
 * allow-list, which is pinned EXACTLY (db-backup, restore-drill, start x2) with a reason each. A new .service with neither fails the build.
 *
 * STATUS TODAY: GREEN-AS-GUARD against main (all 13 job scripts reach the loop; the allow-list covers the other three kinds). The legs that
 * prove the scanner itself (S*) run on synthetic trees and kill the scanner mutants named on each. If a future service breaks the rule this
 * file goes red on THAT service, by name.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/** The pinned allow-list (s7). Anything else must reach the org loop. */
const ALLOW: Readonly<Record<string, string>> = {
  'db-backup': 'backs up the whole database by design, not per company',
  'restore-drill': 'restores a whole-database backup by design, not per company',
  start: 'the web server (shareat-erp and shareat-pos), not a job',
};
const LOOP = 'listOrgsToRun';

type Read = (path: string) => string | undefined;
const diskRead: Read = (p) => (existsSync(join(repoRoot, p)) ? readFileSync(join(repoRoot, p), 'utf8') : undefined);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(join(repoRoot, dir), { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(p, out);
    else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

/** name -> body text of every top-level function / arrow const in the given source files. */
function indexFunctions(files: Record<string, string>): Map<string, string> {
  const idx = new Map<string, string>();
  for (const text of Object.values(files)) {
    const lines = text.split('\n');
    let cur: { name: string; body: string[] } | null = null;
    const flush = () => {
      if (cur) idx.set(cur.name, (idx.get(cur.name) ?? '') + '\n' + cur.body.join('\n'));
      cur = null;
    };
    for (const line of lines) {
      const m = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/.exec(line) ?? /^(?:export\s+)?const\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?\(/.exec(line);
      if (m) {
        flush();
        cur = { name: m[1]!, body: [line] };
      } else if (/^(?:export\s|function\s|async\s|const\s|class\s|interface\s|type\s)/.test(line)) {
        flush();
      } else if (cur) cur.body.push(line);
    }
    flush();
  }
  return idx;
}

/** Does `name` reach the org loop, following calls through the index (depth-limited, cycle-safe)? */
export function reachesLoop(name: string, idx: Map<string, string>, depth = 4, seen = new Set<string>()): boolean {
  if (name === LOOP) return true;
  if (depth < 0 || seen.has(name)) return false;
  seen.add(name);
  const body = idx.get(name);
  if (body === undefined) return false;
  if (new RegExp(`\\b${LOOP}\\b`).test(body)) return true;
  const calls = new Set([...body.matchAll(/\b([A-Za-z0-9_]+)\s*\(/g)].map((m) => m[1]!));
  for (const c of calls) if (idx.has(c) && reachesLoop(c, idx, depth - 1, seen)) return true;
  return false;
}

/** Names a script imports from the domain package. */
function domainImports(script: string): string[] {
  const out: string[] = [];
  for (const m of script.matchAll(/import\s*\{([^}]*)\}\s*from\s*'@shareat\/domain'/g)) {
    for (const part of m[1]!.split(',')) {
      const n = part.trim().split(/\s+as\s+/)[0]!.trim();
      if (n) out.push(n);
    }
  }
  return out;
}

export interface Verdict {
  service: string;
  npmScript: string;
  ok: boolean;
  via: 'org-loop' | 'allow-list' | 'none';
  detail: string;
}

export function judge(service: string, unit: string, read: Read, idx: Map<string, string>, pkgScripts: Record<string, string>): Verdict {
  const exec = /^ExecStart=.*\bnpm run ([A-Za-z0-9:_-]+)/m.exec(unit);
  if (!exec) return { service, npmScript: '?', ok: false, via: 'none', detail: 'no `npm run <script>` ExecStart' };
  const npmScript = exec[1]!;
  if (ALLOW[npmScript]) return { service, npmScript, ok: true, via: 'allow-list', detail: ALLOW[npmScript]! };
  const cmd = pkgScripts[npmScript] ?? '';
  const file = /(scripts\/[A-Za-z0-9._-]+\.ts)/.exec(cmd)?.[1];
  const text = file ? read(file) : undefined;
  if (!file || text === undefined) return { service, npmScript, ok: false, via: 'none', detail: `npm script ${npmScript} does not resolve to a scripts/*.ts file (${cmd || 'missing'})` };
  const names = domainImports(text);
  const hit = names.find((n) => reachesLoop(n, idx));
  return hit
    ? { service, npmScript, ok: true, via: 'org-loop', detail: `${file} -> ${hit} -> ${LOOP}` }
    : { service, npmScript, ok: false, via: 'none', detail: `${file} imports ${names.join(', ') || 'nothing from the domain'}; none reaches ${LOOP}` };
}

const domainFiles = (): Record<string, string> => Object.fromEntries(walk('packages/domain/src').map((p) => [p, readFileSync(join(repoRoot, p), 'utf8')]));
const pkg = (): Record<string, string> => JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).scripts;
const services = (): string[] => readdirSync(join(repoRoot, 'docs/ops')).filter((f) => f.endsWith('.service')).sort();

describe('O7 - every docs/ops/*.service runs per company or is allow-listed', () => {
  const idx = indexFunctions(domainFiles());
  const verdicts = services().map((s) => judge(s, readFileSync(join(repoRoot, 'docs/ops', s), 'utf8'), diskRead, idx, pkg()));

  it('there are services to scan (mutant: a scan of an empty list passes)', () => {
    expect(verdicts.length).toBeGreaterThanOrEqual(16);
  });
  it.each(verdicts.map((v) => [v.service, v] as const))('%s', (_n, v) => {
    expect(v.ok, `${v.service} (npm run ${v.npmScript}): ${v.detail}. Make it loop organisations via listOrgsToRun, or add it to the pinned allow-list WITH a reason.`).toBe(true);
  });
  it('the 06:30 inter-entity-reconcile is in the scanned set and passes through the loop, not the allow-list', () => {
    const v = verdicts.find((x) => x.service === 'shareat-inter-entity-reconcile.service');
    expect(v?.via).toBe('org-loop');
  });
  it('the three nested-loop jobs are accepted ONLY by following into the sweep (pos-day-import, pos-receipt-bridge, usage-auto-post)', () => {
    for (const s of ['shareat-pos-day-import.service', 'shareat-pos-receipt-bridge.service', 'shareat-usage-auto-post.service']) {
      const v = verdicts.find((x) => x.service === s)!;
      expect(v.via, s).toBe('org-loop');
      const script = diskRead(`scripts/${v.npmScript}.ts`)!;
      expect(script, `${s}: if the SCRIPT itself held the loop the follow-through would be untested`).not.toMatch(new RegExp(`\\b${LOOP}\\b`));
    }
  });
  it('the allow-list is EXACTLY db-backup, restore-drill, start (x2) and each is really used (mutant: a widened or stale list)', () => {
    expect(Object.keys(ALLOW).sort()).toEqual(['db-backup', 'restore-drill', 'start']);
    const used = verdicts.filter((v) => v.via === 'allow-list');
    expect(used.map((v) => v.npmScript).sort()).toEqual(['db-backup', 'restore-drill', 'start', 'start']);
    expect(used.filter((v) => v.npmScript === 'start').map((v) => v.service).sort()).toEqual(['shareat-erp.service', 'shareat-pos.service']);
  });
  it('no dual-run service exists and none is allow-listed (K6)', () => {
    expect(services().some((s) => /dual-run/.test(s))).toBe(false);
    expect(Object.keys(ALLOW)).not.toContain('dual-run');
  });
});

describe('O7 - the scanner itself (synthetic trees)', () => {
  const unit = (script: string) => `[Service]\nExecStart=/usr/bin/npm run ${script}\n`;
  const pkgScripts = { 'job-a': 'tsx scripts/job-a.ts', 'job-b': 'tsx scripts/job-b.ts', 'job-c': 'tsx scripts/job-c.ts' };
  const files: Record<string, string> = {
    'scripts/job-a.ts': "import { runA } from '@shareat/domain';\nawait runA({});\n",
    'scripts/job-b.ts': "import { sweepB } from '@shareat/domain';\nawait sweepB({});\n",
    'scripts/job-c.ts': "import { sweepC } from '@shareat/domain';\nawait sweepC({});\n",
  };
  const read: Read = (p) => files[p];
  const idx = indexFunctions({
    sched: [
      'export async function listOrgsToRun(orgId?: string) {',
      '  return [];',
      '}',
      'export async function runA(o: object) {',
      '  const orgs = await listOrgsToRun();',
      '}',
      'export async function innerB() {',
      '  return listOrgsToRun();',
      '}',
      'export async function sweepB(o: object) {',
      '  return innerB();',
      '}',
      'export async function sweepC(o: object) {',
      '  return 1;',
      '}',
    ].join('\n'),
  });

  it('S1: a script whose sweep reaches the loop only INSIDE a nested call passes (mutant: scan of the script file only would fail usage-auto-post-shaped jobs)', () => {
    expect(judge('b.service', unit('job-b'), read, idx, pkgScripts)).toMatchObject({ ok: true, via: 'org-loop' });
    expect(files['scripts/job-b.ts']).not.toContain(LOOP);
  });
  it('S2: a job with no org loop anywhere fails (mutant: scan that passes everything)', () => {
    expect(judge('c.service', unit('job-c'), read, idx, pkgScripts)).toMatchObject({ ok: false, via: 'none' });
  });
  it('S3: a new unit that is neither a loop nor allow-listed fails by name (mutant: allow-list matched by substring)', () => {
    expect(judge('x.service', unit('db-backup-extra'), read, idx, { ...pkgScripts, 'db-backup-extra': 'tsx scripts/missing.ts' }).ok).toBe(false);
    expect(judge('x.service', unit('db-backup'), read, idx, pkgScripts)).toMatchObject({ ok: true, via: 'allow-list' });
  });
  it('S4: a unit with no `npm run` ExecStart fails (mutant: skipping units the regex does not match)', () => {
    expect(judge('y.service', '[Service]\nExecStart=/usr/bin/node server.js\n', read, idx, pkgScripts).ok).toBe(false);
  });
});
