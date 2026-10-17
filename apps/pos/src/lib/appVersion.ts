import pkg from '../../package.json';

/** This build's version: NEXT_PUBLIC_APP_VERSION (set by CI at build time), else the app's package.json version. Compared with the server's
 *  `GET /api/pos2/health` version by "Check for update" (T-425 Ruling 8). */
export const APP_VERSION: string = process.env.NEXT_PUBLIC_APP_VERSION || (typeof pkg.version === 'string' && pkg.version) || 'dev';
