import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-511 S8b (7, Ian's rule of 15 Nov) - a charge (or a credit note / reversal) that arrives AFTER its own month was settled is booked in its own month when that month is still
 * OPEN; when it is CLOSED the charge is booked in the CURRENT month (today, Manila); when the current month is also closed it is refused in the plain words the books already
 * use. Nothing ever posts into a closed period. The reason is recorded on the entry and the audit row and handed back for the message. The idempotency key and the duplicate-copy
 * rule are per charge, never per posting date; the money (amount, VAT, accounts) is identical whichever date is chosen.
 *
 * World: `t511-s6c-world` (Oct and Nov 2026 open, today 5 Nov 2026 through the clock seam). The charge is dated 14 Oct: net 100.00 + VAT 12.00 = 112.00.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);

import { closeDb } from '@shareat/db';
import { setStorageDriver } from '@shareat/domain';
import { CHARGE_DATE, NEXT_OPEN, TODAY, UUID_RE, auditRows, charges, entriesOf, entryCount, linesOf, lineText, netDebit, periodCharge, postCharge, sentenceOf, world } from './_fixtures/t511-s6c-world';

const sql = postgres(url, { max: 6 });
afterAll(async () => {
  setStorageDriver(null);
  await closeDb();
  await sql.end({ timeout: 5 });
});

const closeOctober = (orgId: string) => sql`update fiscal_periods set status = 'closed' where org_id = ${orgId} and starts_on = '2026-10-01'`;
const NOTE = /Dated .* instead of .*: October 2026 is closed\./;

async function memoOf(entryId: string): Promise<string> {
  const [e] = await sql<{ memo: string }[]>`select memo from journal_entries where id = ${entryId}`;
  const lines = await sql<{ line_memo: string | null }[]>`select line_memo from journal_lines where entry_id = ${entryId}`;
  return [e!.memo, ...lines.map((l) => l.line_memo ?? '')].join(' | ');
}

