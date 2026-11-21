/** DEF-373: variables that point the app at a local emulator. A production build or deploy must not carry one. */
export const DEV_ONLY_ENV_KEYS = ['FIREBASE_AUTH_EMULATOR_HOST', 'NEXT_PUBLIC_FIREBASE_EMULATOR_HOST'] as const;

/** The dev-only variables that are set (non-empty) in `env`. Names only, never values. */
export function devOnlyKeysSet(env: Record<string, string | undefined>): string[] {
  return DEV_ONLY_ENV_KEYS.filter((k) => (env[k] ?? '') !== '');
}
