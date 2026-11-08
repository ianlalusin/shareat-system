import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T-529 (TESTER) - R1 / R4 integration: the Kitchen Server Actions (`apps/erp/src/app/pos/kitchen/actions.ts`), driven as functions with REAL Postgres and the REAL T-524
 * `serveLine`. Only the session, `next/cache` and `next/navigation` are replaced. Runs on any scratch "_test" database. docs/tasks/529-pos-kitchen-refills.md R1, R4.
 *
 * ASSUMED API (a 'use server' module; each action returns a result and NEVER throws for a domain refusal - it is called from a client component):
 *   serveLineAction(input: { storeId: string; lineId: string }): Promise<{ ok: true; wrote: boolean } | { ok: false; error: string }>
 *     authorizes serve_pos_ticket at `storeId`, calls T-524 `serveLine` with pairingId null, servedAtDevice = now. `error` is the domain's own sentence (errorMessage(err)).
 *     On a PAIRED tablet the pairing's store wins, and a different `storeId` is { ok: false, error: 'This tablet works at one store only.' } (the state route's sentence).
 *   serveAllAction(input: { storeId: string; lineIds: string[] }): Promise<{
 *       ok: boolean;                       true only when nothing failed
 *       saved: string[];                   lines this call marked served
 *       alreadyServed: string[];           lines that were served already (elsewhere): the domain answers wrote:false
 *       failed: { lineId: string; error: string }[];   lines the domain refused, each with its sentence
 *     }>
 *     ONE serveLine per line, ONE transaction per line: a refusal on one line never undoes another. Lists keep the order of `lineIds`.
 *
 * RED NOW FOR THE RIGHT REASON: the module does not exist (lazy import: "MISSING MODULE ... not built"), after each fixture ran.
 */
const HOLD = vi.hoisted(() => ({ actor: null as null | { orgId: string; personId: string }, token: null as string | null }));
vi.mock('../../src/lib/session', () => {
  const resolved = () => ({ actor: HOLD.actor!, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01') });
  return {
    requireSession: vi.fn(async () => resolved()),
    requireActor: vi.fn(async () => HOLD.actor!),
    currentSession: vi.fn(async () => resolved()),
    readPosTabletToken: vi.fn(async () => HOLD.token),
  };
});
vi.mock('next/cache', () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
  notFound: () => {
    throw new Error('notFound() called');
  },
}));

import { serveLine, addLines, cancelLine, openStand } from '../../../../packages/domain/src/pos';
import { errorMessage } from '../../src/lib/constraint-messages';
import { actorOf, asOrg, auditRows, closeAll, fixture, makeServer0240, newStand, nowIso, sql, stateVersionOf, uuid, type Fx } from '../../../../packages/domain/tests/integration/_fixtures/t525-pos';

afterAll(closeAll);
afterEach(() => {
  vi.restoreAllMocks();
});
beforeEach(() => {
  HOLD.actor = null;
  HOLD.token = null;
});

const ACTIONS = '../../src/app/pos/kitchen/actions';
// biome-ignore lint/suspicious/noExplicitAny: the module under test does not exist yet; its types are the builder's
async function actions(): Promise<any> {
  try {
    return await import(/* @vite-ignore */ ACTIONS);
  } catch (e) {
    throw new Error(`MISSING MODULE: apps/erp/src/app/pos/kitchen/actions.ts cannot be loaded (T-529 not built): ${String((e as Error).message).slice(0, 160)}`);
  }
}
const run = async (as: { orgId: string; personId: string }, name: 'serveLineAction' | 'serveAllAction', input: unknown, token: string | null = null) => {
  const m = await actions();
  if (typeof m[name] !== 'function') throw new Error(`MISSING EXPORT: kitchen/actions.ts does not export ${name} (T-529 not built).`);
  HOLD.actor = as;
  HOLD.token = token;
  return m[name](input);
};

