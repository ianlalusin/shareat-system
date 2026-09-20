import { describe, expect, it } from 'vitest';
import { money, toCentavos } from '@shareat/core/money';
// ⛔ AMENDMENT 3 stub now in place — deliberately WRONG (allocates nothing), not absent. See the
// file header on packages/domain/src/shared/allocate-oldest-first.ts. Every case below runs to its
// own assertion against this stub; a case that PASSES against it is vacuous.
import { allocateOldestFirst, type AllocationItem, type TypedAmount } from '../../src/shared/allocate-oldest-first';

/**
 * T-330 — AMENDMENT 4 rewrite, second pass (Ian's ruling + the auditor's F7-shaped follow-up).
 *
 * ⛔ THE ITEM SHAPE, FINAL: `{ id, dueDate: string | null, documentDate: string, tieBreak, outstanding }`.
 * No `agingDate`, no `createdAt`. THIS MODULE resolves `dueDate ?? documentDate` itself — the one
 * and only implementation of Ian's fallback rule (bible row 162), so a wrapper that gets the
 * fallback wrong has nowhere to hide it: a pre-resolved date cannot be told apart from its absence
 * by a test that only ever sees the resolved value, which is exactly why `agingDate` (the previous
 * shape) was retired before a line of source used it.
 *
 * ⭐ The first ordering case is the auditor's own scenario, the one that reversed the withdrawn
 * NULLS LAST rule: an undated ₱50,000 bill the aging screen already calls `d90plus` must still
 * outrank a ₱10,000 bill with a real but much later due date. It now lives HERE, in the pure file,
 * because the fallback is resolved here.
 */

const item = (
  id: string,
  dueDate: string | null,
  documentDate: string,
  tieBreak: string | null,
  outstanding: string,
): AllocationItem => ({ id, dueDate, documentDate, tieBreak, outstanding: money(outstanding) });

describe('allocateOldestFirst — resolves dueDate ?? documentDate itself (§1, ruling 1 / AMENDMENT 4)', () => {
  it('⭐⭐ an undated bill falls back to its document date and can outrank a bill with a real, later due date', () => {
    // The auditor's scenario verbatim: ₱50,000 invoiced 2026-01-15 with NO due date, against
    // ₱10,000 due 2026-09-25. The aging screen already calls the January bill d90plus. NULLS LAST
    // would have paid September first; the documentDate fallback must pay January first.
    const items = [
      item('september', '2026-09-25', '2026-01-20', 'B-1', '10000.00'), // a real, later due date
      item('january', null, '2026-01-15', 'A-1', '50000.00'), // no due date — falls back to documentDate
    ];
    const result = allocateOldestFirst(items, money('10000.00'));
    expect(result.allocations).toEqual([{ id: 'january', amount: '10000.00' }]);
  });

  it("⭐⭐ MIRROR of the case above (auditor's F1) — reversed geometry, so the correct answer is SECOND, not first: an undated item whose documentDate is LATE must still lose to a dated item due earlier", () => {
    // ⛔ The case above cannot tell a real `dueDate ?? documentDate` fallback apart from "undated
    // sorts first no matter what" — both give the same answer there, because the undated item's
    // documentDate happens to be the earliest date in the fixture. Here it is the LATEST
    // (2026-10-01), so only a genuine fallback resolution puts the dated item ('due-sep',
    // 2026-09-25) first. Verified by hand-simulation against the two candidate bugs before
    // trusting the auditor's claim: "no fallback at all" (null -> '') and "blank-guarded but null
    // not" (`dueDate === '' ? documentDate : (dueDate ?? '')`) BOTH resolve 'undated' to `''`,
    // which sorts before '2026-09-25' and wrongly wins — this case goes red under both.
    const items = [
      item('undated', null, '2026-10-01', null, '1000.00'),
      item('due-sep', '2026-09-25', '2026-01-02', null, '1000.00'),
    ];
    const result = allocateOldestFirst(items, money('1000.00'));
    expect(result.allocations).toEqual([{ id: 'due-sep', amount: '1000.00' }]);
  });

  it("⛔⛔ AMENDMENT 6 — a BLANK due date ('') must be treated as absent, not as a real value that sorts before every date", () => {
    // `dueDate ?? documentDate` only falls back on null/undefined — `'' ?? x` evaluates to `''`,
    // and `''` sorts BEFORE every real date string in ASC order. That is UNDATED-FIRST, the exact
    // option Ian rejected, arriving silently through an expression that reads as obviously correct.
    // The module must guard on truthiness/length, never on `??` alone.
    const items = [
      item('late-due', '2026-12-01', '2026-12-01', null, '1000.00'),
      item('blank', '', '2026-06-15', null, '1000.00'), // '' must resolve to documentDate, 06-15
      item('early-due', '2026-01-01', '2026-01-01', null, '1000.00'),
    ];
    const result = allocateOldestFirst(items, money('3000.00'));
    // Correct: early-due (01-01) < blank→06-15 < late-due (12-01). A `??`-based bug would sort
    // 'blank' FIRST, ahead of even early-due, because '' < '2026-01-01' lexically.
    expect(result.allocations.map((a) => a.id)).toEqual(['early-due', 'blank', 'late-due']);
  });

  it('a due date, once present, wins over documentDate even when documentDate would suggest a different order', () => {
    // 'early-doc' has an early documentDate but a LATE due date — the due date must still govern
    // once it exists at all; documentDate is a fallback, not a competing key.
    const items = [
      item('early-doc', '2026-08-01', '2026-01-01', null, '1000.00'),
      item('has-due', '2026-01-05', '2026-01-10', null, '1000.00'),
    ];
    const result = allocateOldestFirst(items, money('2000.00'));
    expect(result.allocations.map((a) => a.id)).toEqual(['has-due', 'early-doc']);
  });
});

