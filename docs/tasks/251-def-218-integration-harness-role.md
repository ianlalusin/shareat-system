# T-251 — DEF-218: the integration harness must not connect as a superuser

> **Status: RESERVED by the orchestrator, 2026-09-09. Lane E. Awaiting `[E] SPEC`.**
> Number reserved so no peer takes it. Nothing below is built.

The integration pool connects as `postgres` (`rolsuper` + `rolbypassrls`), so any job or policy
that forgets an RLS principal passes its tests and is refused in production. 34 of 107 integration
files never switch principal — the measured list is `docs/discovery/29` §3.4a; **do not recount it.**

See `docs/DEFECTS-REGISTER.md` DEF-218 — including the mutation proving a test-side helper cannot
fix this.
