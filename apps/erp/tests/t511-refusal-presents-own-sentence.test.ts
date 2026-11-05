import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SETTLEMENT_INTAKE_REFUSAL_CODES, intakeRefusal, leaveRefusal, RefusalError } from '@shareat/domain';
import { errorMessage } from '@/lib/constraint-messages';
import { containsIdentifier } from '@/lib/error-shape';

/**
 * T-511 (BOSS-approved fix, 2026-11-04) - a refusal that carries a machine `code` (SettlementIntakeRefusal, LeaveRefusal) is still a REFUSAL: the screen
 * shows its own sentence. `isPresentable` used to reject any error with a string `code`, so every one of them read "The database refused that change".
 * The brand is set only in `RefusalError`'s class body (packages/db/src/refusal.ts); a database error cannot carry it.
 */
const DB_SENTENCE = /The database refused that change/;
const UUID = '3f2b8c1e-5d4a-4b6f-9a7e-1c2d3e4f5a6b';

describe('a branded refusal shows its own sentence, whatever its code', () => {
  it('SettlementIntakeRefusal and LeaveRefusal are RefusalErrors', () => {
    expect(intakeRefusal('FILE_EMPTY', 'The file is empty.')).toBeInstanceOf(RefusalError);
    expect(leaveRefusal('LEAVE_NO_DAYS', 'Pick at least one day.')).toBeInstanceOf(RefusalError);
  });

  it('every settlement code presents its own sentence, never the developer message, never "database"', () => {
    for (const code of SETTLEMENT_INTAKE_REFUSAL_CODES) {
      const r = intakeRefusal(code, `Sentence for ${code} that a person can act on.`);
      const shown = errorMessage(r);
      expect(shown, code).toBe(r.userMessage);
      expect(shown, code).not.toMatch(DB_SENTENCE);
    }
  });

  it('a leave refusal presents its own sentence', () => {
    const r = leaveRefusal('LEAVE_NO_DAYS', 'Pick at least one day.');
    expect(errorMessage(r)).toBe('Pick at least one day.');
  });

  it('the developer message is not what shows when it differs from the sentence; a UUID in either never reaches the screen', () => {
    const r = new (class extends RefusalError {
      readonly code = 'SOME_CODE';
    })(`developer detail for ${UUID}`, `Please check the file for ${UUID} and try again.`);
    const shown = errorMessage(r);
    expect(shown).not.toContain('developer detail');
    expect(containsIdentifier(shown)).toBe(false);
    expect(shown).not.toMatch(DB_SENTENCE);
  });
});

describe('a database error is still never presented, with or without a SQLSTATE-shaped code', () => {
  it('a postgres-shaped error (SQLSTATE code, own message) shows the generic sentence', () => {
    const err = Object.assign(new Error('could not serialize access due to concurrent update on relation "x"'), { code: '40001', severity: 'ERROR' });
    expect(errorMessage(err)).toMatch(DB_SENTENCE);
    expect(errorMessage(err)).not.toContain('relation');
  });
  it('the same error carrying a userMessage-shaped property still shows the generic sentence', () => {
    const err = Object.assign(new Error('boom'), { code: '08006', userMessage: 'It is fine, carry on.' });
    expect(errorMessage(err)).not.toBe('It is fine, carry on.');
  });
  it('a plain object { code, message } is not an Error and shows the generic sentence', () => {
    const shown = errorMessage({ code: '23505', message: 'duplicate key value' });
    expect(shown).toMatch(DB_SENTENCE);
    expect(shown).not.toContain('duplicate key value');
  });
  it('a connection error shows nothing about the host', () => {
    const err = Object.assign(new Error('write ECONNREFUSED 10.0.0.1:5432'), { code: 'ECONNREFUSED' });
    expect(errorMessage(err)).not.toContain('10.0.0.1');
  });
  it('an error that merely copies the brand name as a plain property is not a refusal', () => {
    const err = Object.assign(new Error('write ECONNREFUSED 10.0.0.1:5432'), { code: 'ECONNREFUSED', userMessage: 'fine', refusal: true });
    expect(errorMessage(err)).not.toBe('fine');
  });
});

describe('the brand is minted in one place', () => {
  it("only packages/db/src/refusal.ts (the class) and error-shape.ts (the reader) name Symbol.for('shareat.refusal')", () => {
    const root = resolve(__dirname, '..', '..', '..');
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === '.next' || name === 'tests') continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(name) && readFileSync(full, 'utf8').includes("Symbol.for('shareat.refusal')")) hits.push(full.slice(root.length + 1).replaceAll(sep, '/'));
      }
    };
    for (const d of ['packages', 'apps']) for (const sub of readdirSync(join(root, d))) if (statSync(join(root, d, sub)).isDirectory()) walk(join(root, d, sub));
    expect(hits.sort()).toEqual(['apps/erp/src/lib/error-shape.ts', 'packages/db/src/refusal.ts']);
  });
});