/** A dine-in table with n pork lines (distinct line ids, one second apart so the order is fixed). Returns the line ids. */
async function table(f: Fx, n: number) {
  const st = await newStand(f);
  const sessionId = uuid();
  const base = { storeId: f.storeId, pairingId: f.pairingId };
  const lineIds = Array.from({ length: n }, () => uuid());
  await asOrg(f.orgId, async (tx) => {
    await openStand(tx, f.counter, { ...base, sessionId, mode: 'dine_in', standId: st.id, headsCashier: 2, openedAtDevice: nowIso() });
    await addLines(tx, f.counter, {
      ...base, sessionId,
      lines: lineIds.map((lineId, i) => ({ lineId, menuItemId: f.menu.pork.itemId, variantId: f.menu.pork.variantId, qty: 1, addedAtDevice: new Date(Date.now() + i * 1000).toISOString() })),
    });
  });
  return { sessionId, lineIds };
}
const status = async (lineId: string) =>
  (await sql<{ kitchen_status: string; served_by: string | null }[]>`select kitchen_status, served_by from table_session_lines where id = ${lineId}`)[0]!;
const served = (f: Fx, lineId: string) => asOrg(f.orgId, (tx) => serveLine(tx, f.kitchen, { storeId: f.storeId, pairingId: null, lineId, servedAtDevice: nowIso() }));
const NOT_VALID_LINE = 'The line id is not valid.';

