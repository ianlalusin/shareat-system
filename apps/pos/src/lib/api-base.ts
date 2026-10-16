"use client";

/**
 * Base URL for the server API.
 *
 * - Web (App Hosting) build: empty → relative "/api/..." hits the same origin.
 * - Capacitor APK build: set `NEXT_PUBLIC_API_BASE=https://app.shareat.net` so the
 *   locally-bundled app reaches the deployed backend for online-only features
 *   (loyalty, PINs, AI insights, admin tools). The offline cashier core uses the
 *   client Firestore SDK directly and needs none of these.
 */
export const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "";

/** Prefix a relative "/api/..." path with the configured base. */
export function apiUrl(path: string): string {
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
      input = API_BASE + input;
    } else if (input instanceof URL && input.pathname.startsWith("/api/") && input.origin === window.location.origin) {
      input = API_BASE + input.pathname + input.search;
    }
    return orig(input, init);
  }) as typeof fetch;
}
