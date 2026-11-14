# apps/customer/src/app/feedback

## Overview

Session feedback form at /feedback.

## Interface

- Default Page wraps FeedbackScreen in RequireSession; CustomerData.submitFeedback returns FeedbackOutcome.

## Invariants

- A rating must be chosen; the text control caps input at 500 characters and trims the submitted text.
- The current fixture returns managerAlerted as a demo outcome; this screen does not send a real manager notification.

## Side Effects

- Submits session/participant feedback to the data source, changes local completion state, and offers an external review link when returned.

## Verification

- From the repository root: `npm test -w @shareat/customer`. This app has its own Vitest configuration; the root unit project excludes it.
