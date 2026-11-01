# POS v2 switch-on checklist: Sunday 1 Nov 2026 (Lipa trial)

Copy-paste checklist for Ian and the orchestrator. Sources: `pos2-runbook.md` sections 0, 4-7, 12; `provision.sh`; `shareat-pos.service`; `.github/workflows/deploy.yml`; `app-build.yml`; `scripts/provision-terminal.ts`.

**Trial decisions (Ian, 31 Oct):**
- Cashiers sign in the current way: the store's Firebase email + PIN. Device pairing (T-464) is NOT wired in the app.
- Today's screens. One tablet first, at Lipa. Every other tablet stays on v1.
- Sales go to v1's Firebase format (project `shareat-hub-v2`).

**Rules for the day:**
- The box is `159.223.46.224` (erp2.shareat.net). NEVER `159.223.78.207`.
- NEVER build anything on the box. CI already built POS; the box only runs it.
- NEVER paste the Firebase key, `DATABASE_URL` or a PIN in chat. Commands below never print them.
- Anything marked **CHECK ON THE DAY** could not be settled from the repo.
- If any step fails and the fix is not written here: stop, do not improvise, go to section 7 (rollback).

Shell notes: "server shell" = `ssh root@159.223.46.224` from Ian's laptop (PowerShell is fine). Lines starting with `ssh`/`scp` run on the laptop; lines inside a server shell run on the box.

---

## 0. Before anything changes (read-only)

**0.1 Confirm the box. Who: orchestrator or Ian. Where: laptop.**
```
ssh root@159.223.46.224 'hostname; hostname -I; date'
```
Good: the IP list includes `159.223.46.224`. If not: STOP. You are on the wrong machine.

**0.2 Snapshot of state. Who: orchestrator. Where: laptop.**
```
ssh root@159.223.46.224 'systemctl status shareat-erp shareat-pos --no-pager -l | head -40; echo ---; ls -l /srv/shareat-shared /srv/shareat-shared/secrets; echo ---; ls -l /etc/systemd/system/shareat-pos.service /var/log/shareat/pos.log; echo ---; cat /etc/sudoers.d/shareat-deploy; echo ---; grep -c pos2 /etc/caddy/Caddyfile; free -m'
ssh shareat@159.223.46.224 'sudo -n -l'
```
Good:
- `shareat-erp` is `active (running)`.
- `shareat-pos` is "could not be found", or inactive/dead, or failed. Any of these is fine. It must NOT be running.
- `pos2.env` and `pos2-firebase-key.json` do not exist yet (or exist and you note it).
- `sudo -n -l` (run as `shareat`) lists `systemctl restart shareat-erp.service` and `systemctl restart shareat-pos.service`. If the pos line is missing, the PR #103 sudoers change is not applied yet. Step 3 fixes it.
- `grep -c pos2` on the Caddyfile prints `0` (not applied) or `1`+ (applied).

Write down for step 3: (a) is `/etc/systemd/system/shareat-pos.service` present, (b) does the unit show `EnvironmentFile=`, (c) is `pos.log` present, (d) is the sudoers pos line present, (e) is the Caddy pos2 block present.
Check (b) with: `ssh root@159.223.46.224 'grep EnvironmentFile /etc/systemd/system/shareat-pos.service'`

**0.3 Confirm the latest main deployed POS. Who: orchestrator. Where: laptop.**
```
ssh root@159.223.46.224 'ls -l /srv/shareat/apps/pos/.pos-build-ok; ls -dt /srv/shareat-releases/*/ | head -3; readlink /srv/shareat'
```
Good: `.pos-build-ok` exists in the current release. If it is missing, the last deploy did not build POS: stop and tell the orchestrator (deploy.yml keeps the last good POS only if one existed).

**0.4 Confirm the database has the table. Who: orchestrator. Where: server shell.** (After step 2.3 you have the same command; do it there if easier.) Runbook says production is already past migration 0216, so `pos_terminal_links` (0202) should exist. **CHECK ON THE DAY**: `select to_regclass('pos_terminal_links');` returns `pos_terminal_links`, not empty.

