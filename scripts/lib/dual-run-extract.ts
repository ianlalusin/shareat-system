/**
 * T-392 S4 - the dual run's two file-side halves: `extract` (Ian's machine: read v1, write the snapshot) and the snapshot
 * file rules the droplet applies before it trusts one (`loadSnapshotFile`, `removeSnapshotFile`). docs/tasks/392-dual-run-comparator.md
 * R2, R3, R7 and invariants 27-30.
 *
 * - v1 is only ever read: the client is `makeReadOnlyV1Client`'s, which exposes `collection(path).get()` and nothing else.
 *   v1 is read fresh for each extract, never through the landing table (a deleted v1 leg must stop counting).
 * - A document's store is taken from its PATH; a storeId field inside the document is not trusted.
 * - The snapshot is `buildSnapshot`'s whitelist. No key material is read here (the caller builds the client) and none is printed.
 * - Under NODE_ENV=production `runDualRunExtract` refuses before it reads or writes anything.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReadOnlyV1Client } from '../../packages/etl/src/master-data/snapshot';
import { buildSnapshot, type V1Snapshot } from '../../packages/etl/src/dual-run/snapshot';
import { normaliseBusinessDate } from '../../packages/etl/src/dual-run/week';
import { parseKeysCsv, prefillKeys, serialiseKeysCsv, type V2KeyCatalogue } from '../../packages/etl/src/dual-run/keys';

const EMPTY_CATALOGUE: V2KeyCatalogue = { stores: [], money: [], categories: [] };
const COLLECTIONS = ['journal', 'expenses', 'salesDays', 'suppliers', 'paymentAccounts', 'receipts'] as const;
const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

export interface DualRunExtractOptions {
  from: string;
  through: string;
  outDir: string;
  /** v1 store ids; omitted = every operating store. */
  stores?: string[];
  env: { NODE_ENV?: string; [k: string]: string | undefined };
  now?: Date;
  v2?: V2KeyCatalogue;
}

export interface DualRunExtractResult {
  snapshotPath: string;
  shaPath: string;
  keysPath: string;
  sha: string;
  snapshot: V1Snapshot;
  counts: { journal: number; expenses: number; salesDays: number };
  summary: string;
}

