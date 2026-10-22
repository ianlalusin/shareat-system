# T-461 action-only ERP forms

Status: implemented; local checks recorded below. Visual approval and release CI remain pending.

- Ian's 2026-10-22 ruling: ERP entry/edit fields appear only after Add/Edit/Update/another action. Recorded in the task; the planner should carry this standing UI decision into the bible.
- Shared EditableRecord hides its disabled fieldset while locked; existing edit registry, typed refusal reopening, resets, save logic, hidden ids/version and authorization remain intact.
- CheckedForm shares the native FormDisclosure pattern. Raw mutation entry forms retain their original native form/action/props/children, wrapped at 48 sites across 34 files. An existing DisclosureCard supplies the called context. Submit-only commands remain direct; authentication and navigation filters remain visible.
- Human action labels come from submit children, not code identifiers. Fields stay mounted. Refusal recovery stores only the local reveal id/path, never field values. The signed flash marker reopens a submitted reveal after server refusal.
- Regression RED: 3 failed / 1 passed (locked fields exposed and missing reveal primitive). Final targets: 8 passed, including command-only controls, native-form coverage and a mounted refusal/reopen check that retains typing without storing values.
- Existing shared editor/field-check/spacing/state/rename checks plus root app-boundary/throw/numeric/void census: 309 passed across 12 files before the final coverage case was added. Final target: 6 passed. Typecheck passed.
- One older T-440 assertion assumed form was the root element. It now requires the disclosure plus the same inner form; all disabled/ARIA/status assertions retained.
- Eight existing native disclosures explicitly mark their contained forms as called, avoiding a second prompt. Their existing refusal-driven opening is retained.
- Production build passed with 9008 verified free and the main checkout's environment explicitly checked for localhost:5435/shareat_dev. NODE_ENV is explicitly production for build/start. An intermediate preview-environment build inherited development mode and failed global-error prerendering; the corrected production-mode build passed. An old local next-start listener was detected after the initial build; it was stopped before the repeat builds. No production deployment or data change occurred.
- A later precommit repeat had 308 passed / 1 unchanged G3a 5-second timeout while building; no assertion/limit was weakened. The source d1d0d71 postcommit repeat then passed 311 tests across 12 files. One commit attempt was refused for CR bytes in the new task doc; line endings were corrected, not bypassed.
- Followup: refusal presentation state is scoped to the existing account marker and browser tab. No account marker means no persistence. The account-scope change and existing screen restoration targets passed 13 tests; final followup gates remain required.
- Self-review: all adopter changes are wrapper/import only, server actions untouched; no new nested form, no auth/schema/domain changes, no applied migration edits or baseline/timeout widening.
- Saved ERP browser permission is denied; no browser/HTTP/Android bypass. Local server startup is not visual approval. Ian must check the new layout before release.

## FOR IAN
The new default is prepared for local review. It is not deployed; POS changes remain preserved separately.

## Next role (Ian, 2026-10-22)
Finish the current work, commit and stop development. The old development heartbeat is paused. Ian will supply the exact time to START a read-only auditor schedule every five hours. Each run checks actual diffs first; no diff means skip quietly until the next five-hour run. No five-hour audit schedule is active yet. Audit findings do not authorize source fixes, merging or deployment.
