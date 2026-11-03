// Practice ERP only: stands in for @shareat/storage-firebase so no real Firebase Storage code is even bundled.
// With no bucket configured, instrumentation.ts keeps the in-memory driver; this stub reports "no bucket" and refuses to build a driver.
export function firebaseConfigFromEnv() {
  return null;
}
export function firebaseStorageDriver() {
  throw new Error('practice ERP: Firebase Storage is disabled (in-memory storage only).');
}
