# ERP action-only forms — 2026-10-22

Build the shared disclosure pattern Ian requested. The staff screenshot exposes locked input boxes, even though EditableRecord already requires Edit to change them.

Local census: 175 native forms; 196 CheckedForm/EditableRecord references in app pages. A shared fix covers those editors; native entry forms need explicit adoption. Filters and button-only commands are not record-entry editors. Usage counts in production were not queried; these are source counts, not daily transactions.

The existing DisclosureCard already handles the new-item form. Reuse its native details/summary interaction, avoiding dialog focus traps and a dependency. Existing sibling apps use action-opened modals (POS AddonsPOSModal/ChangePasswordDialog, CUSTOMER form/dialog components); the website's contact entry serves a different public purpose. No reference source or live data is changed.

Industry: [WAI disclosure pattern](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/) makes content available through a trigger with expanded state. Native details/summary supplies keyboard interaction without JavaScript. [Headless UI](https://github.com/tailwindlabs/headlessui), MIT, is an available open-source implementation, but adding it here duplicates the existing native primitive. No vendor/API or package adoption is needed.

Scope: shared locked fields, checked entry forms, and explicit native mutation entry adopters. Keep search/store/date filters and authentication controls visible; direct commands remain their own buttons. No automatic DOM mutation of arbitrary forms, backend changes, data rewriting, modal redesign, or loss of fields/actions. User has already asked for implementation; no further design approval is needed to prepare a reviewable change.
