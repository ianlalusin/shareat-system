# Cutting off someone's access — and why disabling them in Firebase is not enough

> T-237, closing **DEF-224**. Companion to `README.md` §"Standing up an organization on production".
> **Read the first two lines even if you read nothing else.**

## The one thing to know

**Unlink their email account on `/admin/users/<person>`.** That revokes the credential *and* ends
every live session that person holds, immediately, in one transaction.

⛔ **Disabling the account in the Firebase console does NOT do this.** v2 checks the Firebase token
**once, at sign-in**, and the session it mints then is its own — a `shareat_session` cookie backed by
a row in `sessions`, valid for **seven days** (`BROWSER_SESSION_TTL_MS`). Firebase's console stops the
*next* sign-in. It does not touch the session already running, and nothing re-verifies that session
against Firebase for the rest of its life.

So the console and the screen are for different jobs:

| You want | Do this |
|---|---|
| This person out, now | **Unlink** on `/admin/users/<person>`. Their sessions end as you click |
| This person never to sign in again | Unlink **and** disable the account in the Firebase console — otherwise a re-link, by anyone with `manage_users`, restores them |
| A staffer's terminal access stopped | Issue a new PIN from `/staff` (the old one is retired the moment the new one is set), or unlink the PIN credential here |

## What unlinking actually does

1. Revokes the `person_credentials` row — a **timestamp, never a delete**, because a credential that
   once existed is part of the audit trail for everything it authorised.
2. Ends **every live session for that person**, with the reason `revoked`.
3. Reports how many sessions it ended, on the screen: *"Unlinked, and signed out of 2 live
   sessions."* If it says zero, they had none — that is information, not a failure.

⚠️ **Step 2 is person-wide, not credential-wide.** Unlinking an email account also ends a PIN session
that person is holding at a terminal. That is deliberate: this screen exists for *"they have left"*
and *"that account is compromised"*, and half-ending a compromised person's access is not a control.
If someone is only changing their email account, expect them to sign back in at the terminal.

## Linking, and re-linking

- The field takes a **Firebase uid**, copied from the console — not an email address. Resolving an
  email would make this screen depend on a service-account key that the sign-in path deliberately
  does not need.
- ⭐ **A uid that was unlinked can be linked again.** Until T-237 the database refused it outright
  (DEF-224), which made the sign-in screen's own sentence — *"This account is not linked to a person.
  Ask an administrator to link it"* — advice nobody could follow.
- A uid that is already linked to a **live** credential is refused. One account signs in as exactly
  one person.
- A wrong uid is not dangerous, only useless: it never signs anybody in. Unlink it and paste the
  right one.

## ⛔ The refusal you can hit, and what to do about it

> *"This is the last way into this organisation. Give someone else an admin role, or issue this
> person a PIN, before unlinking it."*

The system will not let you remove the only remaining way in. If it did, the recovery would be a
shell on the droplet and `npm run bootstrap-org`'s database posture — not a Sunday anyone wants.
Appoint a second admin (or super-admin) first, or give that person a PIN from `/staff`, then unlink.

## What is deliberately NOT done

- **`checkRevoked` on token verification.** It would need a service-account credential on the
  identity path, cost a round-trip per sign-in, and — the reason it is declined — it hardens only the
  *sign-in moment*. A session already issued is never re-verified, so the seven-day window it looks
  like it closes stays exactly as wide. Unlink is the control; this page is its documentation.
- **A shorter browser session.** That is a change to every office user's day for a case that now has
  a direct control. If session policy is revisited, it is revisited on its own merits.

*(The missing revoke reason used to be listed here. It is done — see below.)*

## The reason, and why it is required — T-239 / DEF-229

Unlinking asks for a short reason, the same way revoking a staff badge on
`/staff/[employmentId]/credentials` already does. It is not optional and it is not only a
front-end rule: `person_credentials_revoke_check` refuses a revoked row that carries no reason, so a
future code path cannot quietly skip it (bible §15.11 — the service layer must not be the only
defence for a rule the database can hold).

- **Write what you would want to read in six months.** *"Left the company"*, *"account compromised —
  reported by the branch manager"*, *"wrong uid pasted"*. Blank and whitespace-only are refused.
- **A PIN retired by a re-issue records itself.** When an administrator issues a new PIN, the old one
  is revoked with *"Superseded by a newly issued PIN for this store."* and **no person named** —
  there is no principal at that layer, and naming the staffer would claim they revoked their own
  credential when somebody else re-issued it. An absent attribution is honest; a fabricated one reads
  as evidence.
- **Who and when are still recorded.** The reason is a third question, not a replacement.
