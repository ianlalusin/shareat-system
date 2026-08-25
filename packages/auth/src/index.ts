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
} from './capabilities';
export type { Role, Capability, CapabilityScope } from './capabilities';

export { authorize, AuthorizationError } from './authorize';
export type { Actor, AuthorizeContext } from './authorize';

export { assignRole, elevateManager } from './roles';
export type { AssignRoleInput, AssignRoleResult } from './roles';

export {
  signInWithPin,
  signInWithFirebase,
  resolveActor,
  signOut,
  endShift,
  setPin,
  AuthenticationError,
  PIN_SESSION_TTL_MS,
  BROWSER_SESSION_TTL_MS,
} from './sessions';
export type { SignInResult, ResolvedSession } from './sessions';
export { hashPin, verifyPin, pinLookupHash, isValidPinFormat, newSessionToken, sessionTokenHash } from './credentials';
