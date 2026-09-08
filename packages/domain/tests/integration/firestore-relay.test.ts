import { config } from 'dotenv';
import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-204 — the Firestore sync relay's orchestration. `docs/tasks/204-firestore-sync-relay-and-day-bootstrap.md`.
 *
 * ⭐ This suite is about the ORCHESTRATION (org resolution, per-org bookkeeping, the RLS-principal
 * switch), not about re-proving `drainOutbox`/`ingestEvents`'s own logic — `mirror-publisher.test.ts`
 * and `inbox-ingestor.test.ts` already do that. Inbox fixtures here deliberately use an
 * UNKNOWN device id, so an event quarantines cleanly without needing a full terminal/credential
 * fixture per org — `quarantined` is just as "decided" an outcome as `ingested` for everything
 * this suite actually checks (grouping, stamping, the scheduler_runs row).
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
  runFirestoreRelay,
  seedAttendanceConfig,
  seedCanonicalPositions,
  type InboxDriver,
  type MirrorDocument,
  type MirrorDriver,
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
  const code = uid(`fr-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const [admin] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${admin!.id}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${admin!.id}, ${store!.id})`;
  const [worker] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Maria Santos') returning id`;
  await asOrg(orgId, (tx) => seedCanonicalPositions(tx, orgId));
  await asOrg(orgId, (tx) =>
    seedAttendanceConfig(tx, { orgId, storeId: store!.id, effectiveFrom: '2026-01-01' }),
  );
  // Clear the seed's own outbox noise so each test starts from a known queue, matching
  // mirror-publisher.test.ts's own convention.
  await sql`delete from mirror_outbox where org_id = ${orgId}`;
  return { orgId, storeId: store!.id, admin: actor(orgId, admin!.id), workerId: worker!.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** One roster row on the outbox, via a real employment. */
async function enqueueRosterRow(f: Fixture): Promise<void> {
  await asOrg(f.orgId, (tx) =>
    createEmployment(tx, f.admin, {
      storeId: f.storeId,
      personId: f.workerId,
      employmentStatus: 'regular',
      startedOn: '2026-01-05',
    }),
  );
}

function fakeMirrorDriver() {
  const written: MirrorDocument[] = [];
  const driver: MirrorDriver = {
    async publish(documents) {
      written.push(...documents);
    },
  };
  return { driver, written };
}

interface InboxDoc {
  docId: string;
  data: unknown;
  processedAt: Date | null;
  punchId: string | null;
}

function fakeInboxDriver(seedDocs: { docId: string; data: unknown }[]) {
  const docs: InboxDoc[] = seedDocs.map((d) => ({ ...d, processedAt: null, punchId: null }));
  const marks: { docId: string; punchId: string | null }[] = [];
  const driver: InboxDriver = {
    async readUnprocessed({ limit }) {
      return docs
        .filter((d) => d.processedAt === null)
        .slice(0, limit)
        .map((d) => ({ docId: d.docId, data: d.data }));
    },
    async markProcessed({ docId, punchId }) {
      const d = docs.find((x) => x.docId === docId);
      if (d) {
        d.processedAt = new Date();
        d.punchId = punchId;
      }
      marks.push({ docId, punchId });
    },
  };
  return { driver, docs, marks };
}

/** An event shaped well enough to clear `shapeErrors`, aimed at an UNKNOWN device on purpose. */
function inboxEvent(storeId: string, over: Record<string, unknown> = {}) {
  return {
    clientPunchId: uid('cp'),
    occurredAt: Date.now(),
    deviceId: '00000000-0000-0000-0000-0000000000ff',
    storeId,
    credentialKind: 'card',
    credentialRef: uid('card'),
    method: 'qr',
    assertedIntent: 'in',
    ...over,
  };
}

// -------------------------------------------------------------------------------------

describe('T-204 — runFirestoreRelay: mirror_publish is genuinely per-org', () => {
  /**
   * ⚠️ **Deliberately TWO scoped calls (`options.orgId` set), never one unscoped call.**
   * `shareat_test_204` is a SHARED database — other integration test files (notably
   * `mirror-publisher.test.ts`) run concurrently against it and carry their OWN pending
   * `mirror_outbox` rows. An unscoped `runFirestoreRelay` call legitimately drains every org's
   * outbox in one pass (matching production), which means it would ALSO drain and mark-published
   * whatever those other files' fixtures were mid-way through — exactly the shared-state hazard
   * bible §3.4/row 94 warns about, generalised from "two agents" to "two test files in one run".
   * Scoping each call to one known org id proves the same RLS-isolation and per-org bookkeeping
   * without ever touching a single row this test didn't create.
   */
  it('drains each org under its OWN RLS principal, and a zero-work org still gets a scheduler_runs row', async () => {
    const a = await fixture('mp-a');
    const b = await fixture('mp-b'); // never gets an employment — nothing to publish

    await enqueueRosterRow(a);

    const { driver: mirror, written } = fakeMirrorDriver();
    const inbox: InboxDriver = { async readUnprocessed() { return []; }, async markProcessed() {} };

    const resultA = await runFirestoreRelay({ mirror, inbox }, { trigger: 'manual', orgId: a.orgId, limit: 500 });
    const resultB = await runFirestoreRelay({ mirror, inbox }, { trigger: 'manual', orgId: b.orgId, limit: 500 });

    const aOut = resultA.outcomes.find((o) => o.orgId === a.orgId && o.job === 'mirror_publish');
    const bOut = resultB.outcomes.find((o) => o.orgId === b.orgId && o.job === 'mirror_publish');
    expect(aOut).toBeDefined();
    expect(bOut).toBeDefined();
    expect(aOut!.posted).toBeGreaterThanOrEqual(1);
    expect(bOut!.posted).toBe(0);
    expect(bOut!.skipped).toBe(0);
    expect(bOut!.failed).toBe(0);

    // ⭐ RLS actually scoped the drain — org B's run published nothing of org A's (it has no
    // outbox rows of its own), and every doc org A's run DID publish names only org A's store.
    expect(written.length).toBeGreaterThanOrEqual(1);
    expect(written.every((d) => d.path.includes(a.storeId))).toBe(true);

    // ⭐ DEF-044's own rule: "it ran and did nothing" still writes a row, for BOTH orgs.
    const runs = await sql<{ org_id: string; job: string; posted_count: number }[]>`
      select org_id, job, posted_count from scheduler_runs
      where org_id in (${a.orgId}, ${b.orgId}) and job = 'mirror_publish'`;
    expect(runs).toHaveLength(2);
  });
});

describe('T-204 — runFirestoreRelay: inbox_relay resolves events to their org by storeId', () => {
  it('groups by the resolved org, and an event whose storeId matches no store is left un-stamped and excluded', async () => {
    const a = await fixture('ir-a');
    const b = await fixture('ir-b');

    const eventA = inboxEvent(a.storeId);
    const eventB = inboxEvent(b.storeId);
    const unresolved = inboxEvent('00000000-0000-0000-0000-000000000abc');

    const { driver: mirror } = fakeMirrorDriver();
    const { driver: inbox, docs, marks } = fakeInboxDriver([
      { docId: uid('doc'), data: eventA },
      { docId: uid('doc'), data: eventB },
      { docId: uid('doc'), data: unresolved },
    ]);

    const result = await runFirestoreRelay({ mirror, inbox }, { trigger: 'manual', limit: 500 });

    // Both known-store events were DECIDED (quarantined — unknown_device — but decided) and
    // therefore stamped.
    expect(marks.some((m) => m.docId === docs[0]!.docId)).toBe(true);
    expect(marks.some((m) => m.docId === docs[1]!.docId)).toBe(true);
    // The unresolved-store event was never even attempted, per §3 step 3 — left un-stamped so a
    // future run (when the store might exist) retries it.
    expect(marks.some((m) => m.docId === docs[2]!.docId)).toBe(false);
    expect(docs[2]!.processedAt).toBeNull();

    const outcomeFor = (orgId: string) =>
      result.outcomes.find((o) => o.orgId === orgId && o.job === 'inbox_relay');
    const aOut = outcomeFor(a.orgId);
    const bOut = outcomeFor(b.orgId);
    expect(aOut!.failed).toBe(1); // one quarantined event: unknown_device
    expect(bOut!.failed).toBe(1);
    expect(aOut!.failures[0]!.reason).toMatch(/unknown_device/);

    // ⭐ A scheduler_runs row per org per job — including the unresolved event's non-existent
    // "org", which correctly gets none at all (nothing to attribute it to).
    const runs = await sql<{ org_id: string }[]>`
      select org_id from scheduler_runs where org_id in (${a.orgId}, ${b.orgId}) and job = 'inbox_relay'`;
    expect(runs).toHaveLength(2);
  });

  it('running the relay twice in a row with no new data changes nothing on the second pass', async () => {
    const a = await fixture('ir-idem');
    const eventA = inboxEvent(a.storeId);
    const { driver: mirror } = fakeMirrorDriver();
    const { driver: inbox } = fakeInboxDriver([{ docId: uid('doc'), data: eventA }]);

    const first = await runFirestoreRelay({ mirror, inbox }, { trigger: 'manual' });
    const second = await runFirestoreRelay({ mirror, inbox }, { trigger: 'manual' });

    const firstInbox = first.outcomes.find((o) => o.orgId === a.orgId && o.job === 'inbox_relay');
    const secondInbox = second.outcomes.find((o) => o.orgId === a.orgId && o.job === 'inbox_relay');
    expect(firstInbox!.failed).toBe(1);
    // The event is already stamped `processedAt` — the fake driver's `readUnprocessed` no longer
    // returns it, so the second run sees nothing for this org at all.
    expect(secondInbox!.posted).toBe(0);
    expect(secondInbox!.skipped).toBe(0);
    expect(secondInbox!.failed).toBe(0);

    const firstMirror = first.outcomes.find((o) => o.orgId === a.orgId && o.job === 'mirror_publish');
    const secondMirror = second.outcomes.find((o) => o.orgId === a.orgId && o.job === 'mirror_publish');
    expect(secondMirror!.posted).toBe(0);
    expect(secondMirror!.failed).toBe(0);
    void firstMirror;
  });
});

describe('T-204 / DEF-227 — a failed org-resolution read must not reject the whole relay', () => {
  /**
   * ⛔ DEF-227: `runInboxRelayJobs`'s pre-loop `storesRepo.orgIdsForStoreIds` read (resolving every
   * event's `storeId` to an org BEFORE any per-org work starts) was awaited outside any try — the
   * last "one failure kills the whole run" shape T-233 left in this file, identical to the
   * `driver.readUnprocessed` failure one block above it, which already IS wrapped.
   *
   * ⭐ No migration, no test-local trigger needed: `stores.id` is `uuid`, and a malformed storeId on
   * an inbox event reaches `inArray(stores.id, [...])` with client-side validation, so Postgres
   * itself refuses it — "invalid input syntax for type uuid" — a naturally-occurring failure shape,
   * not a synthetic one. ⚠️ Deliberately UNSCOPED (no `options.orgId`), matching DEF-227's real
   * shape: the read is one global lookup before the org loop, so every org in this lane's database
   * must be observed to get a row from ONE call — the same reason the idempotency test above this
   * one also calls unscoped.
   */
  it('a malformed storeId does not reject the relay, and every org still gets an inbox_relay row', async () => {
    const a = await fixture('def227-a');
    const b = await fixture('def227-b');

    const { driver: mirror } = fakeMirrorDriver();
    const { driver: inbox } = fakeInboxDriver([
      { docId: uid('doc'), data: inboxEvent('not-a-valid-uuid') },
    ]);

    // The assertion to watch fail before the fix: today this call REJECTS.
    const result = await runFirestoreRelay({ mirror, inbox }, { trigger: 'manual' });

    expect(result.hadFailures).toBe(true);

    const inboxOutcomeFor = (orgId: string) =>
      result.outcomes.find((o) => o.orgId === orgId && o.job === 'inbox_relay');
    const aInbox = inboxOutcomeFor(a.orgId);
    const bInbox = inboxOutcomeFor(b.orgId);
    expect(aInbox).toBeDefined();
    expect(bInbox).toBeDefined();
    expect(aInbox!.error).toMatch(/uuid/i);
    expect(bInbox!.error).toMatch(/uuid/i);
    expect(aInbox!.posted).toBe(0);
    expect(bInbox!.posted).toBe(0);

    // ⭐ Lane A (mirror_publish) already ran, per-org, BEFORE Lane B's pre-loop read — its outcomes
    // must survive too. Before the fix they did not, because the whole promise rejected and the
    // caller never received the `outcomes` array at all, mirror_publish rows included.
    const mirrorOutcomeFor = (orgId: string) =>
      result.outcomes.find((o) => o.orgId === orgId && o.job === 'mirror_publish');
    expect(mirrorOutcomeFor(a.orgId)).toBeDefined();
    expect(mirrorOutcomeFor(b.orgId)).toBeDefined();

    // DEF-044's rule still applies: a run row exists per org per job, including this failed one —
    // `failRun` recorded it, the same as the `readUnprocessed` failure path one block above.
    // ⚠️ Asserting row COUNT alone would also pass a row that was merely started and never closed —
    // this must prove `failRun` actually ran, not just `startRun`: outcome = 'failed' AND
    // finished_at is set (a started-but-abandoned row has neither).
    const runs = await sql<{ org_id: string; outcome: string; finished_at: Date | null }[]>`
      select org_id, outcome, finished_at from scheduler_runs
      where org_id in (${a.orgId}, ${b.orgId}) and job = 'inbox_relay'`;
    expect(runs).toHaveLength(2);
    for (const run of runs) {
      expect(run.outcome).toBe('failed');
      expect(run.finished_at).not.toBeNull();
    }
  });
});
