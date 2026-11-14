# docs

## Overview

Project authority, requirements, decisions and operational documentation.

## Interface

- RULES.md is the digest; ../PROJECT_BIBLE.md remains the authority.
- GLOSSARY.md defines domain terms; POSTING-PATTERNS.md defines the canonical posting examples; HANDOFF-TODAY.md is the current handoff.
- The code-bearing documentation subtree is ops/. Other discovery/plan/task/decision documents are navigation and requirements, not additional executable modules.
- [ops](./ops/README.md) — child interface, invariants and side effects.

## Invariants

- Generated EGM contracts describe code boundaries and do not amend the bible or authorize planned features.
- Log incidental defects in DEFECTS-REGISTER.md; keep capability gaps distinct.

## Side Effects

- Documentation has no runtime mutation; ops/provision.sh and systemd units have operator-controlled effects described in their own contract.

## Verification

- From the repository root: `npm run test` (unit) and affected `npm run test:integration` cases against real PostgreSQL. CLI operations are not a documentation verification step.
