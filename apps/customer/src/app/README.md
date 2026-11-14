# apps/customer/src/app

## Overview

App Router layout and PIN-based table join screen.

## Interface

- layout.tsx exports metadata, viewport and default RootLayout; page.tsx exports the PIN join Page at /.
- RootLayout mounts CustomerProvider, DemoBanner and AppShell around route content.
- [account](./account/README.md) — Optional demo member sign-in and consent-based sign-up at /account.
- [bill](./bill/README.md) — Read-only estimated add-on bill at /bill.
- [cart](./cart/README.md) — Diner cart editing and idempotent order submission at /cart.
- [feedback](./feedback/README.md) — Session feedback form at /feedback.
- [join](./join/README.md) — QR-token landing screen at /join?t=... .
- [menu](./menu/README.md) — Categorized menu and cart quantity controls at /menu.
- [orders](./orders/README.md) — Joined-table order history and demo progress at /orders.

## Invariants

- PIN entry submits after six digits and waits for a device id; a busy request disables further submissions.
- The initial layout and first browser render share the provider loading state.

## Side Effects

- The join screen calls joinByPin, updates the provider session and navigates to /menu; leaving a table clears that session.

## Verification

- From the repository root: `npm test -w @shareat/customer`. This app has its own Vitest configuration; the root unit project excludes it.
