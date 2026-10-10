import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildS3ClientConfig, fsStore, spacesStore, type SpacesConfig } from '../../scripts/lib/backup/object-store';

/**
 * T-393 S1 - audit round (items 1, 5, 6, 7, 8). Written TESTER-FIRST against the audit's required behaviour.
 *
 * Seams the builder must provide (the SDK is not installed locally, so nothing here may need it):
 *  - `buildS3ClientConfig(cfg: SpacesConfig)`: pure; returns the object handed to `new S3Client(...)`.
 *  - `spacesStore(cfg, deps?)` where `deps = { s3?: { send(cmd) }, sdk?: { ListObjectsV2Command, DeleteObjectsCommand,
 *    HeadObjectCommand, GetObjectCommand } }`. When given, they replace the lazily loaded SDK (no network).
 *    A command is a class instance whose `.input` is the constructor argument.
 */

const cfg: SpacesConfig = {
  endpoint: 'https://sgp1.digitaloceanspaces.com',
  region: 'sgp1',
  bucket: 'shareat-pg-backups',
  key: 'DO00KEY',
  secret: 'secret-value',
};
const root = path.resolve(__dirname, '..', '..');
const dirs: string[] = [];
const fresh = (l: string) => {
  const d = mkdtempSync(path.join(tmpdir(), `t393a-${l}-`));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

class Cmd {
  constructor(public input: Record<string, unknown>) {}
}
class ListObjectsV2Command extends Cmd {}
class DeleteObjectsCommand extends Cmd {}
class HeadObjectCommand extends Cmd {}
class GetObjectCommand extends Cmd {}
const fakeSdk = { ListObjectsV2Command, DeleteObjectsCommand, HeadObjectCommand, GetObjectCommand };
function fakeS3(pages: Record<string, unknown>[]) {
  const sent: Cmd[] = [];
  let i = 0;
  const s3 = {
    send: async (c: Cmd) => {
      sent.push(c);
      return c instanceof ListObjectsV2Command ? pages[i++] : { Errors: [] };
    },
  };
  return { sent, s3 };
}
const spaces = (s3: unknown) =>
  (spacesStore as unknown as (c: SpacesConfig, d: unknown) => ReturnType<typeof spacesStore>)(cfg, { s3, sdk: fakeSdk });

describe('T-393 S1 audit 1 - S3 client config', () => {
  it('sets requestChecksumCalculation and responseChecksumValidation to WHEN_REQUIRED (DO Spaces rejects CRC32 trailers)', () => {
    const c = buildS3ClientConfig(cfg) as unknown as Record<string, unknown>;
    expect(c.requestChecksumCalculation).toBe('WHEN_REQUIRED');
    expect(c.responseChecksumValidation).toBe('WHEN_REQUIRED');
    expect(c.endpoint).toBe(cfg.endpoint);
    expect(c.region).toBe('sgp1');
    expect(c.forcePathStyle).toBe(false);
  });
});

describe('T-393 S1 audit 7 - list() never returns a partial listing', () => {
  it('paginates through every page (control)', async () => {
    const { s3 } = fakeS3([
      { Contents: [{ Key: 'postgres/a', Size: 1 }], IsTruncated: true, NextContinuationToken: 't1' },
      { Contents: [{ Key: 'postgres/b', Size: 2 }], IsTruncated: false },
    ]);
    expect((await spaces(s3).list('postgres/')).map((o) => o.key)).toEqual(['postgres/a', 'postgres/b']);
  });
  it('IsTruncated true with no NextContinuationToken THROWS (a partial list would make false orphans)', async () => {
    const { s3 } = fakeS3([
      { Contents: [{ Key: 'postgres/a', Size: 1 }], IsTruncated: true, NextContinuationToken: 't1' },
      { Contents: [{ Key: 'postgres/b', Size: 2 }], IsTruncated: true },
    ]);
    await expect(spaces(s3).list('postgres/')).rejects.toThrow(/truncat|continuation|token/i);
  });
});

describe('T-393 S1 audit 8 - ObjectStore.delete enforces the I5 shapes itself', () => {
  const good = 'postgres/daily/2024-01-01/shareat-20240101T000000Z';
  const bad = [
    'postgres/pinned/cutover-eve.dump',
    'postgres/drills/2024-01-01.json',
    'backups/site-frappe.tar.gz',
    'postgres/daily/2024-01-01/other-20240101T000000Z.dump',
    'postgres/daily/2024-01-01/shareat-20240101T000000Z.dump.partial',
    'postgres/daily/notes.txt',
  ];
  it('fsStore: refuses every key outside I5, deletes NOTHING from a mixed batch, accepts the three shapes', async () => {
    const store = fsStore(fresh('fs'));
    const f = path.join(fresh('src'), 'x');
    writeFileSync(f, 'x');
    for (const k of [`${good}.dump`, `${good}.manifest.json`, `${good}.roles.sql`, ...bad]) await store.put(k, f, {});
    for (const k of bad) await expect(store.delete([k]), k).rejects.toThrow();
    await expect(store.delete([`${good}.dump`, bad[0]!])).rejects.toThrow();
    expect(await store.head(`${good}.dump`)).not.toBeNull(); // the mixed batch removed nothing
    for (const k of bad) expect(await store.head(k), k).not.toBeNull();
    await store.delete([`${good}.dump`, `${good}.manifest.json`, `${good}.roles.sql`]);
    expect(await store.head(`${good}.dump`)).toBeNull();
  });
  it('spacesStore: refuses before any request is sent', async () => {
    const { s3, sent } = fakeS3([]);
    for (const k of bad) await expect(spaces(s3).delete([k]), k).rejects.toThrow();
    await expect(spaces(s3).delete([`${good}.dump`, bad[1]!])).rejects.toThrow();
    expect(sent.filter((c) => c instanceof DeleteObjectsCommand)).toHaveLength(0);
    await spaces(s3).delete([`${good}.dump`]);
    expect(sent.filter((c) => c instanceof DeleteObjectsCommand)).toHaveLength(1);
  });
});

describe('T-393 S1 audit 5 and 6 - db-backup entry point and unit', () => {
  const run = (args: string[], env: Record<string, string>) =>
    spawnSync('npx', ['tsx', 'scripts/db-backup.ts', ...args], {
      cwd: root,
      shell: true,
      encoding: 'utf8',
      timeout: 90_000,
      env: {
        ...process.env,
        SYSTEM_DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/none',
        BACKUP_HEARTBEAT_URL: 'http://127.0.0.1:9/hb',
        ...env,
      },
    });

  it('5. --now together with --production is refused before anything runs (no DB connection, nothing written)', () => {
    const store = fresh('store');
    const r = run(['--production', '--now=2026-10-10T20:30:00Z', `--store=fs:${store}`], {});
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/--now/);
    expect(r.stderr).toMatch(/--production/);
    expect(r.stderr).not.toMatch(/ECONNREFUSED|connect/i);
    expect(readdirSync(store)).toEqual([]);
  }, 60_000);

  it('6a. BACKUP_TMP_DIR is the directory used for the temp files (a missing one fails naming it)', () => {
    const missing = path.join(fresh('tmpbase'), 'no-such-t393-tmp');
    const r = run([`--store=fs:${fresh('store')}`], { BACKUP_TMP_DIR: missing });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('no-such-t393-tmp');
    expect(existsSync(missing)).toBe(false);
  }, 60_000);

  it('6b. the systemd unit sets BACKUP_TMP_DIR (the dump must not land on a small /tmp)', () => {
    const unit = readFileSync(path.join(root, 'docs', 'ops', 'shareat-db-backup.service'), 'utf8');
    expect(unit).toMatch(/^Environment=BACKUP_TMP_DIR=\S+/m);
  });
});
