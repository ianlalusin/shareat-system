import { config } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-511 S2b (TESTER) - `setSalesChannelPlatformCode`: an admin says which delivery platform a sales channel is and the store
 * code that platform prints on its statements. Spec: docs/tasks/511-settlement-upload-s2-spec.md "The two admin edits (2b)" item 1;
 * design: docs/designs/channel-settlement-upload.md Decisions Taken 5, 14, 16.
 *
 * Template: `setChannelPayoutDestination` (channel-settlements/index.ts:725): read the channel, authorize with the CHANNEL'S store,
 * judge the value AFTER the gate, same-value no-op before any write, audit in the same transaction on a real change only.
 *
 * Contract pinned here (the builder implements to it):
 *   setSalesChannelPlatformCode(tx, actor, { channelId, platform: 'grab' | 'foodpanda' | null, code: string | null })
 *   - clearing = platform null AND code null (code '' with platform null is a clear too)
 *   - Grab code = a UUID (any case, 36 chars with dashes); Foodpanda code = 3 to 12 letters or digits; the code is trimmed first
 *   - an unknown channel, or another org's channel: RefusalError 'That channel no longer exists.' (never addressable)
 *   - a code already used by another channel of the same org and platform (case, spaces and retired channels ignored):
 *     RefusalError 'That code is already used by <store name> <channel name>.'; the unique index stays authoritative (a race is
 *     the same refusal, never a 500)
 *   - audit: action 'sales_channel.platform_code_edited', storeId = the channel's store, entityId = the channel id, before/after,
 *     source 'web'; none on a no-op, none on a refusal
 *
 * ASSUMPTION (flag if wrong): the stored code is the TRIMMED text exactly as typed (case kept); uniqueness is what ignores case.
 * NOT TESTABLE (spec contradiction): "the same code is allowed on the other platform" - a Grab code (a UUID, 36 chars) can never be
 * a valid Foodpanda code (3-12 alphanumerics), so no one string is valid on both. The per-platform scope of the unique index is
 * pinned at DB level by t511-s2-migration.test.ts; here only the "same org" scope is testable (another org may reuse a code).
 *
 * Real Postgres on a scratch database whose name contains "_test". Never truncates.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { APP_ROLE, closeDb, RefusalError, transaction, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import { setSalesChannelPlatformCode } from '@shareat/domain';

const sql = postgres(url, { max: 8 });
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
const actorOf = (orgId: string, personId: string): Actor => ({ personId, orgId });

async function person(orgId: string, role: string, name: string, stores: string[]) {
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
  for (const s of stores) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
  return p!.id;
}

async function channel(orgId: string, storeId: string, name: string) {
  const [c] = await sql<{ id: string }[]>`
    insert into sales_channels (org_id, store_id, name, is_remitted_daily) values (${orgId}, ${storeId}, ${name}, true) returning id`;
  return c!.id;
}

/** An org with stores A and B; channels: A "Grab", A "Foodpanda", B "Grab B"; people at every role. */
async function fixture(hint: string) {
  const code = uid(`t511b-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const mkStore = async (name: string) => {
    const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('st')}, ${name}) returning id`;
    return s!.id;
  };
  const storeA = await mkStore('Store A');
  const storeB = await mkStore('Store B');
  const adminId = await person(orgId, 'admin', 'Admin', [storeA, storeB]);
  const adminAId = await person(orgId, 'admin', 'Admin A only', [storeA]);
  const superId = await person(orgId, 'super_admin', 'Super', [storeA, storeB]);
  const managerId = await person(orgId, 'manager', 'Manager', [storeA, storeB]);
  const staffId = await person(orgId, 'staff', 'Staff', [storeA, storeB]);
  const chA1 = await channel(orgId, storeA, 'Grab');
  const chA2 = await channel(orgId, storeA, 'Foodpanda');
  const chB1 = await channel(orgId, storeB, 'Grab B');
  return {
    orgId, storeA, storeB, chA1, chA2, chB1,
    admin: actorOf(orgId, adminId),
    adminA: actorOf(orgId, adminAId),
    superAdmin: actorOf(orgId, superId),
    manager: actorOf(orgId, managerId),
    staff: actorOf(orgId, staffId),
  };
}
type Fx = Awaited<ReturnType<typeof fixture>>;

interface ChannelRow { platform: string | null; platform_store_code: string | null; updated_at: Date | null; name: string; is_remitted_daily: boolean }
async function row(id: string): Promise<ChannelRow> {
  const [r] = await sql<ChannelRow[]>`select platform, platform_store_code, updated_at, name, is_remitted_daily from sales_channels where id = ${id}`;
  return r!;
}

interface AuditRow { action: string; store_id: string | null; entity_id: string; source: string; actor_person_id: string | null; before: Record<string, unknown> | null; after: Record<string, unknown> | null }
async function audits(f: Fx, channelId?: string): Promise<AuditRow[]> {
  return sql<AuditRow[]>`
    select action, store_id, entity_id, source, actor_person_id, before, after from audit_log
    where org_id = ${f.orgId} and action = 'sales_channel.platform_code_edited' ${channelId ? sql`and entity_id = ${channelId}` : sql``}
    order by recorded_at`;
}
const valuesOf = (o: Record<string, unknown> | null) => Object.values(o ?? {}).map((v) => (v === null ? null : String(v)));

type Platform = 'grab' | 'foodpanda' | null;
const set = (f: Fx, who: Actor, channelId: string, platform: Platform, code: string | null) =>
  asOrg(f.orgId, (tx) => setSalesChannelPlatformCode(tx, who, { channelId, platform, code }));

/** Expect a named refusal (a sentence for a person), never a bare Error or a 500. */
async function expectRefusal(p: Promise<unknown>, sentence?: string | RegExp) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, 'expected a refusal, got success').not.toBeNull();
  expect(err, `expected a RefusalError, got ${String((err as Error)?.message)}`).toBeInstanceOf(RefusalError);
  const msg = (err as RefusalError).userMessage;
  expect(msg.length, 'the refusal has a sentence').toBeGreaterThan(10);
  if (typeof sentence === 'string') expect(msg).toBe(sentence);
  else if (sentence) expect(msg).toMatch(sentence);
  return msg;
}
async function expectAuthRefusal(p: Promise<unknown>) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, 'expected an authorization refusal, got success').not.toBeNull();
  expect(err, `expected AuthorizationError, got ${String((err as Error)?.message)}`).toBeInstanceOf(AuthorizationError);
}

