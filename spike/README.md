# spike

## Overview

Disposable technical experiments kept outside the application dependency graph.

## Interface

- The firestore-two-lane child records the offline persistence/rules experiment and its constraints.
- [firestore-two-lane](./firestore-two-lane/README.md) — child interface, invariants and side effects.

## Invariants

- Experiments are not shipped workspace packages and are not imported by apps or packages.

## Side Effects

- This grouping has no executable entry point; child test harnesses may start emulators and mutate isolated test data.

## Verification

- Use the test command documented in the child contract; experiments are outside root workspace tests.
