/**
 * T-386 - the browser-safe entry for the item-code rule (`@shareat/domain/item-code`). It re-exports the pure,
 * dependency-free rule so client files reach it at the path tests/unit/client-bundle-boundary.test.ts resolves and walks.
 */
export * from './items/code';