afterAll(async () => {
  await sql.end({ timeout: 5 });
  await closeDb();
});

describe('T-511 S2b - setSalesChannelPlatformCode: it exists and is exported from the package index', () => {
  it('is a function on @shareat/domain (red until the builder adds it)', () => {
    expect(typeof setSalesChannelPlatformCode).toBe('function');
  });
});

describe('T-511 S2b - who may set a platform code (edit_platform_store_code: admin and super_admin only)', () => {
  it('an admin sets a Grab UUID: stored trimmed, with one audit row (action, store, entity, before, after, source)', async () => {
    const f = await fixture('admin-grab');
    const uuid = randomUUID();
    await set(f, f.admin, f.chA1, 'grab', `  ${uuid}  `);

    const r = await row(f.chA1);
    expect(r.platform).toBe('grab');
    expect(r.platform_store_code, 'the stored code is the trimmed text').toBe(uuid);
    expect(r.updated_at, 'a real change moves updated_at').not.toBeNull();

    const rows = await audits(f, f.chA1);
    expect(rows).toHaveLength(1);
    const a = rows[0]!;
    expect(a.action).toBe('sales_channel.platform_code_edited');
    expect(a.store_id, 'the CHANNEL\'s store').toBe(f.storeA);
    expect(a.entity_id).toBe(f.chA1);
    expect(a.source).toBe('web');
    expect(a.actor_person_id).toBe(f.admin.personId);
    expect(a.before, 'before: nothing was set').toBeTruthy();
    expect((a.before as Record<string, unknown>).platform ?? null).toBeNull();
    expect(valuesOf(a.before).filter((v) => v !== null), 'before holds no code').toEqual([]);
    expect((a.after as Record<string, unknown>).platform).toBe('grab');
    expect(valuesOf(a.after)).toContain(uuid);
  });

  it('an admin changes platform and code: the audit row carries the old and the new', async () => {
    const f = await fixture('admin-change');
    const uuid = randomUUID();
    await set(f, f.admin, f.chA2, 'grab', uuid);
    await set(f, f.admin, f.chA2, 'foodpanda', 'xy12ab');

    const r = await row(f.chA2);
    expect([r.platform, r.platform_store_code]).toEqual(['foodpanda', 'xy12ab']);
    const rows = await audits(f, f.chA2);
    expect(rows).toHaveLength(2);
    const last = rows[1]!;
    expect((last.before as Record<string, unknown>).platform).toBe('grab');
    expect(valuesOf(last.before)).toContain(uuid);
    expect((last.after as Record<string, unknown>).platform).toBe('foodpanda');
    expect(valuesOf(last.after)).toContain('xy12ab');
  });

  it('a super_admin may', async () => {
    const f = await fixture('super');
    await set(f, f.superAdmin, f.chA2, 'foodpanda', 'sup3r1');
    expect((await row(f.chA2)).platform_store_code).toBe('sup3r1');
    expect(await audits(f, f.chA2)).toHaveLength(1);
  });

  it('a manager is refused (AuthorizationError), nothing is written, no audit row', async () => {
    const f = await fixture('manager');
    await expectAuthRefusal(set(f, f.manager, f.chA2, 'foodpanda', 'mgr123'));
    const r = await row(f.chA2);
    expect([r.platform, r.platform_store_code, r.updated_at]).toEqual([null, null, null]);
    expect(await audits(f)).toHaveLength(0);
  });

  it('staff are refused (AuthorizationError), nothing is written, no audit row', async () => {
    const f = await fixture('staff');
    await expectAuthRefusal(set(f, f.staff, f.chA2, 'foodpanda', 'stf123'));
    expect((await row(f.chA2)).platform_store_code).toBeNull();
    expect(await audits(f)).toHaveLength(0);
  });

  it('the gate comes FIRST (auth-first, t440-s9): a manager posting a malformed code is told they may not, not that the code is malformed', async () => {
    const f = await fixture('authfirst');
    await expectAuthRefusal(set(f, f.manager, f.chA2, 'foodpanda', '!!'));
    await expectAuthRefusal(set(f, f.staff, f.chA2, 'grab', 'not-a-uuid'));
    // and a duplicate is not disclosed to someone who may not set codes either
    await set(f, f.admin, f.chA1, 'foodpanda', 'taken1');
    await expectAuthRefusal(set(f, f.manager, f.chA2, 'foodpanda', 'taken1'));
  });

  it('scope: an admin who holds the capability at store A only may edit store A\'s channel but is refused for store B\'s', async () => {
    const f = await fixture('scope');
    await set(f, f.adminA, f.chA2, 'foodpanda', 'scopeA');
    expect((await row(f.chA2)).platform_store_code).toBe('scopeA');
    await expectAuthRefusal(set(f, f.adminA, f.chB1, 'foodpanda', 'scopeB'));
    expect((await row(f.chB1)).platform_store_code).toBeNull();
    expect(await audits(f, f.chB1)).toHaveLength(0);
  });

  it('another org\'s admin cannot address this org\'s channel: "That channel no longer exists."; nothing is written', async () => {
    const f = await fixture('org1');
    const g = await fixture('org2');
    await expectRefusal(set(g, g.admin, f.chA2, 'foodpanda', 'cross12'), 'That channel no longer exists.');
    expect((await row(f.chA2)).platform_store_code).toBeNull();
    expect(await audits(f)).toHaveLength(0);
    expect(await audits(g)).toHaveLength(0);
  });

  it('a channel id that does not exist: "That channel no longer exists."', async () => {
    const f = await fixture('ghost');
    await expectRefusal(set(f, f.admin, randomUUID(), 'foodpanda', 'ghost12'), 'That channel no longer exists.');
  });

  it('writing the code leaves every other column of the channel as it was', async () => {
    const f = await fixture('untouched');
    const before = await row(f.chA1);
    await set(f, f.admin, f.chA1, 'foodpanda', 'keep12');
    const after = await row(f.chA1);
    expect([after.name, after.is_remitted_daily]).toEqual([before.name, before.is_remitted_daily]);
  });
});

