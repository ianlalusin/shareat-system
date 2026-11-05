/**
 * T-510 S1b - the readers learn about dayparts, against a real PostgreSQL. docs/tasks/510-menu-dayparts.md R2, R4.
 * Lunch 08:00-17:00 and Dinner 17:00-08:00 (Asia/Manila, the stores.timezone default), every day, two offers on one variant.
 */
import { afterAll, describe, expect, it } from 'vitest';

import { decimal } from '@shareat/core/money';
import { daypartsRepo, kitchenRepo, menuRepo, withOrgPrincipal } from '@shareat/db';
import { loadLiveStoreOffers, loadStoreMenu } from '@shareat/domain';
import { insDaypart, insDaypartOffer, insRule, insRuleOffer, menuFixture, newItem, refusal, sql, type MenuFx } from '../../../db/tests/integration/_fixtures/t401-menu';

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

/** Manila wall clock three days from now -> the UTC instant (Manila is a fixed +08:00). */
const manila = (hhmm: string): Date => {
  const base = new Date(Date.now() + 3 * 86_400_000);
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), h! - 8, m!, 0));
};

async function fx(hint: string) {
  const f = await menuFixture(hint);
  await insRule(f, f.variantId);
  const lunch = (await insDaypart(f, { name: 'Lunch', start: '08:00', end: '17:00' }))[0]!.id;
  const dinner = (await insDaypart(f, { name: 'Dinner', start: '17:00', end: '08:00' }))[0]!.id;
  return { f, lunch, dinner };
}

const asOrg = <T>(f: MenuFx, fn: Parameters<typeof withOrgPrincipal<T>>[1]) => withOrgPrincipal(f.orgId, fn);
const code = (e: unknown): string | undefined => {
  const x = e as { code?: string; cause?: { code?: string } } | undefined;
  return x?.code ?? x?.cause?.code;
};

describe('loadLiveStoreOffers and the projection pick the offer of the window that is open', () => {
  it('lunch price at 16:59, dinner price at 17:00, dinner again at 03:00; a closed window says when it opens', async () => {
    const { f, lunch, dinner } = await fx('s1b-live');
    await insDaypartOffer(f, f.variantId, lunch, '338.00');
    await insDaypartOffer(f, f.variantId, dinner, '358.00');
    const st = await asOrg(f, (tx) => kitchenRepo.createStation(tx, { orgId: f.orgId, storeId: f.storeId, name: 'Grill', createdBy: f.personId }));
    await asOrg(f, (tx) => kitchenRepo.setRoute(tx, { orgId: f.orgId, storeId: f.storeId, menuItemId: f.itemId, stationId: st.id, createdBy: f.personId }));

    const priceAt = async (hhmm: string) => {
      const at = manila(hhmm);
      const live = await asOrg(f, (tx) => loadLiveStoreOffers(tx, f.orgId, f.storeId, at));
      const menu = await asOrg(f, (tx) => loadStoreMenu(tx, f.orgId, f.storeId, at));
      const ch = menu.menu.items.flatMap((i) => i.variants).find((v) => v.id === f.variantId)!.channels.store;
      expect(live.faults).toEqual([]);
      expect(live.offers.map((o) => o.amount)).toEqual([ch.orderable ? ch.amount : 'not-orderable']);
      return ch.orderable ? ch.amount : 'not-orderable';
    };
    expect(await priceAt('16:59')).toBe('338.00');
    expect(await priceAt('17:00')).toBe('358.00');
    expect(await priceAt('03:00')).toBe('358.00');
    expect(await priceAt('08:00')).toBe('338.00');

    // Retire the dinner offer (withdraw it): at 20:00 only lunch remains live, its window is closed.
    await insDaypartOffer(f, f.variantId, dinner, null);
    const at = manila('20:00');
    const live = await asOrg(f, (tx) => loadLiveStoreOffers(tx, f.orgId, f.storeId, new Date(at.getTime() + 1000)));
    expect(live.offers).toEqual([]);
    expect(live.notOfferedNow).toMatchObject([{ variantId: f.variantId, channel: 'store', availableFrom: '08:00' }]);
  });

  it('a store with no dayparts: the offer is returned exactly as the raw read gives it', async () => {
    const f = await menuFixture('s1b-plain');
    await insRule(f, f.variantId);
    await insDaypartOffer(f, f.variantId, null, '120.00');
    const at = new Date(Date.now() + 5000);
    const raw = await asOrg(f, (tx) => menuRepo.offersInForce(tx, f.storeId, at));
    const live = await asOrg(f, (tx) => loadLiveStoreOffers(tx, f.orgId, f.storeId, at));
    expect(raw).toHaveLength(1);
    expect(live.offers).toEqual(raw);
    expect(live.offers[0]!.daypartId).toBeNull();
  });

  it('the database refuses a live all-day offer next to a dayparted one, so the reader keeps showing the all-day offer', async () => {
    const f = await menuFixture('s1b-mixed');
    await insRule(f, f.variantId);
    const lunch = (await insDaypart(f, { name: 'Lunch' }))[0]!.id;
    await insDaypartOffer(f, f.variantId, null, '300.00');
    expect(code(await refusal(() => insDaypartOffer(f, f.variantId, lunch, '338.00')))).toBeDefined();
    const live = await asOrg(f, (tx) => loadLiveStoreOffers(tx, f.orgId, f.storeId, new Date(Date.now() + 5000)));
    expect(live.offers.map((o) => o.amount)).toEqual(['300.00']);
  });
});

