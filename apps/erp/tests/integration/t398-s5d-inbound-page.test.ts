import { afterAll, describe, expect, it, vi } from 'vitest';

import { pageError, render, sql, world } from './t435-fixture';

/**
 * T-398 S5d audit R4 (TESTER) - /inventory/deliveries/inbound/<id> with an id that is not a uuid is a not-found, never a 500
 * (a Postgres uuid error would surface as an internal fault). A random well-formed uuid is the control: also a not-found.
 * Mutant: the page passes the raw segment to SQL -> the non-uuid leg rejects with a Postgres error instead of NEXT_NOT_FOUND.
 */
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
vi.mock('../../src/lib/session', async () => (await import('./t435-fixture')).sessionMock());
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));

afterAll(async () => {
  const { closeDb } = await import('@shareat/db');
  await closeDb();
  await sql.end({ timeout: 5 });
});

const detailPage = () => import('../../src/app/inventory/deliveries/inbound/[shipmentId]/page');

describe('S5d audit R4: the receipt form for an unknown shipment', () => {
  it('a well-formed but unknown uuid is NEXT_NOT_FOUND (control)', async () => {
    const w = await world();
    const e = await pageError(() => render(detailPage, w.A, { params: { shipmentId: '019a0000-0000-7000-8000-000000000001' } }));
    expect(e).toBe('NEXT_NOT_FOUND');
  });

  it.each(['abc', 'not-a-uuid', '123', "x'; drop table users;--"])('a non-uuid segment "%s" is NEXT_NOT_FOUND, not a database error', async (seg) => {
    const w = await world();
    const e = await pageError(() => render(detailPage, w.A, { params: { shipmentId: seg } }));
    expect(e, `got ${e}`).toBe('NEXT_NOT_FOUND');
  });
});
