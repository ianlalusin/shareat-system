/**
 * T-625 - the pure parts of the move to the `shareat-system` Firebase project (docs/tasks/625-own-firebase-project.md).
 * No network, no database, no process.env in here: the four scripts next to this file wire these to the real thing, and
 * tests/unit/t625-firebase-move.test.ts proves each rule with fakes.
 *
 * Nothing here can delete anything: the bucket ports have a `stat` and a `copyObject`, and no delete.
 * Nothing here prints an email, a uid, a key or an object name: only counts (and row ids of files that are not private-guarded).
 */
import { scriptArg } from '../lib/args';

export const NEW_PROJECT_ID = 'shareat-system';
/** Purposes read through a guarded rule (audit A2): never listed by id, only counted. Same set backfill-file-links guards. */
export const GUARDED_PURPOSES: readonly string[] = ['staff_photo', 'staff_signature', 'leave_document'];

export class MoveArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoveArgError';
  }
}

/** A Google call failed; the message is fixed text plus a status number, never anything Google sent (it can carry credential fragments). */
export class GoogleCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoogleCallError';
  }
}

/** The only error text a script may print: our own fixed messages. Anything else (a driver or Google error) is hidden. */
export const safeMessage = (e: unknown): string =>
  e instanceof MoveArgError || e instanceof GoogleCallError ? e.message : 'unexpected error (details not shown).';

/** `--dry-run` is the default; `--confirm` is the only way to act. Both together is a typo worth refusing. */
export function parseMode(argv: readonly string[]): { confirm: boolean } {
  const confirm = argv.includes('--confirm');
  if (confirm && argv.includes('--dry-run')) throw new MoveArgError('Use --dry-run OR --confirm, not both.');
  return { confirm };
}

export function requiredArg(name: string, argv: readonly string[]): string {
  const v = scriptArg(name, argv);
  if (v === undefined) throw new MoveArgError(`--${name}=<value> is required.`);
  return v;
}

// ---------------------------------------------------------------- uid list

/** One uid per line. Blank lines and `#` comments are ignored; duplicates collapse; a line with spaces is refused (a pasted sentence is not a uid). */
export function parseUidList(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (/\s/.test(line)) throw new MoveArgError('A line in the uid file has a space in it. One uid per line, nothing else.');
    out.add(line);
  }
  return [...out];
}

export interface AuthExport {
  users: Array<{ localId: string } & Record<string, unknown>>;
}

/** Keeps exactly the users whose `localId` is listed. `missing` = listed uids that are not in the export (an account the old project no longer has). */
export function filterAuthExport(
  exp: AuthExport,
  uids: readonly string[],
): { filtered: AuthExport; kept: number; missing: number; extraDropped: number } {
  const wanted = new Set(uids);
  const filtered = { ...exp, users: exp.users.filter((u) => wanted.has(u.localId)) };
  const present = new Set(filtered.users.map((u) => u.localId));
  let missing = 0;
  for (const u of wanted) if (!present.has(u)) missing++;
  return { filtered, kept: filtered.users.length, missing, extraDropped: exp.users.length - filtered.users.length };
}

export function parseAuthExport(text: string): AuthExport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new MoveArgError('The export file is not valid JSON.');
  }
  const users = (parsed as { users?: unknown }).users;
  if (!Array.isArray(users) || !users.every((u) => typeof (u as { localId?: unknown })?.localId === 'string')) {
    throw new MoveArgError('The export file has no "users" list with a localId on every user. Was it made with `firebase auth:export`?');
  }
  return parsed as AuthExport;
}

// ---------------------------------------------------------------- file copy

/** `md5` is the base64 hash Google reports; '' means "Google did not report one", which never counts as equal. */
export interface ObjMeta {
  md5: string;
  size: number;
}
export type CopyDecision = 'copy' | 'skip' | 'missing-source';

export function decideCopy(src: ObjMeta | null, dst: ObjMeta | null): CopyDecision {
  if (src === null) return 'missing-source';
  if (dst === null) return 'copy';
  const same = src.md5 !== '' && src.md5 === dst.md5 && src.size === dst.size;
  return same ? 'skip' : 'copy';
}

export interface FileItem {
  id: string;
  path: string;
  purpose: string;
  byteSize: number;
}

export interface CopyPorts {
  statSrc(path: string): Promise<ObjMeta | null>;
  statDst(path: string): Promise<ObjMeta | null>;
  /** Streams one object old -> new. There is deliberately no delete on either side. */
  copyObject(path: string): Promise<void>;
}

export interface CopyReport {
  total: number;
  copied: number;
  wouldCopy: number;
  skipped: number;
  missingSource: number;
  failed: number;
  /** Row ids of problem files that are not purpose-guarded. Guarded ones are only counted. */
  problemIds: string[];
}

export async function runCopy(files: readonly FileItem[], ports: CopyPorts, confirm: boolean): Promise<CopyReport> {
  const r: CopyReport = { total: files.length, copied: 0, wouldCopy: 0, skipped: 0, missingSource: 0, failed: 0, problemIds: [] };
  const problem = (f: FileItem): void => {
    if (!GUARDED_PURPOSES.includes(f.purpose)) r.problemIds.push(f.id);
  };
  for (const f of files) {
    const src = await ports.statSrc(f.path);
    const decision = decideCopy(src, await ports.statDst(f.path));
    if (decision === 'missing-source') {
      r.missingSource++;
      problem(f);
    } else if (decision === 'skip') {
      r.skipped++;
    } else if (!confirm) {
      r.wouldCopy++;
    } else {
      try {
        await ports.copyObject(f.path);
        // Verify what landed, not what we asked for: the new object must now match the old one.
        if (decideCopy(src, await ports.statDst(f.path)) === 'skip') r.copied++;
        else {
          r.failed++;
          problem(f);
        }
      } catch {
        r.failed++; // never echo the error: a Google auth failure can carry credential fragments
        problem(f);
      }
    }
  }
  return r;
}

// ---------------------------------------------------------------- verify

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** null = fine. A file the new bucket holds at a different size than Postgres recorded is as bad as a missing one. */
export function fileGap(f: FileItem, meta: ObjMeta | null): 'missing' | 'size' | null {
  if (meta === null) return 'missing';
  return meta.size === f.byteSize ? null : 'size';
}

export interface VerifyReport {
  uidsChecked: number;
  uidsMissing: number;
  filesChecked: number;
  filesMissing: number;
  filesWrongSize: number;
  ok: boolean;
}

/** Zero credentials checked is a failure, never a pass: an empty list means the database read went wrong. Zero stored files is allowed (a shop can hold none; the runbook has Ian count first). */
export function summariseVerify(v: Omit<VerifyReport, 'ok'>): VerifyReport {
  const ok = v.uidsChecked > 0 && v.uidsMissing === 0 && v.filesMissing === 0 && v.filesWrongSize === 0;
  return { ...v, ok };
}

// ---------------------------------------------------------------- mirror re-seed

/** The relay drains this many outbox rows per org per run (packages/domain/src/scheduler/index.ts, `limit ?? 500`). */
export const RELAY_ROWS_PER_RUN = 500;

/** How many relay runs empty the queue: the busiest org decides, since each org is drained separately. */
export function relayRunsNeeded(pendingPerOrg: readonly number[], perRun: number = RELAY_ROWS_PER_RUN): number {
  return Math.ceil(Math.max(0, ...pendingPerOrg) / perRun);
}