describe('allocateOldestFirst — ordering (§1 of the spec, three keys: resolved date, tieBreak, id)', () => {
  it('resolved-date ASC, then tieBreak ASC, then id ASC — input handed in UNSORTED, and id order does not match insertion order', () => {
    const items = [
      item('id-2', '2026-01-10', '2026-01-10', 'A-1', '1500.00'),
      item('id-0', '2026-01-05', '2026-01-05', 'B-1', '2000.00'),
      item('id-1', '2026-01-10', '2026-01-10', 'A-1', '1000.00'),
    ];
    // Built in an order that matches neither insertion order (id-2, id-0, id-1) nor a trivial
    // reversal — only genuine sorting by (date, tieBreak, id) produces the right answer.
    const result = allocateOldestFirst(items, money('5000.00'));
    expect(result.allocations.map((a) => a.id)).toEqual(['id-0', 'id-1', 'id-2']);
  });

  it('⭐ a null tieBreak never throws, and the tie resolves by id — ids chosen so insertion order is the OPPOSITE of the expected answer', () => {
    // ⛔ Fixed 2026-09-20 per the auditor: the first version of this case used ids 'earlier' and
    // 'later', which sort alphabetically in the SAME direction as the expected answer, so it would
    // have passed for a reason unrelated to the sort actually running. `zz-should-lose` sorts AFTER
    // `aa-should-win` lexically, same as the rule requires, but the two are built in the OPPOSITE
    // order below, so an implementation that merely preserves input order fails this correctly.
    const items = [
      item('zz-should-lose', '2026-01-10', '2026-01-10', null, '100.00'),
      item('aa-should-win', '2026-01-10', '2026-01-10', null, '100.00'),
    ];
    const result = allocateOldestFirst(items, money('200.00'));
    expect(result.allocations.map((a) => a.id)).toEqual(['aa-should-win', 'zz-should-lose']);
  });
});

