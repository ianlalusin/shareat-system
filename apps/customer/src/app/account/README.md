# apps/customer/src/app/account

## Overview

Optional demo member sign-in and consent-based sign-up at /account.

## Interface

- Default Page renders local SignIn/SignUp components and a member greeting.

## Invariants

- Consent starts false and is required before requesting a code or creating an account; password fields remain password inputs.
- This is fixture-backed membership, with no live authentication or SMS implementation.

## Side Effects

- Calls signIn, requestSignUpCode or signUp through CustomerData; stores the displayed member in local React state.

## Verification

- From the repository root: `npm test -w @shareat/customer`. This app has its own Vitest configuration; the root unit project excludes it.
