import { config } from 'dotenv';
import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-156 — the append-only punch. `docs/tasks/156-attendance-punches.md`.
 *
 * ⭐ Invariant 8 is the unusual one and it is deliberate: every other test here protects DATA, and
 * that one protects the ARCHITECTURE. It is the only mechanism that will still be working in a year
 * when somebody adds "just one denormalised field for the roster screen".
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { APP_ROLE, transaction, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import {
  createEmployment,
  recordPunch,
  seedCanonicalPositions,
  toShiftDay,
  type RecordPunchInput,
} from '@shareat/domain';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

async function fixture(hint: string) {
  const code = uid(`pu-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const [storeB] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(`${hint}b`)}, 'Store B') returning id`;
  const [admin] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${admin!.id}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${admin!.id}, ${store!.id})`;
  await sql`insert into person_store_scope (person_id, store_id) values (${admin!.id}, ${storeB!.id})`;
  const [worker] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Maria Santos') returning id`;

  await asOrg(orgId, (tx) => seedCanonicalPositions(tx, orgId));
  const a = actor(orgId, admin!.id);
  const employment = await asOrg(orgId, (tx) =>
    createEmployment(tx, a, {
      storeId: store!.id,
      personId: worker!.id,
      employmentStatus: 'regular',
      startedOn: '2026-01-05',
    }),
  );
  const employmentB = await asOrg(orgId, (tx) =>
    createEmployment(tx, a, {
      storeId: storeB!.id,
      personId: worker!.id,
      employmentStatus: 'regular',
      startedOn: '2026-01-05',
    }),
  );

  return { orgId, storeId: store!.id, storeBId: storeB!.id, admin: a, workerId: worker!.id, employment, employmentB };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const punch = (f: Fixture, over: Partial<RecordPunchInput> = {}) =>
  asOrg(f.orgId, (tx) =>
    recordPunch(tx, {
      clientPunchId: uid('cp'),
      employmentId: f.employment.id,
      occurredAt: new Date('2026-03-10T09:02:00+08:00'),
      method: 'qr',
      assertedIntent: 'in',
      source: 'online',
      ...over,
    }),
  );

// -------------------------------------------------------------------------------------

describe('T-156 invariant 1 — UPDATE and DELETE are refused on every row, by every path', () => {
  it('raw SQL cannot UPDATE a punch', async () => {
    const f = await fixture('no-update');
    const { punch: p } = await punch(f);
    await expect(sql`update attendance_punches set asserted_intent = 'out' where id = ${p.id}`)
      .rejects.toThrow(/append-only/i);
  });

  it('raw SQL cannot DELETE a punch', async () => {
    const f = await fixture('no-delete');
    const { punch: p } = await punch(f);
    await expect(sql`delete from attendance_punches where id = ${p.id}`).rejects.toThrow(/append-only/i);
  });
});

describe('T-156 invariant 2 — the idempotency key is a UNIQUE constraint, not a timer', () => {
  it('⭐ the same clientPunchId twice yields ONE row and alreadyProcessed the second time', async () => {
    const f = await fixture('idem');
    const id = uid('cp-fixed');
    const first = await punch(f, { clientPunchId: id });
    const second = await punch(f, { clientPunchId: id });

    expect(first.alreadyProcessed).toBe(false);
    expect(second.alreadyProcessed).toBe(true);
    expect(second.punch.id).toBe(first.punch.id);

    const rows = await sql`select id from attendance_punches where client_punch_id = ${id}`;
    expect(rows).toHaveLength(1);
  });

  it('a replay with DIFFERENT data still returns the original — the key decides, not the payload', async () => {
    const f = await fixture('idem-diff');
    const id = uid('cp-diff');
    const first = await punch(f, { clientPunchId: id, assertedIntent: 'in' });
    const second = await punch(f, { clientPunchId: id, assertedIntent: 'out' });
    expect(second.punch.id).toBe(first.punch.id);
    expect(second.punch.assertedIntent).toBe('in');
  });

  it('two punches eight seconds apart BOTH land — there is no debounce', async () => {
    // ⭐ The v1-divergence test. v1 blocks a second live punch inside DEBOUNCE_MS = 8000, and that
    // timer is the half that caused the 2026-08-19 duplicate-session incident. Here the dedupe is
    // the key, so two genuine presses are two genuine punches.
    const f = await fixture('no-debounce');
    const base = new Date('2026-03-10T09:02:00+08:00');
    await punch(f, { occurredAt: base });
    const second = await punch(f, { occurredAt: new Date(base.getTime() + 3000) });
    expect(second.alreadyProcessed).toBe(false);
    const rows = await sql`select id from attendance_punches where employment_id = ${f.employment.id}`;
    expect(rows).toHaveLength(2);
  });
});

describe('T-156 invariant 3 — shiftDay is computed on write, on the 05:00 calendar', () => {
  it('a 01:30 punch lands on the PREVIOUS shift day', async () => {
    const f = await fixture('shiftday');
    const at = new Date('2026-03-10T01:30:00+08:00');
    const { punch: p } = await punch(f, { occurredAt: at, assertedIntent: 'out' });
    expect(p.shiftDay).toBe('2026-03-09');
    expect(p.shiftDay).toBe(toShiftDay(at));
  });

  it('an 18:00 in and an 02:00 out share one shift day', async () => {
    const f = await fixture('overnight');
    const { punch: a } = await punch(f, { occurredAt: new Date('2026-03-10T18:00:00+08:00') });
    const { punch: b } = await punch(f, {
      occurredAt: new Date('2026-03-11T02:00:00+08:00'),
      assertedIntent: 'out',
    });
    expect(a.shiftDay).toBe('2026-03-10');
    expect(b.shiftDay).toBe('2026-03-10');
  });
});

describe('T-156 invariants 4 & 5 — the clock bounds', () => {
  it('a punch more than 5 minutes in the future is REFUSED', async () => {
    const f = await fixture('future');
    await expect(punch(f, { occurredAt: new Date(Date.now() + 30 * 60_000) })).rejects.toThrow(
      /future|not_future|check/i,
    );
  });

  it('a punch 4 minutes in the future is accepted — ordinary clock skew', async () => {
    const f = await fixture('skew');
    const { punch: p } = await punch(f, { occurredAt: new Date(Date.now() + 4 * 60_000) });
    expect(p.id).toBeTruthy();
  });

  it('⭐ an 80-HOUR-OLD punch is ACCEPTED, and its lag is computable', async () => {
    // The deliberate divergence from v1, which rejects past MAX_QUEUE_AGE_MS = 72h and
    // dead-letters it into an IndexedDB nothing can read (landmine #14). Here the event lives in
    // Firestore, so 72h is an adjudication flag rather than a data-loss cliff.
    const f = await fixture('old');
    const at = new Date(Date.now() - 80 * 3_600_000);
    const { punch: p } = await punch(f, { occurredAt: at, source: 'offline_replay' });
    const [row] = await sql<{ lag_hours: string }[]>`
      select extract(epoch from (received_at - occurred_at)) / 3600 as lag_hours
      from attendance_punches where id = ${p.id}`;
    expect(Number(row!.lag_hours)).toBeGreaterThan(79);
  });
});

describe('T-156 invariants 6 & 7 — a correction is a new row', () => {
  it('a correction supersedes exactly one punch', async () => {
    const f = await fixture('correct');
    const { punch: original } = await punch(f);
    const { punch: fix } = await punch(f, {
      supersedesPunchId: original.id,
      voidReason: 'Clocked the wrong person in',
    });
    expect(fix.supersedesPunchId).toBe(original.id);
    expect(fix.voidReason).toMatch(/wrong person/);
  });

  it('a SECOND correction of the same punch is refused', async () => {
    const f = await fixture('correct-twice');
    const { punch: original } = await punch(f);
    await punch(f, { supersedesPunchId: original.id, voidReason: 'first' });
    await expect(punch(f, { supersedesPunchId: original.id, voidReason: 'second' })).rejects.toThrow(
      /unique|duplicate/i,
    );
  });

  it('a voidReason with no supersedesPunchId is refused, and vice versa', async () => {
    const f = await fixture('pair');
    await expect(punch(f, { voidReason: 'orphan' })).rejects.toThrow(/pair|check/i);
    const { punch: original } = await punch(f);
    await expect(punch(f, { supersedesPunchId: original.id })).rejects.toThrow(/pair|check|reason/i);
  });

  it('a correction cannot cross employments', async () => {
    const f = await fixture('cross-emp');
    const { punch: atA } = await punch(f);
    await expect(
      punch(f, {
        employmentId: f.employmentB.id,
        supersedesPunchId: atA.id,
        voidReason: 'moved',
      }),
    ).rejects.toThrow(/same employment/i);
  });
});

describe('T-156 invariant 8 — ⭐ no column here is derived from a business rule', () => {
  it('the column list matches a pinned allow-list, so adding computed_hours fails a TEST', async () => {
    const cols = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_name = 'attendance_punches' order by column_name`;
    expect(cols.map((c) => c.column_name)).toEqual([
      'asserted_intent',
      'captured_by_session_id',
      'client_punch_id',
      'created_at',
      'created_by',
      'device_id',
      'employment_id',
      'id',
      'method',
      'occurred_at',
      'org_id',
      'person_id',
      'received_at',
      'shift_day',
      'source',
      'store_id',
      'supersedes_punch_id',
      'void_reason',
    ]);
  });
});

describe('T-156 invariants 9 & 10 — the punch belongs to the right job', () => {
  it('a punch whose store disagrees with its employment is refused', async () => {
    const f = await fixture('cross-store');
    await expect(punch(f, { employmentId: f.employmentB.id, storeIdOverride: f.storeId })).rejects.toThrow(
      /does not match employment/i,
    );
  });

  it('deleting an employment that has punches is refused by the FK', async () => {
    const f = await fixture('fk-emp');
    await punch(f);
    await expect(sql`delete from employments where id = ${f.employment.id}`).rejects.toThrow(
      /foreign key|violates/i,
    );
  });

  it('deleting the person is refused too', async () => {
    const f = await fixture('fk-person');
    await punch(f);
    await expect(sql`delete from persons where id = ${f.workerId}`).rejects.toThrow(/foreign key|violates/i);
  });
});

describe('T-156 — breaks need no new machinery', () => {
  it('a break is a punch with a different intent, and it stores like any other', async () => {
    const f = await fixture('breaks');
    const day = new Date('2026-03-10T12:00:00+08:00');
    for (const intent of ['break_start', 'break_end'] as const) {
      const { punch: p } = await punch(f, { occurredAt: day, assertedIntent: intent });
      expect(p.assertedIntent).toBe(intent);
    }
    const rows = await sql`
      select asserted_intent from attendance_punches
      where employment_id = ${f.employment.id} and asserted_intent like 'break%'`;
    expect(rows).toHaveLength(2);
  });
});
