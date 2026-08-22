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
  eslint: {
    ignoreDuringBuilds: false,
  },
};

module.exports = nextConfig;
