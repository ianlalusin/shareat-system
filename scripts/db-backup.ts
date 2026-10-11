/**
 * `npm run db-backup` — T-393's nightly off-cluster dump (docs/tasks/393-nightly-backup-and-restore.md).
 *
 * Invoked by the host's systemd timer: docs/ops/shareat-db-backup.timer (04:30 Asia/Manila).
 * NOT armed by anything in this repo: Ian arms it, after creating the Spaces bucket and key (task Q1, bible row 306).
 *
 * Flags:
 *   --store=fs:<dir>   write to a directory instead of Spaces (local smoke; needs no Spaces env)
 *   --dry-run          with the Spaces store: list `postgres/` and write nothing, to prove the key
 *   --production       require BACKUP_HEARTBEAT_URL (the unit files pass this)
 *   --now=<ISO>        fake the clock (smoke: retention across a month boundary)
 *
 * The source is SYSTEM_DATABASE_URL (the RLS-bypassing role) on the DIRECT port. The exit code is load-bearing.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config } from 'dotenv';
import { httpHeartbeat } from './lib/backup/heartbeat';
import { BACKUP_PREFIX, fsStore, resolveSpacesConfig, spacesStore, type ObjectStore } from './lib/backup/object-store';
import { redact } from './lib/backup/pg-tools';
import { runBackup } from './lib/backup/run-backup';

config({ path: '.env.local' });

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main(): Promise<number> {
  if (flag('production') && arg('now') !== undefined) {
    throw new Error('--now cannot be combined with --production: a faked clock would write a production backup under the wrong date');
  }
  const storeArg = arg('store');
  let store: ObjectStore;
  if (storeArg?.startsWith('fs:')) {
    store = fsStore(path.resolve(storeArg.slice(3)));
  } else if (storeArg !== undefined && storeArg !== 'spaces') {
    throw new Error(`unknown --store=${storeArg} (use fs:<dir> or spaces)`);
  } else {
    store = spacesStore(resolveSpacesConfig(process.env)); // R12: checked before any connection opens
  }

  if (flag('dry-run')) {
    const objects = await store.list(BACKUP_PREFIX);
    console.log(`[db-backup] dry run: ${objects.length} object(s) under ${BACKUP_PREFIX}; nothing written`);
    for (const o of objects.slice(-20)) console.log(`  ${o.key} ${o.size}`);
    return 0;
  }

  const sourceUrl = process.env.SYSTEM_DATABASE_URL;
  if (!sourceUrl) throw new Error('SYSTEM_DATABASE_URL is not set');
  const heartbeatUrl = process.env.BACKUP_HEARTBEAT_URL;
  if (flag('production') && !heartbeatUrl) throw new Error('BACKUP_HEARTBEAT_URL is required with --production');

  const nowArg = arg('now');
  const fixed = nowArg ? new Date(nowArg) : undefined;
  if (fixed && Number.isNaN(fixed.getTime())) throw new Error(`--now=${nowArg} is not a date`);

  const tmpDir = await mkdtemp(path.join(process.env.BACKUP_TMP_DIR ?? tmpdir(), 'shareat-db-backup-'));
  try {
    const r = await runBackup({ store, sourceUrl, heartbeat: httpHeartbeat(heartbeatUrl), now: () => fixed ?? new Date(), tmpDir });
    console.log(`[db-backup] summary: ok ${r.dumpKey} ${r.size} bytes, dump ${r.dumpMs} ms, pruned ${r.pruned.length}`);
    return 0;
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(redact(`[db-backup] failed: ${e instanceof Error ? e.message : String(e)}`));
    process.exit(1);
  },
);
