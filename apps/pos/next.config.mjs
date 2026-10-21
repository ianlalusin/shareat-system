import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { emulatorProfile } from './config/emulator-profile.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const packageVersion = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')).version;

// Two build modes (T-417 ruling 3): default = server build (`next start`);
// BUILD_TARGET=capacitor = static export to out/ for the Android APK.
// A static export has no image optimizer and cannot carry headers() (Next docs: guides/static-exports).
const cap = process.env.BUILD_TARGET === 'capacitor';
if (process.env.NEXT_PUBLIC_POS_EMULATOR_MODE === '1' && process.env.POS_EMULATOR_MODE !== '1') {
  throw new Error('Select POS_EMULATOR_MODE explicitly when building an emulator app.');
}
const emulator = emulatorProfile(process.env.POS_EMULATOR_MODE, process.env.POS_EMULATOR_HOST);

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Publish only this scalar, never the dependency manifest, into the client bundle.
  env: { NEXT_PUBLIC_APP_VERSION: process.env.NEXT_PUBLIC_APP_VERSION || packageVersion || 'dev',
    NEXT_PUBLIC_POS_EMULATOR_MODE: emulator ? '1' : '0',
    NEXT_PUBLIC_POS_EMULATOR_HOST: emulator?.host ?? '10.0.2.2' },
  reactStrictMode: true,
  trailingSlash: cap,
  images: cap
    ? { unoptimized: true }
    : {
        // Copied from POS v1 (T-422 B2): item photos live in v1's Firebase Storage bucket.
        remotePatterns: [{ protocol: 'https', hostname: 'firebasestorage.googleapis.com', pathname: '/v0/b/**' }],
      },
  ...(cap ? { output: 'export' } : {}),
  ...(cap
    ? {}
    : {
        // Copied from POS v1: the service worker must never be cached, and may control the whole origin.
        async headers() {
          return [
            {
              source: '/sw.js',
              headers: [
                { key: 'Content-Type', value: 'application/javascript; charset=utf-8' },
                { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
                { key: 'Service-Worker-Allowed', value: '/' },
              ],
            },
          ];
        },
      }),
  typescript: { ignoreBuildErrors: false },
  // Resolve from the monorepo root so Turbopack does not warn about a foreign lockfile.
  turbopack: { root: join(here, '..', '..') },
};

export default nextConfig;