describe('offersInForce (raw rows)', () => {
  it('an online rule beside two live store slots does not fan out; each online row carries the same-daypart store basis', async () => {
    const { f, lunch, dinner } = await fx('s1b-basis');
    await insDaypartOffer(f, f.variantId, lunch, '338.00');
    await insDaypartOffer(f, f.variantId, dinner, '358.00');
    for (const dp of [lunch, dinner]) {
      await sql`insert into menu_offers (org_id, store_id, variant_id, channel, daypart_id, pricing_mode, markup_percent, withdrawn, created_by)
                values (${f.orgId}, ${f.storeId}, ${f.variantId}, 'online', ${dp}, 'percent_markup', 10, false, ${f.personId})`;
    }
    const rows = await asOrg(f, (tx) => menuRepo.offersInForce(tx, f.storeId, new Date(Date.now() + 5000)));
    expect(rows).toHaveLength(4);
    const online = rows.filter((r) => r.channel === 'online');
    expect(online.map((r) => [r.daypartId === lunch ? 'L' : 'D', r.basis?.amount]).sort()).toEqual([['D', '358.00'], ['L', '338.00']]);
  });

  it('an online rule with no dayparts anywhere still gets its store basis (unchanged)', async () => {
    const f = await menuFixture('s1b-basis-plain');
    await insRule(f, f.variantId);
    await insDaypartOffer(f, f.variantId, null, '200.00');
    await insRuleOffer(f, f.variantId, { mode: 'percent_markup', pct: '10' });
    const rows = await asOrg(f, (tx) => menuRepo.offersInForce(tx, f.storeId, new Date(Date.now() + 5000)));
    expect(rows.find((r) => r.channel === 'online')!.basis?.amount).toBe('200.00');
    const live = await asOrg(f, (tx) => loadLiveStoreOffers(tx, f.orgId, f.storeId, new Date(Date.now() + 5000)));
    expect(live.offers.find((r) => r.channel === 'online')!.basis?.amount).toBe('200.00');
  });
});

