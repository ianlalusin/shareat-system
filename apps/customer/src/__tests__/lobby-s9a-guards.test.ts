import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * T-455 S9a items 1 and 3 -- structural guards on the diner glue (no database). docs/tasks/455-customer-lobby.md "S9 rulings".
 * handlers.ts opens exactly ten diner transactions (check-in, me, cancel, birthday request / read / cancel, discount submit / read / cancel, store):
 * every one must go through withLobbyPrincipal, none through the org-wide withOrgPrincipal. The public store read consults the limiter before any query.
 *
 * MUTANT INDEX: one route left on withOrgPrincipal; withLobbyPrincipal imported but a route still opening `transaction` / withSystemOrgPrincipal directly;
 * the limiter called after the lookup or not at all.
 */
const APP = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const handlers = strip(readFileSync(join(APP, 'src', 'server', 'lobby', 'handlers.ts'), 'utf8'));

describe('S9a diner glue', () => {
  it('G1 every diner transaction runs under withLobbyPrincipal (exactly 10) and none under withOrgPrincipal [kills: a route left on the org-wide role]', () => {
    expect(handlers.match(/\bwithLobbyPrincipal\(/g)?.length).toBe(10);
    expect(handlers).not.toMatch(/\bwithOrgPrincipal\b/);
    expect(handlers).not.toMatch(/\bwithSystemOrgPrincipal\b|\bsystemTransaction\b|\bauthTransaction\b|\btransaction\(/);
    expect(handlers).toMatch(/import \{[^}]*\bwithLobbyPrincipal\b[^}]*\} from '@shareat\/db'/);
  });

  it('G2 handleStore consults the read limiter before it opens a transaction, and answers 429 with the counter sentence [kills: limiter after the lookup; no limiter]', () => {
    const at = handlers.indexOf('export async function handleStore');
    expect(at).toBeGreaterThan(0);
    const body = handlers.slice(at);
    const limiter = body.indexOf('lobbyReadAllowed(');
    const tx = body.indexOf('withLobbyPrincipal(');
    expect(limiter).toBeGreaterThan(0);
    expect(limiter).toBeLessThan(tx);
    expect(body).toMatch(/fail\(429, SENTENCES\.counter\)/);
  });

  it('G3 the limiter file never keeps a raw ip as a key or writes a log line [kills: the raw address stored or logged]', () => {
    const src = strip(readFileSync(join(APP, 'src', 'server', 'lobby', 'rate-limit.ts'), 'utf8'));
    expect(src).toMatch(/createHmac|createHash/);
    expect(src).not.toMatch(/console\.|logger\./);
  });
});
