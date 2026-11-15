import { isTestDatabaseUrl } from '../../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/** T-581 R2 - getStoreIdByCode matches the store code in any letter case, per org; two codes of one org differing only by case => undefined. Real Postgres, `_test` guard. */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
vi.mock('server-only', () => ({}));
process.env.DATABASE_URL = url;

const sql = postgres(url, { max: 2 });
const tag = randomBytes(3).toString('hex').toUpperCase();
let orgA = '';
let orgB = '';
let lipaId = '';

const mkOrg = async (n: string) => (await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${n}`}, ${`t581-${n}-${tag}`}) returning id`)[0]!.id;
const mkStore = async (org: string, code: string) => (await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${org}, ${code}, 'S') returning id`)[0]!.id;
async function lookup(org: string, code: string) {
  const { lobbyRepo, withLobbyPrincipal } = await import('@shareat/db');
  return withLobbyPrincipal(org, (tx) => lobbyRepo.getStoreIdByCode(tx, org, code));
}

beforeAll(async () => {
  orgA = await mkOrg('A');
  orgB = await mkOrg('B');
  lipaId = await mkStore(orgA, `LIPA${tag}`);
  await mkStore(orgB, `OTHER${tag}`);
  await mkStore(orgA, `Dup${tag}`);
  await mkStore(orgA, `DUP${tag}`);
});
afterAll(async () => {
  try {
    await (await import('@shareat/db')).closeDb();
  } catch {
    /* ignore */
  }
  await sql.end({ timeout: 5 });
});

describe('getStoreIdByCode (T-581 R2)', () => {
  it('LIPA stored: lipa, Lipa and LIPA all resolve to the same store', async () => {
    for (const c of [`lipa${tag}`, `Lipa${tag}`, `LIPA${tag}`]) expect(await lookup(orgA, c), c).toBe(lipaId);
  });
  it("another org's code never resolves", async () => {
    expect(await lookup(orgB, `lipa${tag}`)).toBeUndefined();
    expect(await lookup(orgA, `other${tag}`)).toBeUndefined();
  });
  it('two codes of one org differing only by case => undefined (refuse, never pick one)', async () => {
    expect(await lookup(orgA, `dup${tag}`)).toBeUndefined();
    expect(await lookup(orgA, `DUP${tag}`)).toBeUndefined();
  });
});
