/**
 * T-602 S6-1 - `listDayCloses` reads the v1 bridge audit marks only when they can matter: the store has a v1 link AND at least one listed Z falls on a date the
 * bridge covers. Otherwise the status line ignores them, so the query is skipped. MUTANT: restore the unconditional read -> the "no link" and "no closes" cases go red.
 */
import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);

vi.mock('@shareat/db', async (importOriginal) => {
  const real = await importOriginal<typeof import('@shareat/db')>();
  return { ...real, auditLogRepo: { ...real.auditLogRepo, listForStoreActions: vi.fn(real.auditLogRepo.listForStoreActions) } };
});

import { auditLogRepo } from '@shareat/db';
import { D1, DC, asOrg, clockAt, close, closeAll, manila, pinOf, sql, standardDay, world } from './_fixtures/t531-day-close';

afterAll(closeAll);
beforeEach(() => {
  vi.mocked(auditLogRepo.listForStoreActions).mockClear(); // braces: a returned function would be run by vitest as a teardown
});

const list = (w: Awaited<ReturnType<typeof world>>) => asOrg(w.orgId, (tx) => DC.listDayCloses(tx, w.counter, { storeId: w.storeId }, clockAt(manila(D1, '22:30'))));
const marksReads = () => vi.mocked(auditLogRepo.listForStoreActions).mock.calls.length;

describe('T-602 S6-1 - listDayCloses reads the bridge marks only when they can matter', () => {
  it('a linked store with a Z on a bridged date reads them once, and the Z is pending', async () => {
    const w = await world('live', D1);
    await standardDay(w, D1);
    await close(w, manila(D1, '22:30'), await pinOf(w, w.managerId));
    const out = await list(w);
    expect(out.closes.map((c: { v1Status: string }) => c.v1Status)).toEqual(['pending']);
    expect(marksReads()).toBe(1);
  });

  it('no Z yet: the marks are not read', async () => {
    const w = await world('live', D1);
    expect((await list(w)).closes).toEqual([]);
    expect(marksReads()).toBe(0);
  });

  it('no v1 link: the marks are not read and the Z is not_applicable', async () => {
    const w = await world('live', D1);
    await standardDay(w, D1);
    await close(w, manila(D1, '22:30'), await pinOf(w, w.managerId));
    await sql`delete from pos_terminal_links where store_id = ${w.storeId}`;
    await sql`delete from pos_v1_store_links where store_id = ${w.storeId}`;
    const out = await list(w);
    expect(out.closes.map((c: { v1Status: string }) => c.v1Status)).toEqual(['not_applicable']);
    expect(marksReads()).toBe(0);
  });
});
