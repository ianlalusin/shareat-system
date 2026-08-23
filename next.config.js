/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Native/Node-only packages must not be bundled into the server build.
  // See PROJECT_BIBLE.md §12 landmine: Next.js server bundling of native deps.
  serverExternalPackages: ['postgres', 'firebase-admin', 'pino'],
  typescript: {
    // Type errors fail the build. Never set this to true.
    ignoreBuildErrors: false,
  },
  // NOTE: the `eslint` key was removed in Next.js 16 and is silently ignored, so it is
  // not set here. Lint is currently NOT enforced anywhere: there is no eslint config in
  // the repo, `next lint` was removed in 16, and CI runs no lint step. Tracked as a gap
  // rather than papered over with a config key that does nothing. See PROJECT_BIBLE.md
  // section 15.7 (CI gates).
  // Turbopack otherwise walks up, finds the package-lock.json in the home directory
  // outside this repo, and warns on every build.
  turbopack: {
    root: __dirname,
  },
};

module.exports = nextConfig;