---

## 1. Firebase key (the write key for project `shareat-hub-v2`)

**1.1 Download the key. Who: Ian. Where: Firebase console, in his browser.**
1. Open https://console.firebase.google.com and click project **shareat-hub-v2**. Check the project id in the page URL / Project settings. It must be exactly `shareat-hub-v2` (the same project the tablet app signs into).
2. Click the gear icon (top left, beside "Project Overview") > **Project settings**.
3. Open the **Service accounts** tab.
4. Click **Generate new private key** > **Generate key**.
5. A `.json` file downloads (name like `shareat-hub-v2-firebase-adminsdk-xxxxx-xxxxxxxxxx.json`). Note the exact name.

Good: file is in `Downloads`. If "Generate new private key" is greyed out: Ian lacks the permission on that project. Ask the project owner. Do not borrow someone else's key by chat.

**CHECK ON THE DAY (optional shortcut, not recommended):** the ERP already has its own key in `/srv/shareat-shared/secrets/`. If it is the same project it could be reused, but a separate key can be revoked on its own. The plan is a new key.

**1.2 Copy it to the box. Who: Ian. Where: laptop (PowerShell).**
Replace the file name with the real one.
```
scp "$env:USERPROFILE\Downloads\shareat-hub-v2-firebase-adminsdk-XXXXX.json" root@159.223.46.224:/srv/shareat-shared/secrets/pos2-firebase-key.json
ssh root@159.223.46.224 'chown shareat:shareat /srv/shareat-shared/secrets/pos2-firebase-key.json && chmod 600 /srv/shareat-shared/secrets/pos2-firebase-key.json && ls -l /srv/shareat-shared/secrets/pos2-firebase-key.json'
```
Good: the last line shows `-rw------- 1 shareat shareat ...  pos2-firebase-key.json`. If "Permission denied": check you used `root@` not `shareat@`.

**1.3 Check it is the right project WITHOUT printing the key. Who: orchestrator. Where: laptop.**
```
ssh root@159.223.46.224 "grep -o '\"project_id\": *\"[^\"]*\"' /srv/shareat-shared/secrets/pos2-firebase-key.json"
```
Good: prints `"project_id": "shareat-hub-v2"`. If it prints any other project: delete the file (`rm`) and redo 1.1. A wrong project makes every refund say "Sign in again".

**1.4 Delete the local copy. Who: Ian. Where: laptop.**
```
Remove-Item "$env:USERPROFILE\Downloads\shareat-hub-v2-firebase-adminsdk-XXXXX.json"
```
Also empty the Recycle Bin. Good: the file is gone from Downloads.

---

## 2. The settings file `/srv/shareat-shared/pos2.env`

Three values, all required. If one is blank the server answers 503 "POS server is not configured" to every route (it does not crash).

**2.1 Start the file and add the key path. Who: orchestrator. Where: server shell (`ssh root@159.223.46.224`).**
```
umask 077
cat > /srv/shareat-shared/pos2.env <<'EOF'
POS_FIREBASE_SA_KEY_FILE=/srv/shareat-shared/secrets/pos2-firebase-key.json
EOF
```
If `pos2.env` already exists, do NOT overwrite: run `wc -l /srv/shareat-shared/pos2.env` and `cut -d= -f1 /srv/shareat-shared/pos2.env` (names only) and add only what is missing.

**2.2 Copy the app role's DATABASE_URL from the ERP's file, without printing it. Who: orchestrator. Where: server shell.**
This is the RLS-enforcing app role (`shareat_app_prod`), the same one the ERP uses. NOT `SYSTEM_DATABASE_URL`.
```
grep -m1 '^DATABASE_URL=' /srv/shareat-shared/.env.local | tr -d '\r' >> /srv/shareat-shared/pos2.env
cut -d= -f1 /srv/shareat-shared/pos2.env
```
(`^DATABASE_URL=` does not match `SYSTEM_DATABASE_URL`.)
Good: the second command prints names only: `POS_FIREBASE_SA_KEY_FILE`, `DATABASE_URL`. If only one name prints, the grep found nothing: the key in `.env.local` may be decorated. **CHECK ON THE DAY** with `grep -c DATABASE_URL /srv/shareat-shared/.env.local` (count only, never print the line).

