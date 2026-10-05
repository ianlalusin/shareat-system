import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-271 — DEF-301. `docs/tasks/271-def-301-constraint-message-lookup.md` §Tests item 5.
 *
 * ⭐ Proves the MECHANISM: a key CAN now be added for one of DEF-279's five hand-raised
 * `RAISE EXCEPTION ... USING CONSTRAINT` invariants and will match by exact structural lookup — the
 * thing substring search could never do, because none of the five ever emit their own name in the
 * message text (that is the whole of DEF-279/DEF-301). Does NOT add any of the five sentences to
 * `CONSTRAINT_MESSAGES` — that is T-272's call. Approved by system32-85 (Q2): mutate the map
 * in-memory for the duration of one test, restore it, and prove the mutation cannot reach the
 * `/setup` allowlist (`WRITTEN_FOR_A_PERSON`, computed once at import time in `pre-session-message.ts`).
 *
 * ⛔ Lives in its OWN file, on the orchestrator's instruction, so vitest's per-file module isolation
 * does real work: nothing here can leak into `constraint-message-lookup.test.ts`'s 26-key pass.
 *
 * ⭐ TDD note: this test is EXPECTED TO FAIL (red) against the OLD substring-search `errorMessage` —
 * captured before the 4-line edit landed — and to pass (green) after it. That is the opposite of the
 * 26-key file, which must stay green throughout; the two files prove different things.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(
    `Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`,
  );
}

import { CONSTRAINT_MESSAGES, errorMessage } from '../../src/lib/constraint-messages';
import { isUnfitForAStranger } from '../../src/lib/pre-session-message';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  await sql.end();
});

async function provoke(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected a real constraint violation, but the statement succeeded');
}