describe('T-511 S2b - the code\'s format, per platform, judged AFTER the gate', () => {
  const GRAB_BAD: [string, string][] = [
    ['not a UUID at all', 'not-a-uuid'],
    ['a UUID without dashes (32 hex)', randomUUID().replace(/-/g, '')],
    ['a UUID with one extra character', `${randomUUID()}0`],
    ['35 characters (one short)', randomUUID().slice(0, 35)],
    ['36 characters with a non-hex letter', `${randomUUID().slice(0, 35)}g`],
    ['a short Foodpanda-style code', 'ab12cd'],
  ];
  it.each(GRAB_BAD)('Grab refuses %s', async (_label, code) => {
    const f = await fixture('grabbad');
    await expectRefusal(set(f, f.admin, f.chA1, 'grab', code));
    expect((await row(f.chA1)).platform_store_code).toBeNull();
    expect(await audits(f)).toHaveLength(0);
  });

  const FP_BAD: [string, string][] = [
    ['2 characters', 'ab'],
    ['13 characters', 'abcdefghijklm'],
    ['a dash', 'ab-cd'],
    ['an inner space', 'ab cd'],
    ['an underscore', 'ab_cd'],
    ['a symbol', 'ab!c'],
    ['a UUID (36 characters)', randomUUID()],
  ];
  it.each(FP_BAD)('Foodpanda refuses %s', async (_label, code) => {
    const f = await fixture('fpbad');
    await expectRefusal(set(f, f.admin, f.chA2, 'foodpanda', code));
    expect((await row(f.chA2)).platform_store_code).toBeNull();
    expect(await audits(f)).toHaveLength(0);
  });

  it.each([
    ['3 characters', 'abc'],
    ['12 characters', 'ab12cd34ef56'],
    ['digits only', '123456'],
    ['mixed case', 'AbC123'],
  ])('Foodpanda accepts %s', async (_label, code) => {
    const f = await fixture('fpgood');
    await set(f, f.admin, f.chA2, 'foodpanda', code);
    expect((await row(f.chA2)).platform_store_code).toBe(code);
  });

  it('Grab accepts an upper-case UUID (case-insensitive) and keeps it as typed', async () => {
    const f = await fixture('grabupper');
    const up = randomUUID().toUpperCase();
    await set(f, f.admin, f.chA1, 'grab', up);
    expect((await row(f.chA1)).platform_store_code).toBe(up);
  });

  it('surrounding spaces and tabs are trimmed before the format is judged and before it is stored', async () => {
    const f = await fixture('trim');
    await set(f, f.admin, f.chA2, 'foodpanda', ' \t xy12ab \t ');
    expect((await row(f.chA2)).platform_store_code).toBe('xy12ab');
  });

  it.each([
    ['spaces only', '   '],
    ['tabs only (the DB blank check uses trim and lets a tab-only code through, so the function must refuse it)', '\t\t'],
    ['spaces and a tab', ' \t '],
    ['the empty string', ''],
  ])('refuses a code that is %s, on either platform', async (_label, code) => {
    const f = await fixture('blank');
    await expectRefusal(set(f, f.admin, f.chA2, 'foodpanda', code));
    await expectRefusal(set(f, f.admin, f.chA1, 'grab', code));
    expect((await row(f.chA2)).platform_store_code).toBeNull();
    expect((await row(f.chA1)).platform_store_code).toBeNull();
    expect(await audits(f)).toHaveLength(0);
  });

  it('a platform without a code is refused with a sentence; so is a code without a platform; so is an unknown platform', async () => {
    const f = await fixture('pair');
    await expectRefusal(set(f, f.admin, f.chA2, 'foodpanda', null));
    await expectRefusal(set(f, f.admin, f.chA2, null, 'abc123'));
    await expectRefusal(
      asOrg(f.orgId, (tx) => setSalesChannelPlatformCode(tx, f.admin, { channelId: f.chA2, platform: 'ubereats' as never, code: 'abc123' })),
    );
    const r = await row(f.chA2);
    expect([r.platform, r.platform_store_code]).toEqual([null, null]);
    expect(await audits(f)).toHaveLength(0);
  });
});

