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
  transpilePackages: ['@shareat/core', '@shareat/db', '@shareat/domain', '@shareat/auth'],
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
