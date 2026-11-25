/**
 * T-640 - provider keys at rest. AES-256-GCM with a master key from the SERVER environment (`AI_KEYS_MASTER_KEY`), which is never in git
 * and never in the database. A stored key is one string, `v1.<iv>.<tag>.<ciphertext>` (base64 parts).
 *
 * The cipher is bound (as GCM "additional data") to the row it belongs to (organisation and provider): a ciphertext copied into another
 * organisation's row, or another provider's, fails to open instead of quietly working.
 *
 * Nothing here logs, and no error message ever contains the key or the ciphertext.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';

export class KeyCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyCryptoError';
  }
}

/** The master key: 32 bytes, given as 64 hex characters or as base64. Returns null when it is absent or not that shape. */
export function parseMasterKey(raw: string | undefined | null): Buffer | null {
  const t = (raw ?? '').trim();
  if (t === '') return null;
  let key: Buffer | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(t)) key = Buffer.from(t, 'hex');
  else if (/^[A-Za-z0-9+/]{43}=?$/.test(t)) {
    const b = Buffer.from(t, 'base64');
    if (b.length === 32) key = b;
  }
  // an all-zero key is a placeholder, not a secret: refused
  return key && !isAllZero(key) ? key : null;
}

function isAllZero(b: Buffer): boolean {
  return b.every((x) => x === 0);
}

const TAG_BYTES = 16;

/** What binds a ciphertext to its row. */
export function keyContext(orgId: string, provider: string): string {
  return `shareat-ai-key:${orgId}:${provider}`;
}

export function encryptSecret(plain: string, masterKey: Buffer, context: string): string {
  if (isAllZero(masterKey)) throw new KeyCryptoError('the server key is all zeros, which is not a key');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join('.');
}

export function decryptSecret(envelope: string, masterKey: Buffer, context: string): string {
  const [version, iv, tag, ct] = envelope.split('.');
  if (version !== VERSION || !iv || !tag || ct === undefined) throw new KeyCryptoError('the stored key is not in a readable form');
  try {
    const decipher = createDecipheriv('aes-256-gcm', masterKey, Buffer.from(iv, 'base64'), { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw new KeyCryptoError('the stored key could not be opened with the server key (wrong server key, or the stored value was changed)');
  }
}

/** The only part of a key that is ever shown back. */
export function lastFour(secret: string): string {
  return secret.slice(-4);
}
