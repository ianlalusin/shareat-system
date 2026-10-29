import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CAPABILITIES } from '../../packages/auth/src/capabilities';

/**
 * T-398 S6 (audit): the capability list embedded in log_break_glass_approval (newest migration that defines it) equals CAPABILITIES exactly.
 * A new capability without a CREATE OR REPLACE migration of the function fails here, loudly.
 */
describe('log_break_glass_approval capability list', () => {
  it('equals CAPABILITIES in capabilities.ts (same members, none extra)', () => {
    const dir = join(__dirname, '..', '..', 'packages', 'db', 'migrations');
    const files = readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f) && /FUNCTION\s+"?log_break_glass_approval"?/i.test(readFileSync(join(dir, f), 'utf8'))).sort();
    expect(files.length, 'a migration defines log_break_glass_approval').toBeGreaterThan(0);
    const sql = readFileSync(join(dir, files[files.length - 1]!), 'utf8');
    const at = sql.search(/FUNCTION\s+"?log_break_glass_approval"?/i);
    const body = sql.slice(at);
    const arr = /ARRAY\[([^\]]*)\]/s.exec(body);
    expect(arr, 'an ARRAY[...] capability list in the function').not.toBeNull();
    const listed = [...arr![1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    expect([...new Set(listed)].sort()).toEqual([...CAPABILITIES].sort());
    expect(listed.length, 'no duplicates').toBe(new Set(listed).size);
  });
});
