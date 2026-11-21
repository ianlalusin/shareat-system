import { afterAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import type { Actor } from '@shareat/auth';
import { M, plain, session, sql, world } from './t435-fixture';
import { ROUTES_AWAITING_A_DECISION } from '../../src/lib/route-open-lists';

/**
 * T-616 - the route map is enforced at RUNTIME, not only by `tests/unit/route-capability-coverage.test.ts`.
 * Spec: docs/tasks/616-deny-by-default-at-runtime.md.
 *
 * `requirePageAccess` refuses a route that has no map entry, is not approved-open and is not on the awaiting list (T-617: that list is now empty). Admins get one extra line.
 * Mutant: make `routeHasNoRule` return false (or drop the early return in `requirePageAccess`) -> the first case goes red.
 */
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
vi.mock('../../src/lib/session', async () => (await import('./t435-fixture')).sessionMock());

afterAll(async () => {
  const { closeDb } = await import('@shareat/db');
  await closeDb();
  await sql.end({ timeout: 5 });
});

const NO_RULE = 'This page has no access rule yet.';

async function gate(route: string, actor: Actor): Promise<string | null> {
  const { requirePageAccess } = await import('../../src/lib/page-access');
  session.actor = actor;
  const { refusal } = await requirePageAccess(route);
  return refusal === null ? null : plain(renderToStaticMarkup(refusal as never));
}

describe('T-616 - requirePageAccess is deny-by-default', () => {
  it('a synthetic unmapped route is refused for a signed-in manager; the admin sees the extra line, the manager does not', async () => {
    const w = await world();
    for (const route of ['/zz-brand-new-screen', '/zz-brand-new-screen/some-id']) {
      const manager = await gate(route, w.M1);
      expect(manager, `${route} for a manager`).not.toBeNull();
      expect(manager).toContain(M.refusedCard);
      expect(manager).not.toContain(NO_RULE);
      const admin = await gate(route, w.A);
      expect(admin, `${route} for an admin`).toContain(M.refusedCard);
      expect(admin).toContain(NO_RULE);
    }
  });

  it('approved-open routes still work, for a person with no grants at all', async () => {
    const w = await world();
    for (const route of ['/setup', '/clock', '/']) expect(await gate(route, w.C), route).toBeNull();
  });

  it('T-617: the awaiting list is empty, so the 13 former awaiting routes are now decided: /items refuses a person with no grant, and /attendance/leave stays open', async () => {
    const w = await world();
    expect(ROUTES_AWAITING_A_DECISION).toEqual([]);
    expect(await gate('/items', w.C)).toContain(M.refusedCard);
    expect(await gate('/items/some-id', w.C)).toContain(M.refusedCard);
    expect(await gate('/attendance/leave', w.C)).toBeNull();
  });

  it('a mapped route is unchanged: allowed with the right word, refused without it', async () => {
    const w = await world();
    expect(await gate('/admin/users', w.A)).toBeNull();
    const refused = await gate('/admin/users', w.C);
    expect(refused).toContain(M.refusedCard);
    expect(refused).not.toContain(NO_RULE);
  });
});
