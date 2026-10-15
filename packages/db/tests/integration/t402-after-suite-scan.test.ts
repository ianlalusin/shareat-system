import { config } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-402 Invariant 18 - the AFTER-SUITE SCAN. docs/tasks/402-activity-log.md R5, Invariant 18.
 * Run LAST in CI (after every other suite has written its audit rows): it reads ALL of `audit_log` and fails on
 *   - a scrypt hash (`scrypt$`) anywhere in a before/after VALUE,
 *   - a JWT (eyJ..<dot>..<dot>) in a value,
 *   - a 4-8 digit value under a key whose tokens include `pin`,
 *   - an unmasked 8+ digit value under an `account`+`number` key,
 *   - a value under a secret-named key (token, secret, session id, api key, password...) that is not '[REDACTED]'.
 * TESTER, not BUILDER. Red at HEAD for two separate reasons, both real:
 *   (1) the catalogue-driven writer does not redact: the LIVE-WRITE leg below appends a payload full of secrets through
 *       `auditLogRepo.append` and the full-table scan then finds them (fails with the offending rows, not an import error);
 *   (2) suites that still assert full supplier account numbers (t365) leave unmasked 8+ digit numbers in the table.
 * The scanner itself is proven on synthetic rows first (positive and negative controls), so a green scan means something.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { APP_ROLE, closeDb, transaction, type Tx } from '../../src';
import * as repo from '../../src/repo/audit-log';

const sql = postgres(url, { max: 3 });
afterAll(async () => {
  await sql.end({ timeout: 5 });
  await closeDb();
});

/** Local token splitter (kept independent of the builder's redact.ts so this guard cannot be weakened with it). */
const tokens = (key: string): string[] =>
  key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
const SECRET_TOKENS = new Set(['password', 'passcode', 'secret', 'token', 'otp', 'hash', 'salt', 'scrypt', 'cookie', 'authorization', 'jwt', 'pwd', 'passwd', 'apikey', 'cvv']);
const isSecretKey = (k: string) => {
  const t = tokens(k);
  if (t.some((x) => SECRET_TOKENS.has(x))) return true;
  // a BARE `session` is a token; a key that merely contains the word (soldInPackageSession, sessionStart) is not -- same rule as the writer (redact.ts).
  if (t.length === 1 && t[0] === 'session') return true;
  for (let i = 0; i + 1 < t.length; i++) {
    const pair = `${t[i]}+${t[i + 1]}`;
    if (['api+key', 'private+key', 'session+id', 'refresh+token', 'access+key', 'card+number'].includes(pair)) return true;
  }
  return false;
};
const hasToken = (k: string, tok: string) => tokens(k).includes(tok);
const isAccountNumberKey = (k: string) => {
  const t = tokens(k);
  return t.length >= 2 && t[t.length - 2] === 'account' && t[t.length - 1] === 'number';
};

interface Finding {
  rule: string;
  path: string;
}
function scanValue(v: unknown, path: string, key: string | null, out: Finding[]): void {
  if (v === null || v === undefined) return;
  if (Array.isArray(v)) {
    v.forEach((x, i) => scanValue(x, `${path}[${i}]`, key, out));
    return;
  }
  if (typeof v === 'object') {
    // an account-number key holding an array/object: its digits live in the children, under other keys
    if (key !== null && isAccountNumberKey(key) && /\d{8,}/.test(JSON.stringify(v))) out.push({ rule: 'unmasked account number inside a container', path });
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) scanValue(x, `${path}.${k}`, k, out);
    return;
  }
  const s = String(v);
  if (/scrypt\$/.test(s)) out.push({ rule: 'scrypt hash', path });
  if (/^Bearer /.test(s)) out.push({ rule: 'Bearer credential', path });
  if (/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./.test(s)) out.push({ rule: 'JWT', path });
  if (key !== null) {
    if (hasToken(key, 'pin') && /^\d{4,8}$/.test(s)) out.push({ rule: '4-8 digit value under a pin key', path });
    if (isAccountNumberKey(key) && /\d{8,}/.test(s)) out.push({ rule: 'unmasked account number', path });
    if (isSecretKey(key) && s !== '[REDACTED]') out.push({ rule: 'secret-named key not redacted', path });
  }
}
function scanRows(rows: Array<{ id: string; action: string; before: unknown; after: unknown }>): string[] {
  const bad: string[] = [];
  for (const r of rows) {
    const f: Finding[] = [];
    scanValue(r.before, 'before', null, f);
    scanValue(r.after, 'after', null, f);
    for (const x of f) bad.push(`${r.action} ${r.id}: ${x.rule} at ${x.path}`);
  }
  return bad;
}