**2.3 Get the organisation id (read-only). Who: orchestrator. Where: server shell.**
`organizations` has row-level security, so this must run as the admin connection (`SYSTEM_DATABASE_URL`), otherwise it returns nothing. The connection string is used in-process and never printed.
```
cd /srv/shareat
U="$(grep -m1 '^SYSTEM_DATABASE_URL=' /srv/shareat-shared/.env.local | cut -d= -f2- | tr -d '\r' | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")"
DATABASE_URL="$U" node -e "require('postgres')(process.env.DATABASE_URL,{max:1}).unsafe('select id, name from organizations').then(r=>{console.log(r);process.exit(0)}).catch(e=>{console.error(e.message);process.exit(1)})"
unset U
```
Good: exactly one row, `SHAREAT OPC`, with a uuid. If it prints `[]`: the URL used was not the admin one: stop, do not guess an id. If node cannot find `postgres`: run from the release dir (`cd "$(readlink -f /srv/shareat)"`). Do NOT use `npm run` build or install anything.
(Alternative from any SQL client as `doadmin`: `BEGIN READ ONLY; select id, name from organizations; ROLLBACK;`)

**2.4 Add the org id. Who: orchestrator. Where: server shell.** Replace the uuid.
```
echo 'POS_ORG_ID=<uuid from 2.3>' >> /srv/shareat-shared/pos2.env
chown shareat:shareat /srv/shareat-shared/pos2.env && chmod 600 /srv/shareat-shared/pos2.env
ls -l /srv/shareat-shared/pos2.env; cut -d= -f1 /srv/shareat-shared/pos2.env
```
Good: mode `-rw-------`, owner `shareat`, and exactly three names: `POS_FIREBASE_SA_KEY_FILE`, `DATABASE_URL`, `POS_ORG_ID`. Fix duplicates or blanks before moving on.

---

## 3. Apply the PR #103 server changes (unit, sudoers, Caddy, pos.log)

PR #103 changed: the unit file (`EnvironmentFile=` line), `/etc/sudoers.d/shareat-deploy` (allow restarting `shareat-pos`), the Caddy `pos2.shareat.net` block, and `/var/log/shareat/pos.log`. Use the results from step 0.2 (a-e).

**Decision rule. Who: orchestrator.**
- If 0.2 shows ALL of (a)-(e) already in place: skip to step 4.
- Otherwise use **Option A** unless one of the safety checks below fails. Then use **Option B**.

**Why re-running `provision.sh` is mostly safe:** it is idempotent. It only (1) re-creates directories and sets owners, (2) rewrites the sudoers file, checked with `visudo -cf`, (3) re-installs every `shareat-*.service`/`.timer` file from the repo and runs `daemon-reload`, and (4) tries to install the Postgres 18 client from the internet (non-fatal; skip-if-present). It ENABLES NOTHING and starts nothing. It does not touch `.env.local`.

**Why it can be unsafe: the Caddy part.** If you pass the domain it OVERWRITES the whole `/etc/caddy/Caddyfile` with an `erp2.shareat.net` block plus the `pos2.shareat.net` block. If the live Caddyfile has anything else in it, that is lost. If you omit the domain, it leaves Caddy alone (so the pos2 block is NOT added). And `scp -r` into an existing `/root/shareat-ops` nests instead of merging, so the old copy runs (DEF-194).

**Safety check before Option A. Who: orchestrator. Where: laptop.**
```
ssh root@159.223.46.224 'cat /etc/caddy/Caddyfile'
```
Good for Option A with the domain: the file holds ONLY an `erp2.shareat.net { reverse_proxy 127.0.0.1:9008 }` block (and maybe the pos2 block). If anything else is in there, use Option B for Caddy.