describe('S8b (7) which month a late charge is booked in', () => {
  it('its own month OPEN: the entry keeps the charge date and there is no note [kills: always dating on today]', async () => {
    const f = await world(sql, 'late-open');
    const res = await postCharge(f, f.admin, await periodCharge(sql, f));
    expect(res.posted).toBe(true);
    expect((res as unknown as { dateNote?: string | null }).dateNote ?? null).toBeNull();
    const c = (await charges(sql, f.orgId))[0]!;
    expect([c.charge_date, c.entry_date]).toEqual([CHARGE_DATE, CHARGE_DATE]);
    expect((await auditRows(sql, f.orgId, 'channel_charge.posted'))).toHaveLength(1);
  });

  it('its own month CLOSED, this month open: booked TODAY (5 Nov), not on the first open date after it; the charge date stays 14 Oct; October is never reopened; the sentence is returned [kills: the old "first open date" (1 Nov); a post into the closed month; reopening]', async () => {
    const f = await world(sql, 'late-closed');
    const ol = await periodCharge(sql, f);
    await closeOctober(f.orgId);
    const res = (await postCharge(f, f.admin, ol)) as unknown as { posted: boolean; journalEntryId: string; dateNote?: string | null };
    expect(res.posted).toBe(true);
    const c = (await charges(sql, f.orgId))[0]!;
    expect([c.charge_date, c.entry_date]).toEqual([CHARGE_DATE, TODAY]);
    expect(TODAY, 'the day chosen is not the old answer').not.toBe(NEXT_OPEN);
    expect((await entriesOf(sql, f.orgId)).find((e) => e.id === c.journal_entry_id)!.entry_date).toBe(TODAY);
    expect(res.dateNote).toMatch(NOTE);
    expect(res.dateNote).not.toMatch(UUID_RE);
    const [p] = await sql<{ status: string }[]>`select status from fiscal_periods where org_id = ${f.orgId} and starts_on = '2026-10-01'`;
    expect(p!.status, 'a period is never reopened').toBe('closed');
  });

  it('the reason is recorded on the entry (memo) and on the audit row; an in-month charge records none [kills: a silent move into another month; a reason that is shown but not kept]', async () => {
    const f = await world(sql, 'late-record');
    const ol = await periodCharge(sql, f);
    await closeOctober(f.orgId);
    const res = (await postCharge(f, f.admin, ol)) as unknown as { journalEntryId: string; dateNote: string };
    expect(await memoOf(res.journalEntryId)).toContain(res.dateNote);
    const [a] = await auditRows(sql, f.orgId, 'channel_charge.posted');
    expect(a).toBeDefined();
    const audit = await sql<{ after: Record<string, unknown> }[]>`select after from audit_log where org_id = ${f.orgId} and action = 'channel_charge.posted'`;
    expect(audit[0]!.after.dateNote).toBe(res.dateNote);
    expect(audit[0]!.after).toMatchObject({ chargeDate: CHARGE_DATE, entryDate: TODAY });

    const g = await world(sql, 'late-record-open');
    const open = (await postCharge(g, g.admin, await periodCharge(sql, g))) as unknown as { journalEntryId: string };
    expect(await memoOf(open.journalEntryId)).not.toMatch(/instead of/);
    const auditOpen = await sql<{ after: Record<string, unknown> }[]>`select after from audit_log where org_id = ${g.orgId} and action = 'channel_charge.posted'`;
    expect(auditOpen[0]!.after.dateNote ?? null).toBeNull();
  });

  it('BOTH months closed: refused in the plain words the books already use (no UUID, nothing written, nothing reopened); once this month is open again it books today [kills: a silent post into a closed month; a raw posting error; reopening]', async () => {
    const f = await world(sql, 'late-both');
    const ol = await periodCharge(sql, f);
    await sql`update fiscal_periods set status = 'closed' where org_id = ${f.orgId}`;
    const before = await entryCount(sql, f.orgId);
    const sentence = await sentenceOf(postCharge(f, f.admin, ol));
    expect(sentence).toMatch(/Every month from .* up to today is closed, so the charge can't be dated\. Ask an admin to open a month first\.$/);
    expect(sentence).not.toMatch(UUID_RE);
    expect(await charges(sql, f.orgId)).toHaveLength(0);
    expect(await entryCount(sql, f.orgId)).toBe(before);
    expect(await auditRows(sql, f.orgId, 'channel_charge.posted')).toHaveLength(0);
    await sql`update fiscal_periods set status = 'open' where org_id = ${f.orgId} and starts_on = '2026-11-01'`;
    expect((await postCharge(f, f.admin, ol)).posted).toBe(true);
    expect((await charges(sql, f.orgId))[0]!.entry_date, 'control').toBe(TODAY);
  });

  it('a REVERSAL (a platform credit note, net -100.00 VAT -12.00) follows the same rule: its own month open keeps its date, closed moves it to today, both closed refuses [kills: a credit note that skips the rule]', async () => {
    const open = await world(sql, 'late-rev-open');
    await postCharge(open, open.admin, await periodCharge(sql, open, { net: '-100.00', vat: '-12.00' }));
    expect((await charges(sql, open.orgId))[0]!.entry_date).toBe(CHARGE_DATE);

    const shut = await world(sql, 'late-rev-closed');
    const ol = await periodCharge(sql, shut, { net: '-100.00', vat: '-12.00' });
    await closeOctober(shut.orgId);
    const res = (await postCharge(shut, shut.admin, ol)) as unknown as { dateNote?: string | null };
    expect((await charges(sql, shut.orgId))[0]!.entry_date).toBe(TODAY);
    expect(res.dateNote).toMatch(NOTE);

    const both = await world(sql, 'late-rev-both');
    const ol2 = await periodCharge(sql, both, { net: '-100.00', vat: '-12.00' });
    await sql`update fiscal_periods set status = 'closed' where org_id = ${both.orgId}`;
    expect(await sentenceOf(postCharge(both, both.admin, ol2))).toMatch(/is closed/);
    expect(await charges(sql, both.orgId)).toHaveLength(0);
  });

  it('the money is identical whichever date is chosen: the same total, VAT, accounts and sides in an open month and in a closed one [kills: an amount or an account that depends on the date]', async () => {
    const a = await world(sql, 'late-money-open');
    const b = await world(sql, 'late-money-closed');
    const la = await periodCharge(sql, a);
    const lb = await periodCharge(sql, b);
    await closeOctober(b.orgId);
    await postCharge(a, a.admin, la);
    await postCharge(b, b.admin, lb);
    const ca = (await charges(sql, a.orgId))[0]!;
    const cb = (await charges(sql, b.orgId))[0]!;
    expect([cb.net_amount, cb.vat_amount, cb.total_amount]).toEqual([ca.net_amount, ca.vat_amount, ca.total_amount]);
    expect(lineText(await linesOf(sql, cb.journal_entry_id))).toEqual(lineText(await linesOf(sql, ca.journal_entry_id)));
    expect(lineText(await linesOf(sql, cb.journal_entry_id))).toEqual(['Cr 1220 112.00', 'Dr 6400 112.00']);
    expect([await netDebit(sql, b.orgId, '6400'), await netDebit(sql, b.orgId, '1220')], 'the world holds 10,000.00 on 1220').toEqual(['112.00', '9888.00']);
  });

  it('the idempotency key does not depend on the posting date: posted when October was closed (dated 5 Nov), the same line again on 6 Nov with October reopened is a quiet no-op, one row [kills: a key built from the entry date (a second entry for the same charge)]', async () => {
    const f = await world(sql, 'late-idem');
    const ol = await periodCharge(sql, f);
    await closeOctober(f.orgId);
    expect((await postCharge(f, f.admin, ol)).posted).toBe(true);
    await sql`update fiscal_periods set status = 'open' where org_id = ${f.orgId} and starts_on = '2026-10-01'`;
    const entries = await entryCount(sql, f.orgId);
    expect((await postCharge(f, f.admin, ol, '2026-11-06')).posted).toBe(false);
    expect(await charges(sql, f.orgId)).toHaveLength(1);
    expect(await entryCount(sql, f.orgId)).toBe(entries);
    const [k] = await sql<{ idempotency_key: string }[]>`select idempotency_key from journal_entries where org_id = ${f.orgId} and source_type = 'channel_charge'`;
    expect(k!.idempotency_key).toBe(`channel_charge:${ol}:post`);
  });

  it('the copy rule does not depend on the chosen posting date: a charge booked on 5 Nov (its month closed) is still a copy of an identical staged line dated 14 Oct [kills: comparing the copy on the posting date]', async () => {
    const f = await world(sql, 'late-copy');
    const first = await periodCharge(sql, f);
    const second = await periodCharge(sql, f);
    await closeOctober(f.orgId);
    expect((await postCharge(f, f.admin, first)).posted).toBe(true);
    expect(await sentenceOf(postCharge(f, f.admin, second))).toMatch(/already booked/);
    expect(await charges(sql, f.orgId)).toHaveLength(1);
  });

  it('audit 10: a LOCKED month is shut like a closed one, and the books never let a locked year keep an open month (0160): locking October alone is refused by the database; locking the whole year makes the charge refuse in the plain closed-months words, the period stays locked, nothing is written [kills: a locked month treated as open (a post into a locked period)]', async () => {
    const f = await world(sql, 'late-locked');
    const ol = await periodCharge(sql, f);
    await expect(sql`update fiscal_periods set status = 'locked' where org_id = ${f.orgId} and starts_on = '2026-10-01'`).rejects.toThrow(/open period in a year that is already locked/);
    await sql`update fiscal_periods set status = 'locked' where org_id = ${f.orgId}`;
    const before = await entryCount(sql, f.orgId);
    expect(await sentenceOf(postCharge(f, f.admin, ol))).toMatch(/Every month from .* up to today is closed, so the charge can't be dated\./);
    expect(await charges(sql, f.orgId)).toHaveLength(0);
    expect(await entryCount(sql, f.orgId)).toBe(before);
    const [p] = await sql<{ status: string }[]>`select status from fiscal_periods where org_id = ${f.orgId} and starts_on = '2026-10-01'`;
    expect(p!.status).toBe('locked');
  });

  it('audit 10: a charge dated in a month with NO period row at all is refused in plain words ("no fiscal period"), nothing written; it is not read as open and it is not moved to today (the behaviour of today, pinned) [kills: a missing period row treated as closed (silently moved) or as open (posted without a period)]', async () => {
    const f = await world(sql, 'late-norow');
    const ol = await periodCharge(sql, f, { lineDate: '2026-09-15' });
    const before = await entryCount(sql, f.orgId);
    const sentence = await sentenceOf(postCharge(f, f.admin, ol));
    expect(sentence).toMatch(/There is no fiscal period for .* yet\./);
    expect(sentence).not.toMatch(UUID_RE);
    expect(await charges(sql, f.orgId)).toHaveLength(0);
    expect(await entryCount(sql, f.orgId)).toBe(before);
  });

  it('a charge dated in the future is still refused in its own words, before any month is looked at [kills: the future-date refusal lost]', async () => {
    const f = await world(sql, 'late-future');
    const ol = await periodCharge(sql, f, { lineDate: '2026-11-20' });
    expect(await sentenceOf(postCharge(f, f.admin, ol))).toMatch(/in the future/i);
  });
});
