/**
 * Server-only reads shared by the /documents screens. T-584. The page gate (`requirePageAccess`, `ROUTE_CAPABILITY`) is the READ control and every domain
 * function authorizes again at the document's store; no rule is decided here.
 */
import { withOrgPrincipal } from '../expenses/lib';

export { withOrgPrincipal };

/** The merge fields offered beside the wording, in the words a person would say them. Shown only; the server's whitelist decides. */
export const FIELD_HELP: ReadonlyArray<{ readonly name: string; readonly says: string }> = [
  { name: 'employee.full_name', says: "the employee's name" },
  { name: 'employee.staff_code', says: 'their staff code' },
  { name: 'employee.position', says: 'their position' },
  { name: 'employee.status', says: 'regular, probationary and so on' },
  { name: 'employee.started_on', says: 'the day they started' },
  { name: 'employee.ended_on', says: 'the day they left' },
  { name: 'store.name', says: "the store's name" },
  { name: 'store.address', says: "the store's address" },
  { name: 'store.tin_branch_code', says: "the store's branch code" },
  { name: 'org.legal_name', says: "the company's registered name" },
  { name: 'org.trading_name', says: 'the everyday trading name' },
  { name: 'org.tin', says: "the company's TIN" },
  { name: 'issuer.full_name', says: 'the person issuing it' },
  { name: 'issuer.position', says: "the issuer's position" },
  { name: 'today', says: "today's date, like 15 November 2026" },
];
