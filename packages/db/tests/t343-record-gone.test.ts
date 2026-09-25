/**
 * T-343 S3 — `docs/tasks/343-def-417-human-readable-refusals.md` §S3, C2.
 * `RecordGoneError`/`recordGone` (new, `packages/db/src/repo/record-gone.ts`).
 *
 * ⛔ RED until the builder adds the file — `Cannot find module '../../src/repo/record-gone'`.
 */
import { describe, expect, it } from 'vitest';
import { recordGone, RecordGoneError } from '../src/repo/record-gone';

describe('C2 — recordGone(): raw message byte-identical, userMessage names the kind, never the id', () => {
  it('no notLonger: "That <what> could not be found. Someone may have changed it — reload the page and try again."', () => {
    const raw = 'updateSupplier: supplier 0190a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b does not exist in org 0190ffff-0000-7000-8000-000000000001';
    const err = recordGone(raw, 'supplier');
    expect(err).toBeInstanceOf(RecordGoneError);
    expect(err.message, 'the raw diagnostic is byte-identical, never rewritten').toBe(raw);
    expect(err.userMessage).toBe(
      'That supplier could not be found. Someone may have changed it — reload the page and try again.',
    );
  });

  it('with notLonger: "...or it is no longer <notLonger>."', () => {
    const raw = 'markExpenseVoided: expense 0190a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b does not exist, is not in org 0190ffff-0000-7000-8000-000000000001, or is not posted';
    const err = recordGone(raw, 'expense', 'posted');
    expect(err.message).toBe(raw);
    expect(err.userMessage).toBe(
      'That expense could not be found, or it is no longer posted. Someone may have changed it — reload the page and try again.',
    );
  });

  it('NEGATIVE: userMessage never contains a UUID, even when the raw message is full of them', () => {
    const raw = 'x 0190a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b y 0190ffff-0000-7000-8000-000000000001';
    const err = recordGone(raw, 'sales day', 'open');
    expect(err.userMessage).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(err.message).toBe(raw);
  });

  it('NEGATIVE: is a real Error (instanceof Error), so every existing `catch (err instanceof Error)` still works', () => {
    const err = recordGone('raw', 'thing');
    expect(err).toBeInstanceOf(Error);
  });
});