describe('the repo', () => {
  it('insertOffer stores the daypart; omitted or null means all day', async () => {
    const { f, lunch } = await fx('s1b-insert');
    const row = await asOrg(f, (tx) =>
      menuRepo.insertOffer(tx, {
        orgId: f.orgId, storeId: f.storeId, variantId: f.variantId, channel: 'store', daypartId: lunch,
        amount: decimal('338.00', '14,2'), bundleHeads: null, extraHeadAmount: null, withdrawn: false, createdBy: f.personId,
      }),
    );
    expect(row.daypartId).toBe(lunch);
    const v2 = await newItem(f, 'a_la_carte');
    await insRule(f, v2.variantId);
    const plain = await asOrg(f, (tx) =>
      menuRepo.insertOffer(tx, {
        orgId: f.orgId, storeId: f.storeId, variantId: v2.variantId, channel: 'store',
        amount: decimal('10.00', '14,2'), bundleHeads: null, extraHeadAmount: null, withdrawn: false, createdBy: f.personId,
      }),
    );
    expect(plain.daypartId).toBeNull();
  });

  it('a daypart of another store is refused by the foreign key (23503)', async () => {
    const { f } = await fx('s1b-fk');
    const other = (await insDaypart(f, { storeId: f.store2Id, name: 'Elsewhere' }))[0]!.id;
    const err = await refusal(() =>
      asOrg(f, (tx) =>
        menuRepo.insertOffer(tx, {
          orgId: f.orgId, storeId: f.storeId, variantId: f.variantId, channel: 'store', daypartId: other,
          amount: decimal('1.00', '14,2'), bundleHeads: null, extraHeadAmount: null, withdrawn: false, createdBy: f.personId,
        }),
      ),
    );
    expect(code(err)).toBe('23503');
  });

  it('historyClash: `same` is per daypart (all-day = null), `later` is blind to the daypart', async () => {
    const { f, lunch, dinner } = await fx('s1b-clash');
    // A whole-millisecond instant: a JavaScript Date cannot carry now()'s microseconds.
    await sql`insert into menu_offers (org_id, store_id, variant_id, channel, effective_from, daypart_id, amount, withdrawn, created_by)
              values (${f.orgId}, ${f.storeId}, ${f.variantId}, 'store', date_trunc('milliseconds', now() + interval '10 days'), ${lunch}, 338, false, ${f.personId})`;
    const at = new Date((await sql<{ t: Date }[]>`select effective_from as t from menu_offers where org_id = ${f.orgId}`)[0]!.t);
    const key = (daypartId?: string | null) => ({ kind: 'offer' as const, storeId: f.storeId, variantId: f.variantId, channel: 'store' as const, daypartId });
    const clash = (daypartId: string | null | undefined, when: Date) => asOrg(f, (tx) => menuRepo.historyClash(tx, key(daypartId), when));
    expect(await clash(lunch, at)).toBe('same');
    expect(await clash(dinner, at), 'Dinner may start with Lunch').toBeNull();
    expect(await clash(null, at), 'an all-day row at that instant would be a different slot').toBeNull();
    expect(await clash(undefined, at)).toBeNull();
    expect(await clash(dinner, new Date(at.getTime() - 3_600_000)), 'a later row of another daypart still blocks an earlier one').toBe('later');
  });

  it('daypartsRepo: insert, list, get, update (sets updated_at), storeTimezone', async () => {
    const f = await menuFixture('s1b-dp');
    const made = await asOrg(f, (tx) =>
      daypartsRepo.insertDaypart(tx, { orgId: f.orgId, storeId: f.storeId, name: 'Brunch', days: [0, 6], startTime: '10:00', endTime: '14:00', createdBy: f.personId }),
    );
    expect(made).toMatchObject({ name: 'Brunch', days: [0, 6], status: 'active', updatedAt: null });
    expect(made.startTime.slice(0, 5)).toBe('10:00');
    const upd = await asOrg(f, (tx) => daypartsRepo.updateDaypart(tx, made.id, { name: 'Late brunch', endTime: '15:00' }));
    expect(upd.name).toBe('Late brunch');
    expect(upd.endTime.slice(0, 5)).toBe('15:00');
    expect(upd.updatedAt).not.toBeNull();
    expect((await asOrg(f, (tx) => daypartsRepo.getDaypart(tx, f.orgId, made.id)))?.name).toBe('Late brunch');
    expect((await asOrg(f, (tx) => daypartsRepo.listDaypartsOfStore(tx, f.orgId, f.storeId))).map((d) => d.id)).toEqual([made.id]);
    expect(await asOrg(f, (tx) => daypartsRepo.listDaypartsOfStore(tx, f.orgId, f.store2Id))).toEqual([]);
    expect(await asOrg(f, (tx) => daypartsRepo.storeTimezone(tx, f.storeId))).toBe('Asia/Manila');
  });
});
