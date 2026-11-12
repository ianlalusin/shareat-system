/**
 * T-546 R2/R3 (TESTER, written FIRST) - the tills of a store: add one, choose its tablet, set its receipt printer; and what the snapshot carries.
 * docs/tasks/546-pos-terminal-printer-settings.md R2, R3, R5.
 *
 *   packages/domain/src/pos/terminals.ts (new)
 *     listTerminals(tx, actor, { storeId })                                   -> { terminals: [{ id, terminalNo, pairingId, pairingLabel, receiptPaperMm, receiptCopies }], freePairings: [{ id, label }] }
 *     createTerminal(tx, actor, { storeId, terminalNo })                      -> { terminalId }
 *     linkTerminal(tx, actor, { storeId, terminalId, pairingId | null })      -> { terminalId }
 *     setTerminalPrinter(tx, actor, { storeId, terminalId, receiptPaperMm, receiptCopies }) -> { terminalId }
 *   Capability: `pair_pos_tablet` (admin and manager at the store; staff never), checked FIRST at the STORE. Audit: pos.terminal_created,
 *   pos.terminal_linked, pos.terminal_printer_set (before and after). A change bumps pos_stores.state_version when that row exists.
 *
 * Raw SQL builds the world (the t525 fixture), so the DATABASE is the oracle. Loaded lazily: a missing module fails each case with its own message.
 */
import { afterAll, describe, expect, it } from 'vitest';

import { AuthorizationError } from '@shareat/auth';
import { RefusalError } from '@shareat/db';
import { asOrg, auditRows, closeAll, fixture, sql, stateVersionOf, uid, RATES, type Fx } from './_fixtures/t525-pos';
import { buildPosSnapshot } from '../../src/pos/snapshot';

afterAll(closeAll);

type TerminalView = { id: string; terminalNo: number; pairingId: string | null; pairingLabel: string | null; receiptPaperMm: number; receiptCopies: number };
type Listed = { terminals: TerminalView[]; freePairings: { id: string; label: string }[] };
const mod = async () => {
  try {
    return (await import(/* @vite-ignore */ '../../src/pos/terminals')) as Record<string, (...a: unknown[]) => Promise<unknown>>;
  } catch (e) {
    throw new Error(`MISSING MODULE: packages/domain/src/pos/terminals.ts cannot be loaded (T-546 not built): ${String((e as Error).message).slice(0, 160)}`);
  }
};
const call = async (name: string, f: Fx, actor: Fx['admin'], input: Record<string, unknown>) => {
  const fn = (await mod())[name];
  if (typeof fn !== 'function') throw new Error(`MISSING EXPORT: terminals.ts does not export ${name} (T-546 not built).`);
  return asOrg(f.orgId, (tx) => fn(tx, actor, input));
};
const list = (f: Fx, actor: Fx['admin'], storeId = f.storeId) => call('listTerminals', f, actor, { storeId }) as Promise<Listed>;
const create = (f: Fx, actor: Fx['admin'], terminalNo: number, storeId = f.storeId) => call('createTerminal', f, actor, { storeId, terminalNo }) as Promise<{ terminalId: string }>;
const link = (f: Fx, actor: Fx['admin'], terminalId: string, pairingId: string | null, storeId = f.storeId) => call('linkTerminal', f, actor, { storeId, terminalId, pairingId });
const setPrinter = (f: Fx, actor: Fx['admin'], terminalId: string, receiptPaperMm: unknown, receiptCopies: unknown, storeId = f.storeId) =>
  call('setTerminalPrinter', f, actor, { storeId, terminalId, receiptPaperMm, receiptCopies });

async function expectRefusal(p: Promise<unknown>, sentence?: string) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, 'expected a refusal, got success').not.toBeNull();
  expect(err, `expected a RefusalError, got ${String((err as Error)?.message)}`).toBeInstanceOf(RefusalError);
  if (sentence !== undefined) expect((err as RefusalError).userMessage).toBe(sentence);
}
async function expectAuthRefusal(p: Promise<unknown>) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, 'expected an authorization refusal, got success').not.toBeNull();
  expect(err, `expected AuthorizationError, got ${String((err as Error)?.message)}`).toBeInstanceOf(AuthorizationError);
}

