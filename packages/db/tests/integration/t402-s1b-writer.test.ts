import { config } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-402 S1b - the audit writer against real Postgres. docs/tasks/402-activity-log.md R1, R2, R5, R9-R11, R14,
 * Contract 1; Invariants 1, 2, 5, 6, 7, 8, 10 (+ the reserved rule, the actor rule, the occurred_at/device passthrough).
 * TESTER, not BUILDER. Run on the lane DB shareat_test_t402 (S1a's migration 0197 is applied there).
 *
 * ## State at HEAD (read before judging the red)
 * - `packages/db/src/audit/catalogue.ts` does not exist -> the import below fails: the WHOLE file is red with
 *   "Failed to resolve import ../../src/audit/catalogue". That is the single root cause until the builder writes it.
 * - Once it resolves, the judging assertions are: the stored labels equal the catalogue entry; UNKNOWN_AUDIT_ACTION /
 *   AUDIT_ACTION_RESERVED / AUDIT_SCOPE_MISMATCH / AUDIT_ACTOR_MISMATCH are in the thrown message; redaction; cap.
 *
 * ## Names the BUILDER must match (packages/db/src/repo/audit-log.ts)
 *   append(tx, orgId, { actorPersonId, action, storeId, entityId, before, after, source, deviceId?, occurredAt? }) -> { id }
 *       (NO `entity` field: it comes from the catalogue)
 *   appendSystem(tx, orgId, { action, storeId, entityId, before, after, source }) -> { id }   (actor_person_id null)
 *   appendClientEvent(tx, orgId, envelope, attested) is exported (S3 owns its behaviour)
 *   Error codes appear in the thrown message (like UNKNOWN_AUDIT_ACTION today): UNKNOWN_AUDIT_ACTION,
 *   AUDIT_ACTION_RESERVED (a `reserved` entry cannot be written - the one code this spec leaves unnamed; I chose it),
 *   AUDIT_SCOPE_MISMATCH, AUDIT_ACTOR_MISMATCH.
 *   redacted_keys: the written paths. I accept either 'pin' or 'after.pin' (a path with the side prefix) - see hasPath().
 *   Masked account number: '••••' + last 4; the sibling '<key>Changed' boolean sits in the SAME object (after, and before).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { APP_ROLE, closeDb, transaction, type Tx } from '../../src';
import * as repo from '../../src/repo/audit-log';
import { AUDIT_CATALOGUE, catalogueEntry, retentionFor, severityFor } from '../../src/audit/catalogue';

const sql = postgres(url, { max: 4 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  await sql.end({ timeout: 5 });
  await closeDb();
});

type AnyRepo = {
  append: (tx: Tx, orgId: string, input: Record<string, unknown>) => Promise<{ id: string }>;
  appendSystem?: (tx: Tx, orgId: string, input: Record<string, unknown>) => Promise<{ id: string }>;
  appendClientEvent?: unknown;
  latestForEntity: (tx: Tx, orgId: string, input: { entity: string; entityId: string; action: string }) => Promise<unknown>;
};
const R = repo as unknown as AnyRepo;

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

async function fixture(hint: string) {
  const code = uid(`t402w-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Actor') returning id`;
  const [d] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Terminal') returning id`;
  return { orgId, storeId: store!.id, actor: p!.id, device: d!.id };
}
type Fx = Awaited<ReturnType<typeof fixture>>;

interface Row {
  id: string;
  org_id: string;
  store_id: string | null;
  actor_person_id: string | null;
  action: string;
  entity: string;
  entity_id: string;
  before: unknown;
  after: Record<string, unknown> | null;
  source: string;
  category: string;
  sensitivity: string;
  severity: number;
  retention_class: string;
  recorded_at: Date;
  occurred_at: Date;
  device_id: string | null;
  redacted_keys: string[];
  clock_suspect: boolean;
}
const rowsFor = (entityId: string) => sql<Row[]>`select * from audit_log where entity_id = ${entityId} order by recorded_at`;

async function thrown(p: Promise<unknown>): Promise<Error | undefined> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  return undefined;
}

/** Accepts 'pin' or 'after.pin' / 'before.pin'. */
const hasPath = (keys: string[], path: string) => keys.some((k) => k === path || k === `after.${path}` || k === `before.${path}`);

const LEGACY_ACTION = 'set_channel_payout';
const writable = AUDIT_CATALOGUE.filter((e) => !e.reserved);

describe('Invariant 1 - an unknown action is refused and inserts nothing', () => {
  it('UNKNOWN_AUDIT_ACTION in the message; no row (mutant: writer accepts any string)', async () => {
    const f = await fixture('inv1');
    const entityId = randomUUID();
    const err = await thrown(
      asOrg(f.orgId, (tx) =>
        R.append(tx, f.orgId, { actorPersonId: f.actor, action: 'made.up_action', storeId: f.storeId, entityId, before: null, after: { a: 1 }, source: 'web' }),
      ),
    );
    expect(err?.message ?? 'did not throw').toMatch(/UNKNOWN_AUDIT_ACTION/);
    expect(await rowsFor(entityId)).toHaveLength(0);
  });
});

describe('a reserved entry cannot be written (R2)', () => {
  it('every reserved entry that a person can write is refused with AUDIT_ACTION_RESERVED and leaves no row', async () => {
    const f = await fixture('reserved');
    const reserved = AUDIT_CATALOGUE.filter((e) => e.reserved && e.actor !== 'system');
    expect(reserved.length, 'the catalogue ships S2/S3/POS/customer entries reserved').toBeGreaterThan(20);
    for (const e of reserved) {
      const entityId = randomUUID();
      const err = await thrown(
        asOrg(f.orgId, (tx) =>
          R.append(tx, f.orgId, { actorPersonId: f.actor, action: e.action, storeId: e.scope === 'store' ? f.storeId : null, entityId, before: null, after: { a: 1 }, source: 'web' }),
        ),
      );
      expect(err?.message ?? `${e.action}: did not throw`, e.action).toMatch(/AUDIT_ACTION_RESERVED/);
      expect(await rowsFor(entityId), e.action).toHaveLength(0);
    }
  });

  it('appendSystem refuses a reserved system entry too, and appendClientEvent exists as a function (S3 fills it in)', async () => {
    const f = await fixture('reserved2');
    expect(typeof R.appendSystem, 'appendSystem exported').toBe('function');
    expect(typeof R.appendClientEvent, 'appendClientEvent exported').toBe('function');
    const sys = AUDIT_CATALOGUE.find((e) => e.reserved && e.actor === 'system');
    if (!sys) return; // none catalogued as system-only at S1b: nothing more to prove here
    const err = await thrown(
      asOrg(f.orgId, (tx) =>
        R.appendSystem!(tx, f.orgId, { action: sys.action, storeId: sys.scope === 'store' ? f.storeId : null, entityId: randomUUID(), before: null, after: {}, source: 'cron' }),
      ),
    );
    expect(err?.message ?? 'did not throw').toMatch(/AUDIT_ACTION_RESERVED/);
  });
});

describe('Invariant 2 - category, sensitivity, severity, retention and entity come from the catalogue, for every writable entry', () => {
  it('writes every non-reserved entry once; each stored row equals its catalogue entry (mutant: input field honoured; retention from sensitivity alone)', async () => {
    expect(writable.length, 'at least the 48 legacy entries are live').toBeGreaterThanOrEqual(48);
    const f = await fixture('inv2');
    const written: Array<{ action: string; entityId: string }> = [];
    await asOrg(f.orgId, async (tx) => {
      for (const e of writable) {
        const entityId = randomUUID();
        const input = { action: e.action, storeId: e.scope === 'store' ? f.storeId : null, entityId, before: null, after: { n: 1 }, source: 'web' };
        if (e.actor === 'system') await R.appendSystem!(tx, f.orgId, { ...input, source: 'cron' });
        else await R.append(tx, f.orgId, { ...input, actorPersonId: f.actor });
        written.push({ action: e.action, entityId });
      }
    });
    for (const w of written) {
      const e = catalogueEntry(w.action)!;
      const [row] = await rowsFor(w.entityId);
      expect(row, `${w.action} wrote no row`).toBeDefined();
      expect(row!.action).toBe(e.action);
      expect(row!.entity, `${w.action} entity`).toBe(e.entity);
      expect(row!.category, `${w.action} category`).toBe(e.category);
      expect(row!.sensitivity, `${w.action} sensitivity`).toBe(e.sensitivity);
      expect(row!.severity, `${w.action} severity`).toBe(severityFor(e.sensitivity));
      expect(row!.retention_class, `${w.action} retention`).toBe(e.retention);
      expect(row!.retention_class).toBe(retentionFor(e.category, e.sensitivity));
      expect(row!.store_id, `${w.action} store_id by scope`).toBe(e.scope === 'store' ? f.storeId : null);
      expect(row!.actor_person_id, `${w.action} actor`).toBe(e.actor === 'system' ? null : f.actor);
      expect(row!.org_id).toBe(f.orgId);
      expect(row!.redacted_keys).toEqual([]);
      expect(row!.clock_suspect).toBe(false);
    }
  });

  it('a caller cannot choose the labels: category/sensitivity/entity in the input do not type-check and are ignored at runtime', async () => {
    const f = await fixture('inv2b');
    const e = catalogueEntry(LEGACY_ACTION)!;
    const entityId = randomUUID();
    await asOrg(f.orgId, (tx) =>
      repo.append(tx, f.orgId, {
        actorPersonId: f.actor,
        action: LEGACY_ACTION,
        storeId: e.scope === 'store' ? f.storeId : null,
        entityId,
        before: null,
        after: { a: 1 },
        source: 'web',
        // @ts-expect-error - the input type has no `category` field (Invariant 2); TS reports only the first excess key,
        category: 'order',
        // so the rest ride in by spread (also what a JS caller or a cast could do) and must be ignored at runtime:
        ...({ sensitivity: 'critical', entity: 'something_else', retentionClass: 'r2y', severity: 2 } as object),
      }),
    );
    const [row] = await rowsFor(entityId);
    expect(row!.category).toBe(e.category);
    expect(row!.sensitivity).toBe(e.sensitivity);
    expect(row!.entity).toBe(e.entity);
  });
});

describe('Invariant 5 / R14 - scope: a store entry needs a store, an org entry must not have one', () => {
  it('AUDIT_SCOPE_MISMATCH both ways; no row (mutant: scope unchecked)', async () => {
    const f = await fixture('inv5');
    const store = writable.find((e) => e.scope === 'store' && e.actor !== 'system');
    const org = writable.find((e) => e.scope === 'org' && e.actor !== 'system');
    expect(store, 'a live store-scoped person entry exists (reopen_pin_sign_in at least)').toBeDefined();
    expect(org, 'a live org-scoped person entry exists (e.g. an org-wide supplier or menu change)').toBeDefined();
    const e1 = randomUUID();
    const err1 = await thrown(
      asOrg(f.orgId, (tx) => R.append(tx, f.orgId, { actorPersonId: f.actor, action: store!.action, storeId: null, entityId: e1, before: null, after: {}, source: 'web' })),
    );
    expect(err1?.message ?? 'did not throw').toMatch(/AUDIT_SCOPE_MISMATCH/);
    expect(await rowsFor(e1)).toHaveLength(0);
    const e2 = randomUUID();
    const err2 = await thrown(
      asOrg(f.orgId, (tx) => R.append(tx, f.orgId, { actorPersonId: f.actor, action: org!.action, storeId: f.storeId, entityId: e2, before: null, after: {}, source: 'web' })),
    );
    expect(err2?.message ?? 'did not throw').toMatch(/AUDIT_SCOPE_MISMATCH/);
    expect(await rowsFor(e2)).toHaveLength(0);
  });
});

describe('R11 - actor rules', () => {
  it('a person-only entry through appendSystem is AUDIT_ACTOR_MISMATCH (and a system-only live entry through append, when one exists)', async () => {
    const f = await fixture('actor');
    const person = writable.find((e) => e.actor === 'person')!;
    expect(person).toBeDefined();
    const err = await thrown(
      asOrg(f.orgId, (tx) =>
        R.appendSystem!(tx, f.orgId, { action: person.action, storeId: person.scope === 'store' ? f.storeId : null, entityId: randomUUID(), before: null, after: {}, source: 'cron' }),
      ),
    );
    expect(err?.message ?? 'did not throw').toMatch(/AUDIT_ACTOR_MISMATCH/);
    const sys = writable.find((e) => e.actor === 'system');
    if (sys) {
      const err2 = await thrown(
        asOrg(f.orgId, (tx) =>
          R.append(tx, f.orgId, { actorPersonId: f.actor, action: sys.action, storeId: sys.scope === 'store' ? f.storeId : null, entityId: randomUUID(), before: null, after: {}, source: 'web' }),
        ),
      );
      expect(err2?.message ?? 'did not throw').toMatch(/AUDIT_ACTOR_MISMATCH/);
    }
  });
});

describe('Invariant 6 - redaction at the writer, on the stored row', () => {
  it('pin, nested passwordHash and Api_Key are [REDACTED]; note kept; redacted_keys lists the three (mutants: top-level only; case-sensitive)', async () => {
    const f = await fixture('inv6');
    const e = catalogueEntry(LEGACY_ACTION)!;
    const entityId = randomUUID();
    await asOrg(f.orgId, (tx) =>
      R.append(tx, f.orgId, {
        actorPersonId: f.actor,
        action: LEGACY_ACTION,
        storeId: e.scope === 'store' ? f.storeId : null,
        entityId,
        before: { sessionId: 'sess-abc', ok: 1 },
        after: { pin: '1234', nested: { passwordHash: 'scrypt$16384$8$1$aa$bb' }, Api_Key: 'x', note: 'ok', pinned: true },
        source: 'web',
      }),
    );
    const [row] = await rowsFor(entityId);
    expect(row!.after).toEqual({ pin: '[REDACTED]', nested: { passwordHash: '[REDACTED]' }, Api_Key: '[REDACTED]', note: 'ok', pinned: true });
    expect(row!.before).toEqual({ sessionId: '[REDACTED]', ok: 1 });
    for (const p of ['pin', 'nested.passwordHash', 'Api_Key', 'sessionId']) expect(hasPath(row!.redacted_keys, p), `redacted_keys has ${p}: ${JSON.stringify(row!.redacted_keys)}`).toBe(true);
    expect(row!.redacted_keys).toHaveLength(4);
    expect(JSON.stringify([row!.before, row!.after])).not.toMatch(/1234|scrypt\$|sess-abc/);
  });

  it('a clean payload records no redacted_keys', async () => {
    const f = await fixture('inv6b');
    const e = catalogueEntry(LEGACY_ACTION)!;
    const entityId = randomUUID();
    await asOrg(f.orgId, (tx) =>
      R.append(tx, f.orgId, { actorPersonId: f.actor, action: LEGACY_ACTION, storeId: e.scope === 'store' ? f.storeId : null, entityId, before: { shipping: 1 }, after: { shipping: 2 }, source: 'web' }),
    );
    expect((await rowsFor(entityId))[0]!.redacted_keys).toEqual([]);
  });
});

describe('R5 / Q6 - bank account numbers keep only the last 4 digits on LIVE writes', () => {
  it('set_supplier_bank_account: before/after masked, Changed flag true, the full numbers appear nowhere in the row', async () => {
    const f = await fixture('bank');
    const e = catalogueEntry('set_supplier_bank_account')!;
    const entityId = randomUUID();
    await asOrg(f.orgId, (tx) =>
      R.append(tx, f.orgId, {
        actorPersonId: f.actor,
        action: 'set_supplier_bank_account',
        storeId: e.scope === 'store' ? f.storeId : null,
        entityId,
        before: { bankName: 'BDO', bankAccountName: 'Acme', bankAccountNumber: '1234567890123' },
        after: { bankName: 'BDO', bankAccountName: 'Acme', bankAccountNumber: '9876543210987' },
        source: 'web',
      }),
    );
    const [row] = await rowsFor(entityId);
    const before = row!.before as Record<string, unknown>;
    const after = row!.after as Record<string, unknown>;
    expect(before.bankAccountNumber).toBe('••••0123');
    expect(after.bankAccountNumber).toBe('••••0987');
    expect(after.bankAccountNumberChanged).toBe(true);
    expect(JSON.stringify([row!.before, row!.after])).not.toMatch(/\d{5,}/);
    expect(row!.redacted_keys, 'masked is not redacted').toEqual([]);
  });

  it('a name-only bank edit (same number both sides) reads Changed false', async () => {
    const f = await fixture('bank2');
    const e = catalogueEntry('set_supplier_bank_account')!;
    const entityId = randomUUID();
    await asOrg(f.orgId, (tx) =>
      R.append(tx, f.orgId, {
        actorPersonId: f.actor,
        action: 'set_supplier_bank_account',
        storeId: e.scope === 'store' ? f.storeId : null,
        entityId,
        before: { bankName: 'BDO', bankAccountNumber: '1234567890123' },
        after: { bankName: 'BPI', bankAccountNumber: '1234567890123' },
        source: 'web',
      }),
    );
    const after = (await rowsFor(entityId))[0]!.after as Record<string, unknown>;
    expect(after.bankAccountNumber).toBe('••••0123');
    expect(after.bankAccountNumberChanged).toBe(false);
  });
});

describe('Invariant 7 - payload cap (before + after <= 16 KB serialised)', () => {
  it('a 40 KB after is stored as a diff of the changed top-level keys with __truncated; an under-cap payload is stored whole', async () => {
    const f = await fixture('inv7');
    const e = catalogueEntry(LEGACY_ACTION)!;
    const mk = (changed: boolean) => Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`k${i}`, `${changed && i < 5 ? 'NEW' : 'old'}-${'x'.repeat(95)}`]));
    const big = randomUUID();
    await asOrg(f.orgId, (tx) =>
      R.append(tx, f.orgId, { actorPersonId: f.actor, action: LEGACY_ACTION, storeId: e.scope === 'store' ? f.storeId : null, entityId: big, before: mk(false), after: mk(true), source: 'web' }),
    );
    const [row] = await rowsFor(big);
    const after = row!.after as Record<string, unknown>;
    expect(after.__truncated, 'mutant: no cap').toBe(true);
    expect(Buffer.byteLength(JSON.stringify([row!.before, row!.after]))).toBeLessThanOrEqual(16 * 1024);
    for (let i = 0; i < 5; i++) expect(String(after[`k${i}`])).toMatch(/^NEW-/);
    expect(after.k399, 'unchanged keys are dropped from the diff').toBeUndefined();

    const small = randomUUID();
    await asOrg(f.orgId, (tx) =>
      R.append(tx, f.orgId, { actorPersonId: f.actor, action: LEGACY_ACTION, storeId: e.scope === 'store' ? f.storeId : null, entityId: small, before: { a: 1 }, after: { a: 2 }, source: 'web' }),
    );
    expect((await rowsFor(small))[0]!.after).toEqual({ a: 2 });
  });
});

