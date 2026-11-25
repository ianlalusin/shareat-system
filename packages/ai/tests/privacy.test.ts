import { describe, expect, it } from 'vitest';
import { PrivacyRefusal, guardChatRequest, scrubText, stripPersonalFields } from '../src/privacy';

/**
 * T-640 test 7: the privacy guard scrubs ID-shaped and key-shaped strings before any outgoing call, refuses a picture, and strips fields that name a person or pay.
 * Every number and key below is made up for the test.
 */
const gone = (input: string, ...secrets: string[]) => {
  const out = scrubText(input).text;
  for (const s of secrets) expect(out, `"${s}" survived in: ${out}`).not.toContain(s);
  return out;
};

describe('T-640 privacy guard - ID-shaped numbers', () => {
  it('SSS, TIN, PhilHealth and Pag-IBIG numbers, dashed or run together, are replaced [kills: a missing pattern, a pattern that only matches the dashed form]', () => {
    gone('SSS 33-1234567-8', '33-1234567-8', '1234567');
    gone('SSS 3312345678', '3312345678');
    gone('TIN 123-456-789', '123-456-789');
    gone('TIN with branch 123-456-789-000', '123-456-789', '000');
    gone('TIN 123456789', '123456789');
    gone('PhilHealth 12-345678901-2', '345678901');
    gone('PhilHealth 123456789012', '123456789012');
    gone('Pag-IBIG 1234-5678-9012', '5678');
    gone('Pag-IBIG 123456789012', '123456789012');
  });

  it('card and account numbers of 13 to 19 digits are replaced, whole [kills: leaving the tail of a 16-digit card]', () => {
    expect(gone('card 4111 1111 1111 1111 ok', '4111', '1111')).toBe('card [NUMBER REMOVED] ok');
    expect(gone('card 4111-1111-1111-1111 ok', '4111', '1111')).toBe('card [NUMBER REMOVED] ok');
    gone('acct 1234567890123', '1234567890123');
  });

  it('ordinary business numbers are left alone: amounts, dates, quantities, codes, UUIDs [kills: a guard so greedy the model gets nothing to work with]', () => {
    const business = 'Sales were 12,345.67 pesos on 2026-11-25 for 48 covers; SKU 1001, qty 2500, 1234567890.50 total; shipping: free; ref 019a3f2e-1234-7abc-8def-0123456789ab.';
    expect(scrubText(business)).toEqual({ text: business, redactions: {} });
  });

  it('the marker holds no part of what it replaced, and the counts say how many of each kind [kills: a marker that echoes the number]', () => {
    const r = scrubText('TIN 123-456-789 and SSS 33-1234567-8, mail a.b@example.com');
    expect(r.text).toBe('TIN [ID REMOVED] and SSS [ID REMOVED], mail [CONTACT REMOVED]');
    expect(r.redactions).toEqual({ government_id: 2, contact: 1 });
  });
});

describe('T-640 privacy guard - key-shaped strings, credentials and contacts', () => {
  it('provider keys, bearer tokens, JWTs and long random-looking tokens are replaced [kills: a key leaving in a prompt]', () => {
    gone('use sk-ant-api03-AbCdEf0123456789xyzXYZ please', 'AbCdEf0123456789xyzXYZ');
    gone('key=sk-proj-0123456789abcdefghijABCDEFGHIJ', '0123456789abcdefghij');
    gone('AIzaSyA1234567890abcdefghijklmnopqrstuv', 'AIzaSy');
    gone('Authorization: Bearer abcdefghijklmnop12345678', 'abcdefghijklmnop12345678');
    gone('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop', 'eyJhbGci');
    gone('hash 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08', '9f86d081884c7d659a2f');
  });

  it('a PIN or password written as "pin: value" loses the value and keeps the word; "shipping: free" is not a PIN [kills: leaving a PIN in, or eating ordinary words]', () => {
    expect(gone('PIN: 4821 and password = hunter2', '4821', 'hunter2')).toBe('PIN: [REMOVED] and password = [REMOVED]');
    expect(scrubText('shipping: free, spinning: yes').text).toBe('shipping: free, spinning: yes');
  });

  it('e-mail addresses and Philippine mobile numbers are replaced [kills: leaving a person\'s contact in]', () => {
    gone('write to maria.santos@example.com', 'maria.santos', 'example.com');
    gone('call 09171234567', '09171234567');
    gone('call 0917-123-4567', '123-4567');
    gone('call +63 917 123 4567', '917 123 4567');
  });
});