describe('T-511 S2b - the Grab refusal describes the shape and carries no UUID (the refusal layer redacts every UUID to "[hidden]")', () => {
  it('a bad Grab code: the sentence has no "[hidden]" and says 36 characters, 8-4-4-4-12, dashes', async () => {
    const f = await fixture('grabshape');
    // 'ab12cd' passes the shared field rule (a Foodpanda shape), so the refusal is the Grab-specific sentence
    const msg = await expectRefusal(set(f, f.admin, f.chA1, 'grab', 'ab12cd'));
    expect(msg).not.toContain('[hidden]');
    expect(msg).toMatch(/36-character/);
    expect(msg).toMatch(/8-4-4-4-12/);
    expect(msg).toMatch(/dash/i);
  });
});

describe('T-511 S2b - clearing', () => {
  it('platform null and code null clears both, and writes an audit row holding the old values', async () => {
    const f = await fixture('clear');
    await set(f, f.admin, f.chA2, 'foodpanda', 'clr123');
    await set(f, f.admin, f.chA2, null, null);

    const r = await row(f.chA2);
    expect([r.platform, r.platform_store_code]).toEqual([null, null]);
    const rows = await audits(f, f.chA2);
    expect(rows).toHaveLength(2);
    const last = rows[1]!;
    expect((last.before as Record<string, unknown>).platform).toBe('foodpanda');
    expect(valuesOf(last.before)).toContain('clr123');
    expect(valuesOf(last.after).filter((v) => v !== null), 'after holds no platform and no code').toEqual([]);
  });

  it('platform null with an empty-string code is a clear too (a blank box); it is NOT refused', async () => {
    const f = await fixture('clear2');
    await set(f, f.admin, f.chA2, 'foodpanda', 'clr456');
    await set(f, f.admin, f.chA2, null, '');
    const r = await row(f.chA2);
    expect([r.platform, r.platform_store_code]).toEqual([null, null]);
  });

  it('clearing a channel that has nothing set is a no-op: no write, no audit row', async () => {
    const f = await fixture('clear3');
    await set(f, f.admin, f.chA2, null, null);
    expect((await row(f.chA2)).updated_at).toBeNull();
    expect(await audits(f)).toHaveLength(0);
  });

  it('a cleared code is free again: another channel may take it', async () => {
    const f = await fixture('clear4');
    await set(f, f.admin, f.chA2, 'foodpanda', 'free12');
    await set(f, f.admin, f.chA2, null, null);
    await set(f, f.admin, f.chB1, 'foodpanda', 'free12');
    expect((await row(f.chB1)).platform_store_code).toBe('free12');
  });
});

