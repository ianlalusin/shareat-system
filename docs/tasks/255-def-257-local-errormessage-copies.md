# T-255 — DEF-257: the ~38 local `errorMessage` reimplementations

> **Status: RESERVED by the orchestrator, 2026-09-10. Unassigned. Sequence AFTER T-252.**
> Number reserved so no peer takes it. Nothing below is built.

DEF-246 describes "48 action files" as if one function guarded them. Measured: **10** files under
`apps/erp/src` reference the shared `constraint-messages` module; **39** define their own local
`errorMessage`/`errorMessageOf`; 2 more duplicate the `CONSTRAINT_MESSAGES` loop with a
screen-specific map.

⛔ **The reimplementation set includes `cash-requests`, `loans`, `ap` and `money-transfers` — the
exact four DEF-246 names as its motivating examples.** So T-252's sanitised fallback, correct as it
is, does not reach the screens that prompted Ian's ruling.

- **Delete the local copies in favour of the one sanitised implementation** — do not sanitise each
  in place. 38 hand-maintained copies is *how the drift happened*; re-sanitising them re-buys it.
- ⚠️ **Sequence after T-252**, so there is one correct implementation to converge on.
- ⛔ Row 189's "the fallback needs no maintenance" is only true of the *shared* one. A local
  `errorMessage` in a file nobody is looking at drifts exactly as a hand-written map does.

See `docs/DEFECTS-REGISTER.md` DEF-257 and **PROJECT_BIBLE.md §13 row 189**. Found 2026-09-10 by
lane D while specifying T-252, reported as a scope finding rather than shipped around.