export async function runDualRunExtract(client: ReadOnlyV1Client, opts: DualRunExtractOptions): Promise<DualRunExtractResult> {
  if (opts.env.NODE_ENV === 'production') {
    throw new Error('extract refuses to run under NODE_ENV=production: production holds no v1 credentials (R3). Run it on the owner machine.');
  }
  const from = normaliseBusinessDate(opts.from);
  const through = normaliseBusinessDate(opts.through);
  if (!from) throw new Error(`--from ${JSON.stringify(opts.from)} is not a real calendar date (YYYY-MM-DD)`);
  if (!through) throw new Error(`--through ${JSON.stringify(opts.through)} is not a real calendar date (YYYY-MM-DD)`);
  if (through < from) throw new Error(`--through ${through} is before --from ${from}`);

  const roster = (await client.collection('stores').get()).docs.map((d) => ({ id: d.id, name: String(d.data().name ?? ''), salesChannels: d.data().salesChannels }));
  // buildSnapshot refuses a store it does not know and names the excluded ones; asking it about the roster alone tells us
  // which ids are operating, so an excluded store is never read. An operating store not asked for is not part of this extract.
  const operating = new Set(buildSnapshot({ stores: roster }, { from, through }).stores.map((s) => s.id));
  const asked = opts.stores ? new Set(opts.stores) : null;
  if (asked) {
    for (const id of asked) {
      if (!operating.has(id)) throw new Error(`--stores ${id}: not an operating v1 store`);
    }
  }
  const selected = roster.filter((s) => !operating.has(s.id) || asked === null || asked.has(s.id));
  const readIds = selected.filter((s) => operating.has(s.id)).map((s) => s.id);

  const raw: Record<string, unknown[]> = { stores: selected, journal: [], expenses: [], salesDays: [], suppliers: [], paymentAccounts: [], receipts: [] };
  for (const storeId of readIds) {
    for (const c of COLLECTIONS) {
      const docs = (await client.collection(`stores/${storeId}/${c}`).get()).docs;
      for (const d of docs) raw[c]!.push({ ...d.data(), id: d.id, storeId });
    }
  }

  const snapshot = buildSnapshot(raw, { from, through, extractedAt: (opts.now ?? new Date()).toISOString() });
  const counts = { journal: snapshot.journal.length, expenses: snapshot.expenses.length, salesDays: snapshot.salesDays.length };

  mkdirSync(opts.outDir, { recursive: true });
  const stem = `v1-dual-run-${from}-${through}`;
  const snapshotPath = join(opts.outDir, `${stem}.json`);
  const shaPath = join(opts.outDir, `${stem}.sha256`);
  const keysPath = join(opts.outDir, 'dual-run-keys.csv');
  const bytes = JSON.stringify(snapshot);
  const sha = sha256(bytes);
  writeFileSync(snapshotPath, bytes, { mode: 0o600 });
  writeFileSync(shaPath, `${sha}  ${stem}.json\n`, { mode: 0o600 });
  const existing = existsSync(keysPath) ? parseKeysCsv(readFileSync(keysPath, 'utf8')) : [];
  writeFileSync(keysPath, serialiseKeysCsv(prefillKeys({ snapshot, existing, v2: opts.v2 ?? EMPTY_CATALOGUE })), { mode: 0o600 });
  for (const p of [snapshotPath, shaPath, keysPath]) chmodSync(p, 0o600);

  const summary = [
    `Extracted ${snapshot.stores.length} stores: ${snapshot.stores.map((s) => s.name).join(', ') || '(none)'}`,
    `Excluded ${snapshot.excludedStores.length} (named, not read): ${snapshot.excludedStores.map((s) => `${s.name} - ${s.reason}`).join('; ') || '(none)'}`,
    `Window: ${from} to ${through} (documents kept ${snapshot.window.from} to ${snapshot.window.through})`,
    `Kept: journal ${counts.journal}, expenses ${counts.expenses}, salesDays ${counts.salesDays}`,
    `Snapshot sha256 ${sha}`,
    `Wrote ${snapshotPath}, ${shaPath}, ${keysPath}`,
  ].join('\n');
  return { snapshotPath, shaPath, keysPath, sha, snapshot, counts, summary };
}

export interface LoadSnapshotOptions {
  /** Injected stat is ALWAYS enforced; the default is POSIX only (Windows has no owner/mode to speak of). */
  stat?: (path: string) => { mode: number; uid: number };
  currentUid?: number;
}

export function loadSnapshotFile(path: string, opts: LoadSnapshotOptions = {}): { snapshot: V1Snapshot; sha: string } {
  const stat = opts.stat ?? (process.platform === 'win32' ? undefined : (p: string) => statSync(p));
  if (stat) {
    const st = stat(path);
    if ((st.mode & 0o077) !== 0) {
      throw new Error(`${path}: file mode ${(st.mode & 0o777).toString(8)} is wider than 600; chmod 600 it. Refused.`);
    }
    const uid = opts.currentUid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);
    if (uid !== undefined && st.uid !== uid) {
      throw new Error(`${path}: owner uid ${st.uid} is not the running user (${uid}). Refused.`);
    }
  }
  const shaPath = path.replace(/\.json$/, '.sha256');
  if (shaPath === path || !existsSync(shaPath)) throw new Error(`${shaPath} is missing: the snapshot cannot be verified (sha256). Refused.`);
  const expected = (readFileSync(shaPath, 'utf8').trim().split(/\s+/)[0] ?? '').toLowerCase();
  const bytes = readFileSync(path);
  const sha = sha256(bytes);
  if (sha !== expected) throw new Error(`The snapshot does not match its sha256 (expected ${expected}, found ${sha}). Refused.`);
  const snapshot = JSON.parse(bytes.toString('utf8')) as V1Snapshot;
  if (snapshot.version !== 1) throw new Error(`${path}: snapshot version ${String(snapshot.version)} is not supported (expected 1). Refused.`);
  return { snapshot, sha };
}

/** Deletes the snapshot after a successful --apply. The .sha256 stays (the sha is provenance on the report). */
export function removeSnapshotFile(path: string): void {
  unlinkSync(path);
}