describe('T-511 S2b - the same value again is a no-op: no write, no updated_at move, NO audit row', () => {
  it('same platform and code twice: one audit row in total, updated_at untouched by the second call', async () => {
    const f = await fixture('noop');
    await set(f, f.admin, f.chA2, 'foodpanda', 'same12');
    const afterFirst = await row(f.chA2);
    expect(afterFirst.updated_at).not.toBeNull();

    await set(f, f.admin, f.chA2, 'foodpanda', 'same12');
    const afterSecond = await row(f.chA2);
    expect(afterSecond.updated_at!.getTime()).toBe(afterFirst.updated_at!.getTime());
    expect(await audits(f, f.chA2)).toHaveLength(1);
  });

  it('the same code typed with surrounding spaces is the same value (it is trimmed first)', async () => {
    const f = await fixture('noop2');
    await set(f, f.admin, f.chA2, 'foodpanda', 'same34');
    await set(f, f.admin, f.chA2, 'foodpanda', '  same34 ');
    expect(await audits(f, f.chA2)).toHaveLength(1);
  });

  it('a no-op is still gated: a manager repeating the stored value is refused, not told "unchanged"', async () => {
    const f = await fixture('noop3');
    await set(f, f.admin, f.chA2, 'foodpanda', 'same56');
    await expectAuthRefusal(set(f, f.manager, f.chA2, 'foodpanda', 'same56'));
  });
});

