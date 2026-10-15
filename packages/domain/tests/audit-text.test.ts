import { describe, expect, it } from 'vitest';
import { AUDIT_FREE_TEXT_MAX, AUDIT_TRUNCATED_MARK, capAuditText } from '../src/shared/audit-text';

/** T-402 S3 audit: the cap must cut on a code-point boundary. A lone surrogate is rejected by Postgres jsonb. */
const hasLoneSurrogate = (s: string) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

describe('capAuditText cuts on a code-point boundary', () => {
  it('499 ASCII + emoji + more: no lone surrogate, head is whole code points, <= 500 code points + marker', () => {
    const text = 'a'.repeat(499) + '😀' + 'b'.repeat(1000);
    const out = capAuditText(text);
    expect(out.endsWith(AUDIT_TRUNCATED_MARK)).toBe(true);
    expect(hasLoneSurrogate(out), 'no lone surrogate').toBe(false);
    const head = out.slice(0, out.length - AUDIT_TRUNCATED_MARK.length);
    expect(hasLoneSurrogate(head)).toBe(false);
    expect([...head].length).toBeLessThanOrEqual(AUDIT_FREE_TEXT_MAX);
    expect(text.startsWith(head), 'head is a prefix of the input').toBe(true);
    expect(JSON.parse(JSON.stringify(out))).toBe(out);
  });

  it('500 emoji (1,000 UTF-16 units) is under the cap in code points and is kept whole', () => {
    const text = '😀'.repeat(500);
    expect(capAuditText(text)).toBe(text);
  });

  it('600 emoji is cut to 500 whole emoji + the marker', () => {
    const out = capAuditText('😀'.repeat(600));
    expect(out).toBe('😀'.repeat(500) + AUDIT_TRUNCATED_MARK);
  });
});
