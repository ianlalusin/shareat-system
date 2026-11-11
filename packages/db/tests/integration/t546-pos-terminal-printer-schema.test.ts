/**
 * T-546 R1 (migration 0246) - the printer settings live on the till (`pos_terminals`): paper width and copies. Tests written FIRST.
 * docs/tasks/546-pos-terminal-printer-settings.md R1, R5 "Migration and DB".
 *
 * Raw SQL against the DATABASE, so the schema is what is proven. Real Postgres via TEST_DATABASE_URL (any `_test` database). Owner statements go
 * through the admin connection (a refusal there is a CHECK); app-role statements go through `asApp` (shareat_app + an org principal, rolled back).
 */
import { afterAll, describe, expect, it } from 'vitest';

import { APP_ROLE } from '../../src/rls/registry';
import { asApp, menuFixture, refusal, sql, uid, type PgErr } from './_fixtures/t401-menu';

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

const code = (e: PgErr | undefined): string | undefined => e?.code ?? (e as { cause?: { code?: string } } | undefined)?.cause?.code;

async function world(hint: string) {
  const m = await menuFixture(`t546-${hint}`);
  const [p] = await sql<{ id: string }[]>`
    insert into pos_tablet_pairings (org_id, store_id, label, cookie_digest, paired_by)
    values (${m.orgId}, ${m.storeId}, ${uid('tablet')}, ${uid('digest')}, ${m.personId}) returning id`;
  const [t] = await sql<{ id: string }[]>`
    insert into pos_terminals (org_id, store_id, terminal_no, pairing_id, created_by) values (${m.orgId}, ${m.storeId}, 1, ${p!.id}, ${m.personId}) returning id`;
  return { ...m, pairingId: p!.id, terminalId: t!.id };
}
type W = Awaited<ReturnType<typeof world>>;
const insertTill = (w: W, no: number, extra: Record<string, number> = {}) =>
  sql`insert into pos_terminals (org_id, store_id, terminal_no, created_by, receipt_paper_mm, receipt_copies)
      values (${w.orgId}, ${w.storeId}, ${no}, ${w.personId}, ${extra.paper ?? 58}, ${extra.copies ?? 1})`;

describe('T-546 R1 pos_terminals printer columns (migration 0246)', () => {
  it('a till created without the columns reads 58 mm and 1 copy (the column defaults; existing rows got the same)', async () => {
    const w = await world('defaults');
    const [r] = await sql<{ receipt_paper_mm: number; receipt_copies: number }[]>`select receipt_paper_mm, receipt_copies from pos_terminals where id = ${w.terminalId}`;
    expect(r).toEqual({ receipt_paper_mm: 58, receipt_copies: 1 });
    const cols = await sql<{ column_name: string; is_nullable: string; column_default: string }[]>`
      select column_name, is_nullable, column_default from information_schema.columns
      where table_schema = 'public' and table_name = 'pos_terminals' and column_name in ('receipt_paper_mm', 'receipt_copies') order by column_name`;
    expect(cols.map((c) => [c.column_name, c.is_nullable, c.column_default])).toEqual([['receipt_copies', 'NO', '1'], ['receipt_paper_mm', 'NO', '58']]);
  });

  it('paper width: 58 and 80 pass; 70, 57 and 0 are refused by the CHECK (23514)', async () => {
    const w = await world('paper');
    expect(await refusal(() => insertTill(w, 2, { paper: 80 }))).toBeUndefined();
    for (const [i, bad] of [70, 57, 0].entries()) expect(code(await refusal(() => insertTill(w, 3 + i, { paper: bad }))), `paper ${bad}`).toBe('23514');
  });

  it('copies: 1, 2 and 3 pass; 0 and 4 are refused by the CHECK (23514)', async () => {
    const w = await world('copies');
    for (const [i, ok] of [2, 3].entries()) expect(await refusal(() => insertTill(w, 2 + i, { copies: ok })), `copies ${ok}`).toBeUndefined();
    for (const [i, bad] of [0, 4].entries()) expect(code(await refusal(() => insertTill(w, 10 + i, { copies: bad }))), `copies ${bad}`).toBe('23514');
  });

  it('an UPDATE to a bad value is refused by the CHECK too (the app role can reach it)', async () => {
    const w = await world('upd-check');
    const bad = await asApp(w.orgId, (tx) => tx`update pos_terminals set receipt_paper_mm = 70 where id = ${w.terminalId}`);
    expect(code(bad.err)).toBe('23514');
    const bad2 = await asApp(w.orgId, (tx) => tx`update pos_terminals set receipt_copies = 4 where id = ${w.terminalId}`);
    expect(code(bad2.err)).toBe('23514');
  });

  it('the grant: shareat_app may UPDATE the two printer columns', async () => {
    const w = await world('grant-ok');
    const r = await asApp(w.orgId, (tx) => tx`update pos_terminals set receipt_paper_mm = 80, receipt_copies = 2, updated_at = now() where id = ${w.terminalId} returning receipt_paper_mm, receipt_copies`);
    expect(r.err, r.err?.message).toBeUndefined();
    expect(r.value?.[0]).toEqual({ receipt_paper_mm: 80, receipt_copies: 2 });
  });

  it('the grant: shareat_app still may not UPDATE terminal_no (42501), and the exact UPDATE column list is pairing_id, updated_at and the two printer columns', async () => {
    const w = await world('grant-no');
    const bad = await asApp(w.orgId, (tx) => tx`update pos_terminals set terminal_no = 9 where id = ${w.terminalId}`);
    expect(code(bad.err)).toBe('42501');
    const cols = await sql<{ column_name: string }[]>`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'pos_terminals'`;
    const granted: string[] = [];
    for (const { column_name } of cols) {
      const [g] = await sql<{ ok: boolean }[]>`select has_column_privilege(${APP_ROLE}, 'public.pos_terminals', ${column_name}, 'UPDATE') ok`;
      if (g!.ok) granted.push(column_name);
    }
    expect(granted.sort()).toEqual(['pairing_id', 'receipt_copies', 'receipt_paper_mm', 'updated_at']);
  });
});
