import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// Two build modes (T-417 ruling 3): default = server build (`next start`);
// BUILD_TARGET=capacitor = static export to out/ for the Android APK.
const cap = process.env.BUILD_TARGET === 'capacitor';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // @shareat/core is TypeScript source (money): compile it with the app.
  transpilePackages: ['@shareat/core'],
  trailingSlash: cap,
  images: { unoptimized: cap },
  ...(cap ? { output: 'export' } : {}),
  typescript: { ignoreBuildErrors: false },
  // Resolve from the monorepo root so Turbopack does not warn about a foreign lockfile.
  turbopack: { root: join(here, '..', '..') },
};

export default nextConfig;
