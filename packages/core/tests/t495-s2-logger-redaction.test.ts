import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { REDACT_CENSOR, REDACT_PATHS } from '../src/logger';

/**
 * T-495 S2 / DEF-792 - sensitive keys are redacted at the root and up to four levels down. Built on the production redact config with
 * a capturing stream, so a wrong path list fails here rather than in a log file. Synthetic values only.
 */
function capture() {
  const lines: string[] = [];
  const log = pino({ level: 'info', redact: { paths: REDACT_PATHS, censor: REDACT_CENSOR } }, {
    write: (s: string) => {
      lines.push(s);
    },
  });
  return { log, out: () => lines.join('') };
}

describe('T-495 S2 - nested redaction', () => {
  it('controls: a root key and a one-level key are redacted', () => {
    const { log, out } = capture();
    log.info({ token: 'SYNTH-ROOT-TOKEN', context: { password: 'SYNTH-ONE-LEVEL' } }, 'x');
    expect(out()).not.toContain('SYNTH-ROOT-TOKEN');
    expect(out()).not.toContain('SYNTH-ONE-LEVEL');
    expect(out()).toContain(REDACT_CENSOR);
  });

  it.each([
    ['context.pin', { context: { pin: 'SYNTH-PIN-1' } }],
    ['context.accessToken', { context: { accessToken: 'SYNTH-ACCESS-1' } }],
    ['request.credentials.password', { request: { credentials: { password: 'SYNTH-PASS-3' } } }],
    ['a.b.c.sessionToken (3 deep)', { a: { b: { c: { sessionToken: 'SYNTH-SESS-4' } } } }],
    ['a.b.c.d.privateKey (4 deep)', { a: { b: { c: { d: { privateKey: 'SYNTH-KEY-5' } } } } }],
    ['context.DATABASE_URL', { context: { DATABASE_URL: 'postgres://u:SYNTH-DB@h/d' } }],
    ['context.template (biometric)', { context: { template: 'SYNTH-TEMPLATE' } }],
  ])('%s is redacted', (_label, payload) => {
    const { log, out } = capture();
    log.info(payload, 'x');
    expect(out()).not.toMatch(/SYNTH-/);
    expect(out()).toContain(REDACT_CENSOR);
  });

  it("a child logger's bindings are redacted too", () => {
    const { log, out } = capture();
    log.child({ correlationId: 'c1', context: { pin: 'SYNTH-CHILD-PIN' } }).info('x');
    expect(out()).not.toContain('SYNTH-CHILD-PIN');
  });

  it('non-sensitive nested keys are left alone', () => {
    const { log, out } = capture();
    log.info({ context: { storeId: 'store-7', nested: { count: 3 } } }, 'x');
    expect(out()).toContain('store-7');
    expect(out()).toContain('"count":3');
  });
});
