/**
 * `npm run restore-drill` — T-393's weekly restore drill (docs/tasks/393-nightly-backup-and-restore.md R8-R10).
 *
 * Invoked by docs/ops/shareat-restore-drill.timer (Sunday 05:30 Asia/Manila). NOT armed by anything in this repo:
 * Ian arms it with the backup (docs/ops/README.md, "Switching backups on").
 *
 * Flags:
 *   --store=fs:<dir>   read dumps from a directory instead of Spaces (local smoke)
 *   --production       require DRILL_HEARTBEAT_URL (the unit file passes this)
 *
 * Env: RESTORE_DRILL_DATABASE_URL (the scratch target, name shareat_restore_drill, direct port, CREATEDB),
 * RESTORE_DRILL_MAINTENANCE_DB (default defaultdb), SYSTEM_DATABASE_URL (PARSED for its name only, never connected).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config } from 'dotenv';
import { httpHeartbeat } from './lib/backup/heartbeat';
import { fsStore, resolveSpacesConfig, spacesStore, type ObjectStore } from './lib/backup/object-store';
import { redact } from './lib/backup/pg-tools';
import { drillExitCode, runDrill } from './lib/backup/run-drill';

config({ path: '.env.local' });

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main(): Promise<number> {
  const storeArg = arg('store');
  let store: ObjectStore;
  if (storeArg?.startsWith('fs:')) {
    store = fsStore(path.resolve(storeArg.slice(3)));
  } else if (storeArg !== undefined && storeArg !== 'spaces') {
    throw new Error(`unknown --store=${storeArg} (use fs:<dir> or spaces)`);
  } else {
    store = spacesStore(resolveSpacesConfig(process.env));
  }

  const targetUrl = process.env.RESTORE_DRILL_DATABASE_URL;
  if (!targetUrl) throw new Error('RESTORE_DRILL_DATABASE_URL is not set');
  const sourceUrl = process.env.SYSTEM_DATABASE_URL;
  if (!sourceUrl) throw new Error('SYSTEM_DATABASE_URL is not set (it is parsed to refuse a target named like the source)');
  const heartbeatUrl = process.env.DRILL_HEARTBEAT_URL;
  if (flag('production') && !heartbeatUrl) throw new Error('DRILL_HEARTBEAT_URL is required with --production');

  const tmpDir = await mkdtemp(path.join(process.env.BACKUP_TMP_DIR ?? tmpdir(), 'shareat-restore-drill-'));
  try {
    const r = await runDrill({
      store,
      targetUrl,
      maintenanceDb: process.env.RESTORE_DRILL_MAINTENANCE_DB ?? 'defaultdb',
      sourceUrl,
      heartbeat: httpHeartbeat(heartbeatUrl),
      tmpDir,
    });
    console.log(
      `[restore-drill] summary: ${r.ok ? 'ok' : 'FAILED'} ${r.dumpKey ?? '-'} download ${r.durations.downloadMs} ms, restore ${r.durations.restoreMs} ms, check ${r.durations.checkMs} ms, ${r.mismatches.length} mismatch(es)`,
    );
    return drillExitCode(r);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(redact(`[restore-drill] failed: ${e instanceof Error ? e.message : String(e)}`));
    process.exit(1);
  },
);
