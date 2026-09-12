/** @type {import('next').NextConfig} */
const path = require('node:path');

// The monorepo keeps ONE .env.local, at the repo root, shared by every app and by
// packages/db's migration runner. Next resolves .env from the app directory, so
// without this it silently starts with no DATABASE_URL and no SESSION_SECRET — a
// green build, green tests, and an app that refuses to boot. Load the root file
// before Next reads its config. (Found by the §9 rule 4 smoketest, 2026-08-23.)
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env.local') });

const nextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript source, not a build artefact. Next must
  // compile them like first-party code. This is what keeps `@shareat/core` a
  // single copy of the truth rather than a published, versioned duplicate.
  // `@shareat/auth` added by T-122: the expenses screens are the first apps/erp code
  // to reach `authorize()` (transitively, through @shareat/domain's expense services) —
  // without this, `next build` cannot compile @shareat/domain's own `import ... from
  // '@shareat/auth'` statements. Found because it was never needed until now: the
  // existing reports screens read the database directly and never call authorize().
  transpilePackages: [
    '@shareat/core',
    '@shareat/db',
    '@shareat/domain',
    '@shareat/auth',
    // ⚠️ Ships TypeScript source like the others. `firebase-admin` itself stays in
    // serverExternalPackages below — transpiling the wrapper is not the same as bundling the SDK.
    '@shareat/storage-firebase',
  ],
  // ⭐ T-282 / DEF-317. WITHOUT this key Next caps a Server Action body at 1 MB
  // (`next/dist/server/app-render/action-handler.js:519`), and every file upload in the app
  // — the supplier invoice photo, the AR collection proof, the delivery document — died at
  // 413 before the action ran. The domain's own per-purpose limits in
  // `packages/domain/src/files/index.ts` (8 MB for a receipt, 25 MB for an onboarding
  // document) were therefore unreachable for their whole existence: no size check, no
  // content-type check and no EXIF strip ever saw the files people actually sent.
  //
  // The invariant: THE FRAMEWORK MUST NEVER BE THE LAYER THAT REFUSES A FILE THE DOMAIN
  // WOULD ACCEPT. So this is bounded by the largest DECLARED PURPOSE_LIMITS.maxBytes
  // (25 MB), not the largest one with a caller today (8 MB) — binding it to the reachable
  // set leaves a green build and a production 413 for whoever wires the next purpose.
  // 26mb = 25 MB + multipart boundary/field overhead.
  //
  // ⚠️ This is a blunt outer bound on EVERY action, not a control. The control is
  // `uploadFile`, which refuses on purpose, type and size before a byte reaches storage.
  // ⚠️ There is a SECOND limit with the identical symptom: Caddy's `request_body max_size`
  // on the production droplet. Fixing this one does not fix that one.
  // Guarded by `tests/unit/server-action-body-limit.test.ts`.
  experimental: {
    serverActions: {
      bodySizeLimit: '26mb',
    },
  },
  // Native/Node-only packages must not be bundled into the server build.
  // See PROJECT_BIBLE.md §12 landmine: Next.js server bundling of native deps.
  serverExternalPackages: ['postgres', 'firebase-admin', 'pino'],
  typescript: {
    // Type errors fail the build. Never set this to true.
    ignoreBuildErrors: false,
  },
  // NOTE: the `eslint` key was removed in Next.js 16 and is silently ignored, so it is
  // not set here. Lint is currently NOT enforced anywhere — see docs/DEFECTS-REGISTER.md
  // DEF-027. Tracked as a gap rather than papered over with a key that does nothing.
  // Turbopack must resolve from the monorepo root, or it walks up and finds a lockfile
  // outside the workspace and warns on every build.
  turbopack: {
    root: path.join(__dirname, '..', '..'),
  },
};

module.exports = nextConfig;
