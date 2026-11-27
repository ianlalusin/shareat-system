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
    // T-640: the AI package ships TypeScript source like the others (domain imports it).
    '@shareat/ai',
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
  // T-511 S4: read-excel-file and yauzl are imported by name inside the settlement xlsx worker (a worker thread the bundler cannot see into).
  serverExternalPackages: ['postgres', 'firebase-admin', 'pino', 'read-excel-file', 'yauzl'],
  typescript: {
    // Type errors fail the build. Never set this to true.
    ignoreBuildErrors: false,
  },
  // T-532 S4: the build id the POS service worker puts in its cache name (`/sw.js?v=...`), so every deploy installs a fresh worker and clears the old caches.
  env: { NEXT_PUBLIC_POS_SW_VERSION: (process.env.GITHUB_SHA || '').slice(0, 12) || Date.now().toString(36) },
  // The worker script is never served from the browser's HTTP cache, or a deploy could not replace it.
  // DEF-845: no `X-Powered-By`, and the four browser-safety headers on every page. No CSP yet (it needs testing against the inline scripts);
  // HSTS without `includeSubDomains` or preload, so it cannot reach other hosts or be hard to undo.
  poweredByHeader: false,
  async headers() {
    return [
      { source: '/sw.js', headers: [{ key: 'Cache-Control', value: 'no-cache, max-age=0' }] },
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
        ],
      },
    ];
  },
  // T-591: "cutover" became "Opening balances". Old links and bookmarks land on the new pages (308; Next keeps the query string).
  // One explicit rule per path, no catch-all: the sub-page names changed (count -> stock-count, opening -> balance-sheet).
  async redirects() {
    return [
      ['/cutover', '/opening-balances'],
      ['/cutover/count', '/opening-balances/stock-count'],
      ['/cutover/count/sheet', '/opening-balances/stock-count/sheet'],
      ['/cutover/opening', '/opening-balances/balance-sheet'],
    ].map(([source, destination]) => ({ source, destination, permanent: true }));
  },
  // NOTE: the `eslint` key was removed in Next.js 16 and is silently ignored, so it is
  // not set here. Lint is currently NOT enforced anywhere — see docs/DEFECTS-REGISTER.md
  // DEF-027. Tracked as a gap rather than papered over with a key that does nothing.
  // Practice ERP only (PRACTICE_ERP=1, set by a local starter script that was retired in T-588). In a git worktree whose node_modules is a junction into another
  // checkout, `@shareat/auth` and `@shareat/storage-firebase` would resolve to THAT checkout's packages, and Turbopack refuses files outside its
  // root. So: root = the folder holding both checkouts, auth pinned to this tree, storage stubbed (in-memory only, no Firebase Storage code).
  // Alias targets are relative to the app folder (apps/erp).
  // Turbopack must resolve from the monorepo root, or it walks up and finds a lockfile
  // outside the workspace and warns on every build.
  turbopack:
    process.env.PRACTICE_ERP === '1'
      ? {
          root: path.join(__dirname, '..', '..', '..'),
          resolveAlias: {
            '@shareat/auth': './' + path.relative(__dirname, path.join(__dirname, '..', '..', 'packages', 'auth', 'src', 'index.ts')).split(path.sep).join('/'),
            '@shareat/auth/errors': './' + path.relative(__dirname, path.join(__dirname, '..', '..', 'packages', 'auth', 'src', 'errors.ts')).split(path.sep).join('/'),
            '@shareat/storage-firebase': './' + path.relative(__dirname, path.join(__dirname, '..', '..', 'scripts', 'lib', 'practice-storage-stub.mjs')).split(path.sep).join('/'),
          },
        }
      : {
          root: path.join(__dirname, '..', '..'),
        },
};

module.exports = nextConfig;
