import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * T-565 (audit MC-002) - migration 0251, menu_daypart_versions: append-only, one open version per daypart, RLS, same-store keys and the backfill.
 * docs/tasks/565-daypart-versions.md s2, s3. Real PostgreSQL on a "_test" database; the owner connection sees the trigger, shareat_app sees the grants.
 */
import { asApp, menuFixture, refusal, sql } from './_fixtures/t401-menu';

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

const ALL = '{0,1,2,3,4,5,6}';
/** A daypart row WITHOUT a version (as migration 0233 left every daypart before 0251). */
const rawDaypart = async (f: { orgId: string; storeId: string; personId: string }, name: string, o: { status?: string; start?: string; end?: string } = {}) =>
  (
    await sql<{ id: string }[]>`
      insert into menu_dayparts (org_id, store_id, name, days, start_time, end_time, status, created_by, created_at)
      values (${f.orgId}, ${f.storeId}, ${name}, ${ALL}::smallint[], ${o.start ?? '08:00'}::time, ${o.end ?? '17:00'}::time, ${o.status ?? 'active'}, ${f.personId}, now() - interval '3 days')
      returning id`
  )[0]!.id;
const version = (f: { orgId: string; storeId: string }, daypartId: string, o: { open?: boolean } = {}) =>
  sql<{ id: string }[]>`
    insert into menu_daypart_versions (org_id, store_id, daypart_id, name, days, start_time, end_time, status, valid_from, valid_to)
    values (${f.orgId}, ${f.storeId}, ${daypartId}, 'V', ${ALL}::smallint[], '08:00', '17:00', 'active', now() - interval '1 day', ${o.open === false ? sql`now() - interval '1 hour'` : null})
    returning id`;

describe('menu_daypart_versions (0251)', () => {
  it('append-only: a window edit, a second close and a DELETE are refused; closing once from NULL is the only change', async () => {
    const f = await menuFixture('t565-append');
    const dp = await rawDaypart(f, 'Lunch');
    const [v] = await version(f, dp);
    const upd = await refusal(() => sql`update menu_daypart_versions set start_time = '09:00' where id = ${v!.id}`);
    expect(upd?.code).toBe('23001');
    expect(await refusal(() => sql`update menu_daypart_versions set valid_to = now() where id = ${v!.id}`)).toBeUndefined();
    expect((await refusal(() => sql`update menu_daypart_versions set valid_to = now() + interval '1 day' where id = ${v!.id}`))?.code).toBe('23001');
    expect((await refusal(() => sql`update menu_daypart_versions set valid_to = null where id = ${v!.id}`))?.code).toBe('23001');
    expect((await refusal(() => sql`delete from menu_daypart_versions where id = ${v!.id}`))?.code).toBe('23001');
  });

  it('the application role can neither delete a version nor edit a column other than valid_to', async () => {
    const f = await menuFixture('t565-grants');
    const dp = await rawDaypart(f, 'Lunch');
    const [v] = await version(f, dp);
    const del = await asApp(f.orgId, (tx) => tx`delete from menu_daypart_versions where id = ${v!.id}`);
    expect(del.err?.code).toBe('42501');
    const edit = await asApp(f.orgId, (tx) => tx`update menu_daypart_versions set name = 'X' where id = ${v!.id}`);
    expect(edit.err?.code).toBe('42501');
    const close = await asApp(f.orgId, (tx) => tx`update menu_daypart_versions set valid_to = now() where id = ${v!.id}`);
    expect(close.err).toBeUndefined();
  });

  it('two open versions of one daypart are refused; a closed one beside an open one is fine', async () => {
    const f = await menuFixture('t565-open');
    const dp = await rawDaypart(f, 'Lunch');
    await version(f, dp, { open: false });
    await version(f, dp);
    const second = await refusal(() => version(f, dp));
    expect(second?.code).toBe('23505');
  });

  it('a version of a daypart at another store, or with valid_to before valid_from, is refused', async () => {
    const f = await menuFixture('t565-keys');
    const dp = await rawDaypart(f, 'Lunch');
    const wrongStore = await refusal(
      () => sql`insert into menu_daypart_versions (org_id, store_id, daypart_id, name, days, start_time, end_time, status, valid_from)
                values (${f.orgId}, ${f.store2Id}, ${dp}, 'V', ${ALL}::smallint[], '08:00', '17:00', 'active', now())`,
    );
    expect(wrongStore?.code).toBe('23503');
    const backwards = await refusal(
      () => sql`insert into menu_daypart_versions (org_id, store_id, daypart_id, name, days, start_time, end_time, status, valid_from, valid_to)
                values (${f.orgId}, ${f.storeId}, ${dp}, 'V', ${ALL}::smallint[], '08:00', '17:00', 'active', now(), now() - interval '1 hour')`,
    );
    expect(backwards?.code).toBe('23514');
  });

  it('isolation: org B cannot read or write org A\'s versions', async () => {
    const a = await menuFixture('t565-iso-a');
    const b = await menuFixture('t565-iso-b');
    const dp = await rawDaypart(a, 'Lunch');
    const [v] = await version(a, dp);
    const seen = await asApp(b.orgId, (tx) => tx`select id from menu_daypart_versions where id = ${v!.id}`);
    expect(seen.value).toHaveLength(0);
    const own = await asApp(a.orgId, (tx) => tx`select id from menu_daypart_versions where id = ${v!.id}`);
    expect(own.value).toHaveLength(1);
    const write = await asApp(
      b.orgId,
      (tx) => tx`insert into menu_daypart_versions (org_id, store_id, daypart_id, name, days, start_time, end_time, status, valid_from)
                 values (${a.orgId}, ${a.storeId}, ${dp}, 'V', ${ALL}::smallint[], '08:00', '17:00', 'active', now())`,
    );
    expect(write.err?.code).toBe('42501');
    const close = await asApp(b.orgId, (tx) => tx`update menu_daypart_versions set valid_to = now() where id = ${v!.id} returning id`);
    expect(close.value ?? []).toHaveLength(0);
  });

  it('a session line may name only a version of its own store (composite key), and may name none', async () => {
    const rows = await sql<{ def: string }[]>`
      select pg_get_constraintdef(oid) def from pg_constraint
       where conrelid = 'table_session_lines'::regclass and conname = 'table_session_lines_daypart_version_same_store_fk'`;
    expect(rows[0]?.def).toMatch(/FOREIGN KEY \(store_id, daypart_version_id\) REFERENCES menu_daypart_versions\(store_id, id\)/);
    const col = await sql<{ is_nullable: string }[]>`
      select is_nullable from information_schema.columns where table_name = 'table_session_lines' and column_name = 'daypart_version_id'`;
    expect(col[0]?.is_nullable).toBe('YES');
  });
});

