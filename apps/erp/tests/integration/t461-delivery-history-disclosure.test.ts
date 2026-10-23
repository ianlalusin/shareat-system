import { config } from 'dotenv';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * DEF-755 (T-461 follow-up) - a received / void delivery's stored lines must render OUTSIDE any
 * `<details>`; only the editable draft starts behind the closed "Receive" disclosure. Real page render
 * against real Postgres (session mocked; reads real). Works on any *_test database with fresh ids.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

const ACTOR_HOLDER: { actor: { orgId: string; personId: string } | null } = { actor: null };
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => ACTOR_HOLDER.actor!),
  requireSession: vi.fn(async () => ({
    actor: ACTOR_HOLDER.actor!, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01'),
  })),
}));
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));

import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { createItem } from '@shareat/domain';
import { testItemCode } from '../../../../packages/domain/tests/integration/_fixtures/item-code';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

async function seed(status: 'draft' | 'received' | 'void') {
  const code = uid('t461d');
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('s')}, 'Store') returning id`;
  const [person] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  const personId = person!.id;
  await sql`insert into person_roles (person_id, org_id, role) values (${personId}, ${orgId}, 'super_admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${personId}, ${store!.id})`;
  const [file] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${orgId}, ${store!.id}, 'receipt_photo', ${`orgs/${orgId}/receipt_photo/${uid('f')}.jpg`}, 'image/jpeg', 1024, ${uid('sum')}, ${personId}) returning id`;
  ACTOR_HOLDER.actor = { orgId, personId };
  const itemName = `Calamansi ${uid('n')}`;
  const item = await asOrg(orgId, (tx) =>
    createItem(tx, { personId, orgId }, { code: testItemCode(), name: itemName, kind: 'raw_material', baseUnit: 'kg' }),
  );
  const [d] =
    status === 'draft'
      ? await sql<{ id: string }[]>`
          insert into deliveries (org_id, store_id, kind, delivered_on, proof_file_id, created_by)
          values (${orgId}, ${store!.id}, 'purchase', '2026-10-01', ${file!.id}, ${personId}) returning id`
      : status === 'received'
        ? await sql<{ id: string }[]>`
          insert into deliveries (org_id, store_id, kind, delivered_on, proof_file_id, created_by, status, received_at, received_by)
          values (${orgId}, ${store!.id}, 'purchase', '2026-10-01', ${file!.id}, ${personId}, 'received', now(), ${personId}) returning id`
        : await sql<{ id: string }[]>`
          insert into deliveries (org_id, store_id, kind, delivered_on, proof_file_id, created_by, status, voided_at, voided_by, void_reason)
          values (${orgId}, ${store!.id}, 'purchase', '2026-10-01', ${file!.id}, ${personId}, 'void', now(), ${personId}, 'wrong supplier') returning id`;
  await sql`
    insert into delivery_lines (delivery_id, line_no, item_id, ordered_quantity, received_quantity, purchase_unit, conversion_factor, unit_cost)
    values (${d!.id}, '1', ${item.id}, 12.5, ${status === 'received' ? '12.500' : null}, 'kg', 1, 345.6700)`;
  return { id: d!.id, itemName };
}

async function html(id: string): Promise<string> {
  const mod = await import('../../src/app/inventory/deliveries/[id]/page');
  const el = await mod.default({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) } as never);
  return renderToStaticMarkup(el as never);
}
const outsideDetails = (h: string) => h.replace(/<details[\s\S]*?<\/details>/g, '');

describe('DEF-755 delivery detail disclosure', () => {
  for (const status of ['received', 'void'] as const) {
    it(`${status}: the stored line table renders outside any <details>`, async () => {
      const { id, itemName } = await seed(status);
      const out = outsideDetails(await html(id));
      expect(out).toContain(itemName);
      expect(out).toContain('12.500 kg');
      expect(out).toContain('345.67');
      expect(out).toContain('<table');
    });
  }

  it('received: shows the received quantity outside the disclosure', async () => {
    const { id } = await seed('received');
    expect(outsideDetails(await html(id))).toContain('12.500 kg');
  });

  it('draft: the editable receive form still starts inside a closed disclosure', async () => {
    const { id, itemName } = await seed('draft');
    const h = await html(id);
    expect(h).toMatch(/<details(?![^>]*\sopen)[^>]*>/);
    expect(outsideDetails(h)).not.toContain(itemName);
    expect(h).toContain('name="receivedQuantity"');
  });
});
