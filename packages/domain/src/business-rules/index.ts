/**
 * T-475 - the client-safe business-rule leaf (@shareat/domain/business-rules). See ./check.ts for the import discipline:
 * nothing here may reach @shareat/db. A `<RuleCheck id="...">` resolves its check from `BUSINESS_CHECKS` BY ID.
 */
import type { BusinessCheck } from './check';
import {
  attestationCheck,
  draftsWouldPostCheck,
  dueNotBeforeInvoiceCheck,
  duplicateNumberCheck,
  feesNotOverTotalCheck,
  receiptPhotoCheck,
  selfVerifyCheck,
  supplierActiveCheck,
  vatCheck,
  verifySupplierActiveCheck,
} from './ap';

export * from './check';
export * from './ap';

// Facts differ per check, so the registry's value type is the check with its facts erased (the caller knows which it asked for).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ALL: ReadonlyArray<BusinessCheck<any>> = [
  supplierActiveCheck,
  dueNotBeforeInvoiceCheck,
  feesNotOverTotalCheck,
  vatCheck,
  duplicateNumberCheck,
  selfVerifyCheck,
  attestationCheck,
  verifySupplierActiveCheck,
  receiptPhotoCheck,
  draftsWouldPostCheck,
];

/** Every check by id. The client resolves a check from here; the server calls the same objects. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const BUSINESS_CHECKS: Readonly<Record<string, BusinessCheck<any>>> = Object.freeze(
  Object.fromEntries(ALL.map((c) => [c.id, c])),
);
