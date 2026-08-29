import { config } from 'dotenv';
import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-161 — the Lane B ingestor. `docs/tasks/161-lane-b-ingestor.md`.
 *
 * ⭐ The one that matters most is invariant 5: a quarantined event **heals** when the world changes
 * under it, with no human action. That is the whole difference between this and v1's dead letter.
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
  activateTerminal,
  adjudicateDay,
  createEmployment,
  endEmployment,
  ingestEvents,
  parseShiftDay,
  provisionTerminal,
  revokeTerminal,
  seedAttendanceConfig,
  seedCanonicalPositions,
  supersedeConfig,
  shiftDayRange,
  toShiftDay,
  type TerminalIdentityDriver,
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

const driver: TerminalIdentityDriver = {
  async mintCustomToken() {
    return 'token';
  },
  async disable() {},
};

const DAY = toShiftDay(new Date(Date.now() - 24 * 3_600_000));
const DAY_START = shiftDayRange(DAY).start.getTime();
const at = (hour: number, minute = 0) =>
  DAY_START + (((((hour - 5) % 24) + 24) % 24) * 60 + minute) * 60_000;

async function fixture(hint: string) {
  const code = uid(`in-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const [other] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(`${hint}o`)}, 'Other') returning id`;
  const [admin] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${admin!.id}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${admin!.id}, ${store!.id})`;
  await sql`insert into person_store_scope (person_id, store_id) values (${admin!.id}, ${other!.id})`;
  const [worker] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Maria Santos') returning id`;

  await asOrg(orgId, (tx) => seedCanonicalPositions(tx, orgId));
  const a = actor(orgId, admin!.id);
  await asOrg(orgId, (tx) =>
    seedAttendanceConfig(tx, { orgId, storeId: store!.id, effectiveFrom: '2026-01-01' }),
  );
  await asOrg(orgId, (tx) =>
    seedAttendanceConfig(tx, { orgId, storeId: other!.id, effectiveFrom: '2026-01-01' }),
  );
  const employment = await asOrg(orgId, (tx) =>
    createEmployment(tx, a, {
      storeId: store!.id,
      personId: worker!.id,
      employmentStatus: 'regular',
      startedOn: '2026-01-05',
    }),
  );
  const { terminal } = await asOrg(orgId, (tx) =>
    provisionTerminal(tx, a, driver, { storeId: store!.id, label: 'Counter' }),
  );
  await asOrg(orgId, (tx) => activateTerminal(tx, { terminalId: terminal.id }));

  return { orgId, storeId: store!.id, otherStoreId: other!.id, admin: a, workerId: worker!.id, employment, terminal };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const event = (f: Fixture, over: Record<string, unknown> = {}) => ({
  clientPunchId: uid('cp'),
  occurredAt: at(14),
  deviceId: f.terminal.id,
  storeId: f.storeId,
  employmentId: f.employment.id,
  method: 'qr',
  assertedIntent: 'in',
  ...over,
});

const ingest = (f: Fixture, events: unknown[]) => asOrg(f.orgId, (tx) => ingestEvents(tx, events));

const quarantined = (f: Fixture) =>
  sql<{ reason_code: string; attempts: number; resolved_at: Date | null; resolution: string | null; raw_event: unknown }[]>`
    select reason_code, attempts, resolved_at, resolution, raw_event
    from inbox_quarantine where org_id = ${f.orgId} order by first_seen_at`;

// -------------------------------------------------------------------------------------

describe('T-161 invariants 1 & 8 — idempotency is a constraint, not a timer', () => {
  it('the same event twice yields one punch and alreadyProcessed the second time', async () => {
    const f = await fixture('idem');
    const e = event(f);
    const first = await ingest(f, [e]);
    const second = await ingest(f, [e]);
    expect(first.ingested).toBe(1);
    expect(second.ingested).toBe(0);
    expect(second.alreadyProcessed).toBe(1);
    const rows = await sql`select id from attendance_punches where client_punch_id = ${e.clientPunchId}`;
    expect(rows).toHaveLength(1);
  });

  it('⭐ 8. a batch of 500 where 499 are replays does 499 no-ops and one insert', async () => {
    const f = await fixture('batch');
    const existing = Array.from({ length: 499 }, () => event(f));
    await ingest(f, existing);
    const fresh = event(f);
    const report = await ingest(f, [...existing, fresh]);
    expect(report.seen).toBe(500);
    expect(report.alreadyProcessed).toBe(499);
    expect(report.ingested).toBe(1);
  });
});

describe('T-161 invariants 2 & 9 — nothing is dropped, and one bad event stops nothing', () => {
  it('⭐ 9. a DATABASE error in one event is quarantined, and the rest of the batch still lands', async () => {
    // ⚠️ The regression this exists for. A logic error — a bad method, an unknown terminal — is
    // decided in TypeScript before any statement runs, so the plain `try` always contained it. A
    // value that is the right TYPE but not a uuid gets all the way to Postgres, which then aborts
    // the whole transaction: the catch-all's own quarantine INSERT was refused too, and
    // `ingestEvents` THREW instead of quarantining. One tablet sending `employmentId: "y"` would
    // have taken a whole store's day down with it.
    //
    // The fix is a savepoint per event. This test is the proof, and it fails without it.
    const f = await fixture('dberror');
    const poison = event(f, { employmentId: 'not-a-uuid' });
    const good = event(f, { occurredAt: at(15) });

    const report = await ingest(f, [poison, good, event(f, { occurredAt: at(16) })]);

    expect(report.seen).toBe(3);
    expect(report.quarantined).toBe(1);
    expect(report.byReason.internal_error).toBe(1);
    // ⭐ The two healthy punches after the poison one still landed.
    expect(report.ingested).toBe(2);

    const rows = await sql`select id from attendance_punches where client_punch_id = ${good.clientPunchId}`;
    expect(rows).toHaveLength(1);

    // And the evidence survived: the raw body is readable, which is what a manager needs.
    const q = await quarantined(f);
    expect(q).toHaveLength(1);
    expect(q[0]!.reason_code).toBe('internal_error');
    expect((q[0]!.raw_event as Record<string, unknown>).employmentId).toBe('not-a-uuid');
  });

  it('2. a malformed event is quarantined with its RAW body intact', async () => {
    const f = await fixture('malformed');
    const bad = event(f, { method: 'telepathy', assertedIntent: 'vibes' });
    const report = await ingest(f, [bad]);
    expect(report.quarantined).toBe(1);
    expect(report.byReason.malformed).toBe(1);

    const [row] = await quarantined(f);
    expect(row!.reason_code).toBe('malformed');
    // ⛔ Stored uninterpreted — we failed to parse it, so our reading of it is worth nothing.
    expect((row!.raw_event as { method: string }).method).toBe('telepathy');
  });

  it('9. one malformed event does NOT stop the batch', async () => {
    const f = await fixture('resilient');
    const report = await ingest(f, [event(f, { method: 'nonsense' }), event(f), event(f)]);
    expect(report.quarantined).toBe(1);
    expect(report.ingested).toBe(2);
  });

  it('an event with no clientPunchId at all is still quarantined, not lost', async () => {
    const f = await fixture('nokey');
    const report = await ingest(f, [{ occurredAt: at(14), deviceId: f.terminal.id }]);
    expect(report.quarantined).toBe(1);
    expect((await quarantined(f))[0]!.reason_code).toBe('malformed');
  });

  it('a device that re-sends a doomed event makes ONE row with rising attempts', async () => {
    const f = await fixture('attempts');
    const bad = event(f, { method: 'nope' });
    await ingest(f, [bad]);
    await ingest(f, [bad]);
    await ingest(f, [bad]);
    const rows = await quarantined(f);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.attempts).toBe(3);
  });
});

