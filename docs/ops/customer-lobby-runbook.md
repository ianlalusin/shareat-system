# Runbook: switch the customer lobby on (order.shareat.net) - T-455 S9

Written for Ian, in plain steps. One command per step. Nothing here contains a real secret: the secret is made on the server and never shown.

**The server is `159.223.46.224`** (our production box). Never the old shared box (the one that runs ERPNext).

## What this does, in plain words

The lobby is the page a diner opens on their phone to join the waiting line. It is a small program (the "customer app") that runs next to the ERP and POS on the same box, on its own internal port (9010). Caddy (the program that answers web addresses) sends `order.shareat.net` to it.

**Only start this after PR #131 (S9a) is merged and deployed.** Step 2 takes its files from merged `main`; before the merge they do not exist there. The deploy builds the customer app and puts it on the box, but it does not start it until you finish the steps below.

Who does what: **you** do every step below. The agent does not touch the box and does not add company data. **Ian runs** the one SQL line in step 9, because it chooses which store opens.

Every database step below runs as the **admin connection** (`SYSTEM_DATABASE_URL`, the `doadmin` login), the same way the other runbooks here do it (for example `pos2-switchon-2026-11-01.md` step 2.3). The tables are protected by row-level security, so the app's own login would see nothing. The connection address is read inside the command and never printed.

## Step 0 - check the code is on the box

Log in to the box (from PowerShell on your PC):

```
ssh root@159.223.46.224
```

Check the customer build arrived (it should print the file name, not an error):

```
ls /srv/shareat/apps/customer/.customer-build-ok
```

If it says "No such file", stop. The last deploy did not build the customer app. Tell the orchestrator; do not go on.

Define a small helper for the database steps. It runs one SQL statement as the admin login and prints the result. **A new login to the box forgets it, so paste it again each time you log in.** Paste it as one block:

```
asql() {
  U="$(grep -m1 '^SYSTEM_DATABASE_URL=' /srv/shareat-shared/.env.local | cut -d= -f2- | tr -d '\r' | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")"
  (cd "$(readlink -f /srv/shareat)" && DATABASE_URL="$U" node -e "require('postgres')(process.env.DATABASE_URL,{max:1}).unsafe(process.argv[1]).then(r=>{console.log(r);process.exit(0)}).catch(e=>{console.error(e.message);process.exit(1)})" "$1")
  unset U
}
```

Check the deploy created the lobby's database role (migration 0225). It should print one row with `shareat_lobby`:

```
asql "select rolname from pg_roles where rolname = 'shareat_lobby'"
```

If it prints `[]`, the database change did not run. Stop and tell the orchestrator.

## Step 1 - the web address (DNS)

At the place that manages `shareat.net` addresses, add an "A record": name `order`, value `159.223.46.224`. Set it to **"DNS only" (the grey cloud), not "Proxied" (the orange cloud)**, because Caddy asks Let's Encrypt for the padlock directly and a proxy in between makes that check fail.

Then, on your PC, check it (it should show 159.223.46.224):

```
nslookup order.shareat.net
```

Do not go on until it shows the box's address. Caddy cannot get the padlock (HTTPS certificate) before that.

## Step 2 - install only what S9a adds (your PC, then the box)

**Only do this after PR #131 is merged.** Do not copy your local `docs/ops` folder and do not re-run `provision.sh`: that would re-install every other unit on the box. Install just the new pieces, taken from merged `main`.