describe('0251 backfill', () => {
  /** The statements between the B0251 markers: what the migration runs over the dayparts that exist when it is applied. */
  const block = (() => {
    const text = readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'migrations', '0251_t565_daypart_versions.sql'), 'utf8');
    const begin = text.indexOf('-- B0251:begin');
    const end = text.indexOf('-- B0251:end');
    if (begin < 0 || end < begin) throw new Error('B0251 block not found in migration 0251');
    return text.slice(begin, end).split(/-->\s*statement-breakpoint/).map((x) => x.trim()).filter((x) => x.length > 0);
  })();

  it('every existing daypart gets exactly one open version that copies it; a retired one stays retired; running it twice adds nothing', async () => {
    const f = await menuFixture('t565-backfill');
    const lunch = await rawDaypart(f, 'Lunch');
    const dinner = await rawDaypart(f, 'Dinner', { start: '17:00', end: '08:00' });
    const retired = await rawDaypart(f, 'Old breakfast', { status: 'retired', start: '06:00', end: '10:00' });
    await sql`update menu_dayparts set name = 'Lunch (edited)', updated_at = now() where id = ${lunch}`;
    for (let pass = 0; pass < 2; pass++) await sql.begin(async (tx) => { for (const s of block) await tx.unsafe(s); });

    const rows = await sql<{ id: string; n: number; open: number; same: boolean; from_ok: boolean }[]>`
      select d.id, count(v.id)::int n, count(v.id) filter (where v.valid_to is null)::int open,
             bool_and(v.name = d.name and v.days = d.days and v.start_time = d.start_time and v.end_time = d.end_time and v.status = d.status and v.org_id = d.org_id and v.store_id = d.store_id) same,
             bool_and(v.valid_from = d.created_at) from_ok
        from menu_dayparts d left join menu_daypart_versions v on v.daypart_id = d.id
       where d.id in (${lunch}, ${dinner}, ${retired}) group by d.id`;
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r).toMatchObject({ n: 1, open: 1, same: true, from_ok: true });
    const status = await sql<{ status: string }[]>`select status from menu_daypart_versions where daypart_id = ${retired}`;
    expect(status.map((s) => s.status)).toEqual(['retired']);
  });
});
