# How to actually drive the app — the §9.4 screen gate, from nothing to a signed-in screenshot

> **Written 2026-09-20 by the orchestrator (`system32-df`), after §9.4 had been reported unmeetable
> for three days on premises that were mostly wrong.** Every command below was run on this machine
> tonight and the output quoted is real. ⛔ **If something here stops being true, fix this file in
> the same pass** — a recipe that has quietly rotted is worse than no recipe, because the next
> person believes it (bible §13 row 204).

---

## 0. What was wrong before, so nobody re-inherits it

Three claims were blocking the screen gate. **Two were false and the third was smaller than it
looked.**

| The claim | What is actually true |
|---|---|
| *"The app 500s / cannot be opened"* | ⛔ **`next dev` is dead on this machine (DEF-401). The APP is not.** `npm run start` serves it correctly. Smoketest against `next start`, always. |
| *"Playwright needs Chrome and the install needs Administrator, which is Ian's"* | ⚠️ **True for the tool being used, and avoidable with a different one.** The Playwright **MCP server** is pinned to the `chrome` channel and exposes no channel override, so through *that* door the blocker is real. ⛔ **But a standalone script driving Playwright's own chromium sidesteps it entirely**, and those builds were already on this machine: `chromium-1208` (Apr), `1228` (Jul), `1234` (Jul) — **months before DEF-401 was filed**, confirmed by directory mtimes, not assumed. |
| *"Neither sign-in route works — the public Firebase config is blank"* (DEF-368/DEF-369) | ⚠️ **Was true, is not now.** The `NEXT_PUBLIC_*` values are populated. What was still blank was **`FIREBASE_PROJECT_ID`** — the SERVER-side one — and `next start` runs as `NODE_ENV=production`, where `env()` hard-requires it. One blank line made `/api/health` report `configuration: invalid`. |

⭐ **The general lesson, because it is the one that keeps repeating here: each of those was a true
observation generalised one step too far.** `next dev` failing became "the app is broken". One
pinned tool's install failing became "nobody can drive a browser". A blank public config in the
past became a blank config now. **Re-measure before inheriting a blocker.**

⚠️ **And note the shape of the middle one, because it is the subtle one and this file got it wrong
on its first draft.** Nobody erred in filing it: the claim was **accurate about the mechanism being
used**. What was wrong was the scope it was read at. ⛔ **"That tool cannot" is not "this cannot"**
— and the difference is a day's work either way.

---

## 1. The environment must be valid IN PRODUCTION MODE

`next start` sets `NODE_ENV=production`, and `env()` requires strictly more in production than in
development. ⛔ **`/api/health` deliberately suppresses the reason in production** (`detailFor`
returns `undefined`), so the endpoint tells you *that* configuration is invalid and never *what*.
**Do not debug this from the HTTP response.** Run the validator directly:

```
NODE_ENV=production npx tsx <a scratch file that imports env() from packages/core/src/env>
```

It prints the missing variable by name. Tonight that was:

```
Shareat System REFUSED TO START — environment is incomplete or invalid.
  - FIREBASE_PROJECT_ID: is required in production
```

⚠️ **`FIREBASE_PROJECT_ID` must EQUAL `NEXT_PUBLIC_FIREBASE_PROJECT_ID`** — `.env.example` says so,
and `env()` compares them when both are visible. If the browser signs in against one project and
the server verifies against another, every sign-in fails in a way that looks like bad credentials.

**Healthy looks like this, and `database: reachable` is the half people forget to check:**

```
{"status":"ok","configuration":"valid","database":"reachable", ...}
```

---

## 2. Start the server — on 9008, and only one

```
npm run start          # next start -p 9008
```

⛔ **Stop it before `npm run build`.** The build overwrites the `.next` the running server is
serving. `tools/gates.mjs` refuses to run `build` while anything listens on 9008, which is the
guard, not a suggestion.
⛔ **One server. Workers never start one** — the orchestrator does, and tells the lane the port.

---

## 3. A signed-in session, without a Firebase account

⛔ **READ THIS BEFORE USING IT.** The forge below **bypasses sign-in on purpose**. A smoketest
driven through it proves things about **SCREENS** and **nothing whatever about authentication**.
Say so in any report that uses it. It refuses any database without `_test` in the name.

