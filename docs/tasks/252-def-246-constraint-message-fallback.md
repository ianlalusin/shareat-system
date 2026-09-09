# T-252 — DEF-246: sanitise the constraint-failure fallback, then count the hits

> **Status: RESERVED by the orchestrator, 2026-09-09. Unassigned. Awaiting a lane and a SPEC.**
> Number reserved so no peer takes it. Nothing below is built.

**Bible §13 row 189 — Ian's ruling, 2026-09-09.** Ship the presentable fallback FIRST so
`errorMessage()` can never render raw Postgres driver text to a person again; THEN instrument it
and let measured hit counts decide which constraints earn a hand-written sentence.

- ⚠️ **Reuse T-245's counter, do not build a second one** — including the part that was hard: its
  first version wrote inside the transaction the refusal aborts, so it recorded nothing with
  nothing red. `withOrgPrincipal`'s independent transaction is the shape that works.
- ⛔ **A counted hit is a DOUBLE signal.** A constraint only reaches the database when nothing above
  it refused first, so a hit means *there is no server-side validation on this field*. Rank the
  follow-up by missing guards, not by message quality.
- ⛔ **Do not "finish the map" as the first move** — row 189 records why that is the low-value half.

See `docs/DEFECTS-REGISTER.md` DEF-246 and **PROJECT_BIBLE.md §13 row 189**.
