import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * T-565 (audit MC-002) - migration 0253, menu_daypart_versions: kept by the database (triggers on menu_dayparts), append-only, one open version per
 * daypart, no two versions overlapping, RLS, same-store keys and the backfill. docs/tasks/565-daypart-versions.md s2, s3.
 * Real PostgreSQL on a "_test" database; the owner connection sees the triggers, shareat_app sees the grants.
 */
import { asApp, menuFixture, refusal, sql } from './_fixtures/t401-menu';

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

type Fx = { orgId: string; storeId: string; personId: string };
const ALL = '{0,1,2,3,4,5,6}';
/** A raw daypart row backdated three days. The database opens its version 1 (valid_from = created_at). */
const rawDaypart = async (f: Fx, name: string, o: { status?: string; start?: string; end?: string } = {}) =>
  (
    await sql<{ id: string }[]>`
      insert into menu_dayparts (org_id, store_id, name, days, start_time, end_time, status, created_by, created_at)
      values (${f.orgId}, ${f.storeId}, ${name}, ${ALL}::smallint[], ${o.start ?? '08:00'}::time, ${o.end ?? '17:00'}::time, ${o.status ?? 'active'}, ${f.personId}, now() - interval '3 days')
      returning id`
  )[0]!.id;
const openVersion = async (dp: string) =>
  (await sql<{ id: string; valid_from: Date }[]>`select id, valid_from from menu_daypart_versions where daypart_id = ${dp} and valid_to is null`)[0]!;
const insertVersion = (f: Fx, dp: string, from: object, to: object | null) =>
  sql`insert into menu_daypart_versions (org_id, store_id, daypart_id, name, days, start_time, end_time, status, valid_from, valid_to)
      values (${f.orgId}, ${f.storeId}, ${dp}, 'V', ${ALL}::smallint[], '08:00', '17:00', 'active', ${from as never}, ${to as never})`;

