'use client';

import { registerPlugin, Capacitor, type PluginListenerHandle } from '@capacitor/core';

/**
 * Native side: android/.../BirthdaySongPlugin.java. On the tablets the songs play
 * through Android's MediaPlayer — the WebView's <audio> stopped responding after a
 * stop (2026-10-17). A plain browser falls back to <audio>.
 */
interface BirthdaySongPlugin {
  play(options: { start: number }): Promise<void>;
  stop(): Promise<{ track: number; fraction: number }>;
  addListener(event: 'track', cb: (data: { index: number }) => void): Promise<PluginListenerHandle>;
}

const Native = registerPlugin<BirthdaySongPlugin>('BirthdaySong');

/** Played in this order, then looped until stopped. Files live in public/sounds. */
export const PLAYLIST = ['/sounds/birthday-shareat.mp3', '/sounds/happy-birthday.mp3'] as const;

/** Index of the track after `i`, wrapping back to the first. */
export function nextTrack(i: number, length: number = PLAYLIST.length): number {
  return (i + 1) % length;
}

/** A track counts as heard once this much of it has played. */
export const HEARD_FRACTION = 0.75;

/**
 * Where the next Play starts: the track after the one last stopped if at least 75% of
 * it played, otherwise that same track again. With no history, the first track.
 */
export function pickStartTrack(
  last: { track: number; fraction: number } | null,
  length: number = PLAYLIST.length,
): number {
  if (!last || !Number.isInteger(last.track) || last.track < 0 || last.track >= length) return 0;
  return last.fraction >= HEARD_FRACTION ? nextTrack(last.track, length) : last.track;
}

// Remembered per tablet so the rotation survives an app restart. Storage can be
// unavailable (private mode, cleared data); then it just starts from the first track.
const RESUME_KEY = 'birthdaySong.lastStop';

function readLastStop(): { track: number; fraction: number } | null {
  try {
    const raw = localStorage.getItem(RESUME_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    return typeof v?.track === 'number' && typeof v?.fraction === 'number' ? v : null;
  } catch {
    return null;
  }
}

function writeLastStop(track: number, fraction: number): void {
  if (track < 0) return;
  try { localStorage.setItem(RESUME_KEY, JSON.stringify({ track, fraction })); } catch { /* storage unavailable */ }
}

// Playback state lives at module level, not in a component, so the song keeps going
// while the cashier moves between the cashier list and the dashboard.
let currentTrack: number | null = null;
const listeners = new Set<(track: number | null) => void>();

function setTrack(track: number | null): void {
  currentTrack = track;
  listeners.forEach((l) => l(track));
}

/** The playing track's index, or null when nothing is playing. */
export function getCurrentTrack(): number | null {
  return currentTrack;
}

/** Calls `listener` whenever the playing track changes. Returns an unsubscribe. */
export function subscribe(listener: (track: number | null) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const isNative = () => Capacitor.isNativePlatform();

// --- Android: MediaPlayer in the plugin --------------------------------------------

let nativeListener: Promise<PluginListenerHandle> | null = null;
function ensureNativeListener(): void {
  if (nativeListener) return;
  // The plugin reports every track change, including the loop advancing and -1 when
  // playback ends on its own (e.g. a phone call takes the speaker).
  nativeListener = Native.addListener('track', ({ index }) => setTrack(index >= 0 ? index : null));
}

// --- Browser fallback: <audio> -----------------------------------------------------

let webStop: (() => void) | null = null;

async function playWeb(start: number): Promise<void> {
  const el = new Audio();
  let index = start;
  let stopped = false;
  const playAt = (i: number) => {
    index = i;
    el.src = PLAYLIST[i];
    setTrack(i);
    return el.play();
  };
  el.onended = () => { if (!stopped) void playAt(nextTrack(index)).catch(() => undefined); };
  // A broken file skips to the other song instead of going silent.
  el.onerror = () => { if (!stopped) void playAt(nextTrack(index)).catch(() => undefined); };
  webStop = () => {
    stopped = true;
    writeLastStop(index, el.duration > 0 ? el.currentTime / el.duration : 0);
    el.onended = null;
    el.onerror = null;
    el.pause();
    el.removeAttribute('src');
    el.load();
  };
  await playAt(start);
}

// --- Public API ----------------------------------------------------------------------

/** Stops the song. Safe to call when nothing is playing. */
export async function stopAll(): Promise<void> {
  if (isNative()) {
    const res = await Native.stop().catch(() => null);
    if (res) writeLastStop(res.track, res.fraction);
  } else {
    webStop?.();
    webStop = null;
  }
  setTrack(null);
}

/**
 * Plays the playlist on a loop until stopAll(), starting where pickStartTrack says.
 * On Android the plugin takes audio focus so music apps on the tablet pause. Resolves
 * once playback has started; rejects if the first track cannot play.
 */
export async function playBirthdayLoop(): Promise<void> {
  await stopAll();
  const start = pickStartTrack(readLastStop());
  try {
    if (isNative()) {
      ensureNativeListener();
      await Native.play({ start });
      setTrack(start);
    } else {
      await playWeb(start);
    }
  } catch (e) {
    await stopAll();
    throw e;
  }
}