describe('T-271 — mechanism proof: a DEF-279 trigger name can now be mapped', () => {
  it('stock_movements_no_negative_on_hand_trg, provoked for real, matches a transiently-added key and never widens the /setup allowlist', async () => {
    const code = uid('t271-mech');
    const [org] = await sql<{ id: string }[]>`
      insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
    const orgId = org!.id;
    const [store] = await sql<{ id: string }[]>`
      insert into stores (org_id, code, name) values (${orgId}, ${uid('store')}, ${'Store'}) returning id`;
    const storeId = store!.id;
    const [person] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${orgId}, 'Actor') returning id`;
    const personId = person!.id;
    const [locType] = await sql<{ id: string }[]>`
      insert into location_types (org_id, code, name) values (${orgId}, ${uid('LT')}, 'Stockroom') returning id`;
    const [location] = await sql<{ id: string }[]>`
      insert into stock_locations (org_id, store_id, code, name, type_id, created_by)
      values (${orgId}, ${storeId}, ${uid('LOC')}, 'Main', ${locType!.id}, ${personId}) returning id`;
    const [item] = await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, created_by)
      values (${orgId}, ${uid('ITEM')}, 'Test Item', 'raw_material', 'kg', ${personId}) returning id`;

    // A real receipt first — pure fixture setup, no refusal expected.
    await sql`
      insert into stock_movements
        (org_id, store_id, location_id, item_id, moved_at, quantity, kind, source_type, source_id, created_by)
      values (${orgId}, ${storeId}, ${location!.id}, ${item!.id}, '2026-01-20T02:00:00Z', '5',
              'receipt', 'delivery', ${crypto.randomUUID()}, ${personId})`;

    // A real usage movement that overdraws it — fires `stock_movements_no_negative_on_hand_trg`
    // for real, via migration 0142's `USING CONSTRAINT`, so `err.constraint_name` is populated.
    const err = await provoke(
      () => sql`
        insert into stock_movements
          (org_id, store_id, location_id, item_id, moved_at, quantity, kind, source_type, source_id, created_by)
        values (${orgId}, ${storeId}, ${location!.id}, ${item!.id}, '2026-01-20T03:00:00Z', '-6',
                'usage', 'usage', ${crypto.randomUUID()}, ${personId})`,
    );
    const raw = err instanceof Error ? err.message : String(err);
    const constraintName = (err as { constraint_name?: unknown } | null)?.constraint_name;
    expect(constraintName).toBe('stock_movements_no_negative_on_hand_trg');
    expect(raw).not.toContain('constraint_name'); // sanity: the field is structured, not in the prose
    expect(raw).not.toMatch(/constraint "stock_movements_no_negative_on_hand_trg"/); // never in the message text — DEF-279's whole point

    // ⛔ Before this task's change, substring search could never find this name anywhere in `raw`
    // (asserted above), so a key added for it would have sat there matching nothing — DEF-301 exactly.

    const TEST_SENTENCE = '__T271_MECHANISM_PROOF_ONLY__ this sentence must never ship';
    const snapshotBefore = { ...CONSTRAINT_MESSAGES };
    expect(Object.prototype.hasOwnProperty.call(CONSTRAINT_MESSAGES, 'stock_movements_no_negative_on_hand_trg')).toBe(
      false,
    );

    // ⚠️ The allowlist probe below must use the REAL provoked `err`, not a plain `new Error(...)`.
    // `isUnfitForAStranger` returns `false` (fit) for ANY plain single-line `Error` regardless of
    // `WRITTEN_FOR_A_PERSON` membership — that set only starts to matter once `err` carries a
    // driver `code` (a real Postgres error always does), which is exactly `err`'s shape here.
    // Sanity, pre-mutation: a real driver error whose message isn't in the allowlist reads unfit.
    expect(isUnfitForAStranger(err, TEST_SENTENCE)).toBe(true);

    try {
      // The transient mutation. Never touches the source file — reverted in `finally` below.
      (CONSTRAINT_MESSAGES as Record<string, string>).stock_movements_no_negative_on_hand_trg = TEST_SENTENCE;

      // THE MECHANISM: exact structural lookup now matches a key that substring search never could.
      expect(errorMessage(err)).toBe(TEST_SENTENCE);

      // THE ALLOWLIST PROOF (condition 3): `WRITTEN_FOR_A_PERSON` in pre-session-message.ts is a
      // module-level `const` built from `CONSTRAINT_MESSAGES` at IMPORT time, so a later runtime
      // mutation cannot reach it — this is invariant 1, demonstrated rather than assumed. If the
      // mutation somehow reached it, this would flip to `false` (fit) instead.
      expect(isUnfitForAStranger(err, TEST_SENTENCE)).toBe(true);
    } finally {
      delete (CONSTRAINT_MESSAGES as Record<string, string>).stock_movements_no_negative_on_hand_trg;
    }

    // The restore actually took: CONSTRAINT_MESSAGES is byte-for-byte what it was before this test.
    expect(CONSTRAINT_MESSAGES).toEqual(snapshotBefore);
    // T-369 S7: 26 -> 27, deliberately — the sales-day unique sentence is written for a person.
    // T-370 S3: 27 -> 28, deliberately — the semi-monthly two-days sentence is written for a person too.
    // T-375 S4: 28 -> 32, deliberately: the four sales-lock constraints.
    expect(Object.keys(CONSTRAINT_MESSAGES).length).toBe(32);

    // And the allowlist reads the same after restore as before the mutation ever happened.
    expect(isUnfitForAStranger(err, TEST_SENTENCE)).toBe(true);
  });

  /**
   * ⛔ system32-85's catch, T-271 CHANGES round: the sibling case the test above does NOT cover,
   * and it is production reality today for all five DEF-279 invariants — no key has been added yet.
   *
   * `resolveConstraintName` finding a structural name is not the same question as "is this raw
   * Postgres grammar a person must never read" (`genericConstraintMessage`'s whole reason to exist,
   * DEF-246/bible row 189). The signal for THAT is `parseConstraintName(raw)` specifically — the name
   * appearing in the PROSE. A hand-raised `RAISE EXCEPTION` message is not raw grammar; it is a
   * sentence a person deliberately wrote for another person, and sanitising it destroys information
   * DEF-301's own register row already named as worth keeping: "the five keep rendering their own
   * hand-authored text, which is precise and actionable... and is BETTER than the generic fallback —
   * T-270 deliberately reverted to it."
   *
   * ⭐ TDD: watch this FAIL first — against the two-branch `if (constraintName) return
   * genericConstraintMessage(raw)` version, `errorMessage` cannot tell "resolved via structured field
   * only" apart from "resolved via prose", so it wrongly sanitises this into the generic sentence.
   * Green only once the gate is narrowed to `parseConstraintName(raw)`.
   */
  it('a DEF-279 invariant with NO key added still renders its own hand-authored sentence, never the generic one', async () => {
    const code = uid('t271-noregress');
    const [org] = await sql<{ id: string }[]>`
      insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
    const orgId = org!.id;
    const [store] = await sql<{ id: string }[]>`
      insert into stores (org_id, code, name) values (${orgId}, ${uid('store')}, ${'Store'}) returning id`;
    const storeId = store!.id;
    const [person] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${orgId}, 'Actor') returning id`;
    const personId = person!.id;
    const [locType] = await sql<{ id: string }[]>`
      insert into location_types (org_id, code, name) values (${orgId}, ${uid('LT')}, 'Stockroom') returning id`;
    const [location] = await sql<{ id: string }[]>`
      insert into stock_locations (org_id, store_id, code, name, type_id, created_by)
      values (${orgId}, ${storeId}, ${uid('LOC')}, 'Main', ${locType!.id}, ${personId}) returning id`;
    const [item] = await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, created_by)
      values (${orgId}, ${uid('ITEM')}, 'Test Item', 'raw_material', 'kg', ${personId}) returning id`;

    await sql`
      insert into stock_movements
        (org_id, store_id, location_id, item_id, moved_at, quantity, kind, source_type, source_id, created_by)
      values (${orgId}, ${storeId}, ${location!.id}, ${item!.id}, '2026-01-20T02:00:00Z', '5',
              'receipt', 'delivery', ${crypto.randomUUID()}, ${personId})`;

    const err = await provoke(
      () => sql`
        insert into stock_movements
          (org_id, store_id, location_id, item_id, moved_at, quantity, kind, source_type, source_id, created_by)
        values (${orgId}, ${storeId}, ${location!.id}, ${item!.id}, '2026-01-20T03:00:00Z', '-6',
                'usage', 'usage', ${crypto.randomUUID()}, ${personId})`,
    );
    const raw = err instanceof Error ? err.message : String(err);
    const constraintName = (err as { constraint_name?: unknown } | null)?.constraint_name;
    expect(constraintName).toBe('stock_movements_no_negative_on_hand_trg'); // structured field: present
    expect(raw).not.toMatch(/constraint "stock_movements_no_negative_on_hand_trg"/); // prose: absent

    expect(
      Object.prototype.hasOwnProperty.call(CONSTRAINT_MESSAGES, 'stock_movements_no_negative_on_hand_trg'),
    ).toBe(false); // no key added — production reality today for all five DEF-279 invariants

    const message = errorMessage(err);
    // Amendment R1 item 1: every UUID in the hand-authored sentence is redacted to `[hidden]` in
    // place; the rest of the sentence (including the computed quantity) survives verbatim.
    expect(message).toBe(raw.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '[hidden]'));
    expect(message).toContain('stock would go negative: item [hidden] at location [hidden] would be');
    expect(message).toContain('after this movement');
    expect(message).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i); // no raw UUID
    expect(message).not.toContain("isn't allowed for"); // never `genericConstraintMessage`'s wording
    expect(message).not.toContain('please check the values you entered');
  });
});