describe('T-161 invariant 3 — a revoked terminal cannot punch', () => {
  it('its events are quarantined, not ingested', async () => {
    const f = await fixture('revoked');
    await asOrg(f.orgId, (tx) =>
      revokeTerminal(tx, f.admin, driver, { terminalId: f.terminal.id, reason: 'Stolen' }),
    );
    const report = await ingest(f, [event(f)]);
    expect(report.byReason.revoked_device).toBe(1);
    expect(report.ingested).toBe(0);
  });

  it('an unknown device is quarantined too', async () => {
    const f = await fixture('unknown-dev');
    const report = await ingest(f, [event(f, { deviceId: '00000000-0000-0000-0000-0000000000ff' })]);
    expect(report.byReason.unknown_device).toBe(1);
  });

  it('a terminal speaking for another store is refused', async () => {
    const f = await fixture('mismatch');
    const report = await ingest(f, [event(f, { storeId: f.otherStoreId })]);
    expect(report.byReason.store_mismatch).toBe(1);
  });
});

describe('T-161 invariant 4 — ⭐ the kill switch is read from the day’s OWN config', () => {
  it('a method disabled for that store is refused, replay included', async () => {
    // v1's scar: `assertMethodEnabled` "was previously skippable by supplying atMs", so a backdated
    // replay could use a method an admin had disabled. Here it is checked on every event.
    const f = await fixture('killswitch');
    await asOrg(f.orgId, (tx) =>
      supersedeConfig(tx, f.admin, {
        storeId: f.storeId,
        effectiveFrom: parseShiftDay(DAY),
        changes: { credentialNfc: false },
      }),
    );
    const report = await ingest(f, [event(f, { method: 'qr' })]);
    expect(report.byReason.method_disabled).toBe(1);
    expect(report.ingested).toBe(0);
  });

  it('...and a method still enabled goes through', async () => {
    const f = await fixture('killswitch-ok');
    await asOrg(f.orgId, (tx) =>
      supersedeConfig(tx, f.admin, {
        storeId: f.storeId,
        effectiveFrom: parseShiftDay(DAY),
        changes: { credentialNfc: false },
      }),
    );
    const report = await ingest(f, [event(f, { method: 'fingerprint' })]);
    expect(report.ingested).toBe(1);
  });
});