/** A live pairing at the store (no till on it yet). */
async function newPairing(f: Fx, storeId = f.storeId, label = uid('Tablet')): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into pos_tablet_pairings (org_id, store_id, label, cookie_digest, paired_by) values (${f.orgId}, ${storeId}, ${label}, ${uid('digest')}, ${f.adminId}) returning id`;
  return row!.id;
}
/** The fixture's live tablet is retired (`pos_tablet_pairings` allows ONE live pairing per store, 0212), so a fresh live one can be made. */
async function replaceTablet(f: Fx, label = uid('Tablet')): Promise<string> {
  await sql`update pos_tablet_pairings set revoked_at = now(), revoked_by = ${f.adminId} where id = ${f.pairingId}`;
  return newPairing(f, f.storeId, label);
}
const t1Of = async (f: Fx) => (await sql<{ id: string }[]>`select id from pos_terminals where pairing_id = ${f.pairingId}`)[0]!.id;
const tillRow = async (id: string) =>
  (await sql<{ terminal_no: number; pairing_id: string | null; receipt_paper_mm: number; receipt_copies: number }[]>`
    select terminal_no, pairing_id, receipt_paper_mm, receipt_copies from pos_terminals where id = ${id}`)[0]!;
const tillCount = async (f: Fx) => (await sql<{ n: number }[]>`select count(*)::int n from pos_terminals where org_id = ${f.orgId}`)[0]!.n;

describe('R2 listTerminals', () => {
  it('lists the store\'s tills in number order with their tablet label and printer settings; no tablet is free while the only live one acts as till 1', async () => {
    const f = await fixture();
    const t2 = (await create(f, f.manager, 2)).terminalId;
    await setPrinter(f, f.manager, t2, 80, 2);
    const got = await list(f, f.manager);
    expect(got.terminals.map((t) => t.terminalNo)).toEqual([1, 2]);
    const label = (await sql<{ label: string }[]>`select label from pos_tablet_pairings where id = ${f.pairingId}`)[0]!.label;
    expect(got.terminals[0]).toMatchObject({ terminalNo: 1, pairingId: f.pairingId, pairingLabel: label, receiptPaperMm: 58, receiptCopies: 1 });
    expect(got.terminals[1]).toMatchObject({ id: t2, terminalNo: 2, pairingId: null, pairingLabel: null, receiptPaperMm: 80, receiptCopies: 2 });
    expect(got.freePairings, 'the revoked pairing, the linked one and the other store\'s are not offered').toEqual([]);
  });

  it('a live tablet that acts as no till is offered, with its label (after the till lets it go)', async () => {
    const f = await fixture();
    await link(f, f.manager, await t1Of(f), null);
    const label = (await sql<{ label: string }[]>`select label from pos_tablet_pairings where id = ${f.pairingId}`)[0]!.label;
    expect((await list(f, f.manager)).freePairings).toEqual([{ id: f.pairingId, label }]);
  });

  it('shows only this store\'s tills (a till of store B is not listed at store A)', async () => {
    const f = await fixture();
    await create(f, f.admin, 5, f.store2Id);
    expect((await list(f, f.manager)).terminals.map((t) => t.terminalNo)).toEqual([1]);
    expect((await list(f, f.admin, f.store2Id)).terminals.map((t) => t.terminalNo)).toEqual([5]);
  });

  it('is refused for a cashier and for a manager of another store (the read gate is the write gate)', async () => {
    const f = await fixture();
    await expectAuthRefusal(list(f, f.counter));
    await expectAuthRefusal(list(f, f.managerOther));
  });
});

describe('R2 createTerminal', () => {
  it('a store manager adds a till: row with the defaults (58 mm, 1 copy, no tablet), created_by, audited pos.terminal_created, state_version +1', async () => {
    const f = await fixture();
    const v0 = await stateVersionOf(f);
    const { terminalId } = await create(f, f.manager, 3);
    expect(await tillRow(terminalId)).toEqual({ terminal_no: 3, pairing_id: null, receipt_paper_mm: 58, receipt_copies: 1 });
    expect((await sql<{ created_by: string }[]>`select created_by from pos_terminals where id = ${terminalId}`)[0]!.created_by).toBe(f.managerId);
    const a = await auditRows(f, 'pos.terminal_created');
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ actor_person_id: f.managerId, store_id: f.storeId, entity_id: terminalId });
    expect(a[0]!.before).toBeNull();
    expect(a[0]!.after).toMatchObject({ terminalNo: 3, receiptPaperMm: 58, receiptCopies: 1 });
    expect(await stateVersionOf(f)).toBe(v0 + 1);
  });

  it('an admin may too', async () => {
    const f = await fixture();
    expect((await create(f, f.admin, 4)).terminalId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('a number the store already uses is refused: "Till N already exists at this store." Nothing is written, nothing audited', async () => {
    const f = await fixture();
    const before = await tillCount(f);
    await expectRefusal(create(f, f.manager, 1), 'Till 1 already exists at this store.');
    expect(await tillCount(f)).toBe(before);
    expect(await auditRows(f, 'pos.terminal_created')).toHaveLength(0);
  });

  it('another store may use the same number', async () => {
    const f = await fixture();
    expect((await create(f, f.admin, 1, f.store2Id)).terminalId).toBeDefined();
  });

  it('a number outside 1..99, a fraction, a string or NaN is refused with a sentence', async () => {
    const f = await fixture();
    for (const bad of [0, 100, -1, 1.5, Number.NaN, '7' as unknown as number]) await expectRefusal(create(f, f.manager, bad as number));
    expect(await tillCount(f)).toBe(1);
  });

  it('the edges 99 passes', async () => {
    const f = await fixture();
    expect((await create(f, f.manager, 99)).terminalId).toBeDefined();
  });

  it('a cashier and a manager of another store are refused (AuthorizationError) and nothing is written', async () => {
    const f = await fixture();
    await expectAuthRefusal(create(f, f.counter, 6));
    await expectAuthRefusal(create(f, f.managerOther, 6));
    expect(await tillCount(f)).toBe(1);
    expect(await auditRows(f, 'pos.terminal_created')).toHaveLength(0);
  });
});

describe('R2 linkTerminal', () => {
  it('a manager links a free live tablet to a till: pairing_id set, audited with before and after, state_version +1', async () => {
    const f = await fixture();
    const t2 = (await create(f, f.manager, 2)).terminalId;
    await link(f, f.manager, await t1Of(f), null); // the store's one live tablet is free now
    const v0 = await stateVersionOf(f);
    await link(f, f.manager, t2, f.pairingId);
    expect((await tillRow(t2)).pairing_id).toBe(f.pairingId);
    const a = await auditRows(f, 'pos.terminal_linked');
    expect(a).toHaveLength(2);
    expect(a[1]).toMatchObject({ actor_person_id: f.managerId, store_id: f.storeId, entity_id: t2 });
    expect(a[1]!.before).toMatchObject({ pairingId: null });
    expect(a[1]!.after).toMatchObject({ pairingId: f.pairingId, terminalNo: 2 });
    expect(await stateVersionOf(f)).toBe(v0 + 1);
  });

  it('null un-links the tablet (the till stays, its receipts keep their till); audited with the old pairing in before', async () => {
    const f = await fixture();
    const t1 = (await sql<{ id: string }[]>`select id from pos_terminals where pairing_id = ${f.pairingId}`)[0]!.id;
    const v0 = await stateVersionOf(f);
    await link(f, f.manager, t1, null);
    expect(await tillRow(t1)).toMatchObject({ terminal_no: 1, pairing_id: null });
    const a = await auditRows(f, 'pos.terminal_linked');
    expect(a[0]!.before).toMatchObject({ pairingId: f.pairingId });
    expect(a[0]!.after).toMatchObject({ pairingId: null });
    expect(await stateVersionOf(f)).toBe(v0 + 1);
    // ...and the freed tablet is offered again
    expect((await list(f, f.manager)).freePairings.map((p) => p.id)).toContain(f.pairingId);
  });

  it('a replaced tablet takes over the till: un-link, then link the new one: the till keeps its number and printer settings', async () => {
    const f = await fixture();
    const t1 = (await sql<{ id: string }[]>`select id from pos_terminals where pairing_id = ${f.pairingId}`)[0]!.id;
    await setPrinter(f, f.manager, t1, 80, 2);
    const fresh = await replaceTablet(f);
    await link(f, f.manager, t1, fresh);
    expect(await tillRow(t1)).toEqual({ terminal_no: 1, pairing_id: fresh, receipt_paper_mm: 80, receipt_copies: 2 });
  });

  it('a pairing of ANOTHER store is refused (and a revoked pairing of this store too): "That tablet is not paired to this store."', async () => {
    const f = await fixture();
    const t2 = (await create(f, f.manager, 2)).terminalId;
    const SENTENCE = 'That tablet is not paired to this store.';
    await expectRefusal(link(f, f.manager, t2, f.pairingBId), SENTENCE);
    await expectRefusal(link(f, f.manager, t2, f.pairingRevokedId), SENTENCE);
    await expectRefusal(link(f, f.manager, t2, '00000000-0000-4000-8000-000000000000'), SENTENCE);
    expect((await tillRow(t2)).pairing_id).toBeNull();
    expect(await auditRows(f, 'pos.terminal_linked')).toHaveLength(0);
  });

  it('a pairing already acting as another till is refused: "That tablet already acts as till N."', async () => {
    const f = await fixture();
    const t2 = (await create(f, f.manager, 2)).terminalId;
    await expectRefusal(link(f, f.manager, t2, f.pairingId), 'That tablet already acts as till 1.');
    expect((await tillRow(t2)).pairing_id).toBeNull();
    expect(await auditRows(f, 'pos.terminal_linked')).toHaveLength(0);
  });

  it('re-choosing the tablet a till already has is not an error', async () => {
    const f = await fixture();
    const t1 = (await sql<{ id: string }[]>`select id from pos_terminals where pairing_id = ${f.pairingId}`)[0]!.id;
    await link(f, f.manager, t1, f.pairingId);
    expect((await tillRow(t1)).pairing_id).toBe(f.pairingId);
  });

  it('a till of ANOTHER store, or one that does not exist, is refused (the till is looked up inside the store)', async () => {
    const f = await fixture();
    const tB = (await create(f, f.admin, 1, f.store2Id)).terminalId;
    await expectRefusal(link(f, f.manager, tB, f.pairingId));
    await expectRefusal(link(f, f.manager, '00000000-0000-4000-8000-000000000000', f.pairingId));
    expect((await tillRow(tB)).pairing_id).toBeNull();
  });

  it('a cashier and a manager of another store are refused, and the till is untouched', async () => {
    const f = await fixture();
    const t1 = (await sql<{ id: string }[]>`select id from pos_terminals where pairing_id = ${f.pairingId}`)[0]!.id;
    await expectAuthRefusal(link(f, f.counter, t1, null));
    await expectAuthRefusal(link(f, f.managerOther, t1, null));
    expect((await tillRow(t1)).pairing_id).toBe(f.pairingId);
    expect(await auditRows(f, 'pos.terminal_linked')).toHaveLength(0);
  });
});

describe('R2 setTerminalPrinter', () => {
  it('a manager sets 80 mm and 3 copies: stored, audited with before and after, state_version +1', async () => {
    const f = await fixture();
    const t1 = await t1Of(f);
    const v0 = await stateVersionOf(f);
    await setPrinter(f, f.manager, t1, 80, 3);
    expect(await tillRow(t1)).toMatchObject({ receipt_paper_mm: 80, receipt_copies: 3 });
    const a = await auditRows(f, 'pos.terminal_printer_set');
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ actor_person_id: f.managerId, store_id: f.storeId, entity_id: t1 });
    expect(a[0]!.before).toMatchObject({ receiptPaperMm: 58, receiptCopies: 1 });
    expect(a[0]!.after).toMatchObject({ receiptPaperMm: 80, receiptCopies: 3 });
    expect(await stateVersionOf(f)).toBe(v0 + 1);
  });

  it('58 mm and 1 copy go back; the admin may too', async () => {
    const f = await fixture();
    const t1 = await t1Of(f);
    await setPrinter(f, f.admin, t1, 80, 2);
    await setPrinter(f, f.admin, t1, 58, 1);
    expect(await tillRow(t1)).toMatchObject({ receipt_paper_mm: 58, receipt_copies: 1 });
  });

  it('paper other than 58 or 80 is refused with a sentence, and nothing changes', async () => {
    const f = await fixture();
    const t1 = await t1Of(f);
    for (const bad of [70, 0, 57, '80', null, 58.5]) await expectRefusal(setPrinter(f, f.manager, t1, bad, 1), 'Paper width must be 58 mm or 80 mm.');
    expect(await tillRow(t1)).toMatchObject({ receipt_paper_mm: 58, receipt_copies: 1 });
    expect(await auditRows(f, 'pos.terminal_printer_set')).toHaveLength(0);
  });

  it('copies outside 1..3, a fraction or a string are refused with a sentence, and nothing changes', async () => {
    const f = await fixture();
    const t1 = await t1Of(f);
    for (const bad of [0, 4, -1, 1.5, '2', null]) await expectRefusal(setPrinter(f, f.manager, t1, 80, bad), 'Copies must be a whole number from 1 to 3.');
    expect(await tillRow(t1)).toMatchObject({ receipt_paper_mm: 58, receipt_copies: 1 });
  });

  it('a till of another store or a missing till is refused', async () => {
    const f = await fixture();
    const tB = (await create(f, f.admin, 1, f.store2Id)).terminalId;
    await expectRefusal(setPrinter(f, f.manager, tB, 80, 1));
    await expectRefusal(setPrinter(f, f.manager, '00000000-0000-4000-8000-000000000000', 80, 1));
    expect(await tillRow(tB)).toMatchObject({ receipt_paper_mm: 58 });
  });

  it('a cashier and a manager of another store are refused, and the till is untouched', async () => {
    const f = await fixture();
    const t1 = await t1Of(f);
    await expectAuthRefusal(setPrinter(f, f.counter, t1, 80, 2));
    await expectAuthRefusal(setPrinter(f, f.managerOther, t1, 80, 2));
    expect(await tillRow(t1)).toMatchObject({ receipt_paper_mm: 58, receipt_copies: 1 });
    expect(await auditRows(f, 'pos.terminal_printer_set')).toHaveLength(0);
  });
});

describe('R2 a save that changes nothing writes nothing', () => {
  it('the same printer values, and re-linking the same tablet, return { wrote: false }: no audit row, no state_version bump, the row untouched', async () => {
    const f = await fixture();
    const t1 = await t1Of(f);
    const v0 = await stateVersionOf(f);
    expect(await setPrinter(f, f.manager, t1, 58, 1)).toMatchObject({ wrote: false });
    expect(await link(f, f.manager, t1, f.pairingId)).toMatchObject({ wrote: false });
    expect(await auditRows(f, 'pos.terminal_printer_set')).toHaveLength(0);
    expect(await auditRows(f, 'pos.terminal_linked')).toHaveLength(0);
    expect(await stateVersionOf(f)).toBe(v0);
    expect((await sql<{ updated_at: Date | null }[]>`select updated_at from pos_terminals where id = ${t1}`)[0]!.updated_at).toBeNull();
  });

  it('a real change right after still writes, audits and bumps (wrote: true); un-linking an already free till is a no-op', async () => {
    const f = await fixture();
    const t1 = await t1Of(f);
    const v0 = await stateVersionOf(f);
    expect(await setPrinter(f, f.manager, t1, 80, 1)).toMatchObject({ wrote: true });
    expect(await setPrinter(f, f.manager, t1, 80, 1)).toMatchObject({ wrote: false });
    expect(await link(f, f.manager, t1, null)).toMatchObject({ wrote: true });
    expect(await link(f, f.manager, t1, null)).toMatchObject({ wrote: false });
    expect(await auditRows(f, 'pos.terminal_printer_set')).toHaveLength(1);
    expect(await auditRows(f, 'pos.terminal_linked')).toHaveLength(1);
    expect(await stateVersionOf(f)).toBe(v0 + 2);
  });
});

describe('R2 a store with no pos_stores row (state_version has nothing to bump)', () => {
  it('create, link and set printer still work at store B; no error from the missing switch row', async () => {
    const f = await fixture();
    const t = (await create(f, f.admin, 2, f.store2Id)).terminalId;
    await link(f, f.admin, t, f.pairingBId, f.store2Id);
    await setPrinter(f, f.admin, t, 80, 2, f.store2Id);
    expect(await tillRow(t)).toMatchObject({ pairing_id: f.pairingBId, receipt_paper_mm: 80, receipt_copies: 2 });
    expect(await sql`select 1 from pos_stores where store_id = ${f.store2Id}`).toHaveLength(0);
  });
});

describe('R3 the snapshot carries the till\'s printer settings', () => {
  const pairingOf = (f: Fx) => ({ pairingId: f.pairingId, orgId: f.orgId, storeId: f.storeId });
  const snapshot = (f: Fx) => asOrg(f.orgId, (tx) => buildPosSnapshot(tx, { pairing: pairingOf(f) }, RATES));

  it('store has receiptPaperMm and receiptCopies (58 and 1 by default)', async () => {
    const f = await fixture();
    expect((await snapshot(f)).body.store).toEqual({ storeId: f.storeId, name: f.storeName, mode: 'test', terminalNo: 1, vatRegistered: true, receiptPaperMm: 58, receiptCopies: 1 });
  });

  it('changing the printer changes the settings AND the ETag; changing it back restores the ETag', async () => {
    const f = await fixture();
    const t1 = await t1Of(f);
    const a = await snapshot(f);
    await setPrinter(f, f.manager, t1, 80, 2);
    const b = await snapshot(f);
    expect(b.body.store).toMatchObject({ receiptPaperMm: 80, receiptCopies: 2 });
    expect(b.etag).not.toBe(a.etag);
    await setPrinter(f, f.manager, t1, 58, 1);
    expect((await snapshot(f)).etag).toBe(a.etag);
    await setPrinter(f, f.manager, t1, 58, 3);
    expect((await snapshot(f)).etag, 'copies alone changes it').not.toBe(a.etag);
  });

  it('a replaced tablet is told the till\'s number and printer settings (they live on the till, not on the tablet)', async () => {
    const f = await fixture();
    const t1 = await t1Of(f);
    await setPrinter(f, f.manager, t1, 80, 3);
    const fresh = await replaceTablet(f);
    await link(f, f.manager, t1, fresh);
    const s = await asOrg(f.orgId, (tx) => buildPosSnapshot(tx, { pairing: { pairingId: fresh, orgId: f.orgId, storeId: f.storeId } }, RATES));
    expect(s.body.store).toMatchObject({ terminalNo: 1, receiptPaperMm: 80, receiptCopies: 3 });
  });

  it('a tablet whose pairing has no till still answers the 409 sentence', async () => {
    const f = await fixture();
    const fresh = await replaceTablet(f); // a new live tablet, linked to nothing
    const err = await asOrg(f.orgId, (tx) => buildPosSnapshot(tx, { pairing: { pairingId: fresh, orgId: f.orgId, storeId: f.storeId } }, RATES)).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(RefusalError);
    expect((err as RefusalError).userMessage).toBe('This tablet has no till number yet. Ask a manager.');
  });

  it('un-linking the tablet makes the snapshot answer the 409 sentence again', async () => {
    const f = await fixture();
    const t1 = (await sql<{ id: string }[]>`select id from pos_terminals where pairing_id = ${f.pairingId}`)[0]!.id;
    await link(f, f.manager, t1, null);
    const err = await snapshot(f).then(() => null, (e: unknown) => e);
    expect((err as RefusalError).userMessage).toBe('This tablet has no till number yet. Ask a manager.');
  });
});