**Why a forge at all:** T-304 made PIN sign-in two-layer, and layer 1 authenticates the *tablet*
against Firebase **in the browser**. That cannot be faked from a script. ⭐ **A real end-to-end
sign-in still needs Ian to create the terminal account in the Firebase console** — that is the one
genuinely outstanding item, and it is small.

### The recipe

```
# 1. a throwaway database, migrated
node <skill>/tools/make-test-dbs.mjs shareat_test_setup --repo .

# 2. an organisation somebody could sign into (dry-run without --confirm first)
node <skill>/tools/run-with-db.mjs shareat_test_setup npx tsx scripts/bootstrap-org.ts \
  --code=SMOKE_ORG --name=SmokeOrg --admin=SmokeAdmin \
  --store-code=SMK --store-name=SmokeStore --pin=246810 --confirm

# 3. mint a session; prints ONLY the cookie value
NODE_PATH=<repo>/node_modules node <skill>/tools/run-with-db.mjs shareat_test_setup \
  npx tsx <skill>/tools/forge-session.ts

# 4. serve the app against that same database
node <skill>/tools/run-with-db.mjs shareat_test_setup npm run start
```

⚠️ **`bootstrap-org` takes no argument with a space in it through `run-with-db`** — the value gets
re-split and the script rejects it. Use `SmokeOrg`, not `"Smoke Org"`.

⭐ **`forge-session.ts` uses the repo's OWN `newSessionToken`, `sessionTokenHash` and
`sessionsRepo.insertSession`** rather than reimplementing the hash. A forge that reimplements the
thing it forges is a second source of truth and drifts silently the day the real one changes.

### Give the store something to show

A bootstrapped organisation is **empty**, and an empty screen is a weak smoketest — it exercises
the zero state and nothing else. Seed the ledger through the app's own `postEntry`, never raw SQL:

```
node <skill>/tools/run-with-db.mjs shareat_test_setup \
  npx tsx <skill>/tools/seed-service-charge-float.ts 5000.00 18
```

⭐ **Through `postEntry`, not an INSERT**, so the rows land exactly as the real writer leaves them —
`store_id` on **both** lines, non-draft, inside a real fiscal period. A fixture built with raw
inserts is a second opinion about what a real row looks like, and the detectors being tested read
precisely those columns.

⚠️ **`bootstrap-org` creates twelve fiscal periods starting THIS MONTH**, so a back-dated fixture
earlier than the 1st of the current month is refused with *"no fiscal period covers entry date"*.
That is the period system working; pick a date inside the window.

### Then drive it

Set the cookie `shareat_session` on `localhost` and load real pages. Verified tonight:

```
/                    -> 200  landed=/                     SIGNED IN  "Dashboard — Shareat System"
/findings            -> 200  landed=/findings             SIGNED IN  "Findings — Shareat System"
/liabilities         -> 200  landed=/liabilities          SIGNED IN  "Liabilities — Shareat System"
/settings/attendance -> 200  landed=/settings/attendance  SIGNED IN  "Attendance & payroll settings"
```

`landed=` is the point: a page that redirected to `/sign-in` still returns 200, so **assert on the
final pathname, never on the status code alone.**

**Playwright lives outside the repo** — the module under `%LOCALAPPDATA%\npm-cache\_npx\...` and the
browser at `%LOCALAPPDATA%\ms-playwright\chromium-1234\chrome-win64\chrome.exe`. The existing
`tools/smoke-*.mjs` scripts show the launch shape.

⛔ **Never run a browser binary with `--version` from a shell here** — it launches a GUI and hangs
until timeout. Check the file exists instead.

---

### ⛔ The Chrome EXTENSION cannot set this cookie, and it cannot tell you that it failed

**Measured 2026-09-21 by the T-332 tester lane (`webapps-d1`), with a control.** This is the third
distinct "you cannot drive the browser" claim this file has had to adjudicate, and unlike the first
two **this one is true — about the extension, and only about the extension.**

| Attempt, checking the FINAL PATHNAME each time | Result |
|---|---|
| `document.cookie = "shareat_session=<value>; path=/"` via the extension's JS tool, then `/settings/attendance` | `landed=/sign-in?next=%2Fsettings%2Fattendance` |
| Same, with `SameSite=Lax` added explicitly | identical |
| ⭐ **CONTROL:** write `testcookie=hello` the same way | **persisted, read back fine** |
| ⭐ **CONTROL:** write `shareat_session=abc123` (trivial value, so the token is not the variable) | **did not appear** |

