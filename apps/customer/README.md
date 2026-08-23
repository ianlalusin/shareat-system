# @shareat/customer — not yet built

Reserved for the customer front-end. **Port 9004** (bible §8 — ports are never shared).

Nothing lives here yet. Sequencing is set by ADR-003: the accounting spine ships
first, then front-ends one at a time behind feature flags, never two at once.

When this app is built it consumes `@shareat/db` and `@shareat/core` like every
other front-end. It must **never** import from another app — apps talk to packages,
never to each other. That rule is the whole reason the integration layer was deleted.

The corresponding reference repo is READ-ONLY (bible §2 rule 1, §13 row 80): copy from
it, keep what is clean, clean what is not, omit what is not needed, add what is missing.
Findings go to `docs/DEFECTS-REGISTER.md`, never a patch at the source.
