/**
 * T-393 R1, R13, I9, I12 — the Postgres client tools, and the one place a secret is kept out of argv and logs.
 *
 * - `buildPgArgs` is pure: the connection string that reaches argv has its password STRIPPED; the password
 *   travels in the child's `PGPASSWORD` env (argv is visible in `ps`).
 * - `redact` learns the Spaces secret/key and the heartbeat URLs from the ENVIRONMENT only (it takes a bare string).
 */
import { spawn } from 'node:child_process';
import path from 'node:path';

export type PgTool = 'pg_dump' | 'pg_restore' | 'pg_dumpall';

/** `PG_BIN_DIR` if set (the droplet pins `/usr/lib/postgresql/18/bin`), else the name on PATH. */
export function resolvePgBin(name: PgTool): string {
  const dir = process.env.PG_BIN_DIR;
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  return dir ? path.join(dir, exe) : exe;
}

export const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';

/**
 * Pure. Returns argv for `pg_dump` / `pg_restore` / `pg_dumpall` (all three accept `--dbname=<conninfo>`) and
 * the env that carries the password. The caller's `extra` flags follow, untouched; put any positional file LAST.
 */
export function buildPgArgs(url: string, extra: string[]): { argv: string[]; env: Record<string, string> } {
  const u = new URL(url);
  const env: Record<string, string> = {};
  if (u.password !== '') env.PGPASSWORD = decodeURIComponent(u.password);
  u.password = '';
  return { argv: [`--dbname=${u.toString()}`, ...extra], env };
}

/** R1: DO's pooler (25061) cannot hold the session a snapshot export needs. Refused before any connection. */
export function assertDirectPort(url: string): void {
  const port = new URL(url).port;
  if (port === '25061') {
    throw new Error('the source URL is on port 25061 (the connection pooler); a snapshot export needs the direct port (25060)');
  }
}

/** Throws unless the client tool's major version is >= the server's major (pg_dump refuses a newer server). */
export async function assertClientMatchesServer(bin: string, serverVersionNum: number): Promise<void> {
  const r = await runTool(bin, ['--version'], {});
  const m = /(\d+)(?:\.\d+)?/.exec(r.stdout);
  if (r.code !== 0 || !m) {
    throw new Error(`${path.basename(bin)} is not usable (exit ${String(r.code)}); set PG_BIN_DIR to the PostgreSQL client bin directory`);
  }
  const client = Number(m[1]);
  const server = Math.floor(serverVersionNum / 10000);
  if (client < server) {
    throw new Error(`${path.basename(bin)} is version ${client} but the server is ${server}; install postgresql-client-${server} and set PG_BIN_DIR`);
  }
}

const SECRET_ENV = ['SPACES_SECRET', 'SPACES_KEY', 'BACKUP_HEARTBEAT_URL', 'DRILL_HEARTBEAT_URL'] as const;

function replaceAll(s: string, needle: string, to: string): string {
  return needle.length < 4 ? s : s.split(needle).join(to);
}

/** R13. Removes connection-string passwords, PGPASSWORD assignments, and the secrets named in the environment. */
export function redact(s: string, extraSecrets: readonly string[] = []): string {
  let out = s;
  // scheme://user:password@host — the password may be percent-encoded; it never contains a raw '@' or whitespace.
  out = out.replace(/([a-z][a-z0-9+.-]*:\/\/[^:@\s/]*):[^@\s]*@/gi, '$1:***@');
  out = out.replace(/(PGPASSWORD\s*=\s*)\S+/gi, '$1***');
  const secrets = [...extraSecrets];
  for (const k of SECRET_ENV) {
    const v = process.env[k];
    if (v) secrets.push(v);
  }
  // Longest first, so a URL goes before any fragment of itself.
  for (const v of secrets.sort((a, b) => b.length - a.length)) {
    out = replaceAll(out, v, '***');
    try {
      out = replaceAll(out, encodeURIComponent(v), '***');
    } catch {
      /* not encodable: nothing more to do */
    }
  }
  return out;
}

/** The secrets embedded in a connection string (decoded and encoded forms), to feed `redact`. */
export function secretsOf(url: string): string[] {
  try {
    const raw = new URL(url).password;
    if (!raw) return [];
    return [raw, decodeURIComponent(raw)];
  } catch {
    return [];
  }
}

export interface ToolResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a client tool with `env` layered over the parent's. Output is capped; the caller redacts before logging. */
export function runTool(bin: string, argv: string[], env: Record<string, string>): Promise<ToolResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, argv, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const CAP = 4 * 1024 * 1024;
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => {
      if (stdout.length < CAP) stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c: Buffer) => {
      if (stderr.length < CAP) stderr += c.toString('utf8');
    });
    child.on('error', (e) => reject(new Error(`could not start ${path.basename(bin)}: ${e.message}`)));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
