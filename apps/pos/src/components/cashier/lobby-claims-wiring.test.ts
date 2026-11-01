/**
 * T-455 S7b (TESTER) - source guards for the claim screens (the POS test setup has no DOM, so screens are read as text, like lobby-wiring.test.ts).
 * docs/tasks/455-customer-lobby.md S7b row. Decisions live in src/lib/pos2/lobbyClaims.ts (lobbyClaims.test.ts); this only proves the screens use them.
 *
 * RED FOR THE RIGHT REASON: LobbyClaimDialog.tsx does not exist (readFileSync fails) and LobbyCard.tsx has no claim wiring.
 *
 * ASSUMPTIONS NEEDING A RULING (see also lobbyClaims.test.ts 1-9)
 *  1. New component src/components/cashier/LobbyClaimDialog.tsx (the pre-filled T-426 dialog); LobbyCard.tsx fetches `lobby/claims` with the same 10 s
 *     poll (one extra request per poll, not a second timer), shows the badge per row and a "Discount claims" strip, and mounts the dialog.
 *  2. The dialog writes the diner through `mutateStatutoryDiners` (the T-426 transactional writer) and never through a second Firestore write path.
 *  3. The reject chips come from LOBBY_REJECT_REASONS; there is no text input / textarea for a reason anywhere in the dialog.
 *  4. The Save button is disabled while claimSaveBlock says no (untick blocks), and the tick starts unticked (checked state from prefillFromClaim).
 *  5. The opened name / ID number are never put in localStorage / sessionStorage / lobbyPending, and never logged.
 *  6. On a 503 / offline answer the strip shows CLAIMS_UNAVAILABLE and nothing else on /cashier changes.
 * MUTANTS: M1 no badge in the card; M2 a second poll timer; M3 free-text reject; M4 Save enabled with the tick off; M5 PII in storage / logs;
 *   M6 a second Firestore write path for the diner; M7 approve / reject routes not called; M8 unavailable sentence missing.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const dialog = () => stripComments(read('LobbyClaimDialog.tsx'));
const card = () => stripComments(read('LobbyCard.tsx'));

describe('LobbyCard: claims badge and strip', () => {
  it('polls lobby/claims inside the existing 10 s poll (no new timer) and shows the badge and the "Discount claims" strip [M1, M2]', () => {
    const src = card();
    expect(src).toMatch(/lobby\/claims/);
    expect(src).toContain('claimsByEntry');
    expect(src).toContain('claimBadgeLabel');
    expect(src).toContain('claimListLine');
    expect(src).toContain('Discount claims');
    expect(src).toContain('LobbyClaimDialog');
    expect((src.match(/setInterval\(/g) ?? []).length, 'LobbyCard has more than the one 10 s timer').toBeLessThanOrEqual(1);
  });

  it('says CLAIMS_UNAVAILABLE when the server is down [M8]', () => {
    expect(card()).toMatch(/CLAIMS_UNAVAILABLE|claimFailure/);
  });

  it('never prints a name or ID number in the list: the strip uses claimListLine only [M5]', () => {
    expect(card()).not.toMatch(/holderName|idNumber/);
  });
});

describe('LobbyClaimDialog: the pre-filled T-426 dialog', () => {
  it('exists, opens the claim through lobby/claim-open, pre-fills with prefillFromClaim, and approves / rejects through their routes [M7]', () => {
    expect(existsSync(new URL('./LobbyClaimDialog.tsx', import.meta.url))).toBe(true);
    const src = dialog();
    for (const route of ['lobby/claim-open', 'lobby/claim-approve', 'lobby/claim-reject']) expect(src.includes(route), route).toBe(true);
    expect(src).toContain('prefillFromClaim');
    expect(src).toContain('approveClaimFlow');
    expect(src).toContain('rejectClaimFlow');
  });

  it('has the required "card seen" tick and Save is disabled by claimSaveBlock [M4]', () => {
    const src = dialog();
    expect(src).toMatch(/type=["']checkbox["']|<Checkbox\b/);
    expect(src).toMatch(/I have seen the card|card seen/i);
    expect(src).toContain('claimSaveBlock');
    expect(src).toMatch(/disabled=\{[^}]*(claimSaveBlock|blocked|saveBlock)/);
  });

  it('writes the diner through mutateStatutoryDiners only (T-426 duplicate refusal stays the net) [M6]', () => {
    const src = dialog();
    expect(src).toContain('mutateStatutoryDiners');
    for (const banned of ['addDoc', 'setDoc', 'updateDoc', 'runTransaction', 'collection(']) {
      expect(src.includes(banned), `dialog uses ${banned}`).toBe(false);
    }
  });

  it('rejects with fixed reason chips only: LOBBY_REJECT_REASONS, no text field for a reason [M3]', () => {
    const src = dialog();
    expect(src).toContain('LOBBY_REJECT_REASONS');
    expect(src).not.toMatch(/<textarea\b/i);
    // the only text-like inputs allowed are the T-426 name and ID fields, never one named reason / note
    expect(src).not.toMatch(/name=["']reason["']|id=["']reason["']|aria-label=["'][^"']*reason/i);
  });

  it('keeps the opened name and ID number in memory only and never logs them [M5]', () => {
    const src = dialog();
    for (const banned of ['localStorage', 'sessionStorage', 'indexedDB', 'lobbyPending', 'console.log', 'console.error', 'console.warn']) {
      expect(src.includes(banned), `dialog uses ${banned}`).toBe(false);
    }
  });

  it('shows the plain retry / unavailable sentences from the pure module', () => {
    expect(dialog()).toMatch(/CLAIM_RETRY_MESSAGE|CLAIMS_UNAVAILABLE|\.message/);
  });
});
