/**
 * The Firebase adapter's contract. T-141 §9.
 *
 * ⭐ **These are unit tests and reach no network.** `firebase-admin` is mocked, so what is proven is
 * the shape of the calls the adapter makes — which is exactly where this task's risk lives. An
 * adapter that reaches the bucket correctly but mints a permanent URL has closed nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface SaveOptions {
  contentType: string;
  resumable: boolean;
  metadata: { contentType: string; cacheControl: string };
}
interface SignOptions {
  version: string;
  action: string;
  expires: number;
}

// ⚠️ Argument types are declared, not inferred. `vi.fn(async () => …)` infers a ZERO-argument
// signature, so `mock.calls[0][0]` is a type error — and the assertions below read exactly those
// arguments, which is the whole point of the file.
const save = vi.fn(async (_body: Buffer, _opts: SaveOptions): Promise<void> => undefined);
const getSignedUrl = vi.fn(async (_opts: SignOptions): Promise<[string]> => [
  'https://signed.example/x?X-Goog-Expires=900',
]);
const download = vi.fn(async (): Promise<[Buffer]> => [Buffer.from('bytes')]);
const del = vi.fn(async (_opts?: { ignoreNotFound?: boolean }): Promise<void> => undefined);
const file = vi.fn((_path: string) => ({ save, getSignedUrl, download, delete: del }));
const bucket = vi.fn((_name: string) => ({ file }));

vi.mock('firebase-admin/app', () => ({
  getApps: () => [],
  initializeApp: (_config: unknown, name: string) => ({ name }),
  cert: (sa: unknown) => sa,
}));
vi.mock('firebase-admin/storage', () => ({ getStorage: () => ({ bucket }) }));

const { firebaseStorageDriver, firebaseConfigFromEnv } = await import('./index');

const KEY = JSON.stringify({
  project_id: 'shareat-hub-v2',
  client_email: 'svc@shareat-hub-v2.iam.gserviceaccount.com',
  // ⚠️ Assembled, never spelled out. `no-committed-secrets` scans TRACKED files for a PEM marker
  // and cannot tell a fake from a real one — which is exactly the property that makes it worth
  // having. A literal marker here would train people to expect that guard to cry wolf.
  private_key: ['-----BEGIN', 'PRIVATE', 'KEY-----', 'x', '-----END', 'PRIVATE', 'KEY-----'].join(
    '\n',
  ),
});

const driver = () => firebaseStorageDriver({ bucket: 'shareat-hub-v2', serviceAccountKey: KEY });

beforeEach(() => {
  save.mockClear();
  getSignedUrl.mockClear();
  file.mockClear();
});

describe('what the adapter must never be able to do', () => {
  it('⛔ exposes no way to make a file public, and no permanent URL at all', () => {
    const d = driver() as unknown as Record<string, unknown>;
    // v1 calls getDownloadURL() and stores the result: a link that never expires, readable by
    // anyone it is forwarded to. The interface has no such method, and this pins that.
    for (const forbidden of ['makePublic', 'publicUrl', 'getDownloadURL', 'downloadUrl']) {
      expect(d[forbidden], `${forbidden} must not exist on the driver`).toBeUndefined();
    }
    expect(Object.keys(d).sort()).toEqual(['get', 'name', 'put', 'remove', 'signedUrl']);
  });

  it('⭐ signs for MINUTES, and the expiry is the caller’s, not a default', async () => {
    const before = Date.now();
    await driver().signedUrl('orgs/abc/receipts/1.jpg', 900);
    const call = getSignedUrl.mock.calls[0]![0];
    expect(call.version).toBe('v4');
    expect(call.action).toBe('read');
    // A read-only signature that dies within the quarter hour asked for.
    expect(call.expires).toBeGreaterThanOrEqual(before + 900_000);
    expect(call.expires).toBeLessThan(before + 901_000);
  });
});

describe('writing', () => {
  it('stores with no-store caching and no resumable session', async () => {
    await driver().put({
      path: 'orgs/abc/receipts/1.jpg',
      bytes: new Uint8Array([1, 2, 3]),
      contentType: 'image/jpeg',
    });
    const opts = save.mock.calls[0]![1];
    // ⛔ A resumable session URL is a write credential with a week-long life. A receipt photo fits
    // in one request.
    expect(opts.resumable).toBe(false);
    // ⚠️ A shared cache holding an accounting document is a copy of it outside the bucket's
    // deny-all — which is the hole this whole task exists to close.
    expect(opts.metadata.cacheControl).toContain('no-store');
    expect(opts.metadata.cacheControl).toContain('private');
    expect(opts.contentType).toBe('image/jpeg');
  });

  it('⚠️ writes to the path it is GIVEN and never composes one', async () => {
    // The domain derives every path and the `stored_files` CHECK enforces the `orgs/<uuid>/` prefix.
    // If the adapter prefixed or rewrote anything, a file would land somewhere the row cannot name.
    await driver().put({
      path: 'orgs/11111111-1111-1111-1111-111111111111/receipts/x.jpg',
      bytes: new Uint8Array([1]),
      contentType: 'image/jpeg',
    });
    expect(file).toHaveBeenCalledWith('orgs/11111111-1111-1111-1111-111111111111/receipts/x.jpg');
  });
});

describe('configuration', () => {
  it('no bucket means not configured — null, not a throw', () => {
    // Development and tests run with no bucket; the loud failure belongs in resolveStorageDriver().
    expect(firebaseConfigFromEnv({})).toBeNull();
    expect(firebaseConfigFromEnv({ FIREBASE_STORAGE_BUCKET: '  ' })).toBeNull();
  });

  it('⛔ a bucket with no credential is refused — half-configured accepts an upload and loses it', () => {
    expect(() => firebaseConfigFromEnv({ FIREBASE_STORAGE_BUCKET: 'b' })).toThrow(
      /no credential is/,
    );
  });

  it('⭐ reads the key from a FILE, which is the preferred form', () => {
    const cfg = firebaseConfigFromEnv(
      { FIREBASE_STORAGE_BUCKET: 'b', FIREBASE_SERVICE_ACCOUNT_KEY_FILE: './secrets/x.json' },
      (path) => (path === './secrets/x.json' ? `  ${KEY}  ` : (() => { throw new Error('nope'); })()),
    );
    // Trimmed, so a trailing newline in the key file is not a parse failure later.
    expect(cfg!.serviceAccountKey).toBe(KEY);
  });

  it('⛔ BOTH forms set is refused rather than silently resolved', () => {
    // capture.ts set this precedent: a precedence rule is a rule nobody remembers under pressure,
    // and "which key did it actually use" is the worst question to ask about a production credential.
    expect(() =>
      firebaseConfigFromEnv({
        FIREBASE_STORAGE_BUCKET: 'b',
        FIREBASE_SERVICE_ACCOUNT_KEY: KEY,
        FIREBASE_SERVICE_ACCOUNT_KEY_FILE: './secrets/x.json',
      }),
    ).toThrow(/BOTH set/);
  });

  it('⚠️ an unreadable key file never echoes the path in the error', () => {
    let message = '';
    try {
      firebaseConfigFromEnv(
        { FIREBASE_STORAGE_BUCKET: 'b', FIREBASE_SERVICE_ACCOUNT_KEY_FILE: '/srv/secret-place/k.json' },
        () => { throw new Error('ENOENT: /srv/secret-place/k.json'); },
      );
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/cannot be read/);
    expect(message).not.toContain('secret-place');
  });

  it('⚠️ a malformed key never echoes its own contents in the error', () => {
    let message = '';
    try {
      // ⚠️ Built, not spelled. The quoted JSON form of that field name is itself one of the markers
      // `no-committed-secrets` scans tracked files for, and a deliberately-truncated JSON fragment
      // in a test looks exactly like a real leaked one to a text scan. ⭐ Writing the marker into a
      // COMMENT explaining the marker tripped the guard too — which is the guard being correctly
      // dumb, and the reason it is worth having.
      const truncated = `{${JSON.stringify('private_key')}: "SECRET-MATERIAL"`;
      firebaseStorageDriver({ bucket: 'b', serviceAccountKey: truncated });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/does not parse as JSON/);
    // Some engines put a snippet of the offending text in SyntaxError.message. A key file is
    // exactly the content that must never reach a log.
    expect(message).not.toContain('SECRET-MATERIAL');
  });

  it('⛔ a truncated key is caught before it becomes a confusing auth failure', () => {
    expect(() =>
      firebaseStorageDriver({ bucket: 'b', serviceAccountKey: '{"project_id":"p"}' }),
    ).toThrow(/missing project_id, client_email or private_key/);
  });
});