describe('T-640 privacy guard - other separators, other key shapes (security audit)', () => {
  it('SSS, TIN, PhilHealth and Pag-IBIG numbers grouped with a space, a dot or a slash are replaced too [kills: a pattern that only knows the dash]', () => {
    for (const sep of [' ', '.', '/', '-']) {
      gone(`SSS 33${sep}1234567${sep}8`, '1234567');
      gone(`TIN 123${sep}456${sep}789`, '456');
      gone(`TIN with branch 123${sep}456${sep}789${sep}000`, '456');
      gone(`PhilHealth 12${sep}345678901${sep}2`, '345678901');
      gone(`Pag-IBIG 1234${sep}5678${sep}9012`, '5678');
    }
  });

  it('Philippine mobile numbers with spaces, dots, a country code or brackets are replaced [kills: a phone number written the way people write it]', () => {
    gone('call 917 123 4567', '917', '4567');
    gone('call (0917) 123-4567', '0917', '4567');
    gone('call 0917 123 4567', '4567');
    gone('call +63 (917) 123-4567', '4567');
    gone('call 0917.123.4567', '4567');
  });

  it('Stripe-style sk_live_ / sk_test_ keys and an Authorization: Basic credential are replaced; the word "Basic" in prose is not [kills: a key shape with an underscore, a Basic credential in a header]', () => {
    gone('key sk_live_0123456789abcdefABCD', '0123456789abcdef');
    gone('key sk_test_0123456789abcdefABCD', '0123456789abcdef');
    gone('rk_live_0123456789abcdefABCD', '0123456789abcdef');
    gone('Authorization: Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpwYXNzd29yZA');
    expect(scrubText('Basic understanding of tax rates').text).toBe('Basic understanding of tax rates');
  });
});

describe('T-640 privacy guard - pictures and personal fields', () => {
  it('a base64 picture is REFUSED, not scrubbed [kills: a receipt image reaching a provider]', () => {
    expect(() => scrubText('here: data:image/jpeg;base64,/9j/4AAQSkZJRg')).toThrow(PrivacyRefusal);
    expect(() => guardChatRequest({ messages: [{ role: 'user', content: 'x data:image/png;base64,iVBORw0KGgo' }] })).toThrow(PrivacyRefusal);
  });

  it('fields that name a person, pay, a PIN, a credential, an ID or an image are stripped at any depth; other fields stay; the input is not changed [kills: pay per person leaving]', () => {
    const input = { store: 'Lipa', total: 1250, staff: [{ fullName: 'Maria Santos', dailyRate: 610, role: 'cashier' }], pin: '4821', nested: { Receipt_Image: 'xx', tin: '123456789', note: 'ok' } };
    const removed = { count: 0 };
    const out = stripPersonalFields(input, removed) as typeof input;
    expect(out).toEqual({ store: 'Lipa', total: 1250, staff: [{ fullName: '[REMOVED]', dailyRate: '[REMOVED]', role: 'cashier' }], pin: '[REMOVED]', nested: { Receipt_Image: '[REMOVED]', tin: '[REMOVED]', note: 'ok' } });
    expect(removed.count).toBe(5);
    expect(input.pin).toBe('4821');
    expect(input.staff[0]!.fullName).toBe('Maria Santos');
  });

  it('guardChatRequest cleans the system prompt, every message (JSON ones lose personal fields first) and the tool descriptions, and reports counts only [kills: a part of the payload that skips the guard]', () => {
    const g = guardChatRequest({
      system: 'You help the owner. Owner TIN 123-456-789.',
      messages: [
        { role: 'user', content: 'Why is SSS 33-1234567-8 here?' },
        { role: 'assistant', content: JSON.stringify({ sales: 100, fullName: 'Maria Santos', pin: '4821' }) },
      ],
      tools: [{ name: 'lookup', description: 'Look up by email a.b@example.com', parameters: { type: 'object' } }],
    });
    const all = JSON.stringify(g);
    for (const leak of ['123-456-789', '33-1234567-8', 'Maria Santos', '4821', 'a.b@example.com']) expect(all, leak).not.toContain(leak);
    const second = g.messages[1]!;
    if (second.role !== 'assistant') throw new Error('expected the assistant turn');
    expect(JSON.parse(second.content)).toEqual({ sales: 100, fullName: '[REMOVED]', pin: '[REMOVED]' });
    expect(g.redactions).toEqual({ government_id: 2, personal_field: 2, contact: 1 });
    expect(g.tools![0]!.parameters).toEqual({ type: 'object' });
  });
});