describe('allocateOldestFirst — exact sum, no epsilon (replaces the struck test 5)', () => {
  // ⛔ VACUOUS AS ORIGINALLY WRITTEN (found 2026-09-20 against the deliberately-empty stub):
  // asserting only `allocations + remainder === payment` is a conservation check an "allocate
  // nothing" implementation satisfies for EVERY case below. `expectedAllocations` closes that gap
  // — adopted into the spec as the standard for this file (AMENDMENT 4).
  const cases: { label: string; outstandings: string[]; amount: string; expectedAllocations: { id: string; amount: string }[] }[] = [
    {
      label: 'a 0.01 payment against a single 1.00 item',
      outstandings: ['1.00'], amount: '0.01',
      expectedAllocations: [{ id: 'item-1', amount: '0.01' }],
    },
    {
      label: 'a 0.05 payment against a single 1.00 item',
      outstandings: ['1.00'], amount: '0.05',
      expectedAllocations: [{ id: 'item-1', amount: '0.05' }],
    },
    {
      label: 'three 33.33 items, payment covers two and part of the third',
      outstandings: ['33.33', '33.33', '33.33'], amount: '77.77',
      expectedAllocations: [
        { id: 'item-1', amount: '33.33' },
        { id: 'item-2', amount: '33.33' },
        { id: 'item-3', amount: '11.11' },
      ],
    },
    {
      // ⛔ FIXED 2026-09-20 (control-B measurement): outstanding === amount made this vector pass
      // fully against a mutant that allocates every item's full outstanding and ignores payment
      // entirely — "cap by payment" and "cap by outstanding" are indistinguishable when the two
      // are equal. Payment is now one centavo BELOW outstanding, so the correct answer is capped
      // by PAYMENT (999999999999.98) while the mutant would still hand back the full outstanding
      // (999999999999.99) — the magnitude stays exercised, the coincidence is gone.
      label: 'a magnitude at the top of numeric(14,2), payment one centavo short of outstanding',
      outstandings: ['999999999999.99'], amount: '999999999999.98',
      expectedAllocations: [{ id: 'item-1', amount: '999999999999.98' }],
    },
    {
      // ⛔ FIXED 2026-09-20, same reason: 0.01 is the smallest representable outstanding, so a
      // single-item version can never make payment < outstanding here — the only way to break the
      // degeneracy at the ALLOCATION-LINE level (not just via the conservation check) is a second
      // item the payment must NOT reach. A mutant that allocates every item its full outstanding,
      // ignoring payment, would wrongly include item-2; the correct answer excludes it entirely.
      label: 'a 0.01 payment against two 0.01 items — only the first is touched',
      outstandings: ['0.01', '0.01'], amount: '0.01',
      expectedAllocations: [{ id: 'item-1', amount: '0.01' }],
    },
  ];

  it.each(cases)('$label — allocates the real lines, and allocations + remainder equal the payment EXACTLY, in centavos', ({ outstandings, amount, expectedAllocations }) => {
    const items = outstandings.map((o, i) => item(`item-${i + 1}`, `2026-01-0${i + 1}`, `2026-01-0${i + 1}`, null, o));
    const result = allocateOldestFirst(items, money(amount));

    // ⭐ The line that closes the vacuousness — an "allocate nothing" stub fails HERE.
    expect(result.allocations).toEqual(expectedAllocations);

    // ⛔ Exact bigint equality — no epsilon, no Number(). Kept alongside the line above, not
    // instead of it — conservation alone is necessary, not sufficient.
    const allocatedCentavos = result.allocations.reduce((sum, a) => sum + toCentavos(money(a.amount)), 0n);
    const remainderCentavos = toCentavos(money(result.remainder));
    expect(allocatedCentavos + remainderCentavos).toBe(toCentavos(money(amount)));

    // Every emitted amount re-parses through money() in this same test — proves each is a real
    // 2dp Money string, not a float artifact that merely LOOKS right when printed.
    for (const a of result.allocations) expect(() => money(a.amount)).not.toThrow();
    expect(() => money(result.remainder)).not.toThrow();
  });

  it('never allocates more than an item is outstanding — the excess becomes remainder, not a bigger item', () => {
    const items = [item('only', '2026-01-01', '2026-01-01', null, '500.00')];
    const result = allocateOldestFirst(items, money('900.00'));
    expect(result.allocations).toEqual([{ id: 'only', amount: '500.00' }]);
    expect(result.remainder).toBe('400.00');
  });

  it('an item already at zero outstanding is skipped, not allocated a zero line', () => {
    const items = [
      item('settled', '2026-01-01', '2026-01-01', null, '0.00'),
      item('open', '2026-01-05', '2026-01-05', null, '300.00'),
    ];
    const result = allocateOldestFirst(items, money('300.00'));
    expect(result.allocations).toEqual([{ id: 'open', amount: '300.00' }]);
  });
});

