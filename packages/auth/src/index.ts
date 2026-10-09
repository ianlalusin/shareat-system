/**
 * @shareat/auth — the single authorize() module (CLAUDE.md, PROJECT_BIBLE.md §7 rule 1).
 * docs/tasks/121-roles-and-access.md.
 */
export {
  ROLES,
  CAPABILITIES,
  CAPABILITY_SCOPE,
  CAPABILITY_MATRIX,
  CONDITIONAL_CAPABILITIES,
  ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER,
  SUPER_ADMIN_ONLY_CAPABILITIES,
  CAPABILITY_AREAS,
  CAPABILITY_AREA_LABEL,
  CAPABILITY_AREA,
  // T-343 S2 — presentation labels only. `refusal-text.ts`'s functions are deliberately NOT
  // re-exported here (spec's own BUILDER file list) — imported by relative path, same convention
  // `errors-leaf.test.ts` already uses for a file this package keeps out of the barrel.
  ROLE_LABEL,
  CAPABILITY_LABEL,
  capabilityTitle,
} from './capabilities';
export type { Role, Capability, CapabilityScope, CapabilityArea } from './capabilities';

export { authorize, heldCapabilities } from './authorize';
/** ⭐ From the leaf, not from the modules that throw them — `packages/auth/src/errors.ts` says why.
 *  An app that needs only the classes should import `@shareat/auth/errors` and skip this barrel. */
export { AuthenticationError, AuthorizationError } from './errors';
export type { Actor, AuthorizeContext } from './authorize';

export { assignRole, assignRoleAsActor, elevateManager, grantCapabilityAsActor } from './roles';
export type { AssignRoleInput, AssignRoleAsActorInput, AssignRoleResult } from './roles';

export {
  signInWithPin,
  signInWithFirebase,
  resolveTerminalIdentity,
  resolveActor,
  signOut,
  endShift,
  endAllForDevice,
  setPin,
  PIN_SESSION_TTL_MS,
  BROWSER_SESSION_TTL_MS,
  /** T-239 / DEF-229 — exported so a test asserts the sentence the code writes, not a copy. */
  PIN_SUPERSEDED_REASON,
  /** T-302 — exported for the same reason: a test asserts this value actually reaches the KDF,
   *  because three of `verifyPin`'s four `false` returns happen before it does. */
  DUMMY_SCRYPT_HASH,
} from './sessions';
export type { SignInResult, ResolvedSession, TerminalIdentity } from './sessions';
export { hashPin, verifyPin, pinLookupHash, isValidPinFormat, newSessionToken, sessionTokenHash } from './credentials';
/** T-237 / DEF-224 — administering someone else's sign-in credentials. Gated on `manage_users`,
 *  unlike everything in `sessions.ts`, which is why it is a separate module. */
export { linkFirebaseCredential, unlinkCredential, reopenPinSignIn } from './credentials-admin';
export type {
  LinkFirebaseCredentialInput,
  UnlinkCredentialInput,
  UnlinkCredentialResult,
} from './credentials-admin';
/** T-232 §2.4 — the first-run setup identity's signature. Credential crypto stays in this package;
 *  `apps/erp/src/lib/session.ts` owns the cookie, never the key. */
export { signSetupIdentity, setupIdentitySignatureMatches } from './credentials';
export { signFlash, flashSignatureMatches } from './credentials';