### Option A: re-run provision.sh (from the repo on the laptop)

Use the repo at the commit that includes PR #103 (current `main`). In the repo root:
```
ssh root@159.223.46.224 'rm -rf /root/shareat-ops'
scp -r docs/ops root@159.223.46.224:/root/shareat-ops
```
Then ONE of these:
- Caddyfile has no pos2 block and passed the safety check: `ssh root@159.223.46.224 'bash /root/shareat-ops/provision.sh erp2.shareat.net'`
- Caddy already has the pos2 block, or the safety check failed: `ssh root@159.223.46.224 'bash /root/shareat-ops/provision.sh'` (no domain argument; Caddy untouched)

Note: it can take a minute or two while it checks the Postgres client. A WARNING line about `postgresql-client-18` is non-fatal.

After either run, verify. Where: laptop.
```
ssh root@159.223.46.224 'cat /etc/sudoers.d/shareat-deploy; grep EnvironmentFile /etc/systemd/system/shareat-pos.service; ls -l /var/log/shareat/pos.log; grep -c pos2 /etc/caddy/Caddyfile; caddy validate --config /etc/caddy/Caddyfile 2>&1 | tail -2; systemctl is-active caddy'
ssh shareat@159.223.46.224 'sudo -n -l'
```
Good:
- The sudoers file lists both `restart shareat-erp.service` and `restart shareat-pos.service`.
- The unit shows `EnvironmentFile=/srv/shareat-shared/pos2.env`.
- `pos.log` is owned by `shareat`.
- The Caddy count is `1` or more and Caddy is `active`.
- `sudo -n -l` (as shareat) lists both restarts.

If `visudo` complains during the run: the old sudoers file is kept (the script stops); tell the orchestrator and use Option B for sudoers. If Caddy `validate` fails: restore with Option B (below) and `systemctl reload caddy`; ERP traffic goes through Caddy, so check `curl -s -o /dev/null -w '%{http_code}\n' https://erp2.shareat.net/sign-in` still prints 200 right away.

### Option B: minimal manual equivalents (server shell)

Do only the pieces that 0.2 showed as missing.

