FINDINGS: clean in automated checks; visual verification blocked
- Ian's final choice, 2026-10-19: plain white, no pattern; preserve the sidebar color. The arch/wave proposals are superseded.
- Workspace-specific tokens make light content and its surfaces white with quiet neutral table rules/striping. Sidebar tokens, opt-in dark mode and semantic warning/error/success fills remain unchanged.
- Name/Kind/Unit share a container-based row at >=21rem; narrower panels reflow. Name is capped at 16rem; the generated code is an inline readout rather than a stretched box.
- Buy/Retail/Wholesale share a wrapping row with concise visible labels and complete accessible names/help; all three independent flags remain available.
- Shared field rows use shorter bases (normal/name 16rem, code 12rem, short 7rem); long text/pickers keep explicit room. Name hints updated on the T-445 screens listed in the spec.
- CHECKED CLEAN: item name, kind, unit and buying/selling controls render in their intended common wrappers; blank required Kind still has no default. Existing item-kind, sidebar, palette/contrast, touch, layout and census guards pass.
- Tests were red first: five missing white-workspace cases, then the row-layout case. Final affected unit run: 11 files, 212 passed, 1 existing skip. Post-commit guards: 7 files, 56 passed. Typecheck passes; final production build succeeds with port 9008 stopped.
- Three affected PostgreSQL files pass all 67 tests. The first run exposed two stale placeholder-text expectations; updated those to Unit…/Kind… while retaining blank selection, required, option lists and refusal/no-write assertions. Code suggestion/override and typed-form refusal tests pass unchanged.
- No domain/database changes. No browser or full-suite result is claimed. After Ian enabled access, the retry reported a saved permission or managed policy denial; no alternate browser/network workaround was attempted. No merge or deployment of this slice.
- Updated preview is outside the repository at the chat's visualization directory. Existing untracked docs/operations/ is untouched.
FOR IAN: white content and compact related rows are implemented locally. Prepare a draft PR for full CI; visual verification remains required before merge. Synthetic local preview offered for Ian to check directly.
