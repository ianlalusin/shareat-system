import { describe, expect, it } from 'vitest';
import { checkField } from '../../src/field-rules/check';
import { POS_REDACTED, POS_STATUTORY_HOLDER_RULES } from '../../src/field-rules/pos';
import { scrubStatutoryHolders } from '../../src/pos/inbox';

/** T-572 (DEF-823) - the device log keeps no senior or PWD card number or name. docs/tasks/572-pos-events-senior-id-scrub.md R1, R4. */
const sale = (seniors: unknown) => ({ sessionId: 's', receiptId: 'r', seniors });
const card = { dinerNo: 1, kind: 'senior', idNumber: 'OSCA-9990042', holderName: 'Zyxwv Quillfeather' };

describe('scrubStatutoryHolders - an allowlist, not a blocklist', () => {
  it('keeps dinerNo and kind, replaces the number and the name with the fixed marker, and drops every other key', () => {
    const out = scrubStatutoryHolders(sale([{ ...card, birthday: '1950-01-01', address: '1 Rizal St' }]));
    expect(out.seniors).toEqual([{ dinerNo: 1, kind: 'senior', idNumber: POS_REDACTED, holderName: POS_REDACTED }]);
    expect(JSON.stringify(out)).not.toMatch(/OSCA|Zyxwv|1950|Rizal/);
  });

  it('leaves the rest of the payload and an empty list alone; the input is not mutated', () => {
    const p = sale([]);
    expect(scrubStatutoryHolders(p)).toEqual(sale([]));
    const q = sale([card]);
    scrubStatutoryHolders(q);
    expect((q.seniors as typeof card[])[0]!.idNumber).toBe('OSCA-9990042');
  });

  it('a malformed list never leaks: a non-object element, an odd dinerNo or kind, and a seniors that is not a list all become the marker', () => {
    const out = scrubStatutoryHolders(sale(['OSCA-1', { dinerNo: 'OSCA-2', kind: 'OSCA-3', idNumber: 'OSCA-4' }]));
    expect(JSON.stringify(out)).not.toMatch(/OSCA/);
    expect(scrubStatutoryHolders(sale('OSCA-5')).seniors).toBe(POS_REDACTED);
    expect(scrubStatutoryHolders(sale(null)).seniors).toBeNull();
    expect('seniors' in scrubStatutoryHolders({ sessionId: 's' })).toBe(false);
  });
});

describe('the marker is never a card number or a name', () => {
  it('POS_STATUTORY_HOLDER_RULES refuses it for both fields, in any case and with spaces, and still accepts a real card', () => {
    for (const v of [POS_REDACTED, ` ${POS_REDACTED} `, POS_REDACTED.toUpperCase()]) {
      expect(checkField(POS_STATUTORY_HOLDER_RULES.idNumber, v).ok, `idNumber ${v}`).toBe(false);
      expect(checkField(POS_STATUTORY_HOLDER_RULES.holderName, v).ok, `holderName ${v}`).toBe(false);
    }
    expect(checkField(POS_STATUTORY_HOLDER_RULES.idNumber, 'OSCA-9990042').ok).toBe(true);
    expect(checkField(POS_STATUTORY_HOLDER_RULES.holderName, 'Zyxwv Quillfeather').ok).toBe(true);
  });
});
