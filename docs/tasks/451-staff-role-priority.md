# T-451 — role-first staff display and privileged-role position removal
Status: Ian visually approved 21 October ("screen good now deploy"); full PR CI must pass before merge. Latest chat ruling supersedes the earlier universal-position assumption.
Display active Super admin / Admin / Manager first; only Staff uses its primary position, never an arbitrary secondary.
Privileged-role hires need no position. Existing assignments can be cleared explicitly on the employment page;
do not delete historical assignments automatically or change a person's role, scope, manual grants or role-derived permissions.
Staff replacements still require a primary; existing staff hire fallback remains. Revoked or foreign-org roles never qualify.
Scope: packages/db/src/repo/employment.ts; packages/domain/src/people/index.ts;
apps/erp/src/app/staff/{lib.ts,page.tsx,StaffViews.tsx,role-title.ts,[employmentId]/page.tsx};
packages/domain/tests/integration/t451-staff-role-positions.test.ts; apps/erp/tests/t451-staff-role-title.test.ts;
affected staff page tests if their fixtures require updates; docs/DEFECTS-REGISTER.md; this task;
docs/reviews/t451-t452-role-forms.md. No bible edit: planner should incorporate the new role/position ruling there.
Supporting test scope: packages/domain/tests/integration/position-defaults.test.ts, legacy cases 10 and 12 fixtures only.
It must seed a pre-T-451 manager assignment directly rather than create a newly prohibited assignment;
retain all elevation, admin-arrival, grant provenance and switch-off assertions unchanged.
Reuse existing accessRepo role reader; no schema change. Preserve authorize/enrol_staff and reconciliation/audit on replacement.
Tests first: three privileged roles clear all assignments and refuse new jobs via stale forms; staff cannot lose primary; no role/permission changes;
hire with existing privileged role gets no default position; revoked role does not bypass requirements; role-first rendered cards/roster.
Ian correction (21 October): retain the existing lanyard ID-card design; only role titles change.
ID cards retain photo/initials, name, role, tenure, employment status, live state and navigation.
Supporting CI guard scope: apps/erp/tests/action-link-sweep.test.ts (count the new removal button);
apps/erp/tests/t384-s3-lock-and-save-guard.test.ts (register its explicit removal command, retain label checks).
Done: affected checks, real PostgreSQL, typecheck, self-review; runtime/visual release gate and full exact-head CI before merge.

Supporting full-CI fixture scope (11 failures reproduced on real PostgreSQL before edits):
apps/erp/tests/integration/t389-s2-staff-web.test.ts uses a separate Staff subject, unchanged admin actors/typing assertions;
packages/auth/tests/integration/t349-s2c-supersede-elevation.test.ts E3 and
packages/domain/tests/integration/t341-position-grants-per-store.test.ts P8 seed historical privileged assignments,
then use setPositionDefault to invoke the real reconciliation through its existing public caller.
The internal primitive stays unexported with its closed importer list unchanged. Keep all supersede/self-skip/authorization assertions.
