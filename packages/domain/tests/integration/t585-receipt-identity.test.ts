/**
 * T-585 R1 - the snapshot carries who issued the receipt, read from this org's own rows and never another org's.
 * Made-up names and numbers only. Real Postgres; runs in CI.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { buildPosSnapshot } from '../../src/pos/snapshot';
import { asOrg, closeAll, fixture, RATES, sql } from './_fixtures/t525-pos';

afterAll(closeAll);

type Fx = Awaited<ReturnType<typeof fixture>>;
const snap = (f: Fx) => asOrg(f.orgId, (tx) => buildPosSnapshot(tx, { pairing: { pairingId: f.pairingId, orgId: f.orgId, storeId: f.storeId } }, RATES));
const identityOf = (s: Awaited<ReturnType<typeof snap>>) => (s.body.store as { identity?: unknown }).identity;

describe('T-585 - the snapshot store.identity', () => {
  it('legal name, TIN + branch, each address line and the contact number, from this org and this store', async () => {
    const f = await fixture('test');
    await sql`update organizations set legal_name = 'Acme Grill Foods Inc.', tin = '123456789' where id = ${f.orgId}`;
    await sql`update stores set tin_branch_code = '00002', address = E'12 Sample St\n Test City', contact_number = '0917 123 4567' where id = ${f.storeId}`;
    expect(identityOf(await snap(f))).toEqual({ businessName: 'Acme Grill Foods Inc.', addressLines: ['12 Sample St', 'Test City', '0917 123 4567'], tin: '123-456-789-00002' });
  });

  it('nothing set: trading name, no address lines, no TIN', async () => {
    const f = await fixture('test');
    await sql`update organizations set legal_name = null, tin = null where id = ${f.orgId}`;
    await sql`update stores set tin_branch_code = null, address = null, contact_number = null where id = ${f.storeId}`;
    const [org] = await sql<{ name: string }[]>`select name from organizations where id = ${f.orgId}`;
    expect(identityOf(await snap(f))).toEqual({ businessName: org!.name, addressLines: [], tin: null });
  });

  it('never another organization\'s values', async () => {
    const a = await fixture('test');
    const b = await fixture('live');
    await sql`update organizations set legal_name = 'Org A Legal', tin = '111111111' where id = ${a.orgId}`;
    await sql`update organizations set legal_name = 'Org B Legal', tin = '222222222' where id = ${b.orgId}`;
    await sql`update stores set tin_branch_code = '00001', address = 'A Street' where id = ${a.storeId}`;
    await sql`update stores set tin_branch_code = '00009', address = 'B Street' where id = ${b.storeId}`;
    expect(identityOf(await snap(a))).toMatchObject({ businessName: 'Org A Legal', addressLines: ['A Street'], tin: '111-111-111-00001' });
    expect(identityOf(await snap(b))).toMatchObject({ businessName: 'Org B Legal', addressLines: ['B Street'], tin: '222-222-222-00009' });
  });

  it('the ETag changes when the identity changes (the tablet refetches)', async () => {
    const f = await fixture('test');
    const before = await snap(f);
    await sql`update organizations set legal_name = 'Renamed Legal Co.' where id = ${f.orgId}`;
    expect((await snap(f)).etag).not.toBe(before.etag);
  });
});