describe('Invariant 8 - same transaction as the caller', () => {
  it('a caller that throws after append leaves no row; one that does not leaves exactly one (mutant: writer opens its own transaction)', async () => {
    const f = await fixture('inv8');
    const e = catalogueEntry(LEGACY_ACTION)!;
    const boom = randomUUID();
    const err = await thrown(
      asOrg(f.orgId, async (tx) => {
        await R.append(tx, f.orgId, { actorPersonId: f.actor, action: LEGACY_ACTION, storeId: e.scope === 'store' ? f.storeId : null, entityId: boom, before: null, after: { a: 1 }, source: 'web' });
        throw new Error('rolled back on purpose');
      }),
    );
    expect(err?.message).toBe('rolled back on purpose');
    expect(await rowsFor(boom), 'no business change commits without its row, no row commits for a rolled-back change').toHaveLength(0);
    const ok = randomUUID();
    const res = await asOrg(f.orgId, (tx) =>
      R.append(tx, f.orgId, { actorPersonId: f.actor, action: LEGACY_ACTION, storeId: e.scope === 'store' ? f.storeId : null, entityId: ok, before: null, after: { a: 1 }, source: 'web' }),
    );
    const rows = await rowsFor(ok);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(res.id);
  });
});

describe('R1 / R10 - recorded_at is the server clock; occurredAt and deviceId pass through', () => {
  it('a supplied occurredAt is kept as occurred_at, recorded_at is now, device_id stored (mutant: recorded_at from occurredAt)', async () => {
    const f = await fixture('times');
    const e = catalogueEntry(LEGACY_ACTION)!;
    const entityId = randomUUID();
    const occurredAt = new Date(Date.now() - 3 * 24 * 3600 * 1000);
    await asOrg(f.orgId, (tx) =>
      R.append(tx, f.orgId, {
        actorPersonId: f.actor,
        action: LEGACY_ACTION,
        storeId: e.scope === 'store' ? f.storeId : null,
        entityId,
        before: null,
        after: {},
        source: 'pos',
        deviceId: f.device,
        occurredAt,
      }),
    );
    const [row] = await rowsFor(entityId);
    expect(row!.occurred_at.getTime()).toBe(occurredAt.getTime());
    expect(Math.abs(row!.recorded_at.getTime() - Date.now())).toBeLessThan(60_000);
    expect(row!.device_id).toBe(f.device);
    expect(row!.source).toBe('pos');
  });
});