- **Sudoers:**
  ```
  printf '%s\n' 'shareat ALL=(root) NOPASSWD: /usr/bin/systemctl restart shareat-erp.service' 'shareat ALL=(root) NOPASSWD: /usr/bin/systemctl restart shareat-pos.service' > /etc/sudoers.d/shareat-deploy.new
  visudo -cf /etc/sudoers.d/shareat-deploy.new && chmod 440 /etc/sudoers.d/shareat-deploy.new && mv /etc/sudoers.d/shareat-deploy.new /etc/sudoers.d/shareat-deploy
  ```
  (Check first with `cat /etc/sudoers.d/shareat-deploy` that there are no other lines that the repo's file does not have.)
- **Log file:**
  ```
  touch /var/log/shareat/pos.log && chown shareat:shareat /var/log/shareat/pos.log && chmod 640 /var/log/shareat/pos.log
  ```
- **Unit file:** copy just that one file from the laptop, then reload.
  ```
  scp docs/ops/shareat-pos.service root@159.223.46.224:/etc/systemd/system/shareat-pos.service
  ssh root@159.223.46.224 'chmod 644 /etc/systemd/system/shareat-pos.service && systemctl daemon-reload'
  ```
- **Caddy:** append this block to `/etc/caddy/Caddyfile` (only if `grep -c pos2` is 0), then validate and reload:
  ```
  cp /etc/caddy/Caddyfile /root/Caddyfile.bak.$(date +%Y%m%d%H%M)
  cat >> /etc/caddy/Caddyfile <<'EOF'

  pos2.shareat.net {
    encode zstd gzip
    request_body {
      max_size 1MB
    }
    reverse_proxy 127.0.0.1:9009
  }
  EOF
  caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy
  ```
  Good: `Valid configuration`, then `curl -s -o /dev/null -w '%{http_code}\n' https://erp2.shareat.net/sign-in` still 200. Caddy needs the DNS record for `pos2.shareat.net` (checked 29 Oct, `nslookup pos2.shareat.net` = 159.223.46.224) to fetch its certificate. If the certificate is slow, see `journalctl -u caddy -n 50`.

---

## 4. Start POS v2 (server shell)

**4.1 Start it. Who: orchestrator.**
```
systemctl daemon-reload
systemctl enable --now shareat-pos
sleep 8
systemctl is-active shareat-pos
journalctl -u shareat-pos -n 30 --no-pager
tail -n 20 /var/log/shareat/pos.log
```
Good: `active`; the journal shows `next start` listening on 127.0.0.1:9009 and no crash/restart loop. If it prints `activating`/`failed` or restarts every 5 s: `systemctl stop shareat-pos` and read the journal. Common causes: `/srv/shareat/apps/pos` missing (0.3), or `npm` not at `/usr/bin/npm` (**CHECK ON THE DAY**: `which npm`). Then go to section 7 if it cannot be fixed in a few minutes.

**4.2 Local health. Who: orchestrator. Where: server shell.**
```
curl -s http://127.0.0.1:9009/api/pos2/health
```
Good: `{"ok":true,"version":"..."}`. (The health route needs no key, no database.)

**4.3 Public health. Who: orchestrator or Ian. Where: laptop.**
```
curl.exe -s https://pos2.shareat.net/api/pos2/health
```
Good: `{"ok":true,"version":"..."}`. Tablets believe only this answer; without it every tablet reads "offline". If it fails but 4.2 works: Caddy or DNS (step 3, `journalctl -u caddy -n 50`).

**4.4 Unauthenticated refund must be refused. Who: orchestrator. Where: laptop.**
```
curl.exe -s -i -X POST https://pos2.shareat.net/api/pos2/refunds -H "content-type: application/json" -d "{}"
```
Good: `HTTP/... 401` with "Sign in again to continue." If you see `503 POS server is not configured`: section 2 is incomplete (names only: `cut -d= -f1 /srv/shareat-shared/pos2.env`) then `systemctl restart shareat-pos`. If you see 200: STOP and stop the service.

**4.5 Memory check. Who: orchestrator. Where: server shell.**
```
free -m
systemctl show shareat-pos -p MemoryCurrent -p MemoryMax
systemctl show shareat-erp -p MemoryCurrent
curl -s -o /dev/null -w '%{http_code} %{time_total}s\n' https://erp2.shareat.net/sign-in
```
Good: POS well under 768 MB (cap), ERP still answers `200` quickly, and `free -m` leaves headroom on the 4 GB box. Repeat after the first sales and after an hour. If POS climbs toward the cap or the ERP slows: `systemctl stop shareat-pos` and tell the lane. The ERP comes first.

**4.6 Next deploy is fine. Who: orchestrator. Where: GitHub (later).** On the next push to main, `deploy.yml` restarts `shareat-pos` through the sudoers line and health-checks `127.0.0.1:9009/api/pos2/health`. A POS failure there never stops the ERP deploy. **CHECK ON THE DAY**: do not deploy during Lipa trading hours unless needed; a restart drops in-flight refund calls (sales do not use the server).

---

## 5. Manager PINs and the approval permission at Lipa (ERP)

Who: Ian (an ERP administrator). Where: ERP admin screens at https://erp2.shareat.net.

For each Lipa manager who will approve refunds / corrections / unpaid-table voids:
1. Sign in as an administrator. Open the **Staff** page (people list) and open the manager.
2. Make sure the manager has an ERP PIN (set or reset it there; the PIN is typed on the screen, never pasted in chat).
3. Give the manager the permission "approve a POS refund or correction" (capability `approve_pos_correction`) at **Lipa**, either by the access-defaults grid or by a hand grant on the person. It is NOT given by default. Administrators hold it implicitly.
   **CHECK ON THE DAY**: the exact menu labels (Staff > person > Access / permissions, or Settings > access defaults) were not confirmed from the repo. Look for the permission by its plain-language name; the codebase has no screen text matching `approve_pos_correction` outside the permission list.

Good: a manager's PIN approves a refund in step 6.8. If the manager's PIN says "not valid": confirm the PIN and the Lipa store grant. Five wrong tries in a day lock the TABLET's approval bucket (runbook section 7.5).

---

## 6. The tablet (ONE Lipa tablet first)

**6.1 Download the signed APK. Who: Ian. Where: laptop browser (signed in to GitHub).**
1. Open the repo's **Actions** tab on GitHub > workflow **CI** > the latest run on branch **main** with a green tick.
2. Scroll to **Artifacts** at the bottom of the run summary. Download **`pos-v2-<run number>.apk`** (the artifact name in `app-build.yml` is `pos-v2-<run number>.apk`; it downloads as a .zip with the .apk inside). Unzip it.
3. Use only this CI-built release APK. NEVER a debug build, and never an older APK over a newer one.

Good: one `.apk` file. If there is no artifact: the signing secrets were not available to that run (the gate skips instead of failing). **CHECK ON THE DAY**: pick a different main run, or ask the orchestrator to check the `Signing gate` step.
Ian confirms the file name and size before sending it to the tablet (a download needs his word).

**6.2 Put it on the tablet. Who: Ian. Where: tablet.**
Move the .apk by USB cable, Drive, or similar. On the tablet: open the file > Install (allow "install unknown apps" for that file manager if asked). Good: the app installs and opens. If it says it conflicts with an installed app of the same name: do NOT uninstall if the tablet holds unsent sales (runbook 12). **CHECK ON THE DAY**: use a tablet that has not been used for v2 before.

**6.3 Sign in the current way. Who: Ian / the Lipa manager. Where: tablet.**
Sign in with the Lipa store's Firebase email and PIN, as on v1. T-464 pairing is not wired; ignore any pairing screen if one appears. Good: the menu / today's screens load. If sign-in fails: check the network on the tablet; nothing on the server is involved in sign-in.

**6.4 Read the device id. Who: Ian. Where: tablet.**
**Settings > Terminal > device id > Copy** (it copies to the clipboard; paste it into a note or message to the orchestrator; a device id is not a secret).

**6.5 Link the tablet to Lipa's terminal person. Who: an ERP administrator (Ian) or the orchestrator on his word. Where: a laptop with the repo and ERP database access (not the droplet).**
Facts needed (find, do not guess):
- `--store=LIPA` (the ERP store code; **CHECK ON THE DAY** that it is `LIPA`).
- The tablet's **terminal person id**: if Lipa's tablet already has an ERP terminal person (the clock terminal), use that id. If not, create it first: `npm run provision-terminal -- --store=LIPA --uid=<firebase uid of the store's tablet login> --confirm` (it prints "terminal person id"). **CHECK ON THE DAY** whether Lipa already has one (skip the create if so).
- `--admin=` the administrator's person id (Ian's, in his own ERP company; the capability needed is `provision_clock_terminal`).
- `--terminal-no=` a whole number 1-99 (use `1` for the first tablet).

