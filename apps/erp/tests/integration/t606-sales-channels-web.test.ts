/**
 * T-606 S1 / DEF-924 - the sales-channels edit action, end to end: a delivery-platform channel is saved on the channel receivable only (the card posts the fixed
 * account), and any other channel keeps its free choice (dine-in, a wholesale buyer, branch sales may be sold on credit - Ian, 18 Nov).
 */
import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

class RedirectSignal extends Error {
  constructor(public to: string) {
    super(`redirect:${to}`);
  }
}
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
const ACTOR_HOLDER: { actor: { orgId: string; personId: string } | null } = { actor: null };
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => ACTOR_HOLDER.actor!),
}));
vi.mock('@/lib/constraint-messages', async () => await import('../../src/lib/constraint-messages'));

import { APP_ROLE, transaction, type Tx } from '@shareat/db';
import { createSalesChannel, postEntry, reverseEntry, setSalesChannelPlatformCode } from '@shareat/domain';
import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { paramsOf } from '../helpers/flash-jar';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

async function redirectOf(action: () => Promise<void>): Promise<string> {
  try {
    await action();
  } catch (err) {
    if (err instanceof RedirectSignal) return err.to;
    throw err;
  }
  throw new Error('expected the action to redirect');
}

async function world(hint: string) {
  const code = uid(`t606${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('t606')}, 'Store t606') returning id`;
  const [admin] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${admin!.id}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${admin!.id}, ${store!.id})`;
  const actor = { orgId, personId: admin!.id };
  ACTOR_HOLDER.actor = actor;
  const channel = async (name: string, receivable: string) =>
    (await asOrg(orgId, (tx) => createSalesChannel(tx, actor as never, { storeId: store!.id, name, isRemittedDaily: false, receivableAccountCode: receivable }))).channelId;
  return { orgId, storeId: store!.id, actor, channel };
}

const form = (o: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(o)) fd.set(k, v);
  return fd;
};
const receivableOf = async (id: string) =>
  (await sql<{ receivable_account_code: string | null }[]>`select receivable_account_code from sales_channels where id = ${id}`)[0]?.receivable_account_code;

describe('T-606 S1 - the edit action and the platform receivable', () => {
  it('a platform channel posted with 1210 is refused in words and stays on 1220; posted with 1220 (the fixed account) it saves - Mutant: drop the domain rule -> 1210 saved, red', async () => {
    const { storeId, actor, orgId, channel } = await world('plat');
    const id = await channel('Foodpanda', '1220');
    await asOrg(orgId, (tx) => setSalesChannelPlatformCode(tx, actor as never, { channelId: id, platform: 'foodpanda', code: 'FP9999' }));
    const { updateSalesChannelAction } = await import('../../src/app/settings/sales-channels/actions');
    const body = (receivable: string) => form({ storeId, channelId: id, name: 'Foodpanda', isRemittedDaily: 'false', receivableAccountCode: receivable, wastageTypeMode: 'tracked' });

    const refused = await redirectOf(() => updateSalesChannelAction(body('1210')));
    expect(paramsOf(refused).get('error')).toMatch(/must use 1220 Channel receivable/);
    expect(await receivableOf(id)).toBe('1220');

    const ok = await redirectOf(() => updateSalesChannelAction(body('1220')));
    expect(paramsOf(ok).get('error')).toBeNull();
    expect(await receivableOf(id)).toBe('1220');
  });

  it('a channel with no platform saves 1210 as before (a wholesale buyer on credit)', async () => {
    const { storeId, channel } = await world('credit');
    const id = await channel('Xlice', '1220');
    const { updateSalesChannelAction } = await import('../../src/app/settings/sales-channels/actions');
    const to = await redirectOf(() => updateSalesChannelAction(form({ storeId, channelId: id, name: 'Xlice', isRemittedDaily: 'false', receivableAccountCode: '1210', wastageTypeMode: 'tracked' })));
    expect(paramsOf(to).get('error')).toBeNull();
    expect(await receivableOf(id)).toBe('1210');
  });

  it('the "Move to Channel receivable" action switches a platform channel from 1210 and a second press says nothing to do - Mutant: the action ignores the request or the domain call -> red', async () => {
    const { storeId, actor, orgId, channel } = await world('move');
    const id = await channel('Foodpanda', '1220');
    await asOrg(orgId, (tx) => setSalesChannelPlatformCode(tx, actor as never, { channelId: id, platform: 'foodpanda', code: 'FP7777' }));
    await sql`update sales_channels set receivable_account_code = '1210' where id = ${id}`; // as Lipa's channels are today
    const { moveChannelReceivableAction } = await import('../../src/app/settings/sales-channels/actions');
    const press = () => redirectOf(() => moveChannelReceivableAction(form({ storeId, channelId: id, requestId: crypto.randomUUID() })));
    const first = paramsOf(await press());
    expect(first.get('error')).toBeNull();
    expect(first.get('ok')).toMatch(/Moved\./);
    expect(await receivableOf(id)).toBe('1220');
    expect(paramsOf(await press()).get('ok')).toMatch(/already uses Channel receivable/);
  });
  it('the success flash prints the moved amount with its thousands comma, "₱6,000.00", never "₱6000.00" - Mutant: print the raw total -> red', async () => {
    const { storeId, actor, orgId, channel } = await world('flash');
    const id = await channel('Foodpanda', '1220');
    await asOrg(orgId, (tx) => setSalesChannelPlatformCode(tx, actor as never, { channelId: id, platform: 'foodpanda', code: 'FP6000' }));
    await sql`update sales_channels set receivable_account_code = '1210' where id = ${id}`;
    // The action dates the move by the real Manila today, so the open period is this month's.
    const [m] = await sql<{ s: string; e: string }[]>`
      select to_char(date_trunc('month', now() at time zone 'Asia/Manila'), 'YYYY-MM-DD') s,
             to_char(date_trunc('month', now() at time zone 'Asia/Manila') + interval '1 month - 1 day', 'YYYY-MM-DD') e`;
    await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, ${m!.s}, ${m!.e}, 'open')`;
    await asOrg(orgId, (tx) =>
      postEntry(tx, {
        orgId, entryDate: m!.s, sourceType: 'sales_day', sourceId: id, idempotencyKey: uid('t606-flash'), memo: 'Platform sales on 1210', postedBy: actor.personId,
        lines: [
          { accountCode: '1210', storeId, debit: '6000.00', partyType: 'channel', partyId: id },
          { accountCode: '4150', storeId, credit: '6000.00' },
        ],
      }),
    );
    const { moveChannelReceivableAction } = await import('../../src/app/settings/sales-channels/actions');
    const flash = paramsOf(await redirectOf(() => moveChannelReceivableAction(form({ storeId, channelId: id, requestId: crypto.randomUUID() })))).get('ok');
    expect(flash).toContain('₱6,000.00');
    expect(flash).not.toContain('6000.00');
  });

  it('T-618 DEF-929: a stale tab replaying a press whose entry was reversed is told the balance is on another account again, not "nothing to do" - Mutant: the replay returns total 0 / the action prints the no-op sentence -> red', async () => {
    const { storeId, actor, orgId, channel } = await world('replay');
    const id = await channel('Foodpanda', '1220');
    await asOrg(orgId, (tx) => setSalesChannelPlatformCode(tx, actor as never, { channelId: id, platform: 'foodpanda', code: 'FP6001' }));
    await sql`update sales_channels set receivable_account_code = '1210' where id = ${id}`;
    const [m] = await sql<{ s: string; e: string }[]>`
      select to_char(date_trunc('month', now() at time zone 'Asia/Manila'), 'YYYY-MM-DD') s,
             to_char(date_trunc('month', now() at time zone 'Asia/Manila') + interval '1 month - 1 day', 'YYYY-MM-DD') e`;
    await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, ${m!.s}, ${m!.e}, 'open')`;
    await asOrg(orgId, (tx) =>
      postEntry(tx, {
        orgId, entryDate: m!.s, sourceType: 'sales_day', sourceId: id, idempotencyKey: uid('t618-replay'), memo: 'Platform sales on 1210', postedBy: actor.personId,
        lines: [
          { accountCode: '1210', storeId, debit: '6000.00', partyType: 'channel', partyId: id },
          { accountCode: '4150', storeId, credit: '6000.00' },
        ],
      }),
    );
    const { moveChannelReceivableAction } = await import('../../src/app/settings/sales-channels/actions');
    const requestId = crypto.randomUUID();
    const press = async () => paramsOf(await redirectOf(() => moveChannelReceivableAction(form({ storeId, channelId: id, requestId })))).get('ok');
    expect(await press()).toMatch(/^Moved\./);
    const [e] = await sql<{ id: string }[]>`select id from journal_entries where org_id = ${orgId} and source_type = 'channel_receivable_reclass'`;
    await asOrg(orgId, (tx) => reverseEntry(tx, { entryId: e!.id, reason: 'Undo the move (test)', reversalDate: m!.s, reversedBy: actor.personId }));

    const replay = await press(); // the same request id, from a tab that never saw the reversal
    expect(replay).toContain('That press was already recorded, so nothing was posted twice.');
    expect(replay).toContain('₱6,000.00 is on another account again');
    expect(replay).not.toContain('Nothing to do');
  });
});