describe('Invariant 10 - the existing reader still works', () => {
  it('latestForEntity finds the row the new writer wrote, by the catalogue entity and the unchanged action string', async () => {
    const f = await fixture('inv10');
    const e = catalogueEntry(LEGACY_ACTION)!;
    expect(e.action).toBe('set_channel_payout');
    const entityId = randomUUID();
    await asOrg(f.orgId, (tx) =>
      R.append(tx, f.orgId, { actorPersonId: f.actor, action: LEGACY_ACTION, storeId: e.scope === 'store' ? f.storeId : null, entityId, before: { moneyAccountId: null }, after: { moneyAccountId: 'x' }, source: 'web' }),
    );
    const got = (await asOrg(f.orgId, (tx) => R.latestForEntity(tx, f.orgId, { entity: e.entity, entityId, action: LEGACY_ACTION }))) as
      | { actorPersonId: string | null; after: unknown }
      | undefined;
    expect(got?.actorPersonId).toBe(f.actor);
    expect(got?.after).toEqual({ moneyAccountId: 'x' });
  });
});

describe('RLS still holds through the new writer', () => {
  it('org B cannot read org A\'s row', async () => {
    const a = await fixture('rlsA');
    const b = await fixture('rlsB');
    const e = catalogueEntry(LEGACY_ACTION)!;
    const entityId = randomUUID();
    await asOrg(a.orgId, (tx) =>
      R.append(tx, a.orgId, { actorPersonId: a.actor, action: LEGACY_ACTION, storeId: e.scope === 'store' ? a.storeId : null, entityId, before: null, after: {}, source: 'web' }),
    );
    const seen = await asOrg(b.orgId, (tx) => tx.execute(dsql`select id from audit_log where entity_id = ${entityId}`));
    expect((seen as unknown as unknown[]).length).toBe(0);
  });
});

export type { Fx };
