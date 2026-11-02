# Runbook: switch the customer lobby on (order.shareat.net) - T-455 S9

Written for Ian, in plain steps. One command per step. Nothing here contains a real secret: the secret is made on the server and never shown.

**The server is `159.223.46.224`** (our production box). Never the old shared box (the one that runs ERPNext).

## What this does, in plain words

The lobby is the page a diner opens on their phone to join the waiting line. It is a small program (the "customer app") that runs next to the ERP and POS on the same box, on its own internal port (9010). Caddy (the program that answers web addresses) sends `order.shareat.net` to it.

This runbook needs the code from **S9a** to be merged and deployed first. The deploy builds the customer app and puts it on the box, but it does not start it until you finish the steps below.

Who does what: **you** do every step below. The agent does not touch the box and does not add company data. **Ian runs** the one SQL line in step 9, because it chooses which store opens.

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

## Step 1 - the web address (DNS)

At the place that manages `shareat.net` addresses, add an "A record": name `order`, value `159.223.46.224`. Then, on your PC, check it (it should show 159.223.46.224):

```
nslookup order.shareat.net
```

Do not go on until it shows the box's address. Caddy cannot get the padlock (HTTPS certificate) before that.

## Step 2 - put the ops files on the box (your PC)

These three commands run on your PC, in the repo folder. The first clears an old copy (an old copy is more dangerous than none):

```
ssh root@159.223.46.224 'rm -rf /root/shareat-ops'
```

Copy the current files up:

```
scp -r docs/ops root@159.223.46.224:/root/shareat-ops
```

Install the unit files, the sudo rule and the log files. Run it with no web address, so it does not touch the Caddy file yet:

```
ssh root@159.223.46.224 'bash /root/shareat-ops/provision.sh'
```

This installs `shareat-customer.service` and `shareat-lobby-nightly.service` and `.timer`. It starts nothing.

## Step 3 - the settings file (on the box)

The lobby reads its settings from one private file. First create it empty, readable only by the `shareat` user:

```
sudo -u shareat install -m 600 /dev/null /srv/shareat-shared/customer.env
```

Make the lobby's secret key. It is generated here and never printed (the `> /dev/null` hides it):

```
echo "LOBBY_HASH_SECRET=$(openssl rand -base64 48 | tr -d '\n')" | sudo -u shareat tee -a /srv/shareat-shared/customer.env > /dev/null
```

The shared settings check also wants a session key. The lobby does not use it, so make a second, different random one:

```
echo "SESSION_SECRET=$(openssl rand -base64 48 | tr -d '\n')" | sudo -u shareat tee -a /srv/shareat-shared/customer.env > /dev/null
```

Copy the database address from the ERP's settings (it is copied, not shown):

```
sudo -u shareat sh -c "grep -m1 '^DATABASE_URL=' /srv/shareat-shared/.env.local | tr -d '\r' >> /srv/shareat-shared/customer.env"
```

Copy the two Firebase lines the shared settings check requires in production (a project name and a file path, no secret in them):

```
sudo -u shareat sh -c "grep -E '^(FIREBASE_PROJECT_ID|FIREBASE_SERVICE_ACCOUNT_KEY_FILE)=' /srv/shareat-shared/.env.local | tr -d '\r' >> /srv/shareat-shared/customer.env"
```

Never copy `SYSTEM_DATABASE_URL` into this file. It is the all-powerful database login, and the lobby must never hold it.

Find your company's id (a long code like 0a1b2c3d-...):

```
sudo -u shareat sh -c "psql \"\$(grep -m1 '^DATABASE_URL=' /srv/shareat-shared/.env.local | cut -d= -f2- | tr -d '\r\"')\" -c 'select id, name from organizations;'"
```

Write it into the file (replace `<the id from the line above>` with that id, keep nothing else):

```
echo "LOBBY_ORG_ID=<the id from the line above>" | sudo -u shareat tee -a /srv/shareat-shared/customer.env > /dev/null
```

Check the file has the right names, without showing any value (you should see 6 names):

```
sudo -u shareat cut -d= -f1 /srv/shareat-shared/customer.env
```

Lock it (it should already be 600; this makes sure):

```
chmod 600 /srv/shareat-shared/customer.env
```

## Step 4 - start the customer app

Tell the system about the new unit files:

```
systemctl daemon-reload
```

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

Check the file is valid before using it (it should say `Valid configuration`):

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

You need Lipa's store id and store code (they are in the `stores` table):

```
sudo -u shareat sh -c "psql \"\$(grep -m1 '^DATABASE_URL=' /srv/shareat-shared/.env.local | cut -d= -f2- | tr -d '\r\"')\" -c \"select id, code, name from stores where name ilike '%lipa%';\""
```

Write down the id and the code. The code is what goes in the QR link (`?s=<code>`).

## Step 9 - switch Lipa on (Ian runs this one SQL line)

**Ian runs** this, nobody else. It makes the lobby open for Lipa. Replace `<org id>` with the id from step 3 and `<store id>` with the id from step 8. It cannot be run twice by mistake (a second run says it is already there):

```
sudo -u shareat sh -c "psql \"\$(grep -m1 '^DATABASE_URL=' /srv/shareat-shared/.env.local | cut -d= -f2- | tr -d '\r\"')\" -c \"insert into lobby_stores (org_id, store_id, enabled) values ('<org id>', '<store id>', true);\""
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

Soft off (diners see "please check in at the counter", the app keeps running). Replace `<store id>`:

```
sudo -u shareat sh -c "psql \"\$(grep -m1 '^DATABASE_URL=' /srv/shareat-shared/.env.local | cut -d= -f2- | tr -d '\r\"')\" -c \"update lobby_stores set paused = true where store_id = '<store id>';\""
```

Hard off (the whole customer app stops; the page does not answer at all):

```
systemctl stop shareat-customer
```

To turn it back on: `update lobby_stores set paused = false ...` for the soft off, or `systemctl start shareat-customer` for the hard off.

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
| `status` says failed | the settings file is incomplete | `journalctl -u shareat-customer -n 30 --no-pager` |
| every diner is told "check in at the counter" | the store is paused, not switched on, or the POS has not been seen for 5 minutes | check `lobby_stores` and that the POS tablet is on |
| `curl` to the store says 503 | `LOBBY_HASH_SECRET` or `LOBBY_ORG_ID` missing or too short | redo the matching line in step 3 |
| the padlock does not appear | DNS is not pointing at the box yet | redo step 1 |