Dry run first (prints the plan, writes nothing):
```
npm run provision-terminal -- --store=LIPA --link-pos-device=<device uuid from 6.4> --terminal-no=1 --terminal-person=<terminal person id> --admin=<admin person id>
```
Read it. If it says REFUSED (store code used by more than one company) add `--org=<company uuid>`. When the plan looks right, run the same line with `--confirm` added at the end.
Good: "DRY RUN - nothing was written" on the first, a success line on the second. Re-linking later revokes the store's previous link. If an error: send the error text, not the ids, to the orchestrator.

The device id changes on EVERY APK re-install, so this step must be redone after each re-install.

**6.6 Printer pairing and one test receipt. Who: Ian / Lipa staff. Where: tablet.**
Pair the receipt printer in the app's printer settings (Bluetooth pairing on the tablet first if needed), then print a test receipt. **CHECK ON THE DAY**: the exact menu name for printer pairing in today's screens. Good: a test receipt prints. If not: unpair/re-pair; no server involved.

**6.7 One real test sale. Who: Lipa manager with Ian watching. Where: tablet.**
Ring one small cash sale on this tablet (and ONLY on this tablet; see the trial rule in section 7). Good: the receipt prints and the sale appears in v1's views (v1's Firebase format, project `shareat-hub-v2`) as a normal sale. **CHECK ON THE DAY**: where Ian looks to confirm it (the v1 POS/sales screen or Firestore receipts for Lipa). Note the receipt number.

