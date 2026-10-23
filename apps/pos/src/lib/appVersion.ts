/** This build's version: NEXT_PUBLIC_APP_VERSION (CI override, else the package version injected by next.config). Compared with the server's
 *  `GET /api/pos2/health` version by "Check for update" (T-425 Ruling 8). */
export const APP_VERSION: string = process.env.NEXT_PUBLIC_APP_VERSION || 'dev';
