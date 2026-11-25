/**
 * Server-only reads shared by the /documents screens. T-584. The page gate (`requirePageAccess`, `ROUTE_CAPABILITY`) is the READ control and every domain
 * function authorizes again at the document's store; no rule is decided here.
 */
import { withOrgPrincipal } from '../expenses/lib';

export { withOrgPrincipal };