describe('serveLineAction', () => {
  it('Kitchen Staff serves a queued line: ok, the row is served by them, one audit row, the state version moves', async () => {
    const f = await fixture();
    const t = await table(f, 1);
    const v0 = await stateVersionOf(f);
    const res = await run(f.kitchen, 'serveLineAction', { storeId: f.storeId, lineId: t.lineIds[0] });
    expect(res).toEqual({ ok: true, wrote: true });
    expect(await status(t.lineIds[0]!)).toEqual({ kitchen_status: 'served', served_by: f.kitchenId });
    const audit = await auditRows(f, 'pos.line_served');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_person_id: f.kitchenId, store_id: f.storeId, entity_id: t.lineIds[0] });
    expect(await stateVersionOf(f)).toBe(v0 + 1);
  });

  it('a line served twice (a double tap, or two screens) is ok the second time with wrote false and no second audit row', async () => {
    const f = await fixture();
    const t = await table(f, 1);
    expect(await run(f.kitchen, 'serveLineAction', { storeId: f.storeId, lineId: t.lineIds[0] })).toEqual({ ok: true, wrote: true });
    expect(await run(f.kitchen, 'serveLineAction', { storeId: f.storeId, lineId: t.lineIds[0] })).toEqual({ ok: true, wrote: false });
    expect(await auditRows(f, 'pos.line_served')).toHaveLength(1);
  });

  it('a line that was cancelled answers with the domain\'s own sentence, and stays cancelled', async () => {
    const f = await fixture();
    const t = await table(f, 1);
    await asOrg(f.orgId, (tx) => cancelLine(tx, f.counter, { storeId: f.storeId, pairingId: f.pairingId, lineId: t.lineIds[0]!, reason: 'Wrong item' }));
    expect(await run(f.kitchen, 'serveLineAction', { storeId: f.storeId, lineId: t.lineIds[0] })).toEqual({ ok: false, error: 'That line was cancelled.' });
    expect((await status(t.lineIds[0]!)).kitchen_status).toBe('cancelled');
  });

  it('is REFUSED for a Server (0240: no serve_pos_ticket), with the domain\'s sentence; the line stays queued and nothing is audited', async () => {
    const f = await fixture();
    const server = await makeServer0240(f);
    const t2 = await table(f, 1);
    const sentence = await asOrg(f.orgId, (tx) => serveLine(tx, server, { storeId: f.storeId, pairingId: null, lineId: t2.lineIds[0]!, servedAtDevice: nowIso() })).then(
      () => 'DID NOT REFUSE',
      (e) => errorMessage(e),
    );
    expect(sentence).not.toBe('DID NOT REFUSE');
    const res = await run(server, 'serveLineAction', { storeId: f.storeId, lineId: t2.lineIds[0] });
    expect(res).toEqual({ ok: false, error: sentence });
    expect((await status(t2.lineIds[0]!)).kitchen_status).toBe('queued');
    expect((await auditRows(f, 'pos.line_served')).map((a) => a.entity_id)).not.toContain(t2.lineIds[0]);
  });

  it('is REFUSED for another store: a person of store B only, asking for store A', async () => {
    const f = await fixture();
    const t = await table(f, 1);
    const res = await run(f.managerOther, 'serveLineAction', { storeId: f.storeId, lineId: t.lineIds[0] });
    expect(res.ok).toBe(false);
    expect(typeof res.error).toBe('string');
    expect(res.error.length).toBeGreaterThan(10);
    expect(res.error, 'one sentence, no UUID').not.toMatch(/\n|[0-9a-f]{8}-[0-9a-f]{4}-/i);
    expect((await status(t.lineIds[0]!)).kitchen_status).toBe('queued');
  });

  it('is REFUSED when a kitchen person names a store they do not work at', async () => {
    const f = await fixture();
    const t = await table(f, 1);
    const res = await run(f.kitchen, 'serveLineAction', { storeId: f.store2Id, lineId: t.lineIds[0] });
    expect(res.ok).toBe(false);
    expect((await status(t.lineIds[0]!)).kitchen_status).toBe('queued');
  });

  it('an admin who works at both stores cannot serve store A\'s line by naming store B (the line is store-scoped)', async () => {
    const f = await fixture();
    const t = await table(f, 1);
    const res = await run(f.admin, 'serveLineAction', { storeId: f.store2Id, lineId: t.lineIds[0] });
    expect(res.ok).toBe(false);
    expect((await status(t.lineIds[0]!)).kitchen_status).toBe('queued');
  });

  it('on a PAIRED tablet, a different storeId is refused with the one sentence, whoever the person is (the pairing\'s store wins)', async () => {
    const f = await fixture();
    const t = await table(f, 1);
    const res = await run(f.admin, 'serveLineAction', { storeId: f.store2Id, lineId: t.lineIds[0] }, f.pairingToken);
    expect(res).toEqual({ ok: false, error: 'This tablet works at one store only.' });
    expect((await status(t.lineIds[0]!)).kitchen_status).toBe('queued');
  });

  it('on a PAIRED tablet the pairing\'s own store works, and the audit row names the person', async () => {
    const f = await fixture();
    const t = await table(f, 1);
    expect(await run(f.kitchen, 'serveLineAction', { storeId: f.storeId, lineId: t.lineIds[0] }, f.pairingToken)).toEqual({ ok: true, wrote: true });
    expect((await auditRows(f, 'pos.line_served'))[0]).toMatchObject({ actor_person_id: f.kitchenId });
  });

  it('a line id that is not an id is the domain\'s sentence, not a crash', async () => {
    const f = await fixture();
    expect(await run(f.kitchen, 'serveLineAction', { storeId: f.storeId, lineId: 'not-an-id' })).toEqual({ ok: false, error: NOT_VALID_LINE });
  });
});

