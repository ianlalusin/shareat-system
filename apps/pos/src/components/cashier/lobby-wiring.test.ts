/**
 * T-455 S5 (TESTER) - source guards for the lobby card wiring (the POS test setup has no DOM, so the screens are read as text, in the
 * style of statutory-panel-wiring.test.ts). docs/tasks/455-customer-lobby.md "S5 rulings" 6, 7 and the S5 row of section 5.
 *
 * RED FOR THE RIGHT REASON: src/components/cashier/LobbyCard.tsx and src/lib/pos2/lobby.ts do not exist (readFileSync fails) and the walk-in modal still writes Firestore.
 * MUTANTS: M1 staff walk-in still goes to Firestore (a leftover addDoc); M2 the card still listens to Firestore; M3 free typing for the code search;
 *   M4 /cashier still mounts WaitlistCard; M5 no 10 s poll; M6 seat never links the phone; M7 seating deletes a Firestore waitlist doc for a lobby entry;
 *   M8 Retry link / Pause lobby / 503 sentence missing; M9 Pause shown without lobbyEnabled.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
const logic = () => readFileSync(new URL('../../lib/pos2/lobby.ts', import.meta.url), 'utf8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('LobbyCard', () => {
  it('exists, polls the list route every 10 s, and never touches Firestore [M2, M5]', () => {
    expect(existsSync(new URL('./LobbyCard.tsx', import.meta.url))).toBe(true);
    const src = stripComments(read('LobbyCard.tsx'));
    expect(src).toMatch(/pos2\/lobby\/list|['"`]lobby\/list['"`]/);
    expect(src).toMatch(/10_?000/);
    for (const banned of ['firebase/firestore', 'onSnapshot', 'addDoc', 'deleteDoc', 'updateDoc', 'setDoc', 'collection(']) {
      expect(src.includes(banned), `LobbyCard uses ${banned}`).toBe(false);
    }
  });

  it('searches the code on an on-screen number pad: no text input in the card [M3]', () => {
    const src = stripComments(read('LobbyCard.tsx'));
    expect(src).not.toMatch(/<Input\b|<input\b|<textarea\b/i);
    expect(src).toContain('keypadPress');
    expect(src).toContain('filterByCode');
  });

  it('has Add walk-in, Call / Seat / Remove (Remove asks once), the Retry link row action, and shows Pause lobby only when the store has the lobby on [M8, M9]', () => {
    const src = read('LobbyCard.tsx');
    for (const label of ['Add walk-in', 'Call', 'Seat', 'Remove', 'Pause lobby']) expect(src.includes(label), label).toBe(true);
    expect(src).toMatch(/useConfirmDialog|confirm\(/);
    expect(src).toMatch(/LOBBY_RETRY_LABEL|Retry link/);
    expect(src).toMatch(/lobbyEnabled\s*&&|lobbyEnabled\s*\?/);
    for (const route of ['lobby/call', 'lobby/remove', 'lobby/pause']) expect(src.includes(route), route).toBe(true);
  });

  it('says the waiting list needs the POS server when it is unavailable [M8]', () => {
    expect(logic()).toContain('The waiting list needs the POS server. Seat walk-ins as usual.');
    expect(read('LobbyCard.tsx')).toMatch(/LOBBY_UNAVAILABLE|lobbyFailure/);
  });
});

describe('the walk-in path lands in Postgres, not Firestore [M1]', () => {
  it('ParkWalkInModal posts to /api/pos2/lobby/park and has no Firestore write left', () => {
    const src = stripComments(read('ParkWalkInModal.tsx'));
    expect(src).toMatch(/lobby\/park/);
    for (const banned of ['addDoc', 'firebase/firestore', 'serverTimestamp', 'setDoc', 'collection(']) {
      expect(src.includes(banned), `ParkWalkInModal still has ${banned}`).toBe(false);
    }
  });
});

describe('/cashier mounts the lobby card and seats through the lobby routes', () => {
  const list = () => stripComments(read('session-list-view.tsx'));

  it('mounts LobbyCard, not WaitlistCard [M4]', () => {
    expect(list()).toContain('<LobbyCard');
    expect(list()).not.toContain('<WaitlistCard');
    expect(list()).not.toMatch(/from\s+['"]\.\/WaitlistCard['"]/);
  });

  it('after the session starts it fetches the join URL like the PIN slip and calls lobby/seat through linkSeatedSession [M6]', () => {
    const wiring = stripComments(list() + read('LobbyCard.tsx'));
    expect(wiring).toContain('linkSeatedSession');
    expect(wiring).toContain('/api/pins/join-url');
    expect(wiring).toMatch(/lobby\/seat/);
  });

  it('seating a lobby entry never deletes a Firestore waitlist document [M7]', () => {
    // The reservation path may still touch Firestore; the waitlist path (collection "waitlist") must be gone.
    expect(list()).not.toMatch(/["'`]waitlist["'`]/);
  });
});
