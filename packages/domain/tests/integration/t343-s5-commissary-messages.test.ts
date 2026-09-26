import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import { closeDb, goneSentence, withOrgPrincipal } from '@shareat/db';
import { listOrderMessages, postOrderMessage } from '../../src/commissary/messages';

/**
 * T-343 S5.1b — M1. `docs/tasks/343-def-417-human-readable-refusals.md` §S5 Amendment R1 item 1.
 *
 * The fifth bypass: `apps/erp/src/app/commissary/orders/[id]/actions.ts:106` shows `result.reason`
 * straight from `postOrderMessage` (`packages/domain/src/commissary/messages.ts:40`), which is
 * `order ${orderId} does not exist` — the raw id, unredacted. `Outcome`'s failure arm gains an
 * optional `userReason?: string` (`commissary/outcome.ts`) and `messages.ts:40` sets it to
 * `goneSentence('order')`; `:61` (`listOrderMessages`) gets the same fix for the one wording, but
 * has no app caller today (spec note) so is not separately asserted here.
 *
 * ⛔ No fixture beyond the org/order ids themselves: `orderParties` is a plain `select … where id =
 * $1` under RLS, so a syntactically valid but nonexistent UUID returns no row without needing any
 * other row to exist first (verified against `packages/db/src/repo/low-stock.ts`).
 */
config({ path: '.env.local' });

afterAll(async () => {
  await closeDb();
});

describe('M1 — postOrderMessage against a missing order', () => {
  it('userReason is the gone sentence, no UUID; reason stays byte-identical (M2)', async () => {
    const orgId = crypto.randomUUID();
    const orderId = crypto.randomUUID();

    const res = await withOrgPrincipal(orgId, (tx) =>
      postOrderMessage(tx, {
        orgId,
        orderId,
        body: 'two crates were short',
        authorId: crypto.randomUUID(),
        actorStoreIds: [crypto.randomUUID()],
      }),
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;

    // M2 — the raw diagnostic is unchanged; only a new, additional field is added.
    expect(res.reason).toBe(`order ${orderId} does not exist`);

    expect(res.userReason).toMatch(/^That order could not be found\./);
    expect(res.userReason).not.toContain(orderId);
  });
});

describe('M1b (optional, cheap) — listOrderMessages against a missing order, the :61 sibling', () => {
  it('userReason === goneSentence("order")', async () => {
    const orgId = crypto.randomUUID();
    const orderId = crypto.randomUUID();

    const res = await withOrgPrincipal(orgId, (tx) =>
      listOrderMessages(tx, { orderId, actorStoreIds: [crypto.randomUUID()] }),
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.userReason).toBe(goneSentence('order'));
  });
});

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** M7 (auditor's CHANGES) — every id-free refusal still carries a presentable `userReason`: one
 *  line, capitalised, ends `.`, no UUID (S2's T1 shape, applied to this group's own two id-free
 *  arms). No DB row needed — both checks run before `orderParties` is ever queried. */
function assertPresentableUserReason(userReason: string | undefined): void {
  expect(userReason, 'must carry a userReason').toBeDefined();
  expect(userReason!.includes('\n'), 'must be a single line').toBe(false);
  expect(/^[A-Z]/.test(userReason!), 'must start upper-case').toBe(true);
  expect(userReason!.endsWith('.'), 'must end with a full stop').toBe(true);
  expect(UUID_RE.test(userReason!), 'must carry no UUID').toBe(false);
}

describe('M7 — the id-free refusals (body empty / over max length) carry a presentable userReason', () => {
  it('body-empty', async () => {
    const orgId = crypto.randomUUID();
    const orderId = crypto.randomUUID();
    const res = await withOrgPrincipal(orgId, (tx) =>
      postOrderMessage(tx, { orgId, orderId, body: '   ', authorId: crypto.randomUUID(), actorStoreIds: [] }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    assertPresentableUserReason(res.userReason);
  });

  it('over-max-length', async () => {
    const orgId = crypto.randomUUID();
    const orderId = crypto.randomUUID();
    const res = await withOrgPrincipal(orgId, (tx) =>
      postOrderMessage(tx, {
        orgId,
        orderId,
        body: 'x'.repeat(2001),
        authorId: crypto.randomUUID(),
        actorStoreIds: [],
      }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    assertPresentableUserReason(res.userReason);
  });
});
