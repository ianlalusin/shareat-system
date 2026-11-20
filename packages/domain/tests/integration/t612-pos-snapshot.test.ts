/**
 * T-612 test 3, POS half - a suspended person drops out of the tablet's snapshot (so the tablet drops their PIN verifier at its next sync, T-609's
 * verifier expiry), and a reinstated one comes back. docs/tasks/612-staff-account-status.md.
 * Fixture: the T-525 POS fixture (raw SQL world; `counter` is an active staff member with an open employment at store A).
 * Mutants (run by hand): the status test removed from BOTH `listOpenEmploymentsAtStore` and `personMaySignInAtStore` -> red (either alone stays
 * green: the snapshot has two gates on purpose).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { suspendAccount, reinstateAccount } from '../../src/people';
import { buildPosSnapshot } from '../../src/pos/snapshot';
import { asOrg, closeAll, fixture, RATES, sql } from './_fixtures/t525-pos';

afterAll(closeAll);

describe('T-612 - the POS snapshot follows the account status', () => {
  it('suspend removes the person from snapshot.staff; reinstate puts them back; their rights rows never moved', async () => {
    const f = await fixture();
    const pairing = { pairingId: f.pairingId, orgId: f.orgId, storeId: f.storeId };
    const staffIds = async () => {
      const s = await asOrg(f.orgId, (tx) => buildPosSnapshot(tx, { pairing }, RATES));
      return s.body.staff.map((x) => x.personId);
    };
    const [emp] = await sql<{ id: string }[]>`select id from employments where person_id = ${f.counterId}`;
    const rights = () => sql`select (select count(*) from person_roles where person_id = ${f.counterId} and revoked_at is null)::int as roles,
      (select count(*) from person_store_scope where person_id = ${f.counterId})::int as scope,
      (select count(*) from person_grants where person_id = ${f.counterId} and revoked_at is null)::int as grants`;

    expect(await staffIds(), 'control: the counter person is on the tablet').toContain(f.counterId);
    const before = await rights();

    await asOrg(f.orgId, (tx) => suspendAccount(tx, f.admin, { employmentId: emp!.id, reason: 'Pending investigation' }));
    const during = await staffIds();
    expect(during, 'suspended: gone from the tablet').not.toContain(f.counterId);
    expect(during, 'everyone else stays').toContain(f.kitchenId);
    expect(await rights(), 'rights untouched while paused').toEqual(before);

    await asOrg(f.orgId, (tx) => reinstateAccount(tx, f.admin, { employmentId: emp!.id }));
    expect(await staffIds(), 'reinstated: back on the tablet').toContain(f.counterId);
    expect(await rights()).toEqual(before);
  });
});
