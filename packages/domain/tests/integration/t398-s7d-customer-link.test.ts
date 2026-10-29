/**
 * T-398 S7d (TESTER) - O15 / DEF-747: `createCustomer` may link a customer to another company only when a franchise agreement joins the two
 * companies (either direction), and only for an admin (manage_chart_of_accounts, unchanged). docs/tasks/398-s7/S7-REFRESH.md s9, s11 (O15), s15 (Q-S7-3 = a).
 * Real Postgres via TEST_DATABASE_URL. Uses the S6 world (L -> PG, X -> Y agreements, W alone). `createCustomer` runs under withOrgPrincipal (app role).
 *
 * STATUS TODAY: the "refused without an agreement" legs are RED (createCustomer only checks "not both links" and "not this org", so the link to X is
 * ACCEPTED). The "created with an agreement" and admin-only legs are GREEN-AS-GUARD (today's behaviour that must survive the fix).
 *
 * The exact sentence is pinned by the refresh: "You can only link a customer to a company you have a franchise agreement with."
 * (read from RefusalError.userMessage, else .message).
 *
 * MUTANTS: check that the target org merely exists; agreement checked in one direction only; check after the insert (row written then thrown only
 * outside a rollback); a different sentence for "no such org" than for "no agreement" (an existence oracle); the sentence naming the target company;
 * authorize() moved after the agreement check (a manager would be told about agreements, not refused).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';

import { withOrgPrincipal } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import { franchiseWorld, sql, type FranchiseWorld } from '../../../db/tests/integration/_fixtures/t398-s6-franchise';
import { createCustomer } from '../../src/customers';

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

const SENTENCE = 'You can only link a customer to a company you have a franchise agreement with.';
const W = (): Promise<FranchiseWorld> => franchiseWorld();
const actor = (orgId: string, personId: string): Actor => ({ orgId, personId });
const sentenceOf = (e: unknown): string => String((e as { userMessage?: string }).userMessage ?? (e as Error).message);
let seq = 0;
const nm = (p: string) => `${p}-${Date.now()}-${++seq}`;

async function customerCount(orgId: string): Promise<number> {
  return (await sql<{ n: number }[]>`select count(*)::int n from customers where org_id = ${orgId}`)[0]!.n;
}
const create = (orgId: string, who: Actor, counterpartyOrgId: string | null, name = nm('Cust')) =>
  withOrgPrincipal(orgId, (tx) => createCustomer(tx, who, { name, counterpartyOrgId }));
async function refusal(p: Promise<unknown>): Promise<unknown> {
  const err = await p.then(() => null, (e) => e);
  expect(err, 'the call must refuse').toBeInstanceOf(Error);
  return err;
}

describe('O15 - DEF-747: linking a customer to another company needs a franchise agreement', () => {
  it('REFUSED with no agreement (L -> X): the sentence, and nothing written - Mutant: the check only asks that the org exists', async () => {
    const w = await W();
    const a = actor(w.l.orgId, w.adminL.id);
    const before = await customerCount(w.l.orgId);
    const err = await refusal(create(w.l.orgId, a, w.x.orgId));
    expect(sentenceOf(err)).toBe(SENTENCE);
    expect(await customerCount(w.l.orgId)).toBe(before);
  });

  it('REFUSED for W (no agreement at all) to L, and for L to W', async () => {
    const w = await W();
    const before = await customerCount(w.l.orgId);
    expect(sentenceOf(await refusal(create(w.l.orgId, actor(w.l.orgId, w.adminL.id), w.w.orgId)))).toBe(SENTENCE);
    expect(sentenceOf(await refusal(create(w.w.orgId, actor(w.w.orgId, w.readerW.id), w.l.orgId)))).toBe(SENTENCE);
    expect(await customerCount(w.l.orgId)).toBe(before);
  });

  it('a third company is refused even though the caller\'s agreement partner has an agreement with it (X -> Y does not make L -> Y) - Mutant: transitive / any-agreement-exists join', async () => {
    const w = await W();
    expect(sentenceOf(await refusal(create(w.l.orgId, actor(w.l.orgId, w.adminL.id), w.y.orgId)))).toBe(SENTENCE);
  });

  it('CREATED with an agreement: L -> PG (franchisor side), treatment inter_entity, row carries the link - Mutant: over-refusal / franchisor side only broken', async () => {
    const w = await W();
    const r = await create(w.l.orgId, actor(w.l.orgId, w.adminL.id), w.pg.orgId);
    expect(r.treatment).toBe('inter_entity');
    const [row] = await sql<{ counterparty_org_id: string; org_id: string }[]>`select counterparty_org_id, org_id from customers where id = ${r.id}`;
    expect(row).toEqual({ counterparty_org_id: w.pg.orgId, org_id: w.l.orgId });
  });

  it('CREATED the other way round: PG -> L (franchisee side; either direction counts) - Mutant: agreement checked in one direction only', async () => {
    const w = await W();
    const r = await create(w.pg.orgId, actor(w.pg.orgId, w.adminPG.id), w.l.orgId);
    expect(r.treatment).toBe('inter_entity');
  });

  it('no existence oracle: a random uuid gets the SAME sentence as a real company without an agreement - Mutant: separate "no such company" message', async () => {
    const w = await W();
    const a = actor(w.l.orgId, w.adminL.id);
    const real = sentenceOf(await refusal(create(w.l.orgId, a, w.x.orgId)));
    const ghost = sentenceOf(await refusal(create(w.l.orgId, a, randomUUID())));
    expect(ghost).toBe(real);
  });

  it('the refusal never names the target company (name or code) - Mutant: sentence interpolating the other org', async () => {
    const w = await W();
    const [x] = await sql<{ name: string; code: string }[]>`select name, code from organizations where id = ${w.x.orgId}`;
    const s = sentenceOf(await refusal(create(w.l.orgId, actor(w.l.orgId, w.adminL.id), w.x.orgId)));
    expect(s).not.toContain(x!.name);
    expect(s).not.toContain(x!.code);
    expect(s).not.toContain(w.x.orgId);
  });

  it('admin only (unchanged): a manager and a staff member are refused with AuthorizationError even toward a company WITH an agreement - Mutant: agreement check replaces authorize()', async () => {
    const w = await W();
    const before = await customerCount(w.l.orgId);
    await expect(create(w.l.orgId, actor(w.l.orgId, w.mgrL.id), w.pg.orgId)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(create(w.l.orgId, actor(w.l.orgId, w.staffL.id), w.pg.orgId)).rejects.toBeInstanceOf(AuthorizationError);
    expect(await customerCount(w.l.orgId)).toBe(before);
  });

  it('authorize() comes FIRST: a manager aiming at a company with NO agreement gets AuthorizationError, not the agreement sentence', async () => {
    const w = await W();
    await expect(create(w.l.orgId, actor(w.l.orgId, w.mgrL.id), w.x.orgId)).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('controls: an ordinary customer (no org link) and an own-org link refusal are unchanged', async () => {
    const w = await W();
    const a = actor(w.l.orgId, w.adminL.id);
    await expect(create(w.l.orgId, a, null)).resolves.toMatchObject({ treatment: 'external' });
    const own = sentenceOf(await refusal(create(w.l.orgId, a, w.l.orgId)));
    expect(own).toMatch(/this organisation/i);
    expect(own).not.toBe(SENTENCE);
  });
});
