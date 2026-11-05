/**
 * T-511 S4 (TESTER, 2026-11-04) - `store-match.ts`: which channel does the code in the file belong to, and what does the person read when it is nobody's.
 * docs/tasks/511-settlement-upload-s4-spec.md "store-match.ts".
 *
 * RED today, for one reason: `packages/domain/src/settlement-intake/store-match.ts` does not exist (the import below cannot resolve).
 *
 * CONTRACT:
 *  M1  `matchChannel(tx: Tx, orgId: string, platform: 'grab' | 'foodpanda', code: string): Promise<MatchedChannel>` with
 *      `MatchedChannel = { channelId, channelName, storeId, storeName, platform, code }` (the code as typed, trimmed). It looks the channel up with
 *      `channelByPlatformCode` (reused from sales-days.ts; reachable as `settlementIntakeRepo.channelByPlatformCode` or `salesDaysRepo.channelByPlatformCode`:
 *      this test replaces BOTH with one stub, so either route works). The comparison itself (lower, trim) is the repo's SQL; this function must not
 *      lower-case or otherwise rewrite the code it passes beyond trimming.
 *  M2  Every refusal is a `SettlementIntakeRefusal`. A blank code refuses WITHOUT querying. Not found and inactive refuse with a sentence that names the
 *      Foodpanda vendor code the staff typed; for a Grab Store ID (a UUID) the sentence never prints it (`refuse()` would turn it into "[hidden]", so the
 *      sentence must not rely on printing one) and says to ask an admin to enter the Grab store code on the channel.
 *  M3  Only active channels match. (The "two stores" case of the spec cannot reach this function: the unique index leaves one channel per code, so the
 *      lookup returns at most one. It is the unique index that is tested, in the S2 migration test.)
 *  M4  `matchChannel` knows nothing about the actor: "This file does not belong to your stores" is the ingest fine gate's sentence, tested in the
 *      ingest integration test.
 */
import { describe, expect, it, vi } from 'vitest';
import { SettlementIntakeRefusal } from '../../src/settlement-intake/refusal';

const lookup = vi.hoisted(() => vi.fn());
vi.mock('@shareat/db', async (importOriginal) => {
  const real = await importOriginal<Record<string, Record<string, unknown>>>();
  const withLookup = (ns: Record<string, unknown> | undefined): Record<string, unknown> => ({ ...(ns ?? {}), channelByPlatformCode: lookup });
  return { ...real, salesDaysRepo: withLookup(real.salesDaysRepo), settlementIntakeRepo: withLookup(real.settlementIntakeRepo) };
});

import { matchChannel, refuseIfInactive } from '../../src/settlement-intake/store-match';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const GRAB_ID = '2aa5b300-2e60-4b52-8306-91e3377551ae';
const TX = {} as never;
const ORG = '00000000-0000-4000-8000-000000000001';

const found = (over: Record<string, unknown> = {}) => ({ id: 'c-1', name: 'Foodpanda', storeId: 's-1', storeName: 'Lipa', isActive: true, ...over });

async function refusalOf(run: () => Promise<unknown>): Promise<SettlementIntakeRefusal> {
  try {
    await run();
  } catch (e) {
    if (e instanceof SettlementIntakeRefusal) return e;
    throw e;
  }
  throw new Error('expected a SettlementIntakeRefusal but the call returned normally');
}

describe('T-511 S4 store-match - the happy path', () => {
  it('returns the channel and its store for an active match, passing the org and platform through [kills: wrong platform or org in the lookup]', async () => {
    lookup.mockReset().mockResolvedValue(found());
    const r = await matchChannel(TX, ORG, 'foodpanda', '  O6JZ ');
    expect(r).toMatchObject({ channelId: 'c-1', storeId: 's-1', storeName: 'Lipa', platform: 'foodpanda' });
    const args = lookup.mock.calls[0] as unknown[];
    expect(args[1]).toBe(ORG);
    expect(args[2]).toBe('foodpanda');
    expect(['O6JZ', '  O6JZ ']).toContain(args[3]); // as typed or trimmed (the SQL compares lower/trim); never rewritten to lower case here
  });

  it('a Grab Store ID is looked up as the Grab platform', async () => {
    lookup.mockReset().mockResolvedValue(found({ name: 'Grab' }));
    await matchChannel(TX, ORG, 'grab', GRAB_ID);
    expect((lookup.mock.calls[0] as unknown[])[2]).toBe('grab');
  });
});

