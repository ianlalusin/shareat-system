# `secrets/` — local credential files, never committed

Everything in this directory is gitignored **except this README**
(`.gitignore`: `secrets/*` then `!secrets/README.md`).

> The ignore rule was written **before** the first key was ever placed here. That order is the
> whole point: a credential that lands in an un-ignored directory can be swept into a commit by
> `git add -A` seconds later, and a pushed secret is a rotated secret, not a deleted one.

## What goes here

| File | What it is |
|---|---|
| `erp.sa.json` | Read-only service account for the **live v1 ERP** Firebase project |
| `hub.sa.json` | Read-only service account for the **live POS/hub** Firebase project |

Point `.env.local` at them by **path**, not by pasting their contents:

```
CAPTURE_ERP_SA_KEY_FILE=./secrets/erp.sa.json
CAPTURE_HUB_SA_KEY_FILE=./secrets/hub.sa.json
CAPTURE_SALT=<openssl rand -base64 32>
```

`CAPTURE_SALT` stays an env value — it is not a Google credential, it is the pseudonymisation
salt used to hash staff names and customer identifiers before a specimen is written to the
corpus. Changing it re-pseudonymises everything, so pick one and keep it.

## Two rules that matter more than the ignore file

**1. Grant the least privilege that works.** These reach **production** data in two live systems.
`Cloud Datastore Viewer` / `Firebase Viewer` is enough — nothing that can write.

The ETL is already incapable of mutating the source by design: `SourceReader`
(`packages/etl/src/source-reader.ts`) declares no write method, so there is no call to make. A
read-only key turns that from *intended* into *structural* — the difference between "our code
does not write" and "this credential cannot write, whatever the code does."

**2. These are LOCAL ONLY.** Never set them in a deployed environment. The running app has no
reason to hold a credential to the old system, and a deployed copy is a credential in one more
place that can leak.

## The guard

`tests/unit/no-committed-secrets.test.ts` scans every **git-tracked** file for service-account
markers and fails the build if one appears. It runs in CI on every push, so it cannot be skipped
the way a local pre-commit hook can (`--no-verify`).

It protects the repository, not your working copy: a key sitting here uncommitted is fine and
expected — that is what this directory is for.

## Downstream consequence: `etl_source_documents` now holds real PII

T-114a (`npm run capture`, `@shareat/etl-firestore`) uses these keys to land REAL v1 documents
— staff names, customer identifiers, live figures — into Postgres's `etl_source_documents`
table, unmodified. That is correct for a migration (this is not the pseudonymised specimen
corpus path — `pseudonymise.ts`, T-117 — which exists for a different purpose: committed test
fixtures).

**Consequence, not solved here:** once a capture run has landed data, `etl_source_documents`
must be treated the same way this directory is — **never exported, never dumped into a shared
artifact or report, never copied into a test fixture or corpus.** No anonymisation layer exists
for this table (deliberately out of scope for T-114a). Anyone querying it directly (`psql`,
Drizzle Studio, a debugging script) is looking at production data and should treat the output
accordingly.
