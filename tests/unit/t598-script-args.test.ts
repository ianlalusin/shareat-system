import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ScriptArgError, scriptArg } from '../../scripts/lib/args';

/**
 * T-598 S12 / DEF-423 - `--org x` (a space) and `--org=` (nothing) used to read as "no org", and the script then ran for EVERY org.
 * MUTANT: make `scriptArg` return undefined for the space form (accept it as absent) -> the first and third cases go red.
 */
const scriptsDir = resolve(__dirname, '../../scripts');

describe('scriptArg', () => {
  it('reads --name=value, keeping a value that itself contains "="', () => {
    expect(scriptArg('org', ['node', 's.ts', '--org=abc'])).toBe('abc');
    expect(scriptArg('period', ['--period=a=b'])).toBe('a=b');
    expect(scriptArg('org', ['--manual'])).toBeUndefined();
  });
  it('refuses the space form by name', () => {
    expect(() => scriptArg('org', ['--org', 'abc'])).toThrow(ScriptArgError);
    expect(() => scriptArg('org', ['--org', 'abc'])).toThrow(/--org needs an equals sign: write --org=<value>/);
  });
  it('refuses an empty value', () => {
    expect(() => scriptArg('org', ['--org='])).toThrow(/--org= has no value/);
  });
});

describe('the ops scripts read their arguments through it', () => {
  it('no script carries its own `--${name}=` reader any more', () => {
    const own = readdirSync(scriptsDir)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => /startsWith\(`--\$\{name\}=`\)/.test(readFileSync(resolve(scriptsDir, f), 'utf8')));
    expect(own, 'these scripts still read --name= themselves, so --name <value> is silently ignored').toEqual([]);
  });

  it('a real script given `--org x` exits non-zero and says why, before it touches anything', () => {
    const r = spawnSync('npx', ['tsx', 'scripts/fiscal-period-seed.ts', '--org', 'x'], { cwd: resolve(scriptsDir, '..'), encoding: 'utf8', shell: true, timeout: 150_000 });
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain('--org needs an equals sign');
  }, 180_000);
});