describe('T-511 S2b - a code identifies ONE channel per platform in an org (case, spaces and retired channels ignored)', () => {
  it('a second channel of the same org and platform cannot take the code: the sentence names the holder as "<store> <channel>"; nothing is written', async () => {
    const f = await fixture('dup');
    await set(f, f.admin, f.chA2, 'foodpanda', 'dup123');
    await expectRefusal(set(f, f.admin, f.chB1, 'foodpanda', 'dup123'), 'That code is already used by Store A Foodpanda.');
    expect((await row(f.chB1)).platform_store_code).toBeNull();
    expect(await audits(f, f.chB1)).toHaveLength(0);
  });

  it('upper and lower case are the same code', async () => {
    const f = await fixture('dupcase');
    await set(f, f.admin, f.chA2, 'foodpanda', 'abc123');
    await expectRefusal(set(f, f.admin, f.chB1, 'foodpanda', 'ABC123'), 'That code is already used by Store A Foodpanda.');
  });

  it('surrounding spaces do not make a different code', async () => {
    const f = await fixture('dupspace');
    await set(f, f.admin, f.chA2, 'foodpanda', 'abc123');
    await expectRefusal(set(f, f.admin, f.chB1, 'foodpanda', '  abc123  '), 'That code is already used by Store A Foodpanda.');
  });

  it('the same holds for Grab UUIDs, in any case', async () => {
    const f = await fixture('dupgrab');
    const uuid = randomUUID();
    await set(f, f.admin, f.chA1, 'grab', uuid);
    await expectRefusal(set(f, f.admin, f.chB1, 'grab', uuid.toUpperCase()), 'That code is already used by Store A Grab.');
  });

  it('a retired (inactive) channel keeps its code: it still blocks the code', async () => {
    const f = await fixture('dupinactive');
    await set(f, f.admin, f.chA2, 'foodpanda', 'old123');
    await sql`update sales_channels set is_active = false where id = ${f.chA2}`;
    // the holder is retired: the sentence says so (audit 3 Nov: a retired channel is still the holder)
    await expectRefusal(set(f, f.admin, f.chB1, 'foodpanda', 'old123'), 'That code is already used by Store A Foodpanda (retired).');
  });

  it('an admin scoped to store A only, colliding with a store B channel code, gets the generic sentence (no store or channel name leaks across stores)', async () => {
    const f = await fixture('dupleak');
    await set(f, f.admin, f.chB1, 'foodpanda', 'leak12');
    const msg = await expectRefusal(set(f, f.adminA, f.chA2, 'foodpanda', 'leak12'), 'That code is already used by another channel.');
    expect(msg).not.toMatch(/Store B|Grab B/);
  });

  it('an admin scoped to store A only still gets the NAMED sentence when the holder is in store A', async () => {
    const f = await fixture('dupown');
    await set(f, f.admin, f.chA1, 'foodpanda', 'own123');
    await expectRefusal(set(f, f.adminA, f.chA2, 'foodpanda', 'own123'), 'That code is already used by Store A Grab.');
  });

  it('another org may reuse the same code on the same platform (the scope is the org)', async () => {
    const f = await fixture('orgscope1');
    const g = await fixture('orgscope2');
    await set(f, f.admin, f.chA2, 'foodpanda', 'shared');
    await set(g, g.admin, g.chA2, 'foodpanda', 'shared');
    const uuid = randomUUID();
    await set(f, f.admin, f.chA1, 'grab', uuid);
    await set(g, g.admin, g.chA1, 'grab', uuid);
    expect((await row(g.chA2)).platform_store_code).toBe('shared');
    expect((await row(g.chA1)).platform_store_code).toBe(uuid);
  });

  it('the channel\'s own code is not a duplicate of itself (re-saving it is the no-op, not a refusal)', async () => {
    const f = await fixture('self');
    await set(f, f.admin, f.chA2, 'foodpanda', 'self12');
    await set(f, f.admin, f.chA2, 'foodpanda', 'SELF12'); // a case-only edit of its own code is allowed (a real change)
    expect((await row(f.chA2)).platform_store_code).toBe('SELF12');
  });

  it('RACE: a rival holds the code in an uncommitted transaction when this call runs; the unique index decides and the person gets the same refusal, not a 500', async () => {
    const f = await fixture('race');
    const code = 'race12';
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const ready = new Promise<void>((r) => (held = r));
    const rival = sql.begin(async (t) => {
      await t`update sales_channels set platform = 'foodpanda', platform_store_code = ${code} where id = ${f.chA2}`;
      held();
      await gate;
    });
    await ready;
    // The pre-read cannot see the rival's uncommitted row, so this UPDATE blocks on the unique index until the rival commits.
    const contender = set(f, f.admin, f.chB1, 'foodpanda', code).then(() => null, (e: unknown) => e);
    await new Promise((r) => setTimeout(r, 800));
    release();
    await rival;
    const outcome = await contender;

    expect(outcome, 'the contender must not succeed: the rival committed the code first').not.toBeNull();
    expect(outcome, `expected a RefusalError, got ${String((outcome as Error)?.name)}: ${String((outcome as Error)?.message)}`).toBeInstanceOf(RefusalError);
    expect((outcome as RefusalError).userMessage).toMatch(/already used/i);
    expect((await row(f.chB1)).platform_store_code).toBeNull();
    expect((await row(f.chA2)).platform_store_code).toBe(code);
    expect(await audits(f, f.chB1)).toHaveLength(0);
  });
});