describe('menu_daypart_versions (0253)', () => {
  it('append-only: a window edit, a second close and a DELETE are refused; closing once from NULL is the only change', async () => {
    const f = await menuFixture('t565-append');
    const v = await openVersion(await rawDaypart(f, 'Lunch'));
    expect((await refusal(() => sql`update menu_daypart_versions set start_time = '09:00' where id = ${v.id}`))?.code).toBe('23001');
    expect(await refusal(() => sql`update menu_daypart_versions set valid_to = now() where id = ${v.id}`)).toBeUndefined();
    expect((await refusal(() => sql`update menu_daypart_versions set valid_to = now() + interval '1 day' where id = ${v.id}`))?.code).toBe('23001');
    expect((await refusal(() => sql`update menu_daypart_versions set valid_to = null where id = ${v.id}`))?.code).toBe('23001');
    expect((await refusal(() => sql`delete from menu_daypart_versions where id = ${v.id}`))?.code).toBe('23001');
  });

  it('the application role can neither delete a version nor edit a column other than valid_to', async () => {
    const f = await menuFixture('t565-grants');
    const v = await openVersion(await rawDaypart(f, 'Lunch'));
    expect((await asApp(f.orgId, (tx) => tx`delete from menu_daypart_versions where id = ${v.id}`)).err?.code).toBe('42501');
    expect((await asApp(f.orgId, (tx) => tx`update menu_daypart_versions set name = 'X' where id = ${v.id}`)).err?.code).toBe('42501');
    expect((await asApp(f.orgId, (tx) => tx`update menu_daypart_versions set valid_to = now() where id = ${v.id}`)).err).toBeUndefined();
  });

  it('two open versions of one daypart are refused', async () => {
    const f = await menuFixture('t565-open');
    const dp = await rawDaypart(f, 'Lunch');
    const err = await refusal(() => insertVersion(f, dp, sql`now() - interval '1 day'`, null));
    expect(['23505', '23P01']).toContain(err?.code);
  });

  it('no two versions of one daypart overlap: an overlapping closed row is refused, an adjacent one is accepted', async () => {
    const f = await menuFixture('t565-overlap');
    const dp = await rawDaypart(f, 'Lunch');
    const open = await openVersion(dp);
    const overlapping = await refusal(() => insertVersion(f, dp, sql`${open.valid_from}::timestamptz + interval '1 hour'`, sql`${open.valid_from}::timestamptz + interval '2 hours'`));
    expect(overlapping?.code).toBe('23P01');
    const adjacent = await refusal(() => insertVersion(f, dp, sql`${open.valid_from}::timestamptz - interval '1 day'`, sql`${open.valid_from}::timestamptz`));
    expect(adjacent).toBeUndefined();
  });

  it('a version of a daypart at another store, or with valid_to before valid_from, is refused', async () => {
    const f = await menuFixture('t565-keys');
    const dp = await rawDaypart(f, 'Lunch');
    // closed and long before the open version, so neither the open-version index nor the overlap rule fires first: only the store key can refuse
    const wrongStore = await refusal(
      () => sql`insert into menu_daypart_versions (org_id, store_id, daypart_id, name, days, start_time, end_time, status, valid_from, valid_to)
                values (${f.orgId}, ${f.store2Id}, ${dp}, 'V', ${ALL}::smallint[], '08:00', '17:00', 'active', now() - interval '9 days', now() - interval '8 days')`,
    );
    expect(wrongStore?.code).toBe('23503');
    const backwards = await refusal(() => insertVersion(f, dp, sql`now()`, sql`now() - interval '1 hour'`));
    expect(backwards?.code).toBe('23514');
  });

  it("isolation: org B cannot read or write org A's versions", async () => {
    const a = await menuFixture('t565-iso-a');
    const b = await menuFixture('t565-iso-b');
    const dp = await rawDaypart(a, 'Lunch');
    const v = await openVersion(dp);
    expect((await asApp(b.orgId, (tx) => tx`select id from menu_daypart_versions where id = ${v.id}`)).value).toHaveLength(0);
    expect((await asApp(a.orgId, (tx) => tx`select id from menu_daypart_versions where id = ${v.id}`)).value).toHaveLength(1);
    const write = await asApp(
      b.orgId,
      (tx) => tx`insert into menu_daypart_versions (org_id, store_id, daypart_id, name, days, start_time, end_time, status, valid_from)
                 values (${a.orgId}, ${a.storeId}, ${dp}, 'V', ${ALL}::smallint[], '08:00', '17:00', 'active', now() - interval '9 days')`,
    );
    expect(write.err?.code).toBe('42501');
    const close = await asApp(b.orgId, (tx) => tx`update menu_daypart_versions set valid_to = now() where id = ${v.id} returning id`);
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

describe('0253 - the database keeps the versions (triggers on menu_dayparts)', () => {
  /** The open version, side by side with the daypart row: every window column must agree. */
  const agree = async (dp: string) =>
    (
      await sql<{ n: number; same: boolean }[]>`
        select count(v.id)::int n,
               coalesce(bool_and(v.name = d.name and v.days = d.days and v.start_time = d.start_time and v.end_time = d.end_time and v.status = d.status), false) same
          from menu_dayparts d left join menu_daypart_versions v on v.daypart_id = d.id and v.valid_to is null where d.id = ${dp}`
    )[0]!;

  it('a raw INSERT opens version 1; a raw UPDATE of the window, the name or the status closes it and opens the next, and the open version always equals the row', async () => {
    const f = await menuFixture('t565-trigger');
    const dp = await rawDaypart(f, 'Lunch');
    expect(await agree(dp)).toEqual({ n: 1, same: true });
    const v1 = await openVersion(dp);

    await sql`update menu_dayparts set start_time = '09:00', updated_at = now() where id = ${dp}`;
    expect(await agree(dp)).toEqual({ n: 1, same: true });
    await sql`update menu_dayparts set name = 'Brunch', days = '{1,2,3}'::smallint[], end_time = '15:00' where id = ${dp}`;
    expect(await agree(dp)).toEqual({ n: 1, same: true });
    await sql`update menu_dayparts set status = 'retired' where id = ${dp}`;
    expect(await agree(dp)).toEqual({ n: 1, same: true });

    const all = await sql<{ id: string; status: string; valid_to: Date | null; same_edge: boolean }[]>`
      select id, status, valid_to, coalesce(valid_to = lead(valid_from) over (order by valid_from, id), true) same_edge
        from menu_daypart_versions where daypart_id = ${dp} order by valid_from, id`;
    expect(all).toHaveLength(4);
    expect(all[0]!.id).toBe(v1.id);
    expect(all.map((v) => v.status)).toEqual(['active', 'active', 'active', 'retired']);
    expect(all.every((v) => v.same_edge)).toBe(true); // each version closes exactly where the next opens
    expect(all.filter((v) => v.valid_to === null)).toHaveLength(1);
  });

  it('an UPDATE that changes no window column adds no version', async () => {
    const f = await menuFixture('t565-noop');
    const dp = await rawDaypart(f, 'Lunch');
    await sql`update menu_dayparts set name = name, start_time = start_time, updated_at = now() where id = ${dp}`;
    expect((await sql`select id from menu_daypart_versions where daypart_id = ${dp}`).length).toBe(1);
  });

  it("in the writer's own transaction a read at the millisecond-cut now sees the new window (a reader's dbNow)", async () => {
    const f = await menuFixture('t565-same-tx');
    await sql.begin(async (tx) => {
      const [d] = await tx<{ id: string }[]>`
        insert into menu_dayparts (org_id, store_id, name, days, start_time, end_time, created_by)
        values (${f.orgId}, ${f.storeId}, 'Lunch', ${ALL}::smallint[], '08:00', '17:00', ${f.personId}) returning id`;
      const at = async () =>
        tx<{ start_time: string }[]>`
          select start_time::text from menu_daypart_versions
           where daypart_id = ${d!.id} and valid_from <= date_trunc('milliseconds', now()) and (valid_to is null or valid_to > date_trunc('milliseconds', now()))`;
      expect((await at()).map((r) => r.start_time)).toEqual(['08:00:00']);
      await tx`update menu_dayparts set start_time = '10:00' where id = ${d!.id}`;
      expect((await at()).map((r) => r.start_time)).toEqual(['10:00:00']);
    });
  });
});

describe('0253 backfill', () => {
  /** The statements between the B0253 markers: what the migration runs over the dayparts that exist when it is applied. */
  const block = (() => {
    const text = readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'migrations', '0253_t565_daypart_versions.sql'), 'utf8');
    const begin = text.indexOf('-- B0253:begin');
    const end = text.indexOf('-- B0253:end');
    if (begin < 0 || end < begin) throw new Error('B0253 block not found in migration 0253');
    return text.slice(begin, end).split(/-->\s*statement-breakpoint/).map((x) => x.trim()).filter((x) => x.length > 0);
  })();

  it('every existing daypart gets exactly one open version that copies it; a retired one stays retired; running it twice adds nothing', async () => {
    const f = await menuFixture('t565-backfill');
    const ids: string[] = [];
    // Replica mode skips the origin triggers: these rows are what 0233 left behind, dayparts with no version.
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      const mk = async (name: string, status: string, start: string, end: string) =>
        (
          await tx<{ id: string }[]>`
            insert into menu_dayparts (org_id, store_id, name, days, start_time, end_time, status, created_by, created_at)
            values (${f.orgId}, ${f.storeId}, ${name}, ${ALL}::smallint[], ${start}::time, ${end}::time, ${status}, ${f.personId}, now() - interval '3 days') returning id`
        )[0]!.id;
      ids.push(await mk('Lunch', 'active', '08:00', '17:00'), await mk('Dinner', 'active', '17:00', '08:00'), await mk('Old breakfast', 'retired', '06:00', '10:00'));
      await tx`update menu_dayparts set name = 'Lunch (edited)', updated_at = now() where id = ${ids[0]!}`;
    });
    expect(await sql`select id from menu_daypart_versions where daypart_id in ${sql(ids)}`).toHaveLength(0);
    for (let pass = 0; pass < 2; pass++) await sql.begin(async (tx) => { for (const s of block) await tx.unsafe(s); });

    const rows = await sql<{ id: string; n: number; open: number; same: boolean; from_ok: boolean }[]>`
      select d.id, count(v.id)::int n, count(v.id) filter (where v.valid_to is null)::int open,
             bool_and(v.name = d.name and v.days = d.days and v.start_time = d.start_time and v.end_time = d.end_time and v.status = d.status and v.org_id = d.org_id and v.store_id = d.store_id) same,
             bool_and(v.valid_from = d.created_at) from_ok
        from menu_dayparts d left join menu_daypart_versions v on v.daypart_id = d.id
       where d.id in ${sql(ids)} group by d.id`;
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r).toMatchObject({ n: 1, open: 1, same: true, from_ok: true });
    const status = await sql<{ status: string }[]>`select status from menu_daypart_versions where daypart_id = ${ids[2]!}`;
    expect(status.map((s) => s.status)).toEqual(['retired']);
  });
});
