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
