import { config } from 'dotenv';
import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-183 — the quarantine screen and lane health. `docs/tasks/183-quarantine-and-lane-health.md`.
 *
 * ⭐ The one that matters most is invariant 2: **Retry re-runs the real ingest path.** Everything
 * else on this screen is presentation; that is the bit that decides whether a shift is recoverable.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(
    `Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`,
  );
}

import { APP_ROLE, transaction, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import {
  LANE_HEALTH,
  LaneHealthError,
  activateTerminal,
  createEmployment,
  discardQuarantined,
  enrolCard,
  ingestEvents,
  laneHealth,
  listQuarantine,
  provisionTerminal,
  retryQuarantined,
  seedAttendanceConfig,
  seedCanonicalPositions,
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

/**
 * Two stores, an admin over both, and a MANAGER over the first only.
 *
 * ⚠️ The manager is not decoration. `provision_clock_terminal` is the one capability on this screen
 * a manager does not hold, and the discard gate is the whole reason T-183 names it separately —
 * a fixture with only an admin could never have caught that.
 */
async function fixture(hint: string) {
  const code = uid(`lh-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const [other] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(`${hint}o`)}, 'Other') returning id`;

  const [adminP] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${adminP!.id}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${adminP!.id}, ${store!.id})`;
  await sql`insert into person_store_scope (person_id, store_id) values (${adminP!.id}, ${other!.id})`;

  const [managerP] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Manager') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${managerP!.id}, ${orgId}, 'manager')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${managerP!.id}, ${store!.id})`;

  /** ⚠️ Scoped to the OTHER store only — the actor invariant 1 must not leak to. */
  const [outsiderP] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Outsider') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${outsiderP!.id}, ${orgId}, 'manager')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${outsiderP!.id}, ${other!.id})`;

  const [worker] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Maria Santos') returning id`;

  await asOrg(orgId, (tx) => seedCanonicalPositions(tx, orgId));
  const admin = actor(orgId, adminP!.id);
  await asOrg(orgId, (tx) =>
    seedAttendanceConfig(tx, { orgId, storeId: store!.id, effectiveFrom: '2026-01-01' }),
  );
  await asOrg(orgId, (tx) =>
    seedAttendanceConfig(tx, { orgId, storeId: other!.id, effectiveFrom: '2026-01-01' }),
  );

  const employment = await asOrg(orgId, (tx) =>
    createEmployment(tx, admin, {
      storeId: store!.id,
      personId: worker!.id,
      employmentStatus: 'regular',
      startedOn: '2026-01-05',
    }),
  );
  const { terminal } = await asOrg(orgId, (tx) =>
    provisionTerminal(tx, admin, driver, { storeId: store!.id, label: 'Counter' }),
  );
  await asOrg(orgId, (tx) => activateTerminal(tx, { terminalId: terminal.id }));

  const cardId = uid('card');
  const credential = await asOrg(orgId, (tx) =>
    enrolCard(tx, admin, { employmentId: employment.id, cardId }),
  );

  // ⚠️ Backdated on purpose. `resolveCredentialAt` requires `enrolled_at <= occurredAt` — a badge
  // cannot authorise a punch made before it existed, which is a real fraud guard (enrol a card
  // today, back-date a month of punches to it). These fixtures punch on YESTERDAY's shift day, so
  // an enrolment stamped `now()` would correctly refuse every one of them.
  await sql`update attendance_credentials set enrolled_at = now() - interval '30 days'
            where id = ${credential.id}`;

  return {
    orgId,
    storeId: store!.id,
    otherStoreId: other!.id,
    admin,
    manager: actor(orgId, managerP!.id),
    outsider: actor(orgId, outsiderP!.id),
    workerId: worker!.id,
    employment,
    terminal,
    cardId,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const event = (f: Fixture, over: Record<string, unknown> = {}) => ({
  clientPunchId: uid('cp'),
  occurredAt: at(14),
  deviceId: f.terminal.id,
  storeId: f.storeId,
  credentialKind: 'card',
  credentialRef: f.cardId,
  method: 'qr',
  assertedIntent: 'in',
  ...over,
});

const ingest = (f: Fixture, events: unknown[]) => asOrg(f.orgId, (tx) => ingestEvents(tx, events));
const health = (f: Fixture, a: Actor, over: Record<string, unknown> = {}) =>
  asOrg(f.orgId, (tx) => laneHealth(tx, a, { storeId: f.storeId, ...over }));
const list = (f: Fixture, a: Actor) =>
  asOrg(f.orgId, (tx) => listQuarantine(tx, a, { storeId: f.storeId }));

/** Quarantine one event by naming an employment that does not exist. Heals once it does. */
async function stick(f: Fixture, over: Record<string, unknown> = {}) {
  const ghostCard = uid('ghostcard');
  const e = event(f, { credentialRef: ghostCard, ...over });
  await ingest(f, [e]);
  const rows = await sql<{ id: string }[]>`
    select id from inbox_quarantine where client_punch_id = ${e.clientPunchId}`;
  return { event: e, id: rows[0]!.id, ghostCard };
}

/**
 * ⭐ The world changing, since T-185: somebody ENROLS the badge the stuck event names.
 *
 * This replaces the old helper, which rewrote the stored raw event to name a real employment. That
 * was always a stand-in; now it is the actual operation a manager performs, and the event itself is
 * never touched — which is invariant 8, demonstrated rather than asserted.
 */
async function enrol(f: Fixture, cardId: string) {
  const row = await asOrg(f.orgId, (tx) =>
    enrolCard(tx, f.admin, { employmentId: f.employment.id, cardId }),
  );
  // Backdated for the same reason as the fixture's own card — see the note there.
  await sql`update attendance_credentials set enrolled_at = now() - interval '30 days'
            where id = ${row.id}`;
  return row;
}

// ---------------------------------------------------------------------------------------

describe('T-183 invariant 1 — a quarantined event is visible to its own store, and nobody else', () => {
  it("a manager of the store sees it; a manager of another store does not", async () => {
    const f = await fixture('vis');
    await stick(f);

    const mine = await list(f, f.manager);
    expect(mine.open).toHaveLength(1);

    // ⛔ The outsider is a manager — just not HERE. The denial is the store scope, not the role.
    await expect(list(f, f.outsider)).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('the sentence a manager reads is prose, not a reason code', async () => {
    const f = await fixture('sentence');
    await stick(f);
    const { open } = await list(f, f.manager);
    expect(open[0]!.reasonCode).toBe('unknown_credential');
    expect(open[0]!.sentence).toContain('Enrol them');
    // The ingestor's own specifics survive into the sentence rather than being replaced by it.
    // ⭐ Since T-185 the detail names the CREDENTIAL and the moment, not a person — because at this
    // point the server genuinely does not know who it was, which is the honest thing to render.
    expect(open[0]!.sentence).toContain('card credential');
    expect(open[0]!.sentence).toContain('revoked before the punch');
  });

  it('⛔ a malformed event is marked NOT retryable, because retrying it can never help', async () => {
    const f = await fixture('unretryable');
    await ingest(f, [event(f, { method: 'telepathy' })]);
    const { unattributed } = await list(f, f.admin);
    const malformed = unattributed.find((r) => r.reasonCode === 'malformed');
    expect(malformed).toBeDefined();
    expect(malformed!.retryable).toBe(false);
    expect(malformed!.sentence).toContain('cannot help');
  });
});

describe('⭐ T-183 invariant 2 — Retry re-runs the REAL ingest path', () => {
  it('a stuck event becomes a punch once the world is fixed, and leaves the open list', async () => {
    const f = await fixture('retry');
    // Stick it on a badge nobody has enrolled...
    const { id, event: e, ghostCard } = await stick(f);
    expect((await list(f, f.manager)).open).toHaveLength(1);

    // ...then enrol that badge. ⭐ The stored event is NOT touched — invariant 8 — the world around
    // it changed, which is exactly the situation Retry exists for.
    await enrol(f, ghostCard);

    const result = await asOrg(f.orgId, (tx) =>
      retryQuarantined(tx, f.manager, { quarantineId: id, storeId: f.storeId }),
    );
    expect(result.ingested).toBe(true);
    expect(result.punchId).not.toBeNull();
    expect(result.stillStuckBecause).toBeNull();

    const punches = await sql`select id from attendance_punches where client_punch_id = ${e.clientPunchId}`;
    expect(punches).toHaveLength(1);
    expect((await list(f, f.manager)).open).toHaveLength(0);
  });

  it('⭐ a retry that heals records NO person — nobody decided it, the world changed', async () => {
    const f = await fixture('healnobody');
    const { id, event: e, ghostCard } = await stick(f);
    await enrol(f, ghostCard);
    await asOrg(f.orgId, (tx) =>
      retryQuarantined(tx, f.manager, { quarantineId: id, storeId: f.storeId }),
    );

    const [resolved] = await sql<{ resolution: string; resolved_by: string | null }[]>`
      select resolution, resolved_by from inbox_quarantine where client_punch_id = ${e.clientPunchId}`;
    expect(resolved!.resolution).toBe('ingested');
    // ⛔ A sentinel person here would make an automatic recovery read as somebody's judgement.
    expect(resolved!.resolved_by).toBeNull();
  });

  it('a retry that does not fix anything says why it is STILL stuck, and the row stays open', async () => {
    const f = await fixture('stillstuck');
    const { id } = await stick(f);
    const result = await asOrg(f.orgId, (tx) =>
      retryQuarantined(tx, f.manager, { quarantineId: id, storeId: f.storeId }),
    );
    expect(result.ingested).toBe(false);
    expect(result.stillStuckBecause).toBe('unknown_credential');
    expect((await list(f, f.manager)).open).toHaveLength(1);

    // The attempt counter moved, which is how a manager sees they have tried this three times.
    const [row] = await sql<{ attempts: number }[]>`select attempts from inbox_quarantine where id = ${id}`;
    expect(row!.attempts).toBeGreaterThan(1);
  });

  it('a resolved row cannot be retried — it is history, not a queue item', async () => {
    const f = await fixture('resolvedretry');
    const { id } = await stick(f);
    await asOrg(f.orgId, (tx) =>
      discardQuarantined(tx, f.admin, { quarantineId: id, storeId: f.storeId, reason: 'duplicate' }),
    );
    await expect(
      asOrg(f.orgId, (tx) =>
        retryQuarantined(tx, f.admin, { quarantineId: id, storeId: f.storeId }),
      ),
    ).rejects.toBeInstanceOf(LaneHealthError);
  });
});

describe('⛔ T-183 invariant 3 — Discard needs a reason, a human, and never deletes', () => {
  it('a blank reason is refused', async () => {
    const f = await fixture('noreason');
    const { id } = await stick(f);
    await expect(
      asOrg(f.orgId, (tx) =>
        discardQuarantined(tx, f.admin, { quarantineId: id, storeId: f.storeId, reason: '   ' }),
      ),
    ).rejects.toBeInstanceOf(LaneHealthError);
    const [row] = await sql<{ resolved_at: Date | null }[]>`
      select resolved_at from inbox_quarantine where id = ${id}`;
    expect(row!.resolved_at).toBeNull();
  });

  it('a discard keeps the row forever and names who did it', async () => {
    const f = await fixture('discard');
    const { id } = await stick(f);
    await asOrg(f.orgId, (tx) =>
      discardQuarantined(tx, f.admin, {
        quarantineId: id,
        storeId: f.storeId,
        reason: 'Test punch from a device being set up.',
      }),
    );
    const [row] = await sql<{
      resolution: string;
      resolved_by: string;
      resolution_reason: string;
      raw_event: unknown;
    }[]>`select resolution, resolved_by, resolution_reason, raw_event from inbox_quarantine where id = ${id}`;
    expect(row!.resolution).toBe('discarded');
    expect(row!.resolved_by).toBe(f.admin.personId);
    expect(row!.resolution_reason).toContain('being set up');
    // ⭐ The evidence survives the decision. A discard is a judgement, not an erasure.
    expect(row!.raw_event).toBeTruthy();
  });

  it('⛔ a MANAGER may retry but may not discard — the capabilities are deliberately different', async () => {
    const f = await fixture('gate');
    const { id } = await stick(f);
    // Reading and retrying: fine.
    await asOrg(f.orgId, (tx) =>
      retryQuarantined(tx, f.manager, { quarantineId: id, storeId: f.storeId }),
    );
    // Discarding: not theirs. It is the only button here that can lose a real shift.
    await expect(
      asOrg(f.orgId, (tx) =>
        discardQuarantined(tx, f.manager, { quarantineId: id, storeId: f.storeId, reason: 'no' }),
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('a discarded row appears in the resolved tail, so the decision stays readable', async () => {
    const f = await fixture('tail');
    const { id } = await stick(f);
    await asOrg(f.orgId, (tx) =>
      discardQuarantined(tx, f.admin, { quarantineId: id, storeId: f.storeId, reason: 'test rig' }),
    );
    const { open, resolved } = await list(f, f.manager);
    expect(open).toHaveLength(0);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.resolutionReason).toBe('test rig');
  });
});

describe('⛔ T-183 invariant 4 — a discarded event is not resurrected by the next ingest run', () => {
  it('the device re-delivers the same event and it is refused, not re-ingested', async () => {
    const f = await fixture('nores');
    const { id: rowId, event: e, ghostCard } = await stick(f);
    await asOrg(f.orgId, (tx) =>
      discardQuarantined(tx, f.admin, {
        quarantineId: rowId,
        storeId: f.storeId,
        reason: 'Staffer never worked this shift.',
      }),
    );

    // ⚠️ Now enrol the badge, so the very same event becomes PERFECTLY VALID, and deliver it again.
    // Without the guard it would sail through and become a punch — silently overturning a
    // manager's decision on nobody's authority.
    await enrol(f, ghostCard);
    const report = await ingest(f, [e]);
    expect(report.refusedDiscarded).toBe(1);
    expect(report.ingested).toBe(0);
    const punches = await sql`select id from attendance_punches where client_punch_id = ${e.clientPunchId}`;
    expect(punches).toHaveLength(0);

    // And the resolution is untouched — the reason the manager gave still stands.
    const [after] = await sql<{ resolution: string; resolution_reason: string }[]>`
      select resolution, resolution_reason from inbox_quarantine where id = ${rowId}`;
    expect(after!.resolution).toBe('discarded');
    expect(after!.resolution_reason).toContain('never worked');
  });
});

describe('T-183 invariant 5 — health warns on outbox lag', () => {
  it('a queue drained a second ago is ok; ONE row from breakfast is not', async () => {
    const f = await fixture('lag');
    // The fixture's own employment insert left an unpublished roster row behind it.
    const fresh = await health(f, f.manager);
    expect(fresh.outbox.pending).toBeGreaterThan(0);
    expect(fresh.outbox.status).toBe('ok');

    await sql`update mirror_outbox
              set enqueued_at = now() - interval '90 minutes'
              where store_id = ${f.storeId} and published_at is null`;
    const stale = await health(f, f.manager);
    expect(stale.outbox.status).toBe('warn');
    expect(stale.outbox.lagMinutes).toBeGreaterThan(LANE_HEALTH.outboxLagWarnMinutes);
    expect(stale.needsAttention).toBe(true);
  });

  it('⭐ lag is measured from the oldest row, not from a count', async () => {
    const f = await fixture('lagcount');
    await sql`update mirror_outbox set published_at = now() where store_id = ${f.storeId}`;
    const drained = await health(f, f.manager);
    expect(drained.outbox.pending).toBe(0);
    expect(drained.outbox.lagMinutes).toBeNull();
    expect(drained.outbox.status).toBe('ok');
  });

  it("⛔ an inbox nobody has measured reads 'unknown', never 'ok'", async () => {
    const f = await fixture('inboxunknown');
    const silent = await health(f, f.manager);
    // Postgres cannot see a Firestore document the relay has not reached. Saying so is the answer.
    expect(silent.inbox.status).toBe('unknown');
    expect(silent.inbox.reportedAt).toBeNull();

    const reported = await health(f, f.manager, {
      inbox: { oldestUnprocessedAt: new Date(Date.now() - 60 * 60_000), reportedAt: new Date() },
    });
    expect(reported.inbox.status).toBe('warn');
    expect(reported.inbox.lagMinutes).toBeGreaterThan(LANE_HEALTH.inboxUnprocessedWarnMinutes);
  });
});

describe('T-183 invariant 6 — a silent terminal is listed; a store that closed early is not', () => {
  it('25 hours quiet is a closed store; 30 hours quiet is an outage', async () => {
    const f = await fixture('silent');
    await sql`update clock_terminals set last_seen_at = now() - interval '25 hours' where id = ${f.terminal.id}`;
    const closedEarly = await health(f, f.manager);
    expect(closedEarly.terminals[0]!.status).toBe('ok');

    await sql`update clock_terminals set last_seen_at = now() - interval '30 hours' where id = ${f.terminal.id}`;
    const down = await health(f, f.manager);
    expect(down.terminals[0]!.status).toBe('silent');
    expect(down.terminals[0]!.silentHours).toBe(30);
    expect(down.needsAttention).toBe(true);
  });

  it('⚠️ three ways of being quiet, and only one is a fault', async () => {
    const f = await fixture('quiet');
    // Paired this morning, nobody has clocked in yet — a normal Tuesday, not an outage.
    const noPunches = await health(f, f.manager);
    expect(noPunches.terminals[0]!.status).toBe('no_punches_yet');

    // Provisioned but never signed in — a provisioning job somebody has not finished.
    await sql`update clock_terminals set activated_at = null where id = ${f.terminal.id}`;
    const unpaired = await health(f, f.manager);
    expect(unpaired.terminals[0]!.status).toBe('never_paired');
  });

  it('a revoked terminal is not listed as silent — it is meant to be quiet', async () => {
    const f = await fixture('revoked');
    await sql`update clock_terminals
              set revoked_at = now(), revoked_by = ${f.admin.personId}, revoke_reason = 'retired',
                  last_seen_at = now() - interval '40 hours'
              where id = ${f.terminal.id}`;
    const report = await health(f, f.manager);
    expect(report.terminals).toHaveLength(0);
  });
});

describe('T-183 invariant 7 — the raw event is kept exactly as received', () => {
  it('the stored body is the one the device sent, uninterpreted', async () => {
    const f = await fixture('raw');
    const e = event(f, { credentialRef: uid('ghostcard'), batteryPct: 4 });
    await ingest(f, [e]);
    const { open } = await list(f, f.manager);
    const raw = open[0]!.rawEvent as Record<string, unknown>;
    expect(raw.clientPunchId).toBe(e.clientPunchId);
    // ⭐ A field we do not model survives. By definition we failed to interpret this event, so
    // storing our reading of it would store the mistake instead of the evidence.
    expect(raw.batteryPct).toBe(4);
  });
});

describe('T-183 invariant 8 — nothing here can edit an event', () => {
  it('⛔ the module exposes exactly two operator actions, and neither writes the body', async () => {
    const mod = await import('@shareat/domain');
    const writers = Object.keys(mod).filter((k) => /Quarantin/i.test(k) && typeof (mod as Record<string, unknown>)[k] === 'function');
    // `retryQuarantined`, `discardQuarantined`, `listQuarantine`, `quarantineSentence`.
    // ⛔ Any name suggesting an edit — updateQuarantine, editQuarantinedEvent — would fail here.
    expect(writers.sort()).toEqual([
      'discardQuarantined',
      'listQuarantine',
      'quarantineSentence',
      'retryQuarantined',
    ]);
  });
});

describe('⭐ T-183 — the number that says the lane heals itself', () => {
  it('counts the events that came back on their own, and not the ones a person discarded', async () => {
    const f = await fixture('healed');
    // One heals on its own...
    const { id, ghostCard } = await stick(f);
    await enrol(f, ghostCard);
    await asOrg(f.orgId, (tx) =>
      retryQuarantined(tx, f.manager, { quarantineId: id, storeId: f.storeId }),
    );
    // ...and one a human threw away.
    const second = await stick(f);
    await asOrg(f.orgId, (tx) =>
      discardQuarantined(tx, f.admin, {
        quarantineId: second.id,
        storeId: f.storeId,
        reason: 'not a real shift',
      }),
    );

    const report = await health(f, f.manager);
    expect(report.healedRecently).toBe(1);
    expect(report.quarantineOpen).toBe(0);
  });
});
