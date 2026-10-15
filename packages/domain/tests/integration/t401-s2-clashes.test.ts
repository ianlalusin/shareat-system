/**
 * T-401 S2 audit rulings (docs/tasks/401-erp-menu-catalog-master.md "S2 audit rulings"). TESTER, not BUILDER. Real Postgres.
 *  (1) The domain PRE-CHECKS the monotonic and same-instant rules for offers, option offers and depletion rules: a clash is refused in a
 *      SENTENCE (the domain's refusal, with a userMessage, no SQLSTATE, no constraint wording) before the database would raise.
 *  (2) Two "now" writes for one key in ONE transaction are refused in a sentence; set-then-cancel in one transaction: a FUTURE row may be
 *      cancelled in the same transaction that wrote it (net nothing), a "now" row may not (it is already in effect).
 *  (3) withdrawMenuItemRequest authorizes BEFORE it reads: a caller without the capability gets the same refusal for a nonexistent id and
 *      an existing one (no "does not exist" for one and "not allowed" for the other).
 *
 * ## Assumed contract (as the other S2 files): setMenuOffer / withdrawMenuOffer / cancelScheduledOffer / setOptionOffer / setDepletionRule /
 * requestMenuItem / withdrawMenuItemRequest, `(actor, input, tx?)`, `effectiveFrom?: Date` (omitted = the database now()).
 * A refusal is a throw; `expectSentence` (fixture) is the shape check. Mutants: the pre-check is dropped and the raw 23505 / trigger message
 * reaches the caller; withdrawMenuItemRequest reads the row first.
 */
import { afterAll, describe, expect, it } from 'vitest';

import { AuthorizationError } from '@shareat/auth';
import {
  cancelScheduledOffer,
  requestMenuItem,
  setDepletionRule,
  setMenuOffer,
  setOptionOffer,
  withdrawMenuItemRequest,
  withdrawMenuOffer,
} from '@shareat/domain';

import { asOrg, attempt, cast, expectSentence, rawItem, rawOption, rawRule, sql, type Cast } from './_fixtures/t401-s2-menu';

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

const HOUR = 3_600_000;
const soon = (h: number) => new Date(Date.now() + h * HOUR);

async function world(hint: string) {
  const c = await cast(hint);
  const { variantId } = await rawItem(c);
  await rawRule(c, variantId);
  return { c, variantId };
}
const count = async (table: string, c: Cast) => Number((await sql.unsafe(`select count(*)::int as n from ${table} where org_id = '${c.orgId}'`))[0]!.n);

type Kind = 'offer' | 'option' | 'rule';
/** One writer per kind, for a fixed key; `at` omitted = the DB now(). */
async function writer(kind: Kind, hint: string) {
  const c = await cast(hint);
  const item = await rawItem(c);
  const opt = await rawOption(c);
  if (kind === 'offer') await rawRule(c, item.variantId);
  const put = (at?: Date) =>
    kind === 'offer'
      ? (txx: never) => setMenuOffer(c.admin, { storeId: c.storeA, variantId: item.variantId, channel: 'store', amount: '100.00', ...(at ? { effectiveFrom: at } : {}) } as never, txx)
      : kind === 'option'
        ? (txx: never) => setOptionOffer(c.admin, { storeId: c.storeA, optionValueId: opt.valueId, channel: 'store', priceDelta: '5.00', ...(at ? { effectiveFrom: at } : {}) } as never, txx)
        : (txx: never) => setDepletionRule(c.admin, { variantId: item.variantId, mode: 'no_stock', ...(at ? { effectiveFrom: at } : {}) } as never, txx);
  const run = (at?: Date) => asOrg(c.orgId, (tx) => attempt(() => (put(at) as (t: unknown) => Promise<unknown>)(tx)));
  const table = kind === 'offer' ? 'menu_offers' : kind === 'option' ? 'menu_option_offers' : 'menu_depletion_rules';
  return { c, run, table, put };
}

describe('(1) clashes are refused in a sentence, before the database raises', () => {
  for (const kind of ['offer', 'option', 'rule'] as Kind[]) {
    it(`${kind}: "from now" while a LATER row is already scheduled for the same key (monotonic) -> sentence, nothing written`, async () => {
      const w = await writer(kind, `cl-mono-${kind}`);
      const first = await w.run(soon(2));
      expect(first.failed, `control: the scheduled row must go in (${first.message})`).toBe(false);
      const before = await count(w.table, w.c);
      const r = await w.run(); // now() < the scheduled row
      expectSentence(r, `${kind} now-after-later`);
      expect(await count(w.table, w.c)).toBe(before);
    });

    it(`${kind}: a second row at the SAME effective_from -> sentence, nothing written`, async () => {
      const w = await writer(kind, `cl-same-${kind}`);
      const T = soon(3);
      const first = await w.run(T);
      expect(first.failed, `control: ${first.message}`).toBe(false);
      const before = await count(w.table, w.c);
      const r = await w.run(T);
      expectSentence(r, `${kind} same instant`);
      expect(await count(w.table, w.c)).toBe(before);
    });
  }

  it('setDepletionRule against an EXISTING same-instant rule (a rule already in force at the very instant) -> sentence', async () => {
    const c = await cast('cl-rule-now');
    const { variantId } = await rawItem(c);
    const T = soon(1);
    await asOrg(c.orgId, (tx) => setDepletionRule(c.admin, { variantId, mode: 'no_stock', effectiveFrom: T } as never, tx));
    const r = await asOrg(c.orgId, (tx) => attempt(() => setDepletionRule(c.admin, { variantId, mode: 'no_stock', effectiveFrom: T } as never, tx)));
    expectSentence(r, 'rule at the same instant');
  });
});

