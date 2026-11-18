import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-606 S4 - "Move to Channel receivable" (`moveChannelToChannelReceivable`). World: the t511-s6b fixture, a Foodpanda channel at Lipa on 1210 with one verified day
 * (10,000 posted Dr 1210 party channel on 12 Oct). The entry is dated by the test's clock argument (the screen never passes one).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

import { channelSettlementsRepo, closeDb } from '@shareat/db';
import { AuthorizationError } from '@shareat/auth';
import * as D from '@shareat/domain';
import { asOrg, auditRows, correct, fx, linesOf, lineText, netDebit, sentenceOf, uid, type Fx } from './_fixtures/t511-s6b-world';

const sql = postgres(url, { max: 8 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const CLOCK = '2026-11-02';
const move = (f: Fx, over: { requestId?: string; who?: Fx['admin']; channelId?: string; today?: string } = {}) =>
  asOrg(f.orgId, (tx) =>
    D.moveChannelToChannelReceivable(tx, over.who ?? f.admin, { channelId: over.channelId ?? f.channelId, requestId: over.requestId ?? crypto.randomUUID() }, over.today ?? CLOCK),
  );
const reclassEntries = async (f: Fx) =>
  sql<{ id: string; entry_date: string }[]>`
    select id, entry_date::text from journal_entries where org_id = ${f.orgId} and source_type = 'channel_receivable_reclass' order by created_at`;
const channelCode = async (f: Fx) => (await sql<{ c: string | null }[]>`select receivable_account_code as c from sales_channels where id = ${f.channelId}`)[0]!.c;

describe('T-606 S4 - the move', () => {
  it('moves the balance and the setting together: Dr 1220 / Cr 1210, party the channel, the line store; both accounts tie; a settlement sees the balance as outstanding - Mutant: swap Dr/Cr, drop the setting change -> red', async () => {
    const f = await fx(sql, 's4-move', { staff: '10000.00', file: '10000.00', receivable: '1210' });
    expect(Number(await netDebit(sql, f.orgId, '1210')), 'control: the day sits on 1210').toBe(10000);
    const r = await move(f);
    expect(r).toMatchObject({ moved: true, total: '10000.00' });
    const entries = await reclassEntries(f);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.entry_date).toBe(CLOCK);
    const lines = await linesOf(sql, entries[0]!.id);
    expect(lineText(lines)).toEqual(['Cr 1210 10000.00', 'Dr 1220 10000.00']);
    for (const l of lines) expect([l.party_type, l.party_id, l.store_id]).toEqual(['channel', f.channelId, f.storeA]);
    expect(Number(await netDebit(sql, f.orgId, '1210'))).toBe(0);
    expect(Number(await netDebit(sql, f.orgId, '1220'))).toBe(10000);
    expect(await channelCode(f)).toBe('1220');
    expect(await asOrg(f.orgId, (tx) => channelSettlementsRepo.outstandingFor(tx, f.orgId, f.channelId))).toBe('10000.00');
    const audit = await auditRows(sql, f.orgId, 'sales_channel.receivable_moved');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ entity_id: f.channelId, store_id: f.storeA, actor_person_id: f.admin.personId });
  });

  it('a second press (the same request id, or a new one) does nothing once nothing is left: one entry, one audit row', async () => {
    const f = await fx(sql, 's4-twice', { staff: '10000.00', file: '10000.00', receivable: '1210' });
    const requestId = crypto.randomUUID();
    await move(f, { requestId });
    expect(await move(f, { requestId })).toMatchObject({ moved: false, entryId: null });
    expect(await move(f)).toMatchObject({ moved: false });
    expect(await reclassEntries(f)).toHaveLength(1);
    expect(await auditRows(sql, f.orgId, 'sales_channel.receivable_moved')).toHaveLength(1);
  });

  it('nothing owed on the old account: it only switches the setting, no entry', async () => {
    const f = await fx(sql, 's4-zero', { staff: '10000.00', file: '10000.00', receivable: '1210', verified: false });
    expect(await move(f)).toMatchObject({ moved: true, entryId: null, total: '0.00' });
    expect(await reclassEntries(f)).toHaveLength(0);
    expect(await channelCode(f)).toBe('1220');
  });

  it('a credit balance posts the other way round, never a negative amount', async () => {
    const f = await fx(sql, 's4-credit', { staff: '10000.00', file: '10000.00', receivable: '1210', verified: false });
    const { postEntry } = await import('../../src/ledger/post-entry');
    await asOrg(f.orgId, (tx) =>
      postEntry(tx, {
        orgId: f.orgId, entryDate: '2026-10-12', sourceType: 'sales_day', sourceId: f.dayId, idempotencyKey: `s4-credit:${uid('k')}`, memo: 'A credit on the channel', postedBy: f.admin.personId,
        lines: [
          { accountCode: '4150', storeId: f.storeA, debit: '50.00' },
          { accountCode: '1210', storeId: f.storeA, credit: '50.00', partyType: 'channel', partyId: f.channelId },
        ],
      }),
    );
    const r = await move(f);
    expect(r.total).toBe('-50.00');
    const [e] = await reclassEntries(f);
    expect(lineText(await linesOf(sql, e!.id))).toEqual(['Cr 1220 50.00', 'Dr 1210 50.00']);
  });
});

