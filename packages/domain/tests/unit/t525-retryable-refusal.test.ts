import { describe, expect, it } from 'vitest';
import { refuse } from '../../src/shared/refusal';
import { eventFault, isRetryableRefusal, refusalCode } from '../../src/pos/inbox';

/** The classifier for errors that are not refusals: a database error of class 22 (data) or 23 (integrity) is the event's own fault; the rest is a retry. */
describe('T-525 - database error classes', () => {
  const dbError = (code: string, wrapped = false) => {
    const inner = Object.assign(new Error('db'), { code });
    return wrapped ? Object.assign(new Error('Failed query'), { cause: inner }) : inner;
  };
  it('class 22 and 23 (also under a wrapper) are POS_EVENT_INVALID with the SQLSTATE in the sentence', () => {
    for (const code of ['22003', '22P05', '23502', '23514']) {
      for (const wrapped of [false, true]) {
        const f = eventFault(dbError(code, wrapped));
        expect(f?.code, code).toBe('POS_EVENT_INVALID');
        expect(f?.sentence, code).toContain(code);
      }
    }
  });
  it('40001, 40P01, class 08, 53, 57, a node network code and a plain Error are not the event\'s fault (retry)', () => {
    for (const code of ['40001', '40P01', '08006', '08003', '53200', '57014', 'ECONNRESET', 'EPIPE']) expect(eventFault(dbError(code)), code).toBeNull();
    expect(eventFault(new Error('boom'))).toBeNull();
  });
});

/** T-525 planner ruling 7: a refusal from the activity-log writer is a server failure, so the inbox answers `retry` (no row, batch stops), never `quarantined`. */
describe('T-525 - which refusal codes are the server\'s fault', () => {
  it('any AUDIT_* / UNKNOWN_AUDIT_* code is retryable', () => {
    for (const code of ['AUDIT_SCOPE_MISMATCH', 'AUDIT_ACTION_RESERVED', 'AUDIT_ACTOR_MISMATCH', 'UNKNOWN_AUDIT_ACTION']) {
      expect(isRetryableRefusal(code), code).toBe(true);
    }
  });

  it('the event\'s own faults are not: ordinary codes and the POS_EVENT_* family', () => {
    for (const code of ['RULES_NOT_WIRED', 'RECORDED_DIFFERENTLY', 'POS_EVENT_REFUSED', 'POS_EVENT_INVALID', 'POS_EVENT_PERSON_REFUSED', 'POS_EVENT_NOT_ALLOWED', 'POS_EVENT_PIN_REFUSED', 'XAUDIT_NOT']) {
      expect(isRetryableRefusal(code), code).toBe(false);
    }
  });

  it('the real audit writer\'s refusals carry codes the check reads (the raw message starts with the code)', () => {
    const refusal = refuse('AUDIT_SCOPE_MISMATCH: pos.sale_completed is store-scoped and needs a store', 'That change could not be recorded in the activity log. Please tell the developers.');
    expect(refusalCode(refusal)).toBe('AUDIT_SCOPE_MISMATCH');
    expect(isRetryableRefusal(refusalCode(refusal)!)).toBe(true);
    expect(refusalCode(refuse('pos: table already paid', 'This table is already paid.'))).toBeNull();
  });
});
