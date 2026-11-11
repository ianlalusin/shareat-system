/**
 * T-526 audit - only a network failure or a 5xx counts toward offline. Any other 4xx (not 401/403, which have their own rulings) is an answer from
 * the server: the state is kept, the shell is told, and the streak resets.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { initialPosState, pollPosState, reducePosState } from '@/app/pos/_shell/pos-state';
import { posHttpErrorMessage } from '@/app/pos/_shell/messages';

const body = { stateVersion: 7, openStands: [], kitchenQueue: [], refillQueue: [] };
const deps = (status: number) => ({
  fetch: vi.fn(async () => new Response(status === 200 ? JSON.stringify(body) : null, { status })) as unknown as typeof fetch,
  storeId: '11111111-1111-4111-8111-111111111111',
  visibilityState: () => 'visible' as const,
});
const had = reducePosState(initialPosState, { type: 'ok', body });

describe('T-526 audit - any other 4xx keeps the state and says so', () => {
  it('400, 404, 409 and 429 keep the body, stay online, reset the streak, and carry the code', async () => {
    for (const status of [400, 404, 409, 429]) {
      const s = await pollPosState(deps(status), await pollPosState(deps(500), had));
      expect(s, String(status)).toMatchObject({ httpError: status, online: true, failures: 0 });
      expect(s.body).toBe(had.body);
    }
  });
  it('the sentence is exact and the shell shows it in a Banner', () => {
    expect(posHttpErrorMessage(404)).toBe('Something went wrong (HTTP 404). Tell a manager.');
    expect(readFileSync('apps/erp/src/app/pos/_shell/PosShell.tsx', 'utf8')).toMatch(/state\.httpError[\s\S]{0,80}posHttpErrorMessage/);
  });
  it('control: a 5xx is still a failure (offline after 2), and a 200 clears the code', async () => {
    const one = await pollPosState(deps(500), had);
    expect(one.httpError).toBeUndefined();
    expect((await pollPosState(deps(503), one)).online).toBe(false);
    expect((await pollPosState(deps(200), await pollPosState(deps(404), had))).httpError).toBeUndefined();
  });
});
