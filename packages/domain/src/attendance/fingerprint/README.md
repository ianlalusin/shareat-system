# Fingerprint
## Overview
Portable, DB-free fingerprint logic shared by the enrolment server path and the clock-terminal client path: match-token minting, matcher-DB shaping, the re-arm state machine and the reader pool (T-314 slice A). It owns the rule that a credential's token is minted randomly, never derived from the template, so re-enrolment can invalidate it.
## Interface
- `index.ts`: barrel re-exporting `token`, `core`, `arm`, `pool`. Deliberately NOT folded into `../index.ts` (client-bundle boundary).
- `token.ts`: `generateMatchToken` (32 hex chars from Web Crypto), `mintUniqueToken(isTaken)`.
- `core.ts`: `MAX_FINGERS` (2), `hasFingerprint`, `validateFingerprintTemplates`, `buildReaderEntries`, `resolveFingerprintMatchToken`.
- `arm.ts`: types `FingerprintArmState`, `ArmPlan`; const `FRESH_ARM_STATE` (frozen); `planArm(state, mode)`.
- `pool.ts`: types `FingerprintCredential`, `PoolMode`; `loggedOutPool`, `soloPool`, `poolEntries`, `poolKey`, `poolFor`.
## Invariants
- Nothing here may import `@shareat/db`, `@shareat/auth`, Capacitor, node `crypto` or `navigator`; a client file reaching a DB import breaks the browser bundle (T-266 boundary test).
- The match token is minted, never hashed from the template (a finger cannot be rotated).
- `mintUniqueToken` throws after 12 failed candidates rather than returning an empty token.
- `MAX_FINGERS` mirrors the DB CHECK on `attendance_credentials` (1 to 2 templates); the CHECK stays the authority.
- Each template gets a unique reader id `${matchToken}#${slot}`; `#` is safe because tokens are hex. `resolveFingerprintMatchToken` strips the suffix.
- `FRESH_ARM_STATE` is frozen; copy it, never assign into it.
- `poolKey` is order-independent. `soloPool` returns `null` when the staffer has no fingerprint (fall back to passcode/NFC).
## Side Effects
- None (pure functions), except `generateMatchToken` reads randomness from `globalThis.crypto`, and `mintUniqueToken` awaits the caller-injected `isTaken`.
## Verification
- Run: `npm test` (from the repo root C:\Users\ianla\webapps\shareat-system; vitest unit project)
