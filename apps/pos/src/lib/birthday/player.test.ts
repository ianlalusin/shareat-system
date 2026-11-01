/**
 * T-455 S6b (TESTER) - PORT PARITY with v1's src/lib/birthday/player.test.ts (POS repo, read-only reference).
 * The v1 cases are copied unchanged; the last block adds guards on what the port must ship (mp3s, Android plugin).
 *
 * RED FOR THE RIGHT REASON: `./player` does not exist in apps/pos yet ("Failed to resolve import").
 * CONTRACT THE BUILDER MATCHES: `@/lib/birthday/player` is v1's player.ts verbatim (PLAYLIST, nextTrack, pickStartTrack, HEARD_FRACTION,
 *   playBirthdayLoop, stopAll, getCurrentTrack, subscribe), native plugin name 'BirthdaySong'.
 *
 * ASSUMPTIONS NEEDING A RULING (numbered once here; scheduler.test.ts, birthdayPresets.test.ts and server/__tests__/lobby-birthday-routes.test.ts cite them)
 *  A1. Both mp3s are copied from v1 public/sounds into apps/pos/public/sounds: birthday-shareat.mp3 (1.8 MB, Ian's Suno paid-plan song, commercial use
 *      per the v1 spec of 2026-10-03) and happy-birthday.mp3 (2.0 MB, "supplied by Ian"; the v1 spec states no licence for that recording). Ruling needed:
 *      confirm Ian owns the happy-birthday recording. About 3.8 MB added to the APK.
 *  A2. The Android plugin BirthdaySongPlugin.java is ported to apps/pos/android/.../net/shareat/pos2/ (package renamed pos -> pos2) and registered in pos2 MainActivity.
 *  A3. Routes (all POST, Pos2 auth + deviceId like S5): /api/pos2/lobby/birthday/{list,accept,decline,play}; handlers handleLobbyBirthdayList|Accept|Decline|Play
 *      in @/server/pos2/lobbyBirthday; port methods on Pos2Deps.lobby: birthdayList, birthdayAccept, birthdayDecline, birthdayPlay.
 *      Bodies: list {} -> { ok, birthdays: BirthdayListRow[] }; accept { requestId (uuid), scheduledAt (ISO string) }; decline { requestId, reason }; play { requestId }.
 *  A4. Decline presets (domain accepts any 1..80 text; the POS offers exactly three buttons): "Too busy right now", "Not available today", "We cannot play it at this time".
 *  A5. The prompt shows as a dialog on /cashier, driven by the same 10 s poll as LobbyCard; one request at a time, oldest first; a time picker defaults to "Now".
 *  A6. The schedule survives offline/reload in localStorage key `pos2.birthdaySchedule.<storeId>` (same convenience pattern as lobbyPending). If storage is gone the
 *      request stays accepted on the server and expires 30 min after its time.
 *  A7. "Too late" rule: on restore, an accepted item whose time passed MORE than 30 min ago is dropped and never played; within 30 min it still counts down and plays
 *      (same 30 minutes as the domain's LOBBY_BIRTHDAY_EXPIRE_MINUTES, measured on the tablet clock).
 *  A8. At the scheduled time a 10 s countdown ("Birthday song in 10... Stop") shows; Stop cancels the play for good (the request stays accepted until it expires; there is no staff cancel route).
 *  A9. After the song starts the tablet POSTs birthday/play; if offline the "mark played" is queued in storage and retried by flushPlayed() on the next poll; the song plays regardless.
 *  A10. The manual v1 button (BirthdaySongButton, loops until Stop) is ported as-is to the cashier list.
 */
import { describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

vi.mock('@capacitor/core', () => ({
  registerPlugin: () => ({}),
  Capacitor: { isNativePlatform: () => false },
}));

import { PLAYLIST, nextTrack, pickStartTrack } from './player';

describe('birthday playlist', () => {
  it('plays the SharEat song first, then Happy Birthday', () => {
    expect(PLAYLIST).toEqual(['/sounds/birthday-shareat.mp3', '/sounds/happy-birthday.mp3']);
  });

  it('loops back to the first song after the last', () => {
    expect(nextTrack(0)).toBe(1);
    expect(nextTrack(1)).toBe(0);
  });
});

describe('where the next play starts', () => {
  it('starts with the first song when nothing was played yet', () => {
    expect(pickStartTrack(null)).toBe(0);
  });

  it('moves to the next song when the last one was stopped at 75% or later', () => {
    expect(pickStartTrack({ track: 0, fraction: 0.75 })).toBe(1);
    expect(pickStartTrack({ track: 1, fraction: 0.9 })).toBe(0);
  });

  it('replays the same song when it was stopped before 75%', () => {
    expect(pickStartTrack({ track: 0, fraction: 0.74 })).toBe(0);
    expect(pickStartTrack({ track: 1, fraction: 0.1 })).toBe(1);
  });

  it('ignores a remembered track that no longer exists', () => {
    expect(pickStartTrack({ track: 5, fraction: 0.9 })).toBe(0);
  });
});

describe('what the port ships [A1, A2]', () => {
  const here = (p: string) => new URL(p, import.meta.url);
  it('has both mp3s in apps/pos/public/sounds', () => {
    expect(existsSync(here('../../../public/sounds/birthday-shareat.mp3'))).toBe(true);
    expect(existsSync(here('../../../public/sounds/happy-birthday.mp3'))).toBe(true);
  });
  it('has the Android plugin, named BirthdaySong, registered in MainActivity', () => {
    const dir = '../../../android/app/src/main/java/net/shareat/pos2/';
    expect(existsSync(here(`${dir}BirthdaySongPlugin.java`))).toBe(true);
    expect(readFileSync(here(`${dir}BirthdaySongPlugin.java`), 'utf8')).toContain('@CapacitorPlugin(name = "BirthdaySong")');
    expect(readFileSync(here(`${dir}MainActivity.java`), 'utf8')).toContain('registerPlugin(BirthdaySongPlugin.class)');
  });
});