**6.8 Void / refund path. Who: Lipa manager with Ian. Where: tablet + ERP.**
Do only what Ian allows on the day:
- Refund the test sale: needs the internet, a manager PIN (from step 5), and this tablet linked (6.5). Good: refund goes through and the receipt shows an approver.
- Void an unpaid table: needs the internet, a manager PIN.
Failure messages:
- "This tablet is not registered for approvals yet": redo 6.5 with the current device id.
- "Sign in again": the Firebase project mismatch (check 1.3).
- "Cannot reach the POS server": check 4.3.
- The tablet is capped after 5 wrong PINs in a day: wait 24 h or an administrator clears it (runbook 7.5).

**6.9 X-reading. Who: Lipa manager. Where: tablet.**
Run an X-reading (cash control, not a BIR document) and check the count matches the test sale(s). **CHECK ON THE DAY**: the menu path in today's screens (Settings > Unsent sales > Print X-slip is the offline one; the regular X-reading is in the cash / end-of-shift area). Good: the figures equal what was rung.

**6.10 Before leaving it. Who: Ian.** Settings > Unsent sales must say `Unsent sales: 0`. Other Lipa tablets stay on v1.

---

## 7. Rollback, and the trial rule

**Trial rule: ring each sale on ONE app only.** Never ring the same sale on v1 and v2. Lipa's one v2 tablet takes the sales it takes; every other Lipa tablet stays on v1. If a customer's sale has to be repeated, void the first one properly in the app that rang it before ringing it again.

**To switch POS v2 off (v1 keeps working untouched):**
```
ssh root@159.223.46.224 'systemctl stop shareat-pos && systemctl disable shareat-pos && systemctl is-active shareat-pos'
```
Good: prints `inactive`. Effect: tablets' refund, correction and online-void buttons say they cannot reach the POS server and change nothing. Sales, offline payment and the offline void do not use the server and continue. The ERP and v1 are not affected. Do NOT enable v1's own refund path: it is the hole this closes.

**To put the Lipa tablet back on v1:**
1. Settings > Unsent sales must say `Unsent sales: 0`. If not, connect it to the internet and wait for them to send. NEVER uninstall or clear data while the count is above 0.
2. Ring sales on the v1 tablet/app again.

**To undo the config changes (only if asked):** `mv /srv/shareat-shared/pos2.env /root/pos2.env.off`; to revoke the key, delete it in Firebase console > Project settings > Service accounts > Manage service account permissions > the key. Caddy: restore `/root/Caddyfile.bak.*` and `systemctl reload caddy`.

**Stop and call the lane if:** the ERP slows down or its memory drops (4.5); `shareat-pos` loops in restart; any step prints a surprise `200` where 401 is expected; any key or URL appears in your terminal output.

---

## Open items for the day (summary)

1. Is `shareat-pos.service` already installed on the box, and does the Caddyfile already have a pos2 block (step 0.2)? Decides Option A vs B.
2. Exact ERP menu labels for the manager PIN and `approve_pos_correction` grant (step 5).
3. Lipa's store code (`LIPA`), whether its terminal person exists, and the admin person id (6.5).
4. Printer pairing and X-reading menu names in today's screens (6.6, 6.9).
5. Latest main run has a signed APK artifact (6.1).
6. Where Ian checks that a v2 sale shows up in v1 (6.7).
7. `/usr/bin/npm` exists and the ssh user is `root` (the repo's README uses `root@`; `shareat@` is key-only deploy login).