describe('T-161 invariant 5 — ⭐ a quarantine HEALS, with no human action', () => {
  it('an event stuck as unknown_credential ingests once the employment exists', async () => {
    const f = await fixture('heal');
    const ghost = '00000000-0000-0000-0000-0000000000aa';
    const e = event(f, { employmentId: ghost });

    const stuck = await ingest(f, [e]);
    expect(stuck.byReason.unknown_credential).toBe(1);

    // The world changes: the event is re-delivered naming a real, open employment.
    const fixed = { ...e, employmentId: f.employment.id };
    const healed = await ingest(f, [fixed]);

    expect(healed.ingested).toBe(1);
    expect(healed.healed).toBe(1);

    const [row] = await quarantined(f);
    expect(row!.resolved_at).not.toBeNull();
    expect(row!.resolution).toBe('ingested');
  });

  it('⭐ a healed row records NO person — nobody decided it', async () => {
    const f = await fixture('heal-attr');
    const e = event(f, { employmentId: '00000000-0000-0000-0000-0000000000bb' });
    await ingest(f, [e]);
    await ingest(f, [{ ...e, employmentId: f.employment.id }]);
    const [row] = await sql<{ resolved_by: string | null }[]>`
      select resolved_by from inbox_quarantine where org_id = ${f.orgId}`;
    expect(row!.resolved_by).toBeNull();
  });

  it('an employment that has ENDED is unknown_credential, not silently accepted', async () => {
    const f = await fixture('ended');
    await asOrg(f.orgId, (tx) =>
      endEmployment(tx, f.admin, {
        employmentId: f.employment.id,
        endedOn: '2026-06-30',
        employmentStatus: 'resigned',
      }),
    );
    const report = await ingest(f, [event(f)]);
    expect(report.byReason.unknown_credential).toBe(1);
  });
});

describe('T-161 invariants 7 & 10 — the 72-hour rule, and the report', () => {
  it('⭐ 7. a punch older than 72 hours INGESTS — it is flagged downstream, not refused here', async () => {
    // v1 rejects it and dead-letters it. Plan §5 D3: the event is reachable in Firestore, so
    // ingest always accepts and T-157 raises `late_event_arrival` for a manager to confirm.
    // Ingest is not where a business judgement is made.
    const f = await fixture('old');
    const old = Date.now() - 80 * 3_600_000;
    const report = await ingest(f, [event(f, { occurredAt: old })]);
    expect(report.ingested).toBe(1);
    expect(report.quarantined).toBe(0);
  });

  it('a FUTURE punch is quarantined — the device clock is wrong', async () => {
    const f = await fixture('future');
    const report = await ingest(f, [event(f, { occurredAt: Date.now() + 30 * 60_000 })]);
    expect(report.byReason.future_timestamp).toBe(1);
  });

  it('10. the report’s numbers add up to `seen`', async () => {
    const f = await fixture('report');
    const report = await ingest(f, [event(f), event(f, { method: 'bogus' }), event(f)]);
    expect(report.ingested + report.alreadyProcessed + report.quarantined).toBe(report.seen);
    expect(report.seen).toBe(3);
  });
});

describe('T-161 invariant 6 — the terminal is stamped, and the loop closes', () => {
  it('ingesting stamps lastSeenAt on the terminal', async () => {
    const f = await fixture('seen');
    await ingest(f, [event(f)]);
    const [row] = await sql<{ last_seen_at: Date | null }[]>`
      select last_seen_at from clock_terminals where id = ${f.terminal.id}`;
    expect(row!.last_seen_at).not.toBeNull();
  });

  it('⭐ THE EXIT GATE, minus the browser: an offline punch pair ingests and adjudicates correctly', async () => {
    // Two punches captured while the terminal had no network, replayed in one batch on reconnect,
    // and the day comes out right. The browser half — that the writes survive the outage at all —
    // is T-153's, proven against the emulator.
    const f = await fixture('gate');
    const report = await ingest(f, [
      event(f, { occurredAt: at(14), assertedIntent: 'in' }),
      event(f, { occurredAt: at(23), assertedIntent: 'out' }),
    ]);
    expect(report.ingested).toBe(2);
    expect(report.quarantined).toBe(0);

    const day = await asOrg(f.orgId, (tx) =>
      adjudicateDay(tx, { employmentId: f.employment.id, shiftDay: DAY }),
    );
    expect(day.computedMinutes).toBe(9 * 60);
    expect(day.status).toBe('computed');
    expect(day.anomalies).toEqual([]);
  });
});