describe("allocateOldestFirst — Ian's ruling 2: typed amounts are filled by the OPERATOR, never re-filled (AMENDMENT 7)", () => {
  // ⭐ AMENDMENT 7 — this rule had NO TEST ANYWHERE as originally contracted: it could only live
  // in the screen, and §9.4 (the screen) is deferred this cycle (Chrome absent). Moved here so a
  // pure test can falsify it.
  const typed = (id: string, amount: string): TypedAmount => ({ id, amount: money(amount) });

  it('1. a typed item is not re-filled — it does not appear in the output at all', () => {
    const items = [item('typed-item', '2026-01-01', '2026-01-01', null, '500.00')];
    const result = allocateOldestFirst(items, money('500.00'), [typed('typed-item', '500.00')]);
    expect(result.allocations).toEqual([]);
    expect(result.remainder).toBe('0.00');
  });

  it('2. the payment available is reduced by the SUM of typed before allocating anything', () => {
    const items = [
      item('typed-item', '2026-01-01', '2026-01-01', null, '1000.00'),
      item('open-item', '2026-01-05', '2026-01-05', null, '2000.00'),
    ];
    const result = allocateOldestFirst(items, money('800.00'), [typed('typed-item', '300.00')]);
    // Available for auto-fill is 800 − 300 = 500, not the full 800 — invariant 1 reached by the
    // arithmetic that builds the array, a route the existing "allocatedTotal > amount" guard
    // (which sees only the final merged array) does not cover on its own.
    expect(result.allocations).toEqual([{ id: 'open-item', amount: '500.00' }]);
    expect(result.remainder).toBe('0.00');
  });

  it('3. ⛔ a typed sum EXCEEDING the payment is refused, not silently distributed against a negative balance', () => {
    const items = [item('a', '2026-01-01', '2026-01-01', null, '1000.00')];
    expect(() => allocateOldestFirst(items, money('500.00'), [typed('a', '600.00')])).toThrow();
  });

  it('4a. Q5 — a NEGATIVE payment is refused, not distributed (money() accepts a leading "-", so this is reachable)', () => {
    const items = [item('a', '2026-01-01', '2026-01-01', null, '1000.00')];
    expect(() => allocateOldestFirst(items, money('-100.00'))).toThrow();
  });

  it('4b. Q5 — a ZERO payment is refused, not distributed', () => {
    const items = [item('a', '2026-01-01', '2026-01-01', null, '1000.00')];
    expect(() => allocateOldestFirst(items, money('0.00'))).toThrow();
  });

  it('5. ⛔⛔ Q5, the UNSPECIFIED direction — a NEGATIVE typed amount inflates the pot instead of being refused', () => {
    // The auditor's own measurement, replayed: the only guard is `typedCentavos > paymentCentavos`,
    // which a NEGATIVE typed amount passes trivially — `remaining = payment - typedCentavos` then
    // computes to MORE than the payment (Invariant 1 breach: 1000 payment, -100 typed -> 1100
    // proposed). Q5's own reasoning ("money() accepts a leading '-', so refuse a non-positive
    // amount") was applied to `payment` and never to `typed` — the two halves of one subtraction,
    // one guarded and one not. Red against the CURRENT module (it returns an inflated plan instead
    // of throwing) and red against a do-nothing stub too (a stub never throws either) — this case
    // does not depend on which wrong implementation is in the tree, only on "must throw" being true.
    const items = [
      item('A', '2026-01-01', '2026-01-01', null, '1000.00'),
      item('B', '2026-01-05', '2026-01-05', null, '2000.00'),
    ];
    expect(() => allocateOldestFirst(items, money('1000.00'), [typed('A', '-100.00')])).toThrow();
  });

  it("6. ⭐ a typed id ABSENT from `items` still reduces the pot — MY assertion is REFUSE (throw), not Ian's ruling", () => {
    // ⛔ UNRULED — flagging rather than deciding quietly. I read this as consistent with how every
    // other typed-invariant violation in this module behaves (rule 3's "typed sum exceeds payment"
    // throws; Q3's "open id with no matching key" throws) — the module's own pattern is fail
    // closed on any inconsistency touching `typed`, never a silent partial accounting. A caller
    // could reach this if an item closes between the screen rendering it and Save being pressed.
    // If this is the wrong call, invert the assertion — do not let it stand by default because a
    // test happened to assert it first.
    // ⚠️ REACHABILITY: not reachable from the current UI, which only ever builds `typed` FROM the
    // rendered items. This pins the pure module's own contract as a caller-independent guarantee,
    // not a path exercised today. Red against the current module (it silently returns a plan
    // ₱400 short with no error) and red against a do-nothing stub (which also never throws).
    const items = [item('only', '2026-01-01', '2026-01-01', null, '1000.00')];
    expect(() => allocateOldestFirst(items, money('1000.00'), [typed('ghost', '400.00')])).toThrow();
  });

  it("7. ⭐ the SAME id typed TWICE is counted twice against the pot — MY assertion is REFUSE (throw), not Ian's ruling", () => {
    // Same reasoning and same caveat as case 6: unruled, my own reading, invert if wrong.
    // `typedIds` (a Set) correctly de-duplicates for the SKIP step, but `typedCentavos` sums the
    // raw array, so a duplicate id is subtracted from the pot twice while only skipped once — the
    // dedup and the sum disagree with each other over the same input.
    // ⚠️ REACHABILITY: not reachable from the current UI (one box per item, so one typed entry per
    // id) — pins the pure module's contract, not a live path. Red against the current module
    // (silently returns a plan short by the double-counted amount, no error) and red against a
    // do-nothing stub (never throws).
    const items = [item('a', '2026-01-01', '2026-01-01', null, '1000.00')];
    expect(() =>
      allocateOldestFirst(items, money('1000.00'), [typed('a', '100.00'), typed('a', '100.00')]),
    ).toThrow();
  });
});