describe('(2) one transaction, one key', () => {
  it('setMenuOffer then withdrawMenuOffer ("now" both) on the same key in ONE transaction: the second is refused in a sentence, the first stands', async () => {
    const { c, variantId } = await world('cl-tx1');
    const out = await asOrg(c.orgId, async (tx) => {
      await setMenuOffer(c.admin, { storeId: c.storeA, variantId, channel: 'store', amount: '100.00' } as never, tx);
      return attempt(() => withdrawMenuOffer(c.admin, { storeId: c.storeA, variantId, channel: 'store' } as never, tx));
    });
    expectSentence(out, 'withdraw after set in one tx');
    expect(await count('menu_offers', c), 'the set survived: the tx was not poisoned by a raw error').toBe(1);
  });

  it('setMenuOffer twice ("now" both) in ONE transaction: the second is refused in a sentence', async () => {
    const { c, variantId } = await world('cl-tx2');
    const out = await asOrg(c.orgId, async (tx) => {
      await setMenuOffer(c.admin, { storeId: c.storeA, variantId, channel: 'store', amount: '100.00' } as never, tx);
      return attempt(() => setMenuOffer(c.admin, { storeId: c.storeA, variantId, channel: 'store', amount: '110.00' } as never, tx));
    });
    expectSentence(out, 'second now-write in one tx');
    expect(await count('menu_offers', c)).toBe(1);
  });

  it('set a FUTURE offer then cancel it in the same transaction: allowed, net nothing written', async () => {
    const { c, variantId } = await world('cl-tx3');
    const out = await asOrg(c.orgId, async (tx) => {
      const o = await setMenuOffer(c.admin, { storeId: c.storeA, variantId, channel: 'store', amount: '100.00', effectiveFrom: soon(2) } as never, tx);
      return attempt(() => cancelScheduledOffer(c.admin, { id: o.id, storeId: c.storeA } as never, tx));
    });
    expect(out.failed, `cancelling a scheduled row in the tx that wrote it was refused: ${out.message}`).toBe(false);
    expect(await count('menu_offers', c)).toBe(0);
  });

  it('set a "now" offer then cancel it in the same transaction: refused in a sentence (it is already in effect), the offer stays', async () => {
    const { c, variantId } = await world('cl-tx4');
    const out = await asOrg(c.orgId, async (tx) => {
      const o = await setMenuOffer(c.admin, { storeId: c.storeA, variantId, channel: 'store', amount: '100.00' } as never, tx);
      return attempt(() => cancelScheduledOffer(c.admin, { id: o.id, storeId: c.storeA } as never, tx));
    });
    expectSentence(out, 'cancel a row in effect');
    expect(await count('menu_offers', c)).toBe(1);
  });
});

describe('(3) withdrawMenuItemRequest authorizes before it reads', () => {
  it('a caller with no request_menu_item gets the SAME refusal for a nonexistent id and for an existing one (mutant: the row is read first)', async () => {
    const c = await cast('cl-wd');
    const req = await asOrg(c.orgId, (tx) => requestMenuItem(c.manager, { storeId: c.storeA, name: 'Wagyu Platter', itemType: 'a_la_carte' } as never, tx));
    const ghost = '00000000-0000-7000-8000-000000000000';
    const a = await asOrg(c.orgId, (tx) => attempt(() => withdrawMenuItemRequest(c.staff, { id: ghost } as never, tx)));
    const b = await asOrg(c.orgId, (tx) => attempt(() => withdrawMenuItemRequest(c.staff, { id: req.id } as never, tx)));
    for (const [label, r] of [['nonexistent id', a], ['existing id', b]] as const) {
      expect(r.failed, `${label}: not refused`).toBe(true);
      expect(r.error, `${label}: must be an authorization refusal, not "does not exist" (${r.message})`).toBeInstanceOf(AuthorizationError);
      expect((r.error as AuthorizationError).capability).toBe('request_menu_item');
    }
    expect((a.error as AuthorizationError).userMessage, 'the two refusals read the same').toBe((b.error as AuthorizationError).userMessage);
    const [row] = await sql<{ status: string }[]>`select status from menu_item_requests where id = ${req.id}`;
    expect(row!.status).toBe('open');
  });
});
