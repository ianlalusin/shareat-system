/**
 * T-394 R4, R5, R12 - the child processes the rehearsal runs: the REAL cutover-purge CLI (three times), `db:migrate`, `db-backup`.
 * docs/tasks/394-purge-and-opening-rehearsal.md s4, s6 I3, I4, I4a.
 *
 * This module has no purge logic of its own: it only decides argv and env, and spawns. Every child gets the guarded target in
 * its env EXPLICITLY (never the parent's database URLs), because dotenv in the child never overrides a variable already set.
 * Results: code 0 pass, 1 a child failed, 2 refused by a guard (then nothing was spawned).
 */
import { spawn as nodeSpawn } from 'node:child_process';
import path from 'node:path';
import { CUTOVER_CLASSIFICATION } from '../../../packages/db/src/cutover/classification';
import { checkTargetGuards, resolveTargetUrl } from './guards';

export interface SpawnCall {
  command: string;
  args: string[];
  env: Record<string, string | undefined>;
}
export type SpawnFn = (call: SpawnCall) => Promise<{ code: number }>;
export type LivenessFn = () => Promise<{ ok: boolean; message?: string }>;
export interface ChildrenResult {
  ok: boolean;
  code: 0 | 1 | 2;
  ran: number;
  message?: string;
}

type Env = Record<string, string | undefined>;

const repoRoot = process.cwd(); // commands run from the repo root (npm run), as cutover-purge's own .env.local load assumes
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
/** Production monitors, storage keys and edge/POS credentials: no rehearsal child needs them, and none may reach production. */
const EDGE_SECRET_RE = /^SPACES_|HEARTBEAT|^FIREBASE_SERVICE_ACCOUNT|^FIREBASE_STORAGE_BUCKET$|^POS_API_/;
const DB_URL_NAMES = ['DATABASE_URL', 'SYSTEM_DATABASE_URL', 'TEST_DATABASE_URL', 'REHEARSAL_DATABASE_URL'] as const;

/** The date the purge keeps from: read from the classification (scripts may not import from apps). */
export const KEEP_FROM: string = (CUTOVER_CLASSIFICATION.fiscal_periods as unknown as { keepFrom: string }).keepFrom;

/** Parent env minus every database URL, plus the guarded target under each database URL name. */
export function childEnv(parent: Env, target: string): Env {
  const env: Env = {};
  for (const [k, v] of Object.entries(parent)) {
    if (typeof v === 'string' && /^postgres(ql)?:\/\//i.test(v)) continue;
    env[k] = v;
  }
  for (const k of DB_URL_NAMES) env[k] = target;
  // Blank (not delete): dotenv in the child never overrides a variable that is already set, so a blank stops .env.local re-supplying it.
  for (const k of Object.keys(env)) if (EDGE_SECRET_RE.test(k)) env[k] = '';
  return env;
}

function guard(env: Env, confirmDatabase: string): { target: string } | ChildrenResult {
  const url = resolveTargetUrl(env);
  const g = checkTargetGuards({ url, confirmDatabase, env });
  if (!g.ok || !url) return { ok: false, code: 2, ran: 0, message: `REFUSED: ${g.refusals.join('; ')}` };
  return { target: url };
}
const refused = (g: { target: string } | ChildrenResult): g is ChildrenResult => !('target' in g);

async function runAll(calls: SpawnCall[], spawn: SpawnFn): Promise<ChildrenResult> {
  let ran = 0;
  for (const call of calls) {
    const { code } = await spawn(call);
    ran++;
    if (code !== 0) return { ok: false, code: 1, ran, message: `child exited ${code}` };
  }
  return { ok: true, code: 0, ran };
}

export async function runPurgeChildren(o: {
  env: Env;
  confirmDatabase: string;
  by: string;
  spawn: SpawnFn;
  liveness: LivenessFn;
  /** Where the purge child writes its report: the rehearsal dir, never the repo's docs/reviews (R10). */
  reportDir?: string;
}): Promise<ChildrenResult> {
  const g = guard(o.env, o.confirmDatabase);
  if (refused(g)) return g;
  const env = childEnv(o.env, g.target);
  if (o.reportDir) env.CUTOVER_PURGE_REPORT_DIR = o.reportDir;
  const base = ['--confirm-database', o.confirmDatabase, '--yes-really-not-local'];
  const mk = (extra: string[]): SpawnCall => ({ command: process.execPath, args: [tsxCli, 'scripts/cutover-purge.ts', ...base, ...extra], env });
  // Liveness (R3 e) is re-checked before EACH child: a session that connects between the dry run and the apply must stop the apply.
  let ran = 0;
  for (const call of [mk([]), mk(['--rehearse', '--as-of', KEEP_FROM]), mk(['--apply', '--as-of', KEEP_FROM, '--by', o.by])]) {
    const live = await o.liveness();
    if (!live.ok) return { ok: false, code: 2, ran, message: `REFUSED: ${live.message ?? 'another session is connected to the target'}` };
    const { code } = await o.spawn(call);
    ran++;
    if (code !== 0) return { ok: false, code: 1, ran, message: `child exited ${code}` };
  }
  return { ok: true, code: 0, ran };
}

export async function runMigrateChild(o: { env: Env; confirmDatabase: string; spawn: SpawnFn }): Promise<ChildrenResult> {
  const g = guard(o.env, o.confirmDatabase);
  if (refused(g)) return g;
  return runAll([{ command: 'npm', args: ['run', 'db:migrate'], env: childEnv(o.env, g.target) }], o.spawn);
}

export async function runPredumpChild(o: { env: Env; confirmDatabase: string; dir: string; spawn: SpawnFn }): Promise<ChildrenResult> {
  const g = guard(o.env, o.confirmDatabase);
  if (refused(g)) return g;
  return runAll([{ command: 'npm', args: ['run', 'db-backup', '--', `--store=fs:${o.dir}`], env: childEnv(o.env, g.target) }], o.spawn);
}

/** The real spawn: output goes to the operator's terminal; cwd is the repo root. */
export const realSpawn: SpawnFn = (call) =>
  new Promise((resolve, reject) => {
    const win = process.platform === 'win32' && call.command === 'npm';
    const quote = (a: string): string => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
    const child = nodeSpawn(call.command, win ? call.args.map(quote) : call.args, {
      cwd: repoRoot,
      env: call.env as NodeJS.ProcessEnv,
      stdio: 'inherit',
      shell: win,
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1 }));
  });
