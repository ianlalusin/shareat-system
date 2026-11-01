/**
 * T-455 S6b (TESTER) - source guards for the birthday prompt wiring (the POS test setup has no DOM, so screens are read as text, like lobby-wiring.test.ts).
 * Assumptions A3, A4, A5, A8, A10: see src/lib/birthday/player.test.ts header.
 *
 * RED FOR THE RIGHT REASON: BirthdayPrompt.tsx and BirthdaySongButton.tsx do not exist (readFileSync fails) and /cashier does not mount them.
 * MUTANTS: M1 prompt never polls; M2 free-typed decline reason (presets missing); M3 no time picker; M4 no countdown Stop; M5 prompt uses Firestore;
 *   M6 manual button not ported; M7 prompt not mounted on the cashier screen; M8 scheduler never restored on app start.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('BirthdayPrompt', () => {
  it('exists, polls birthday/list on the 10 s poll, and never touches Firestore [M1, M5]', () => {
    expect(existsSync(new URL('./BirthdayPrompt.tsx', import.meta.url))).toBe(true);
    const src = stripComments(read('BirthdayPrompt.tsx'));
    expect(src).toMatch(/lobby\/birthday\/list/);
    expect(src).toMatch(/10_?000/);
    for (const banned of ['firebase/firestore', 'onSnapshot', 'addDoc', 'setDoc', 'updateDoc', 'collection(']) expect(src.includes(banned), banned).toBe(false);
  });

  it('has Accept with a time picker, Decline with the three presets (no free typing), and a countdown with Stop [M2, M3, M4]', () => {
    const src = stripComments(read('BirthdayPrompt.tsx'));
    for (const label of ['Accept', 'Decline', 'Stop']) expect(src.includes(label), label).toBe(true);
    expect(src).toMatch(/type=["']time["']|TimePicker|timePicker/);
    expect(src).toContain('BIRTHDAY_DECLINE_PRESETS');
    expect(src).not.toMatch(/<textarea\b/i);
    expect(src).toMatch(/lobby\/birthday\/accept/);
    expect(src).toMatch(/lobby\/birthday\/decline/);
    expect(src).toContain('createBirthdayScheduler');
    expect(src).toMatch(/\.restore\(\)/); // [M8]
  });
});

describe('the manual button and the cashier screen', () => {
  it('BirthdaySongButton is ported (toggle play/stop through the player module) [M6]', () => {
    expect(existsSync(new URL('./BirthdaySongButton.tsx', import.meta.url))).toBe(true);
    const src = stripComments(read('BirthdaySongButton.tsx'));
    expect(src).toContain('playBirthdayLoop');
    expect(src).toContain('stopAll');
    expect(src).toMatch(/Stop birthday song/);
  });

  it('the cashier screen mounts the prompt and the manual button [M7]', () => {
    const page = readFileSync(new URL('../../app/cashier/page.tsx', import.meta.url), 'utf8');
    expect(page).toContain('BirthdayPrompt');
    expect(page).toContain('BirthdaySongButton');
  });
});
