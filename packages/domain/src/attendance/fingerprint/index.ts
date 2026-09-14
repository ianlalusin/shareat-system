/**
 * Portable fingerprint logic — token minting, matcher-DB shaping, the re-arm state machine and
 * the reader pool. T-314 slice A.
 *
 * ⛔ **Deliberately its own barrel, not folded into `../index.ts`.** This module is consumed by
 * BOTH the enrolment server path and the clock-terminal CLIENT path. `packages/domain/src/index.ts`
 * (`@shareat/domain`) re-exports modules that import `@shareat/db`, and a `'use client'` file that
 * reaches it pulls the postgres driver into the browser bundle — proven in production by T-266
 * (`tests/unit/client-bundle-boundary.test.ts`), which walks every `@shareat/domain/<subpath>` a
 * client file imports to confirm it is genuinely DB-free. Nothing in this directory imports
 * `@shareat/db`, `@shareat/auth`, Capacitor, or `navigator` — keep it that way.
 */
export * from './token';
export * from './core';
export * from './arm';
export * from './pool';