describe('T-606 S4 - what is refused', () => {
  it('a manager is refused (manage_chart_of_accounts is admin only) and nothing changes - Mutant: drop the authorize -> the manager moves it, red', async () => {
    const f = await fx(sql, 's4-manager', { staff: '10000.00', file: '10000.00', receivable: '1210' });
    await expect(move(f, { who: f.managerA })).rejects.toThrow(AuthorizationError);
    expect(await channelCode(f)).toBe('1210');
    expect(await reclassEntries(f)).toHaveLength(0);
  });

  it('a channel with no delivery platform has nothing to move', async () => {
    const f = await fx(sql, 's4-noplat', { staff: '10000.00', file: '10000.00', receivable: '1210' });
    await sql`update sales_channels set platform = null, platform_store_code = null where id = ${f.channelId}`;
    expect(await sentenceOf(move(f))).toMatch(/is not a delivery platform channel, so there is nothing to move/);
    expect(await channelCode(f)).toBe('1210');
  });

  it("another organisation's channel is not found, and a bad request id is 'out of date'", async () => {
    const f = await fx(sql, 's4-orgA', { staff: '10000.00', file: '10000.00', receivable: '1210' });
    const g = await fx(sql, 's4-orgB', { staff: '10000.00', file: '10000.00', receivable: '1210' });
    expect(await sentenceOf(move(g, { channelId: f.channelId }))).toBe('That channel no longer exists.');
    expect(await channelCode(f)).toBe('1210');
    expect(await sentenceOf(move(f, { requestId: 'nope' }))).toBe('This form is out of date. Reload the page and try again.');
  });

  it("a closed month is refused with nothing changed: today's period closed -> no entry, the setting stays - Mutant: date it anyway -> posts into a closed month or changes the setting, red", async () => {
    const f = await fx(sql, 's4-closed', { staff: '10000.00', file: '10000.00', receivable: '1210' });
    await sql`update fiscal_periods set status = 'closed' where org_id = ${f.orgId} and starts_on = '2026-10-01'`;
    expect(await sentenceOf(move(f, { today: '2026-10-20' }))).toBe("This month is closed, so the move can't be dated. Ask an admin to open a month first. Nothing was changed.");
    expect(await channelCode(f)).toBe('1210');
    expect(await reclassEntries(f)).toHaveLength(0);
    expect(Number(await netDebit(sql, f.orgId, '1210'))).toBe(10000);
  });
});

describe('T-606 S4 - a balance that comes back after the move', () => {
  const reverseIt = (f: Fx, entryId: string) =>
    asOrg(f.orgId, (tx) => D.reverseEntry(tx, { entryId, reason: 'Undo the move (test)', reversalDate: CLOCK, reversedBy: f.admin.personId }));
  const offBalance = async (f: Fx) =>
    (await asOrg(f.orgId, (tx) => D.listSalesChannelsForAdmin(tx, f.admin, { storeId: f.storeA }))).find((c) => c.id === f.channelId)!.offAccountBalance;

  it('move, an admin reverses the move entry, the button comes back and a second move sweeps the balance so the platform file can be approved again - Mutant: restore the "already on 1220 -> nothing to do" return -> red', async () => {
    const f = await fx(sql, 's4-leftover', { staff: '10000.00', file: '11000.00', receivable: '1210' });
    const first = await move(f);
    await reverseIt(f, first.entryId!);
    expect(await channelCode(f), 'the reversal does not change the setting').toBe('1220');
    expect(Number(await netDebit(sql, f.orgId, '1210')), 'the balance is stranded on 1210 again').toBe(10000);
    expect(await offBalance(f), 'the screen has the figure to show the button').toBe('10000.00');
    expect(await sentenceOf(correct(f, f.admin))).toMatch(/still has \u20b110,000\.00 on 1210 Accounts receivable/);

    const before = (await reclassEntries(f)).length;
    const second = await move(f);
    expect(second).toMatchObject({ moved: true, total: '10000.00' });
    expect((await reclassEntries(f)).length).toBe(before + 1);
    expect(Number(await netDebit(sql, f.orgId, '1210'))).toBe(0);
    expect(Number(await netDebit(sql, f.orgId, '1220'))).toBe(10000);
    expect(await offBalance(f)).toBeNull();
    expect(await auditRows(sql, f.orgId, 'sales_channel.receivable_moved')).toHaveLength(2);
    expect((await correct(f, f.admin)).corrected, 'approvals work again').toBe(true);
    // Nothing left: a further press does nothing.
    expect(await move(f)).toMatchObject({ moved: false, entryId: null });
  });

  it('a replay of the same press posts nothing (even after the entry was reversed), while a new press posts - Mutant: drop the "created: false" return -> a replay audits a move that never happened, red', async () => {
    const f = await fx(sql, 's4-replay', { staff: '10000.00', file: '10000.00', receivable: '1210' });
    const requestId = crypto.randomUUID();
    const first = await move(f, { requestId });
    await reverseIt(f, first.entryId!);
    const entries = (await reclassEntries(f)).length;
    const audits = (await auditRows(sql, f.orgId, 'sales_channel.receivable_moved')).length;
    expect(await move(f, { requestId }), 'a stale tab pressing again').toMatchObject({ moved: false });
    expect((await reclassEntries(f)).length).toBe(entries);
    expect((await auditRows(sql, f.orgId, 'sales_channel.receivable_moved')).length).toBe(audits);
    expect(Number(await netDebit(sql, f.orgId, '1210'))).toBe(10000);
    expect(await move(f), 'a real second press').toMatchObject({ moved: true });
    expect(Number(await netDebit(sql, f.orgId, '1210'))).toBe(0);
  });

  it('a non-admin learns nothing about whether a channel id exists: both a real id and a made-up one are refused as not allowed - Mutant: read the channel before authorize -> the made-up id gets "no longer exists", red', async () => {
    const f = await fx(sql, 's4-oracle', { staff: '10000.00', file: '10000.00', receivable: '1210' });
    await expect(move(f, { who: f.managerA, channelId: f.channelId })).rejects.toThrow(AuthorizationError);
    await expect(move(f, { who: f.managerA, channelId: crypto.randomUUID() })).rejects.toThrow(AuthorizationError);
  });
});
