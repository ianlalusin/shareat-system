/**
 * T-393 R4, R12 — the object store behind the backup: DO Spaces in production, a directory in tests.
 *
 * `@aws-sdk/*` is loaded lazily inside `spacesStore`, so the tests and the `--store=fs:` smoke never need it.
 * The prefix is a constant, never an env var (R12).
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { checkValueAgainstDocs, type ConfigExpectation } from '../config-contract';
import { DAILY_KEY_RE } from './retention';

export const BACKUP_PREFIX = 'postgres/';
export const BACKUP_BUCKET = 'shareat-pg-backups';
export const FRAPPE_BUCKET = 'shareat-erp-backups';
export const SPACES_ENDPOINT_DOCUMENTED = 'https://sgp1.digitaloceanspaces.com';

export interface ObjectStore {
  put(key: string, file: string, meta: Record<string, string>): Promise<void>;
  head(key: string): Promise<{ size: number; meta: Record<string, string> } | null>;
  list(prefix: string): Promise<{ key: string; size: number }[]>;
  get(key: string, toFile: string): Promise<void>;
  delete(keys: string[]): Promise<void>;
}

export interface SpacesConfig {
  endpoint: string;
  region: string;
  bucket: string;
  key: string;
  secret: string;
}

const CITE = ['docs/tasks/393-nightly-backup-and-restore.md R12', 'ADR-002 s1'];
const BUCKET_EXPECTATION: ConfigExpectation = {
  envVar: 'SPACES_BUCKET',
  allowedValues: [BACKUP_BUCKET],
  citations: CITE,
  consequence: 'A backup written to the wrong bucket is a backup nobody will find.',
};
const ENDPOINT_EXPECTATION: ConfigExpectation = {
  envVar: 'SPACES_ENDPOINT',
  allowedValues: [SPACES_ENDPOINT_DOCUMENTED],
  citations: CITE,
  consequence: 'The backup would go to an endpoint nobody documented.',
};
const REGION_EXPECTATION: ConfigExpectation = {
  envVar: 'SPACES_REGION',
  allowedValues: ['sgp1'],
  citations: CITE,
  consequence: 'The signing region must match the endpoint.',
};

/** R12 / I10. Pure. Throws on any violation, before any connection opens. */
export function resolveSpacesConfig(env: Record<string, string | undefined>): SpacesConfig {
  const need = (name: string): string => {
    const v = (env[name] ?? '').trim();
    if (v === '') throw new Error(`${name} is missing or empty (bible 15.9: no default for a credential)`);
    return v;
  };
  const key = need('SPACES_KEY');
  const secret = need('SPACES_SECRET');
  const bucket = need('SPACES_BUCKET');
  if (bucket === FRAPPE_BUCKET) {
    throw new Error(
      `SPACES_BUCKET is "${FRAPPE_BUCKET}", the Frappe archive. This key must never be able to write to or delete ` +
        'from it (bible row 64; ADR-002 "Do not delete them"). Use the dedicated bucket.',
    );
  }
  const endpoint = need('SPACES_ENDPOINT');
  const region = (env.SPACES_REGION ?? '').trim() || 'sgp1';
  for (const [value, exp] of [
    [bucket, BUCKET_EXPECTATION],
    [endpoint, ENDPOINT_EXPECTATION],
    [region, REGION_EXPECTATION],
  ] as const) {
    const r = checkValueAgainstDocs(value, exp);
    if (!r.ok) throw new Error(r.message);
  }
  return { endpoint, region, bucket, key, secret };
}

/** I5, enforced by the store itself: only the three shapes under postgres/daily/ can ever be deleted. */
function assertDeletable(keys: string[]): void {
  const bad = keys.filter((k) => !DAILY_KEY_RE.test(k));
  if (bad.length > 0) throw new Error(`refusing to delete ${bad.length} key(s) outside the I5 shapes, e.g. ${bad[0]}`);
}

// ---------------------------------------------------------------------------------------------- fsStore

