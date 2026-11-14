import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - name must contain "_test".`);
}

import { variationParentOptions } from '../../src/app/items/lib';

/**
 * T-502 section 13 ruling A6 - the "Variation of" select never offers a service (a service is never a variation parent).
 * Run via it.mjs against the lane database.
 */
const sql = postgres(url, { max: 3 });
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe('T-502 A6 - variationParentOptions', () => {
  it('offers a top-level stocked item and omits a service item', async () => {
    const c = `t502s13-${Date.now().toString(36)}`;
    const [o] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${c}`}, ${c}) returning id`;
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${o!.id}, 'Admin') returning id`;
    const mk = async (code: string, name: string, kind: string) => {
      const [r] = await sql<{ id: string }[]>`
        insert into items (org_id, code, name, kind, base_unit, created_by) values (${o!.id}, ${code}, ${name}, ${kind}, ${kind === 'service' ? 'pcs' : 'kg'}, ${p!.id}) returning id`;
      return r!.id;
    };
    const stocked = await mk('T5S1-001', 'Charcoal', 'supply');
    const service = await mk('T5S2-001', 'Electricity', 'service');
    const ids = (await variationParentOptions(o!.id)).map((r) => r.id);
    expect(ids).toContain(stocked);
    expect(ids).not.toContain(service);
  });
});