describe('T-511 S4 store-match - the sentences', () => {
  it('Foodpanda code not found: the sentence names the code the staff typed, no id, no [hidden] [kills: generic "not found" with no code]', async () => {
    lookup.mockReset().mockResolvedValue(null);
    const r = await refusalOf(() => matchChannel(TX, ORG, 'foodpanda', 'A08X'));
    expect(r.message).toContain('A08X');
    expect(r.message).not.toMatch(UUID);
    expect(r.message).not.toContain('[hidden]');
    expect(r.userMessage).toContain('A08X');
  });

  it('Grab Store ID not found: the sentence never prints the id, says it is not set up and to ask an admin to enter the Grab store code on the channel [kills: UUID printed (refuse() turns it into [hidden])]', async () => {
    lookup.mockReset().mockResolvedValue(null);
    const r = await refusalOf(() => matchChannel(TX, ORG, 'grab', GRAB_ID));
    for (const text of [r.message, r.userMessage]) {
      expect(text).not.toMatch(UUID);
      expect(text).not.toContain('[hidden]');
      expect(text).not.toContain(GRAB_ID.slice(0, 8));
      expect(text).toMatch(/Grab store is not set up/i);
      expect(text).toMatch(/ask an admin/i);
      expect(text).toMatch(/Grab store code/i);
    }
  });

  // Audit fix 4 (4 Nov): matchChannel RETURNS an inactive channel (so the ingest can run the store gate first); refuseIfInactive is the second step the ingest runs after the gate.
  it('an inactive (retired) channel is returned by matchChannel, then refuseIfInactive refuses: it names the Foodpanda code, and never prints a Grab id [kills: matching a retired channel; the inactive sentence reaching someone who may not see the store]', async () => {
    lookup.mockReset().mockResolvedValue(found({ isActive: false }));
    expect(await matchChannel(TX, ORG, 'foodpanda', 'O6JZ')).toMatchObject({ channelId: 'c-1', storeId: 's-1', isActive: false });
    const fp = await refusalOf(async () => refuseIfInactive(await matchChannel(TX, ORG, 'foodpanda', 'O6JZ')));
    expect(fp.message).toContain('O6JZ');
    expect(fp.message).toMatch(/inactive|retired|not active|switched off/i);
    const grab = await refusalOf(async () => refuseIfInactive(await matchChannel(TX, ORG, 'grab', GRAB_ID)));
    expect(grab.message).not.toMatch(UUID);
    expect(grab.message).not.toContain('[hidden]');
    expect(grab.message).toMatch(/inactive|retired|not active|switched off/i);
  });

  it('a blank or whitespace code refuses without querying [kills: looking up an empty code]', async () => {
    lookup.mockReset();
    for (const platform of ['foodpanda', 'grab'] as const) {
      for (const code of ['', '   ']) {
        const r = await refusalOf(() => matchChannel(TX, ORG, platform, code));
        expect(r.message).not.toContain('[hidden]');
      }
    }
    expect(lookup).not.toHaveBeenCalled();
  });

  it('a hostile vendor code (a UUID shape, very long, newlines) is shown safely: no UUID, one line, short [kills: echoing the cell raw]', async () => {
    lookup.mockReset().mockResolvedValue(null);
    const r = await refusalOf(() => matchChannel(TX, ORG, 'foodpanda', `${GRAB_ID}\nX${'Z'.repeat(300)}`));
    expect(r.message).not.toMatch(UUID);
    expect(r.message).not.toContain('[hidden]');
    expect(r.message.length).toBeLessThan(400);
    expect(r.message).not.toContain('\n');
  });
});