describe('serveAllAction (All out)', () => {
  it('serves every line of the card: ok, all saved in the given order, nothing failed', async () => {
    const f = await fixture();
    const t = await table(f, 3);
    const res = await run(f.kitchen, 'serveAllAction', { storeId: f.storeId, lineIds: t.lineIds });
    expect(res).toEqual({ ok: true, saved: t.lineIds, alreadyServed: [], failed: [] });
    for (const l of t.lineIds) expect((await status(l)).kitchen_status).toBe('served');
    expect(await auditRows(f, 'pos.line_served')).toHaveLength(3);
  });

  it('one line already served elsewhere gives a PARTIAL report: it is named, the rest are still served', async () => {
    const f = await fixture();
    const t = await table(f, 3);
    await served(f, t.lineIds[1]!); // another screen got there first
    const res = await run(f.kitchen, 'serveAllAction', { storeId: f.storeId, lineIds: t.lineIds });
    expect(res).toEqual({ ok: true, saved: [t.lineIds[0], t.lineIds[2]], alreadyServed: [t.lineIds[1]], failed: [] });
    for (const l of t.lineIds) expect((await status(l)).kitchen_status).toBe('served');
    expect(await auditRows(f, 'pos.line_served')).toHaveLength(3); // the earlier one plus the two this call saved
  });

  it('a refused line is reported with its sentence and does NOT undo the others (one transaction per line)', async () => {
    const f = await fixture();
    const t = await table(f, 4);
    await served(f, t.lineIds[1]!);
    await asOrg(f.orgId, (tx) => cancelLine(tx, f.counter, { storeId: f.storeId, pairingId: f.pairingId, lineId: t.lineIds[2]!, reason: 'Duplicate' }));
    const res = await run(f.kitchen, 'serveAllAction', { storeId: f.storeId, lineIds: t.lineIds });
    expect(res).toEqual({
      ok: false,
      saved: [t.lineIds[0], t.lineIds[3]],
      alreadyServed: [t.lineIds[1]],
      failed: [{ lineId: t.lineIds[2], error: 'That line was cancelled.' }],
    });
    expect((await status(t.lineIds[0]!)).kitchen_status).toBe('served');
    expect((await status(t.lineIds[2]!)).kitchen_status).toBe('cancelled');
    expect((await status(t.lineIds[3]!)).kitchen_status).toBe('served');
  });

  it('for a Server (no serve_pos_ticket) every line fails with the domain\'s sentence and nothing is served', async () => {
    const f = await fixture();
    const server = await makeServer0240(f);
    const t = await table(f, 2);
    const sentence = await asOrg(f.orgId, (tx) => serveLine(tx, server, { storeId: f.storeId, pairingId: null, lineId: t.lineIds[0]!, servedAtDevice: nowIso() })).then(
      () => 'DID NOT REFUSE',
      (e) => errorMessage(e),
    );
    expect(sentence).not.toBe('DID NOT REFUSE');
    const res = await run(server, 'serveAllAction', { storeId: f.storeId, lineIds: t.lineIds });
    expect(res).toEqual({ ok: false, saved: [], alreadyServed: [], failed: t.lineIds.map((lineId) => ({ lineId, error: sentence })) });
    for (const l of t.lineIds) expect((await status(l)).kitchen_status).toBe('queued');
  });

  it('for another store nothing is served', async () => {
    const f = await fixture();
    const t = await table(f, 2);
    const res = await run(f.managerOther, 'serveAllAction', { storeId: f.storeId, lineIds: t.lineIds });
    expect(res.ok).toBe(false);
    expect(res.saved).toEqual([]);
    for (const l of t.lineIds) expect((await status(l)).kitchen_status).toBe('queued');
  });

  it('on a paired tablet a different storeId is refused up front: ok false, nothing served', async () => {
    const f = await fixture();
    const t = await table(f, 2);
    const res = await run(f.admin, 'serveAllAction', { storeId: f.store2Id, lineIds: t.lineIds }, f.pairingToken);
    expect(res.ok).toBe(false);
    expect(res.saved).toEqual([]);
    for (const l of t.lineIds) expect((await status(l)).kitchen_status).toBe('queued');
  });
});

describe('fixtures this file leans on', () => {
  it('the kitchen person and the server are different people, and actorOf builds a plain actor', async () => {
    const f = await fixture();
    expect(actorOf(f.orgId, f.kitchenId)).toEqual(f.kitchen);
  });
});
