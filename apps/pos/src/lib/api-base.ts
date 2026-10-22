"use client";
import { emulatorProfile } from '../../config/emulator-profile.mjs';
const emulator = emulatorProfile(process.env.NEXT_PUBLIC_POS_EMULATOR_MODE, process.env.NEXT_PUBLIC_POS_EMULATOR_HOST);

/**
 * Base URL for the server API.
 *
 * - Web (App Hosting) build: empty → relative "/api/..." hits the same origin.
 * - Capacitor APK build: set `NEXT_PUBLIC_API_BASE=https://app.shareat.net` so the
 *   locally-bundled app reaches the deployed backend for online-only features
 *   (loyalty, PINs, AI insights, admin tools). The offline cashier core uses the
 *   client Firestore SDK directly and needs none of these.
 */
export const API_BASE = emulator?.apiBase ?? process.env.NEXT_PUBLIC_API_BASE ?? "";

/**
 * T-424 Ruling 1: the POS v2 server (refunds, tender corrections, session voids, analytics port). Only "/api/pos2/..." calls go here; every
 * other "/api/..." call keeps API_BASE (v1's server). Defaults to https://pos2.shareat.net.
 */
export const POS2_API_BASE = emulator?.apiBase ?? (process.env.NEXT_PUBLIC_POS2_API_BASE || "https://pos2.shareat.net");

const POS2_PREFIX = "/api/pos2/";

/** The base for one relative "/api/..." path. */
function baseFor(path: string): string {
  return path.startsWith(POS2_PREFIX) ? POS2_API_BASE : API_BASE;
}

/** Prefix a relative "/api/..." path with the configured base. */
export function apiUrl(path: string): string {
  if (path.startsWith(POS2_PREFIX) && API_BASE) return `${POS2_API_BASE}${path}`;
  if (!API_BASE) return path;
  return path.startsWith("/") ? `${API_BASE}${path}` : path;
}

/**
 * One-time fetch shim so the dozens of existing relative `fetch("/api/...")`
 * calls work from the Capacitor build without editing each call site. Only
 * active when `API_BASE` is set (i.e. the APK build) and only rewrites string
 * URLs that start with "/api/". No-op on the web build.
 */
export function installApiBaseFetch(): void {
  if (typeof window === "undefined" || !API_BASE) return;
  const w = window as unknown as { fetch: typeof fetch; __apiBasePatched?: boolean };
  if (w.__apiBasePatched) return;
  w.__apiBasePatched = true;
  const orig = w.fetch.bind(w);
  w.fetch = ((input: any, init?: any) => {
    if (typeof input === "string" && input.startsWith("/api/")) {
      input = baseFor(input) + input;
    } else if (input instanceof URL && input.pathname.startsWith("/api/") && input.origin === window.location.origin) {
      input = baseFor(input.pathname) + input.pathname + input.search;
    }
    return orig(input, init);
  }) as typeof fetch;
}
