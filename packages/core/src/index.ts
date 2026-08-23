/**
 * @shareat/core — primitives every front-end shares.
 *
 * These are the four modules that encode v1's worst landmines as code
 * (PROJECT_BIBLE.md §12). They live in a package, not an app, because ERP, POS,
 * CUSTOMER and the Website must all agree on what a peso is and when a business
 * day ends. Two copies of that truth is exactly the defect class ADR-003 deletes.
 */
export * from './money';
export * from './datetime';
export * from './logger';
export * from './env';
