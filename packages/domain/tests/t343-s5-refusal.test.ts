/**
 * T-343 S5.0 — F1-F5. `docs/tasks/343-def-417-human-readable-refusals.md` §S5.0 table, Amendment
 * R1 items 3-4, Amendment R2 fold.
 *
 * `packages/domain/src/shared/refusal.ts` (new) re-exports `RefusalError`/`refuse` from
 * `@shareat/db` and adds `gone`, `internalFault`, `humanDate` — the domain-level producer API
 * (Design, §S5: auth cannot import domain, so the class itself lives at the lowest shared layer,
 * `packages/db/src/refusal.ts`, and this file is the producer surface domain code actually calls).
 *
 * ⛔ RED until the builder adds both files — `Cannot find module '../src/shared/refusal'`.
 */
import { describe, expect, it } from 'vitest';
import { recordGone } from '@shareat/db';
import { parseBusinessDate } from '@shareat/core/datetime';
import { RefusalError, refuse, gone, internalFault, humanDate } from '../src/shared/refusal';

const U = '0190a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b';

describe('F1 — refuse(raw, s): a RefusalError carrying the raw diagnostic and the human sentence separately', () => {
  it('instanceof RefusalError and Error; message is raw, userMessage is the sentence, name is RefusalError', () => {
    const raw = 'createExpense: supplier invoice 0190a3b4-... does not belong to this supplier';
    const s = 'That invoice is from a different supplier.';
    const err = refuse(raw, s);
    expect(err).toBeInstanceOf(RefusalError);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe(raw);
    expect(err.userMessage).toBe(s);
    expect(err.name).toBe('RefusalError');
  });
});

describe('F2 — gone(raw, what, notLonger) matches recordGone(...)\'s wording exactly, and is a RefusalError', () => {
  it('gone(...) and recordGone(...) produce the identical userMessage', () => {
    const raw = 'voidExpense: expense 0190a3b4-... does not exist, is not in org ..., or is not posted';
    expect(gone(raw, 'expense', 'posted').userMessage).toBe(recordGone(raw, 'expense', 'posted').userMessage);
  });

  it('recordGone(...) is itself a RefusalError (re-parented, S3\'s shape unchanged)', () => {
    expect(recordGone('raw', 'thing')).toBeInstanceOf(RefusalError);
  });
});

describe('F3 — internalFault(raw) carries NO userMessage (Invariant 13: only for states no user input can produce)', () => {
  it('⛔ has no own userMessage, and message stays the raw diagnostic', () => {
    const raw = 'postEntry: journal entry carries no journalEntryId — data inconsistency';
    const err = internalFault(raw);
    expect(err.message).toBe(raw);
    expect(Object.prototype.hasOwnProperty.call(err, 'userMessage')).toBe(false);
  });
});

describe('F4 — refuse(...) sanitises the sentence; it does not throw on ordinary free text (R1.4)', () => {
  it('⛔ collapses every whitespace run (newlines included) to one space, and trims', () => {
    expect(refuse('raw', 'a\n  b').userMessage).toBe('a b');
  });

  it('⛔ replaces each UUID in the sentence with [hidden], the S1 token', () => {
    expect(refuse('raw', `x ${U}`).userMessage).toBe('x [hidden]');
  });

  it('⛔ throws only when the sanitised result is empty (possible only with an empty/blank literal)', () => {
    // Design names no exact wording for this internal-invariant throw (unlike every user-facing
    // sentence elsewhere in this task, which is always given verbatim) — unruled, flagged rather
    // than invented. The positive control (a real sentence never throws) is the load-bearing half:
    // without it, this test would equally pass if `refuse` threw on EVERY call, proving nothing.
    expect(() => refuse('raw', '  ')).toThrow();
    expect(() => refuse('raw', 'a real sentence')).not.toThrow();
  });
});

describe('F5 — humanDate: no second date formatter alongside formatBusinessDateTime', () => {
  it('renders 2026-09-25 as "Sep 25, 2026" — a hand-written literal, not the implementation\'s own output', () => {
    // /code-review: computing "expected" from formatBusinessDateTime(businessDayRange(...).start, …)
    // is the SAME call chain humanDate itself makes — both sides move together, so the control
    // passes even if humanDate's implementation is wrong in some way this test meant to catch (e.g.
    // the wrong dateStyle, or the wrong instant within the day). "Sep 25, 2026" is independently
    // verified: `Intl.DateTimeFormat('en-PH', { dateStyle: 'medium', timeZone: 'Asia/Manila' })`
    // formatting Manila midnight of 2026-09-25 (`2026-09-24T16:00:00.000Z`, UTC+8, no DST).
    const result = humanDate(parseBusinessDate('2026-09-25'));
    expect(result).toBe('Sep 25, 2026');
    expect(result).toContain('2026');
    expect(result).toContain('25');
  });
});