On your PC (PowerShell), get the latest `main` and save the three files. The `cmd /c` form copies the files byte for byte (PowerShell's own redirect would change the line endings and break the units):

```
git -C C:\Users\ianla\webapps\shareat-system fetch origin
```

```
New-Item -ItemType Directory -Force "$env:TEMP\lobby-ops" | Out-Null
```

```
cmd /c "git -C C:\Users\ianla\webapps\shareat-system show origin/main:docs/ops/shareat-customer.service > %TEMP%\lobby-ops\shareat-customer.service"
```

```
cmd /c "git -C C:\Users\ianla\webapps\shareat-system show origin/main:docs/ops/shareat-lobby-nightly.service > %TEMP%\lobby-ops\shareat-lobby-nightly.service"
```

```
cmd /c "git -C C:\Users\ianla\webapps\shareat-system show origin/main:docs/ops/shareat-lobby-nightly.timer > %TEMP%\lobby-ops\shareat-lobby-nightly.timer"
```

Each command must finish with no error, and the three files must not be empty:

```
Get-ChildItem "$env:TEMP\lobby-ops" | Select-Object Name, Length
```

Make a folder on the box for these three files (a new folder just for this job) and copy them up:

```
ssh root@159.223.46.224 'mkdir -p /root/lobby-ops'
```

```
scp "$env:TEMP\lobby-ops\shareat-customer.service" "$env:TEMP\lobby-ops\shareat-lobby-nightly.service" "$env:TEMP\lobby-ops\shareat-lobby-nightly.timer" root@159.223.46.224:/root/lobby-ops/
```

Now on the box. Install the three unit files (installing starts nothing):

```
install -m 644 -t /etc/systemd/system /root/lobby-ops/shareat-customer.service /root/lobby-ops/shareat-lobby-nightly.service /root/lobby-ops/shareat-lobby-nightly.timer
```

Add the one sudo rule that lets the deploy restart the customer app (only if it is not already there):

```
grep -q 'restart shareat-customer.service' /etc/sudoers.d/shareat-deploy || echo 'shareat ALL=(root) NOPASSWD: /usr/bin/systemctl restart shareat-customer.service' >> /etc/sudoers.d/shareat-deploy
```

Check the sudo file is still valid (it must say `parsed OK`; if it does not, stop and tell the orchestrator):

```
visudo -cf /etc/sudoers.d/shareat-deploy
```

Create the two log files the units write to:

```
touch /var/log/shareat/customer.log /var/log/shareat/lobby-nightly.log && chown shareat:shareat /var/log/shareat/customer.log /var/log/shareat/lobby-nightly.log && chmod 640 /var/log/shareat/customer.log /var/log/shareat/lobby-nightly.log
```

Tell the system about the new unit files:

```
systemctl daemon-reload
```

The Caddy block is added in step 5, and the file is validated before Caddy is reloaded.

## Step 3 - the settings file (on the box)

The lobby reads its settings from one private file, `/srv/shareat-shared/customer.env`.

**Two things to know before you start:**

- The block below creates the file only if it does not exist, and adds each line only if it is not already there. **Running this step again is safe: nothing is cut off and no line is doubled.**
- `LOBBY_HASH_SECRET` is the lobby's secret key. **If it is ever replaced by a new one, every diner who is waiting is logged out**: their phones can no longer find their place in line. The block never replaces an existing one. Do not delete that line "to start clean" while diners are waiting.

Find your company's id (a long code like 0a1b2c3d-...). It must show exactly one row:

```
asql "select id, name from organizations"
```

Paste this block as one piece, after replacing `<the id from the line above>` with that id. It makes the file if needed and fills in what is missing, and it never prints a value:

```
f=/srv/shareat-shared/customer.env
umask 077
[ -e "$f" ] || install -m 600 /dev/null "$f"
if [ -n "$(tail -c1 "$f")" ]; then echo >> "$f"; fi
has() { grep -q "^$1=" "$f"; }
has LOBBY_HASH_SECRET || echo "LOBBY_HASH_SECRET=$(openssl rand -base64 48 | tr -d '\n')" >> "$f"
has SESSION_SECRET || echo "SESSION_SECRET=$(openssl rand -base64 48 | tr -d '\n')" >> "$f"
has DATABASE_URL || grep -m1 '^DATABASE_URL=' /srv/shareat-shared/.env.local | tr -d '\r' >> "$f"
for k in FIREBASE_PROJECT_ID FIREBASE_SERVICE_ACCOUNT_KEY_FILE; do has "$k" || grep -m1 "^$k=" /srv/shareat-shared/.env.local | tr -d '\r' >> "$f"; done
has LOBBY_ORG_ID || echo "LOBBY_ORG_ID=<the id from the line above>" >> "$f"
chown shareat:shareat "$f" && chmod 600 "$f"
```

What it fills in, and why: `SESSION_SECRET` is a separate random key that the lobby does not use but the shared settings check requires in production. `DATABASE_URL` is the app's normal login, copied and not shown. The two Firebase lines are a project name and a file path, with no secret in them.

**Never copy `SYSTEM_DATABASE_URL` into this file.** It is the all-powerful database login, and the lobby must never hold it.

Check the file has the right names, without showing any value. You should see 6 names, each with a count of 1:

```
cut -d= -f1 /srv/shareat-shared/customer.env | sort | uniq -c
```

Check the permissions (it should show `-rw-------` and owner `shareat`):

```
ls -l /srv/shareat-shared/customer.env
```

## Step 4 - start the customer app

Start it and make it start by itself after a reboot:

```
systemctl enable --now shareat-customer.service
```

Check it is running (it should say `active (running)`; if it says `failed`, the next command shows why):

```
systemctl status shareat-customer --no-pager
```

```
journalctl -u shareat-customer -n 30 --no-pager
```

## Step 5 - the Caddy block (the web address goes live)

Add the lobby's block to the Caddy file. This only adds; it does not change the ERP or POS blocks. The line `header_up X-Real-IP {remote_host}` is important: it makes Caddy tell the app the diner's real address, which the app uses for its limits.

```
grep -q 'order.shareat.net' /etc/caddy/Caddyfile || printf '\norder.shareat.net {\n  encode zstd gzip\n  request_body {\n    max_size 64KB\n  }\n  reverse_proxy 127.0.0.1:9010 {\n    header_up X-Real-IP {remote_host}\n  }\n}\n' >> /etc/caddy/Caddyfile
```

Check the file is valid before using it (it should say `Valid configuration`; if it does not, do not reload, tell the orchestrator):

```
caddy validate --config /etc/caddy/Caddyfile
```

Make Caddy pick it up:

```
systemctl reload caddy
```

## Step 6 - the nightly clean-up

Every night at 05:30 (Manila time) the lobby wipes names and notes of old, closed entries (privacy). Turn the timer on:

```
systemctl enable --now shareat-lobby-nightly.timer
```

Check it is listed with a "next run" time:

```
systemctl list-timers shareat-lobby-nightly.timer --no-pager
```

## Step 7 - check it answers, before any store is on

This should print `200` for the page and a plain "check in at the counter" message for the store (no store is switched on yet, so that is correct):

```
curl -s -o /dev/null -w '%{http_code}\n' https://order.shareat.net/lobby
```

```
curl -s 'https://order.shareat.net/api/lobby/store?s=NOSUCHSTORE'
```

If the second one says "not configured" or "Something went wrong", the settings file in step 3 is incomplete: run `journalctl -u shareat-customer -n 30 --no-pager` and tell the orchestrator.

## Step 8 - find Lipa's store id

You need Lipa's store id and store code (they are in the `stores` table). Paste the `asql` helper from step 0 first if this is a new login:

```
asql "select id, code, name from stores where name ilike '%lipa%'"
```

Write down the id and the code. The code is what goes in the QR link (`?s=<code>`).

## Step 9 - switch Lipa on (Ian runs this one SQL line)

**Ian runs** this, nobody else. It makes the lobby open for Lipa. Replace `<org id>` with the id from step 3 and `<store id>` with the id from step 8. It cannot be run twice by mistake (a second run says it is already there):

```
asql "insert into lobby_stores (org_id, store_id, enabled) values ('<org id>', '<store id>', true)"
```

The lobby only accepts diners while the POS has been seen in the last 5 minutes. The POS tablet sets that by itself.

## Step 10 - the first real check

Open `https://order.shareat.net/lobby?s=<Lipa's code>` on your phone. You should see Lipa's name and the number waiting. Do one test check-in, then cancel it from the same phone. At the POS, the card should show it.

## Step 11 - measure the memory and write it down

The lobby may use at most 512 MB (`MemoryMax=512M`) so it can never starve the ERP. Read the number right after the start:

```
systemctl show shareat-customer -p MemoryCurrent
```

Read it again after the test check-in and again after an hour. Write the three numbers in the table at the bottom of this file. Also check the ERP is still fine:

```
systemctl show shareat-erp -p MemoryCurrent
```

If the lobby climbs toward the cap, switch it off (next section) and tell the orchestrator. The ERP comes first.

## How to switch it off

Soft off (diners see "please check in at the counter", the app keeps running). Replace `<store id>` (paste the `asql` helper from step 0 first if this is a new login):

```
asql "update lobby_stores set paused = true where store_id = '<store id>'"
```

Hard off (the whole customer app stops; the page does not answer at all):

```
systemctl stop shareat-customer
```

To turn it back on: `asql "update lobby_stores set paused = false where store_id = '<store id>'"` for the soft off, or `systemctl start shareat-customer` for the hard off.

## Memory readings (fill in)

| When | `MemoryCurrent` (bytes) | Note |
|---|---|---|
| right after start | | |
| after the test check-in | | |
| after one hour | | |

## What can go wrong

| Sign | Likely cause | What to do |
|---|---|---|
| Step 0 file missing | the customer build failed in the deploy | tell the orchestrator; do not go on |
| Step 0 role check prints `[]` | the database change (migration 0225) did not run | tell the orchestrator; do not go on |
| `status` says failed | the settings file is incomplete | `journalctl -u shareat-customer -n 30 --no-pager` |
| every diner is told "check in at the counter" | the store is paused, not switched on, or the POS has not been seen for 5 minutes | check `lobby_stores` and that the POS tablet is on |
| `curl` to the store says 503 | `LOBBY_HASH_SECRET` or `LOBBY_ORG_ID` missing or too short | redo step 3 (it only adds what is missing) |
| the padlock does not appear | DNS is not pointing at the box yet, or the record is proxied (orange cloud) | redo step 1 |