⭐ **The control is what makes this a diagnosis rather than a guess**, and it isolates the cause to
the cookie NAME rather than to the token, the value, or the tool being broken in general.

**Why:** page JavaScript **can never override or clear an HttpOnly cookie** — only a server
`Set-Cookie` can. A name with no prior cookie (`testcookie`) takes immediately; `shareat_session`,
which already has an HttpOnly cookie for that origin in the profile the extension drives, does not.

⛔ **AND THE FAILURE IS SILENT, WHICH IS THE HALF THAT COSTS THE HOUR.** The extension's JS tool
hard-blocks any output that looks like it is reading cookie data — `[BLOCKED: Cookie/query string
data]` — on **any** call touching `document.cookie` for a read, **whatever the cookie name**. That is
a safety guardrail in the tool, not something to work around. Its consequence here is that **the
write fails AND you cannot read back to discover that it did.** You see only the redirect.

⭐ **THE FIX IS THE RECIPE THIS FILE ALREADY PRESCRIBES — a standalone Playwright script**, which
sets cookies at the browser-context level and is not subject to the restriction:

```
const { chromium } = require('C:/Users/ianla/AppData/Local/npm-cache/_npx/705bc6b22212b352/node_modules/playwright');
const EXE = 'C:/Users/ianla/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
await context.addCookies([{
  name: 'shareat_session', value: '<forged token>',
  domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax',
}]);
```

A fresh Playwright context is also a **clean profile**, so there is no stale HttpOnly cookie to
fight — the problem disappears rather than being cleared. Copy the launch shape from
`smoke-t290.mjs`; keep new smoke scripts **outside the repo**, in the orchestrator skill's `tools/`
directory where every previous one lives, so they never land in the tree.

> ⭐⭐ **THE DISTINCTION THAT MUST SURVIVE THIS ENTRY, because collapsing it is how §9.4 got reported
> impossible three times:** *"I cannot authenticate the extension's browser"* is **NOT** *"the screen
> cannot be reached."* The tester hit this, named it as a tooling gap, and ⛔ **explicitly declined
> to escalate §9.4 as UNMET** — correctly, because the screen was fine and one mechanism was not.
> **"That tool cannot" is not "this cannot"**, which is the same lesson §0 of this file already
> records about the MCP Playwright server. It has now been learned twice, through two different
> doors, about two different tools, in two days.

---

## 4. What a smoketest report must contain

The URL · what was clicked · **what CHANGED on screen** · console output · a screenshot where the
change is visual. ⛔ **What it saw, never what it expected.**

⛔ **Never click a control that raises an `alert()` or `confirm()`** when driving through the Chrome
extension — it blocks the extension and ends browser access for that session. Headless Playwright
can dismiss dialogs, but the rule stands for anything driven through the extension.

⚠️ **If the screen could not be reached at all, that is §9.4 UNMET** — say it in those words and
escalate. Bible row 203 makes shipping with a gate unmet **Ian's call**, never a lane's, and never
a silent omission.

---

## 5. Known noise, so it is not re-investigated

- **A single console `404` on every page.** Present on all four routes above, unresolved, almost
  certainly a static asset. Not a blocker; worth someone's ten minutes.
- **`/api/health` reports `revision.sha: "unknown"`** locally. `npm run write-revision` populates
  it. Harmless for a smoketest; ⛔ **in production the forty characters are the only honest answer
  to "what is deployed" (DEF-360)** — never compare anything shorter.
- ⛔ **A freshly bootstrapped store has NO `store_attendance_config` row (DEF-249)**, so
  `/settings/attendance` renders a store picker and nothing else. That is the defect, not a broken
  screen. Specced as T-332. ⚠️ **This was first written here as DEF-405, which is retracted as a
  duplicate** — cite **DEF-249**, and read **DEF-251** and **DEF-256** with it.

- **Running the integration suite in parallel locally (T-400).** `node scripts/make-integration-worker-dbs.mjs 4 && INTEGRATION_WORKERS=4 DATABASE_POOL_MAX=4 npm run test:integration`. Re-run the first command after every migration; unset, the suite is serial on one DB as before.