/** Same key semantics as Spaces, over a directory. Metadata lives in a `.meta` sidecar tree outside any key space. */
export function fsStore(rootDir: string): ObjectStore {
  const META = '.meta';
  const dataPath = (key: string) => path.join(rootDir, ...key.split('/'));
  const metaPath = (key: string) => path.join(rootDir, META, ...key.split('/')) + '.json';
  const checkKey = (key: string) => {
    if (key === '' || key.startsWith('/') || key.split('/').includes('..') || key.startsWith(`${META}/`)) {
      throw new Error(`invalid object key: ${key}`);
    }
  };
  async function walk(dir: string, rel: string, out: { key: string; size: number }[]): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (rel === '' && e.name === META) continue;
      const r = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) await walk(path.join(dir, e.name), r, out);
      else out.push({ key: r, size: (await stat(path.join(dir, e.name))).size });
    }
  }
  return {
    async put(key, file, meta) {
      checkKey(key);
      await mkdir(path.dirname(dataPath(key)), { recursive: true });
      await copyFile(file, dataPath(key));
      await mkdir(path.dirname(metaPath(key)), { recursive: true });
      await writeFile(metaPath(key), JSON.stringify(meta));
    },
    async head(key) {
      checkKey(key);
      try {
        const st = await stat(dataPath(key));
        let meta: Record<string, string> = {};
        try {
          meta = JSON.parse(await readFile(metaPath(key), 'utf8')) as Record<string, string>;
        } catch {
          /* no metadata */
        }
        return { size: st.size, meta };
      } catch {
        return null;
      }
    },
    async list(prefix) {
      const all: { key: string; size: number }[] = [];
      await walk(rootDir, '', all);
      return all.filter((o) => o.key.startsWith(prefix)).sort((a, b) => a.key.localeCompare(b.key));
    },
    async get(key, toFile) {
      checkKey(key);
      await mkdir(path.dirname(toFile), { recursive: true });
      await copyFile(dataPath(key), toFile);
    },
    async delete(keys) {
      assertDeletable(keys);
      for (const key of keys) {
        checkKey(key);
        await rm(dataPath(key), { force: true });
        await rm(metaPath(key), { force: true });
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------- spacesStore

// A computed specifier keeps the type checker and bundlers from resolving the SDK when only the fs store is used.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const load = (name: string): Promise<any> => import(/* @vite-ignore */ name);

/** DO Spaces over `@aws-sdk/client-s3` + `@aws-sdk/lib-storage` (streamed multipart). Covered by the first production run. */
/** Pure: the object handed to `new S3Client(...)`. DO Spaces rejects the SDK's default CRC32 trailers, hence WHEN_REQUIRED. */
export function buildS3ClientConfig(cfg: SpacesConfig) {
  return {
    endpoint: cfg.endpoint,
    region: cfg.region,
    forcePathStyle: false,
    credentials: { accessKeyId: cfg.key, secretAccessKey: cfg.secret },
    requestChecksumCalculation: 'WHEN_REQUIRED' as const,
    responseChecksumValidation: 'WHEN_REQUIRED' as const,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function spacesStore(cfg: SpacesConfig, deps?: { s3?: any; sdk?: any }): ObjectStore {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cached: Promise<{ s3: any; sdk: any; lib: any }> | undefined;
  const client = () =>
    (cached ??= (async () => {
      if (deps?.s3 && deps?.sdk) return { s3: deps.s3, sdk: deps.sdk, lib: undefined };
      const [sdk, lib] = await Promise.all([load('@aws-sdk/client-s3'), load('@aws-sdk/lib-storage')]);
      const s3 = new sdk.S3Client(buildS3ClientConfig(cfg));
      return { s3, sdk, lib };
    })());
  return {
    async put(key, file, meta) {
      const { s3, lib } = await client();
      const up = new lib.Upload({
        client: s3,
        params: { Bucket: cfg.bucket, Key: key, Body: createReadStream(file), Metadata: meta },
      });
      await up.done();
    },
    async head(key) {
      const { s3, sdk } = await client();
      try {
        const r = await s3.send(new sdk.HeadObjectCommand({ Bucket: cfg.bucket, Key: key }));
        return { size: Number(r.ContentLength ?? 0), meta: (r.Metadata ?? {}) as Record<string, string> };
      } catch (e) {
        const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
        if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return null;
        throw e;
      }
    },
    async list(prefix) {
      const { s3, sdk } = await client();
      const out: { key: string; size: number }[] = [];
      let token: string | undefined;
      do {
        const r = await s3.send(new sdk.ListObjectsV2Command({ Bucket: cfg.bucket, Prefix: prefix, ContinuationToken: token }));
        for (const o of (r.Contents ?? []) as { Key: string; Size?: number }[]) out.push({ key: o.Key, size: Number(o.Size ?? 0) });
        token = r.IsTruncated ? (r.NextContinuationToken as string | undefined) : undefined;
        if (r.IsTruncated && !token) throw new Error('listing was truncated but returned no continuation token; refusing a partial listing');
      } while (token);
      return out;
    },
    async get(key, toFile) {
      const { s3, sdk } = await client();
      const r = await s3.send(new sdk.GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
      await mkdir(path.dirname(toFile), { recursive: true });
      await pipeline(r.Body, createWriteStream(toFile));
    },
    async delete(keys) {
      assertDeletable(keys);
      const { s3, sdk } = await client();
      for (let i = 0; i < keys.length; i += 1000) {
        const batch = keys.slice(i, i + 1000).map((Key) => ({ Key }));
        const r = await s3.send(new sdk.DeleteObjectsCommand({ Bucket: cfg.bucket, Delete: { Objects: batch, Quiet: true } }));
        if (r.Errors?.length) throw new Error(`delete failed for ${r.Errors.length} object(s)`);
      }
    },
  };
}