describe('the scanner itself (so a green scan means something)', () => {
  const row = (after: unknown) => [{ id: 'r', action: 'x', before: null, after }];
  it('flags each forbidden shape (positive controls)', () => {
    expect(scanRows(row({ n: { h: 'scrypt$16384$8$1$aa$bb' } }))).toHaveLength(1);
    expect(scanRows(row({ memo: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig' }))).toHaveLength(1);
    expect(scanRows(row({ userPin: '123456' }))).toHaveLength(1);
    expect(scanRows(row({ pin: 1234 }))).toHaveLength(1);
    expect(scanRows(row({ bankAccountNumber: '1234567890123' }))).toHaveLength(1);
    expect(scanRows(row({ sessionId: 'abc' }))).toHaveLength(1);
    expect(scanRows(row({ list: [{ api_key: 'k' }] }))).toHaveLength(1);
    expect(scanRows(row({ bankAccountNumber: ['1234567890'] })).length, 'array under an account key').toBeGreaterThan(0);
    expect(scanRows(row({ accountNumber: { v: '1234567890' } })).length, 'object under an account key').toBeGreaterThan(0);
    expect(scanRows(row({ note: 'Bearer abc.def' }))).toHaveLength(1);
    expect(scanRows(row({ pwd: 'x' }))).toHaveLength(1);
    expect(scanRows(row({ cardNumber: '4111111111111111' })).length).toBeGreaterThan(0);
  });
  it('passes clean and masked payloads and the false-positive keys (negative controls)', () => {
    expect(scanRows(row({ pin: '[REDACTED]', bankAccountNumber: '••••0123', pinned: '1234', note: 'ok', staffCode: '123456', shipping: 12345678, passage: 'p', cardboard: 'c', bankAccountNumberList: ['••••0123'] }))).toEqual([]);
  });
});

describe('Invariant 18 - one scan of ALL of audit_log', () => {
  it('LIVE WRITE (mutant: raw PIN in `after`): a payload full of secrets through the real writer leaves none of them in the table', async () => {
    const code = `t402scan-${Date.now()}`;
    const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
    const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${org!.id}, ${code}, 'S') returning id`;
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${org!.id}, 'Actor') returning id`;
    const entityId = randomUUID();
    // scope comes from the catalogue once it exists; absent at HEAD, so import it dynamically and tolerate that
    const cat = (await import('../../src/audit/catalogue').catch(() => null)) as { catalogueEntry: (a: string) => { scope: string } | undefined } | null;
    const storeId = cat?.catalogueEntry('set_supplier_bank_account')?.scope === 'store' ? store!.id : null;
    await transaction(async (tx: Tx) => {
      await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
      await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
      await tx.execute(dsql`select set_config('app.org_id', ${org!.id}, true)`);
      await (repo as unknown as { append: (tx: Tx, o: string, i: Record<string, unknown>) => Promise<unknown> }).append(tx, org!.id, {
        actorPersonId: p!.id,
        action: 'set_supplier_bank_account',
        entity: 'suppliers', // the pre-S1b writer still wants it (ignored once the catalogue owns it), so HEAD reaches the real failure
        storeId,
        entityId,
        before: { bankAccountNumber: '1234567890123', pin: '123456' },
        after: {
          bankAccountNumber: '9876543210987',
          pinHash: 'scrypt$16384$8$1$aa$bb',
          token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln',
          sessionId: 'sess_0123456789abcdef',
          note: 'ok',
          accountNumber: ['1234567890'],
          cardNumber: '4111111111111111',
          memo: 'Bearer abc.def',
          nested: { bankAccountNumber: { v: '1234567890' } },
          note2: 'ok',
        },
        source: 'web',
      });
    });
    const mine = await sql<{ id: string; action: string; before: unknown; after: unknown }[]>`select id, action, before, after from audit_log where entity_id = ${entityId}`;
    expect(mine, 'the row was written').toHaveLength(1);
    expect(scanRows(mine)).toEqual([]);
  });

  it('every row in audit_log, every partition, is clean', async () => {
    const rows = await sql<{ id: string; action: string; before: unknown; after: unknown }[]>`select id, action, before, after from audit_log`;
    const bad = scanRows(rows);
    expect(bad.slice(0, 20), `${bad.length} offending value(s) in ${rows.length} rows`).toEqual([]);
  });
});
