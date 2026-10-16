"use client";

/**
 * Unified "new kitchen ticket" alert.
 *
 * Native platforms (Capacitor Android APK):
 *   → LocalNotifications.schedule()  (status-bar + system sound + vibration)
 *   → Haptics.notification()         (extra tactile kick)
 *
 * Web / browser:
 *   → Web Audio beep (no asset file needed; survives all CDNs/WebViews)
 *   → Notification API visual banner (best-effort, some WebViews stub it out)
 *
 * Web Audio is blocked until the user has interacted with the page once, so
 * `primeKitchenAudio()` must be called from a click/tap/key handler at some
 * point before the first alert fires.
 */

import { Capacitor } from "@capacitor/core";

let audioCtx: AudioContext | null = null;
let kitchenAudio: HTMLAudioElement | null = null;
let primed = false;
let nativeChannelEnsured = false;

const ALERT_SOUND_PATH = "/sounds/kitchen-alert.mp3";

const KITCHEN_CHANNEL_ID = "kitchen-alerts";

/** Create (idempotent) the high-importance Android notification channel we use for kitchen alerts. */
async function ensureKitchenChannel(): Promise<void> {
  if (nativeChannelEnsured) return;
  try {
    const { LocalNotifications } = await import("@capacitor/local-notifications");
    await LocalNotifications.createChannel({
      id: KITCHEN_CHANNEL_ID,
      name: "Kitchen Alerts",
      description: "Plays a sound when a new kitchen ticket arrives.",
      importance: 5,            // HIGH — enables heads-up banner + sound even when app is foreground
      visibility: 1,            // PUBLIC
      sound: "default",         // use the user-picked system default
      vibration: true,
      lights: true,
    } as any);
    nativeChannelEnsured = true;
  } catch {
    // Plugin absent or platform unsupported — caller will fall back to web path.
  }
}

/** Must be called inside a user gesture (click / tap / keydown). Safe to call repeatedly. */
export function primeKitchenAudio(): void {
  if (primed) return;
  if (typeof window === "undefined") return;
  try {
    // Pre-load the audio file — satisfies autoplay policy for subsequent calls.
    const audio = new Audio(ALERT_SOUND_PATH);
    audio.preload = "auto";
    audio.load();
    kitchenAudio = audio;
  } catch {
    // file may not exist yet; synthesized beep will be used instead
  }
  try {
    const Ctor = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (Ctor) {
      const ctx: AudioContext = audioCtx ?? new Ctor();
      audioCtx = ctx;
      // A silent 1-frame blip unlocks autoplay policies on most engines.
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.01);
      if (ctx.state === "suspended") void ctx.resume();
    }
  } catch {
    // ignore
  }
  primed = true;
}

async function webBeep(durationMs = 260, freq = 880): Promise<void> {
  // Try the real audio file first.
  if (kitchenAudio) {
    try {
      kitchenAudio.currentTime = 0;
      await kitchenAudio.play();
      return;
    } catch {
      // autoplay blocked or file missing — fall through to synthesized beep
    }
  }
  // Synthesized beep fallback.
  if (!audioCtx || !primed) return;
  try {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    const t0 = audioCtx.currentTime;
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(0.25, t0 + 0.02);
    gain.gain.linearRampToValueAtTime(0, t0 + durationMs / 1000);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t0);
    osc.stop(t0 + durationMs / 1000 + 0.02);
  } catch {
    // ignore
  }
}

/**
 * Request whatever permissions the current platform needs so subsequent alerts
 * can actually surface. Call once on page mount.
 */
export async function requestKitchenAlertPermission(): Promise<void> {
  if (typeof window === "undefined") return;

  if (Capacitor.isNativePlatform()) {
    try {
      const { LocalNotifications } = await import("@capacitor/local-notifications");
      const state = await LocalNotifications.checkPermissions();
      if (state.display !== "granted") {
        await LocalNotifications.requestPermissions();
      }
      // Create (or update) the dedicated HIGH-importance channel so sound plays
      // even while the kitchen page is the foreground app.
      await ensureKitchenChannel();
    } catch {
      // plugin missing or platform unsupported — ignore, web fallback will run
    }
    return;
  }

  // Web fallback: request browser Notification permission.
  try {
    if ("Notification" in window && Notification.permission === "default") {
      void Notification.requestPermission().catch(() => {});
    }
  } catch {
    // ignore
  }
}

/**
 * Fire an alert for a new kitchen ticket. Safe to call from any client-side
 * context; picks the right backend based on platform.
 */
export async function fireKitchenAlert(opts: { title: string; body?: string }): Promise<void> {
  const title = opts.title || "New Kitchen Ticket";
  const body = opts.body || "";

  if (Capacitor.isNativePlatform()) {
    try {
      const [{ LocalNotifications }, { Haptics, NotificationType }] = await Promise.all([
        import("@capacitor/local-notifications"),
        import("@capacitor/haptics"),
      ]);
      // Make sure the HIGH-importance channel exists before scheduling.
      await ensureKitchenChannel();
      // Fire-and-forget both; failures are non-fatal.
      void LocalNotifications.schedule({
        notifications: [
          {
            id: Date.now() % 2147483647,
            title,
            body,
            channelId: KITCHEN_CHANNEL_ID,   // route through HIGH channel
            sound: "default",                 // redundant with channel, kept for <O versions
            // no `schedule` → posts immediately instead of via AlarmManager
            // no `smallIcon` → plugin uses the app icon (avoids missing-resource silent failure)
          },
        ],
      } as any).catch(() => {});
      void Haptics.notification({ type: NotificationType.Success }).catch(() => {});
      return;
    } catch {
      // fall through to web path if native plugins fail at runtime
    }
  }

  // Web path
  void webBeep();
  try {
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification(title, { body, silent: false });
    }
  } catch {
    // ignore
  }
}
