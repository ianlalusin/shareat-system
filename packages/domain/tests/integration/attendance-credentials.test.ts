import { config } from 'dotenv';
import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-164 — credential enrolment and the mirror. `docs/tasks/164-credential-enrolment-and-mirror.md`.
 *
 * ⭐ The one that matters most is invariant 7: **a punch made before a revocation still ingests;
 * one made after it does not.** That single pair is what closes landmine #22 — v1 authorises a
 * punch by possession of a token alone, so a leaked credential punches forever.
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
  CredentialError,
  MAX_TEMPLATES,
  activateTerminal,
  createEmployment,
  drainOutbox,
  endEmployment,
  enrolCard,
  enrolFingerprint,
  ingestEvents,
  listCredentials,
  provisionTerminal,
  revokeCredential,
  seedAttendanceConfig,
  seedCanonicalPositions,
  shiftDayRange,
  toShiftDay,
  type MirrorDocument,
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
  const code = uid(`cred-${hint}`);
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

  /** A cashier — holds no `manage_attendance`, so enrolment must refuse them. */
  const [staffP] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Cashier') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${staffP!.id}, ${orgId}, 'staff')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${staffP!.id}, ${store!.id})`;

  const [worker] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Maria Santos') returning id`;
  const [worker2] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Ana Cruz') returning id`;

  await asOrg(orgId, (tx) => seedCanonicalPositions(tx, orgId));
  const admin = actor(orgId, adminP!.id);
  for (const s of [store!.id, other!.id]) {
    await asOrg(orgId, (tx) =>
      seedAttendanceConfig(tx, { orgId, storeId: s, effectiveFrom: '2026-01-01' }),
    );
  }

  const employment = await asOrg(orgId, (tx) =>
    createEmployment(tx, admin, {
      storeId: store!.id,
      personId: worker!.id,
      employmentStatus: 'regular',
      startedOn: '2026-01-05',
    }),
  );
  const colleague = await asOrg(orgId, (tx) =>
    createEmployment(tx, admin, {
      storeId: store!.id,
      personId: worker2!.id,
      employmentStatus: 'regular',
      startedOn: '2026-01-05',
    }),
  );
  const { terminal } = await asOrg(orgId, (tx) =>
    provisionTerminal(tx, admin, driver, { storeId: store!.id, label: 'Counter' }),
  );
  await asOrg(orgId, (tx) => activateTerminal(tx, { terminalId: terminal.id }));

  return {
    orgId,
    storeId: store!.id,
    otherStoreId: other!.id,
    admin,
    cashier: actor(orgId, staffP!.id),
    employment,
    colleague,
    terminal,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Enrol, then backdate — every punch in this suite lands on yesterday's shift day. */
async function enrolCardBackdated(f: Fixture, cardId: string, employmentId?: string) {
  const row = await asOrg(f.orgId, (tx) =>
    enrolCard(tx, f.admin, { employmentId: employmentId ?? f.employment.id, cardId }),
  );
  await sql`update attendance_credentials set enrolled_at = now() - interval '30 days'
            where id = ${row.id}`;
  return row;
}

const punch = (f: Fixture, cardId: string, over: Record<string, unknown> = {}) => ({
  clientPunchId: uid('cp'),
  occurredAt: at(14),
  deviceId: f.terminal.id,
  storeId: f.storeId,
  credentialKind: 'card',
  credentialRef: cardId,
  method: 'qr',
  assertedIntent: 'in',
  ...over,
});

const ingest = (f: Fixture, events: unknown[]) => asOrg(f.orgId, (tx) => ingestEvents(tx, events));

// ---------------------------------------------------------------------------------------

describe('T-164 invariant 1 — one live card, one owner', () => {
  it('the same card cannot be enrolled to two people at once', async () => {
    const f = await fixture('dup');
    const card = uid('c');
    await enrolCardBackdated(f, card);
    await expect(enrolCardBackdated(f, card, f.colleague.id)).rejects.toBeInstanceOf(CredentialError);
  });

  it('⭐ but a REVOKED card id may be reissued — a lost badge gets reprinted', async () => {
    const f = await fixture('reissue');
    const card = uid('c');
    const first = await enrolCardBackdated(f, card);
    await asOrg(f.orgId, (tx) =>
      revokeCredential(tx, f.admin, { credentialId: first.id, reason: 'Lost by the staffer.' }),
    );
    // The partial index is what allows this: uniqueness applies only to LIVE rows.
    const reissued = await enrolCardBackdated(f, card, f.colleague.id);
    expect(reissued.id).not.toBe(first.id);
  });
});

describe('⛔ T-164 invariant 2 — a face credential cannot be expressed', () => {
  it('the constraint refuses it, so no publisher can ever leak a face template', async () => {
    const f = await fixture('face');
    // Bible §5.3, after the 2026-07-04 exfiltration finding: face is "never mirrored, never cached,
    // never bundled". Everything in this table is published, so the kind must not exist at all.
    await expect(
      sql`insert into attendance_credentials (org_id, store_id, employment_id, kind, card_id, enrolled_by)
          values (${f.orgId}, ${f.storeId}, ${f.employment.id}, 'face', 'x', ${f.admin.personId})`,
    ).rejects.toThrow(/attendance_credentials_kind_check/);
  });
});

describe('T-164 invariants 3 & 4 — the mirror, and what it deliberately omits', () => {
  it('enrolling publishes to biometricMirror; revoking publishes a TOMBSTONE', async () => {
    const f = await fixture('mirror');
    const published: MirrorDocument[] = [];
    const mirror = { publish: async (docs: readonly MirrorDocument[]) => { published.push(...docs); } };

    const card = uid('c');
    const cred = await enrolCardBackdated(f, card);
    await asOrg(f.orgId, (tx) => drainOutbox(tx, mirror));

    const doc = published.find((d) => d.path.includes('biometricMirror'));
    expect(doc).toBeDefined();
    expect(doc!.path).toBe(`biometricMirror/${f.storeId}/credentials/${cred.id}`);
    expect(doc!.deleted).toBe(false);
    expect((doc!.data as Record<string, unknown>).cardId).toBe(card);

    published.length = 0;
    await asOrg(f.orgId, (tx) =>
      revokeCredential(tx, f.admin, { credentialId: cred.id, reason: 'Staffer left.' }),
    );
    await asOrg(f.orgId, (tx) => drainOutbox(tx, mirror));

    const tomb = published.find((d) => d.path.includes('biometricMirror'));
    // ⛔ A hard delete is invisible to a device that was offline when it happened — it keeps the
    // stale badge forever. The tombstone is how a terminal LEARNS the credential died.
    expect(tomb!.deleted).toBe(true);
  });

  it('⛔ the credential document carries no name, staff code or position', async () => {
    const f = await fixture('nopii');
    const published: MirrorDocument[] = [];
    const mirror = { publish: async (docs: readonly MirrorDocument[]) => { published.push(...docs); } };
    await enrolCardBackdated(f, uid('c'));
    await asOrg(f.orgId, (tx) => drainOutbox(tx, mirror));

    const doc = published.find((d) => d.path.includes('biometricMirror'))!;
    const keys = Object.keys(doc.data as Record<string, unknown>);
    // Identity lives on the roster, which every store member may read. Duplicating it behind the
    // terminal-only wall buys nothing and gives two documents the chance to disagree.
    expect(keys).not.toContain('displayName');
    expect(keys).not.toContain('staffCode');
    expect(keys).not.toContain('position');
  });
});

describe('⭐⭐ T-164 invariants 5-8 — the SERVER resolves the credential', () => {
  it('an event naming a card becomes that card owner’s punch, with no employmentId sent', async () => {
    const f = await fixture('resolve');
    const card = uid('c');
    await enrolCardBackdated(f, card);

    const report = await ingest(f, [punch(f, card)]);
    expect(report.ingested).toBe(1);

    const [row] = await sql<{ employment_id: string }[]>`
      select employment_id from attendance_punches where org_id = ${f.orgId}`;
    // ⭐ The device never said whose punch this was. The server decided.
    expect(row!.employment_id).toBe(f.employment.id);
  });

  it('6. a card nobody enrolled is quarantined, not guessed at', async () => {
    const f = await fixture('unknown');
    const report = await ingest(f, [punch(f, uid('never'))]);
    expect(report.byReason.unknown_credential).toBe(1);
    expect(report.ingested).toBe(0);
  });

  it('⭐⭐ 7. a punch BEFORE a revocation ingests; one AFTER it does not', async () => {
    const f = await fixture('revwindow');
    const card = uid('c');
    const cred = await enrolCardBackdated(f, card);

    // Revoke as of the middle of yesterday's shift.
    await asOrg(f.orgId, (tx) =>
      revokeCredential(tx, f.admin, { credentialId: cred.id, reason: 'Badge lost.' }),
    );
    await sql`update attendance_credentials set revoked_at = ${new Date(at(15)).toISOString()}
              where id = ${cred.id}`;

    // 14:00 — before it died. A real person with a live badge; the revocation had not happened yet.
    const before = await ingest(f, [punch(f, card, { occurredAt: at(14) })]);
    expect(before.ingested).toBe(1);

    // ⛔ 16:00 — after. This is the half v1 could not say: a terminal offline for a week still
    // holds the badge in its mirror, and the server refuses it anyway.
    const after = await ingest(f, [punch(f, card, { occurredAt: at(16) })]);
    expect(after.ingested).toBe(0);
    expect(after.byReason.unknown_credential).toBe(1);
  });

  it('8. a credential belonging to another store’s employment is refused', async () => {
    const f = await fixture('xstore');
    const elsewhere = await asOrg(f.orgId, (tx) =>
      createEmployment(tx, f.admin, {
        storeId: f.otherStoreId,
        personId: f.colleague.personId,
        employmentStatus: 'regular',
        startedOn: '2026-01-05',
      }),
    );
    const card = uid('c');
    await enrolCardBackdated(f, card, elsewhere.id);

    // The terminal is at `storeId`; the credential lives at `otherStoreId`.
    const report = await ingest(f, [punch(f, card)]);
    expect(report.ingested).toBe(0);
    expect(report.byReason.unknown_credential).toBe(1);
  });

  it('⛔ a device cannot file a `manual` entry, nor a `face` punch', async () => {
    const f = await fixture('methods');
    const card = uid('c');
    await enrolCardBackdated(f, card);
    // A manual entry is a back-office act with a named human behind it (T-156); a face template is
    // never mirrored, so no device can have matched one locally.
    const report = await ingest(f, [
      punch(f, card, { method: 'manual' }),
      punch(f, card, { method: 'face' }),
    ]);
    expect(report.byReason.malformed).toBe(2);
    expect(report.ingested).toBe(0);
  });
});

describe('T-164 invariant 9 — re-enrolling a fingerprint ROTATES the token', () => {
  it('the old token stops resolving the moment the finger is enrolled again', async () => {
    const f = await fixture('rotate');
    const first = await asOrg(f.orgId, (tx) =>
      enrolFingerprint(tx, f.admin, { employmentId: f.employment.id, templates: ['dGVtcA=='] }),
    );
    await sql`update attendance_credentials set enrolled_at = now() - interval '30 days'
              where id = ${first.id}`;

    const second = await asOrg(f.orgId, (tx) =>
      enrolFingerprint(tx, f.admin, { employmentId: f.employment.id, templates: ['dGVtcDI='] }),
    );
    await sql`update attendance_credentials set enrolled_at = now() - interval '30 days'
              where id = ${second.id}`;
    expect(second.matchToken).not.toBe(first.matchToken);

    // Pin the rotation to a known instant rather than racing the wall clock: the rotation revoked
    // the old row at now(), so "now minus a minute" would land BEFORE it and legitimately resolve.
    await sql`update attendance_credentials set revoked_at = ${new Date(at(12)).toISOString()}
              where id = ${first.id}`;

    // ⭐ v1's own M5 fix, kept: a template lifted off a device stops working GOING FORWARD once the
    // finger is re-enrolled. `now` is after the rotation, so the old token is dead.
    const stale = await ingest(f, [
      punch(f, first.matchToken!, {
        credentialKind: 'fingerprint',
        method: 'fingerprint',
        occurredAt: at(14),
      }),
    ]);
    expect(stale.ingested).toBe(0);
    expect(stale.byReason.unknown_credential).toBe(1);

    const fresh = await ingest(f, [
      punch(f, second.matchToken!, {
        credentialKind: 'fingerprint',
        method: 'fingerprint',
        occurredAt: at(14),
      }),
    ]);
    expect(fresh.ingested).toBe(1);
  });

  it('⚠️ the residual, stated rather than discovered: a BACKDATED punch on the old token resolves', async () => {
    // Every credential is judged as of the punch's own timestamp (invariant 7), and that one rule
    // has a consequence here: a punch dated BEFORE the rotation still resolves against the old
    // token, because at that moment the token really was live.
    //
    // ⚠️ Kept deliberately, as one rule rather than a special case for rotation, and the residual
    // is bounded in three ways worth naming:
    //   1. Writing to the inbox at all requires a PROVISIONED TERMINAL (the rules check
    //      `request.auth.token.deviceId`), so a lifted template alone is not enough — which is
    //      already strictly better than v1, where possession of the token WAS the authorisation.
    //   2. The punch lands on a past shift day, where T-157 flags `late_event_arrival` and a
    //      manager confirms it before it can pay.
    //   3. Forward-in-time is closed absolutely, which is the half that let v1's leaked token
    //      punch indefinitely.
    //
    // ⛔ This test exists so the behaviour is a decision on the record, not a discovery later.
    const f = await fixture('rotate-backdate');
    const first = await asOrg(f.orgId, (tx) =>
      enrolFingerprint(tx, f.admin, { employmentId: f.employment.id, templates: ['dGVtcA=='] }),
    );
    await sql`update attendance_credentials set enrolled_at = now() - interval '30 days'
              where id = ${first.id}`;
    await asOrg(f.orgId, (tx) =>
      enrolFingerprint(tx, f.admin, { employmentId: f.employment.id, templates: ['dGVtcDI='] }),
    );

    const backdated = await ingest(f, [
      punch(f, first.matchToken!, { credentialKind: 'fingerprint', method: 'fingerprint' }),
    ]);
    expect(backdated.ingested).toBe(1);
  });

  it('at most two fingers', async () => {
    const f = await fixture('fingers');
    await expect(
      asOrg(f.orgId, (tx) =>
        enrolFingerprint(tx, f.admin, {
          employmentId: f.employment.id,
          templates: ['a', 'b', 'c'],
        }),
      ),
    ).rejects.toBeInstanceOf(CredentialError);
    expect(MAX_TEMPLATES).toBe(2);
  });
});

describe('⛔ T-164 invariant 10 — no app surface returns a secret', () => {
  it('listCredentials gives a manager metadata and a hint, never the card id', async () => {
    const f = await fixture('nosecret');
    const card = uid('cardvalue');
    await enrolCardBackdated(f, card);
    await asOrg(f.orgId, (tx) =>
      enrolFingerprint(tx, f.admin, { employmentId: f.employment.id, templates: ['dGVtcA=='] }),
    );

    const list = await asOrg(f.orgId, (tx) =>
      listCredentials(tx, f.admin, { employmentId: f.employment.id }),
    );
    expect(list).toHaveLength(2);

    const serialised = JSON.stringify(list);
    // ⭐ This is the structural close of v1's widest credential hole:
    // `listFingerprintTemplatesAction` is gated to ANY store member and returns every staffer's raw
    // template and match token. Here there is no such call — and what does exist leaks nothing.
    expect(serialised).not.toContain(card);
    expect(serialised).not.toContain('dGVtcA==');
    expect(serialised).not.toContain('matchToken');

    const cardRow = list.find((c) => c.kind === 'card')!;
    // A hint, so two badges can be told apart on screen. Not enough to clone one.
    expect(cardRow.cardHint).toBe(`…${card.slice(-4)}`);
    expect(list.find((c) => c.kind === 'fingerprint')!.fingerCount).toBe(1);
  });

  it('a cashier may not enrol a credential', async () => {
    const f = await fixture('gate');
    await expect(
      asOrg(f.orgId, (tx) =>
        enrolCard(tx, f.cashier, { employmentId: f.employment.id, cardId: uid('c') }),
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('a badge cannot be enrolled for somebody who has left', async () => {
    const f = await fixture('ended');
    await asOrg(f.orgId, (tx) =>
      endEmployment(tx, f.admin, {
        employmentId: f.employment.id,
        endedOn: '2026-06-30',
        employmentStatus: 'resigned',
      }),
    );
    // That is exactly the credential that punches unnoticed.
    await expect(enrolCardBackdated(f, uid('c'))).rejects.toBeInstanceOf(CredentialError);
  });

  it('revoking needs a reason', async () => {
    const f = await fixture('reason');
    const cred = await enrolCardBackdated(f, uid('c'));
    await expect(
      asOrg(f.orgId, (tx) =>
        revokeCredential(tx, f.admin, { credentialId: cred.id, reason: '  ' }),
      ),
    ).rejects.toBeInstanceOf(CredentialError);
  });
});
