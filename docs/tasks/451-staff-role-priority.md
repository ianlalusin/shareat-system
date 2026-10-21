# T-451 — role-first staff display and privileged-role position removal
Status: built locally 21 October; visual/runtime release check and full PR CI pending. Latest chat ruling supersedes the earlier universal-position assumption.
Display active Super admin / Admin / Manager first; only Staff uses its primary position, never an arbitrary secondary.
Privileged-role hires need no position. Existing assignments can be cleared explicitly on the employment page;
do not delete historical assignments automatically or change a person's role, scope, manual grants or role-derived permissions.
Staff replacements still require a primary; existing staff hire fallback remains. Revoked or foreign-org roles never qualify.
Scope: packages/db/src/repo/employment.ts; packages/domain/src/people/index.ts;
apps/erp/src/app/staff/{lib.ts,page.tsx,StaffViews.tsx,role-title.ts,[employmentId]/page.tsx};
packages/domain/tests/integration/t451-staff-role-positions.test.ts; apps/erp/tests/t451-staff-role-title.test.ts;
affected staff page tests if their fixtures require updates; docs/DEFECTS-REGISTER.md; this task;
docs/reviews/t451-t452-role-forms.md. No bible edit: planner should incorporate the new role/position ruling there.
Reuse existing accessRepo role reader; no schema change. Preserve authorize/enrol_staff and reconciliation/audit on replacement.
Tests first: three privileged roles clear all assignments; staff cannot lose primary; no role/permission changes;
hire with existing privileged role gets no default position; revoked role does not bypass requirements; role-first rendered cards/roster.
Compact staff cards retain photo/initials, name, role, tenure, employment status, live state and navigation.
Done: affected checks, real PostgreSQL, typecheck, self-review; runtime/visual release gate and full exact-head CI before merge.
