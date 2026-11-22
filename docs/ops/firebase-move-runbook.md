# Firebase move runbook (T-625): ERP v2 leaves the shared v1 projects and uses its own project, `shareat-system`

For Ian. Plain steps, in order. Spec: `docs/tasks/625-own-firebase-project.md`.

**What moves:** sign-in accounts (email accounts and store terminal accounts), the files behind `stored_files` (staff photos, receipts), and the clock Firestore. Everyone keeps the same password. Nothing in Postgres changes.

**What does NOT move:** POS and CUSTOMER stay on `shareat-hub-v2`. Do not touch `/srv/shareat-shared/pos2.env` and do not touch any `POS_*` or `CAPTURE_*` line. The tablets sign into `shareat-hub-v2` and must keep doing so.

**Two machines.** Steps marked **LAPTOP** run in PowerShell on your PC, in `C:\Users\ianla\webapps\shareat-system`. Steps marked **DROPLET** run on the server (`159.223.46.224`, never `159.223.78.207`) after you log in with:

```powershell
ssh root@159.223.46.224
```

**Rules for the whole day**
- Never paste a key, a password hash or a password into chat. Files are named by path only.
- The old accounts and the old bucket are never deleted in this runbook. They are your way back.
- If any step prints something you did not expect, stop and ask BOSS. Do not carry on.

---

## 0. Before the night (can be done any day, nothing breaks)

### 0.1 BOSS merges and deploys the code (new scripts must be on the droplet)
Nothing changes for staff: the env values are not touched yet. Check the scripts arrived, on the **DROPLET**:

```bash
ls /srv/shareat/scripts/firebase-move
```

You should see `select-uids.ts`, `filter-export.ts`, `copy-files.ts`, `verify.ts` (plus `lib.ts`, `db.ts`, `admin.ts`).

### 0.2 Check the new project is ready (Firebase console, `shareat-system`)
- Authentication: Email/Password is on.
- Firestore: a database called `(default)` exists. If not, create it (same region as the stores' tablets, Asia is fine).
- Storage: the bucket `shareat-system.firebasestorage.app` exists.
- Project settings, "Your apps": a **Web app** exists. If not, click "Add app", choose Web, name it `ERP`. You need its config values in step 3.1.

### 0.3 Deploy the rules to the new project (**LAPTOP**)
This only touches `shareat-system`. The file `firebase/storage.rules` closes the bucket to every browser (the server still reaches it).

```powershell
cd C:\Users\ianla\webapps\shareat-system\firebase
```

```powershell
firebase deploy --only firestore,storage --project shareat-system
```

It should end with `Deploy complete!`.

### 0.4 Put the new key on the server (**LAPTOP**, needs Git for Windows' `bash`)
Use the real file name from `C:\Users\ianla\webapps\PK\shareat-system\`. It checks the key belongs to `shareat-system`, copies it, and prints a short code from each side. The two codes must be the same.

```powershell
bash docs/ops/install-firebase-key.sh /c/Users/ianla/webapps/PK/shareat-system/<the key file name>.json
```

### 0.5 Practice runs (read-only, **DROPLET**)
They print counts and change nothing. Write the numbers down.

```bash
cd /srv/shareat && sudo -u shareat env NODE_ENV=production npx tsx scripts/firebase-move/select-uids.ts
```

Expect `N live firebase credential(s)`. If it says zero or fails on `SYSTEM_DATABASE_URL`, stop.

Find the OLD key path (it is a path, not a secret):

```bash
grep -m1 '^FIREBASE_SERVICE_ACCOUNT_KEY_FILE=' /srv/shareat-shared/.env.local
```

Now the file copy practice. Replace `<old key path>` with what you saw after the `=`:

```bash
cd /srv/shareat && sudo -u shareat env NODE_ENV=production npx tsx scripts/firebase-move/copy-files.ts --from-key=<old key path> --to-key=/srv/shareat-shared/secrets/shareat-system-admin.json --from-bucket=shareat-hub-v2 --to-bucket=shareat-system.firebasestorage.app
```

Expect `would copy` equal to the file count and `MISSING in old bucket 0`. A MISSING number above 0 means a database row points at a file that is not in the old bucket. Stop and tell BOSS which row ids it printed.

> **Tip:** you can run the real copy (step 4.4) days ahead. It only adds files and skips ones already there, so on the night it only copies what is new.

---

## 1. The night (stores closed, nobody signing in)

### 1.1 Before you start
- Tell the stores: no clock punches and no ERP use during the window.
- Every clock tablet must be online for a minute so its punches reach the server.

### 1.2 Stop new sync, and empty the clock inbox (**DROPLET**)
Run it twice. The second run must show the inbox line with `posted 0`.

```bash
cd /srv/shareat && sudo -u shareat env NODE_ENV=production npm run firestore-relay -- --manual
```

```bash
cd /srv/shareat && sudo -u shareat env NODE_ENV=production npm run firestore-relay -- --manual
```

Now stop the 2-minute timer. It stays off until step 7.

```bash
systemctl stop shareat-firestore-relay.timer
```

```bash
systemctl is-active shareat-firestore-relay.timer
```

It must say `inactive`.

### 1.3 Save the list of accounts to move (**DROPLET**)
Writes one account id per line. It prints only a count.

```bash
cd /srv/shareat && sudo -u shareat env NODE_ENV=production npx tsx scripts/firebase-move/select-uids.ts --confirm --out=/srv/shareat-shared/secrets/uids.txt
```

Copy it to your laptop (run this on the **LAPTOP**):

```powershell
scp root@159.223.46.224:/srv/shareat-shared/secrets/uids.txt C:\Users\ianla\uids.txt
```

### 1.4 Export the old accounts (**LAPTOP**)
This file holds password hashes. Treat it like a key. Never commit it.

```powershell
firebase auth:export C:\Users\ianla\old-users.json --format=json --project studio-7300228488-a394e
```

### 1.5 Cut it down to the live accounts (**LAPTOP**)
Practice first (prints counts only):

```powershell
npx tsx scripts/firebase-move/filter-export.ts --in=C:\Users\ianla\old-users.json --uids=C:\Users\ianla\uids.txt
```

Expect `kept` equal to `uids wanted` and `wanted but NOT in export: 0`. If the last number is above 0, stop and ask BOSS.

Then write it:

```powershell
npx tsx scripts/firebase-move/filter-export.ts --in=C:\Users\ianla\old-users.json --uids=C:\Users\ianla\uids.txt --confirm --out=C:\Users\ianla\new-users.json
```

### 1.6 Import the accounts, keeping their passwords (**LAPTOP**)
Firebase needs the OLD project's password settings. Get them in the Firebase console of the OLD project (`studio-7300228488-a394e`): Authentication, Users tab, the three-dots menu at the top right, "Password hash parameters". It shows `base64_signer_key`, `base64_salt_separator`, `rounds` and `mem_cost`.

Type them straight into the command below. Do not paste them in chat or save them anywhere.

```powershell
firebase auth:import C:\Users\ianla\new-users.json --project shareat-system --hash-algo=SCRYPT --hash-key="<base64_signer_key>" --salt-separator="<base64_salt_separator>" --rounds=8 --mem-cost=14
```

(Use the `rounds` and `mem_cost` numbers the console shows if they differ from 8 and 14.)

It should say it imported N users with no errors. N must equal the count from step 1.3.

**If the import fails or logins fail later:** the fallback is to create the accounts fresh and send password-reset emails, and you set new terminal passwords by hand. Ask BOSS before doing this.

### 1.7 Copy the files (**DROPLET**)
Practice (no bytes move):

```bash
cd /srv/shareat && sudo -u shareat env NODE_ENV=production npx tsx scripts/firebase-move/copy-files.ts --from-key=<old key path> --to-key=/srv/shareat-shared/secrets/shareat-system-admin.json --from-bucket=shareat-hub-v2 --to-bucket=shareat-system.firebasestorage.app
```

Real copy (it never deletes anything). It checks size and MD5 of every file after copying:

```bash
cd /srv/shareat && sudo -u shareat env NODE_ENV=production npx tsx scripts/firebase-move/copy-files.ts --from-key=<old key path> --to-key=/srv/shareat-shared/secrets/shareat-system-admin.json --from-bucket=shareat-hub-v2 --to-bucket=shareat-system.firebasestorage.app --confirm
```

Expect `failed 0` and `MISSING in old bucket 0`. If it was interrupted, run the same command again: it skips what is already there.

### 1.8 Check everything arrived (**DROPLET**)

```bash
cd /srv/shareat && sudo -u shareat env NODE_ENV=production npx tsx scripts/firebase-move/verify.ts --key=/srv/shareat-shared/secrets/shareat-system-admin.json --bucket=shareat-system.firebasestorage.app --confirm
```

It must end with `verify: OK`. Any gap prints `GAPS FOUND`: stop, do not switch over.

---

## 2. Switch the server to the new project (**DROPLET**)

### 2.1 Back up both env files (the backup is your rollback)

```bash
STAMP=$(date +%Y%m%d%H%M%S); cp -p /srv/shareat-shared/.env.local /root/env.local.bak.$STAMP; cp -p /srv/shareat-shared/customer.env /root/customer.env.bak.$STAMP; echo $STAMP
```

Write the stamp down.

### 2.2 Look at the names in `.env.local` (no values)

```bash
grep -E '^(FIREBASE_|NEXT_PUBLIC_FIREBASE_)' /srv/shareat-shared/.env.local | cut -d= -f1
```

`FIREBASE_SERVICE_ACCOUNT_KEY` (the one-line form) must NOT be in the list, because setting both forms is refused. If it is, ask BOSS before going on.

### 2.3 Change the three values in `.env.local`

```bash
sed -i -e 's|^FIREBASE_PROJECT_ID=.*|FIREBASE_PROJECT_ID=shareat-system|' -e 's|^FIREBASE_SERVICE_ACCOUNT_KEY_FILE=.*|FIREBASE_SERVICE_ACCOUNT_KEY_FILE=/srv/shareat-shared/secrets/shareat-system-admin.json|' -e 's|^FIREBASE_STORAGE_BUCKET=.*|FIREBASE_STORAGE_BUCKET=shareat-system.firebasestorage.app|' /srv/shareat-shared/.env.local
```

Check (shows the three lines, no secrets in them):

```bash
grep -E '^(FIREBASE_PROJECT_ID|FIREBASE_SERVICE_ACCOUNT_KEY_FILE|FIREBASE_STORAGE_BUCKET)=' /srv/shareat-shared/.env.local
```

Each must show once, with the new values. If a line was missing, `sed` changed nothing for it: add it by hand with `nano /srv/shareat-shared/.env.local`.

### 2.4 The customer lobby file: only the project and key

```bash
sed -i -e 's|^FIREBASE_PROJECT_ID=.*|FIREBASE_PROJECT_ID=shareat-system|' -e 's|^FIREBASE_SERVICE_ACCOUNT_KEY_FILE=.*|FIREBASE_SERVICE_ACCOUNT_KEY_FILE=/srv/shareat-shared/secrets/shareat-system-admin.json|' /srv/shareat-shared/customer.env
```

```bash
grep -E '^(FIREBASE_PROJECT_ID|FIREBASE_SERVICE_ACCOUNT_KEY_FILE)=' /srv/shareat-shared/customer.env
```

### 2.5 Check permissions are still tight

```bash
ls -l /srv/shareat-shared/.env.local /srv/shareat-shared/customer.env /srv/shareat-shared/secrets/shareat-system-admin.json
```

Each shows `-rw-------` and owner `shareat`.

---

## 3. The five browser values (GitHub secrets) and the rebuild

The browser values are baked in when the app is built, so changing them needs a rebuild, not just a restart.

### 3.1 Read the five values (Firebase console, `shareat-system`)
Project settings, "Your apps", the Web app, "SDK setup and configuration", "Config". You need `apiKey`, `authDomain`, `projectId`, `appId`.

### 3.2 Set the GitHub secrets
GitHub, the shareat-system repo, Settings, Secrets and variables, Actions. Edit these five (paste each value with no spaces before or after, and no new line):

| Secret | Value |
|---|---|
| `NEXT_PUBLIC_FIREBASE_API_KEY` | the `apiKey` |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | the `authDomain` |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | `shareat-system` |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | the `appId` |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` | **leave it EMPTY** (delete the secret, or set it blank) |

Why the bucket one stays empty: nothing in the app reads it, and the storage check refuses the same value in both places.

### 3.3 Rebuild and restart
Ask BOSS to start a deploy (a push to main, or "Re-run all jobs" on the latest Deploy run in GitHub Actions). The deploy restarts `shareat-erp`. Wait for it to go green. Do not build on the server.

Then restart the lobby app, on the **DROPLET**:

```bash
systemctl restart shareat-customer
```

---

## 4. Turn the clock sync back on

### 4.0 The database helper (only needed for step 4.1)
Paste this once as one block on the **DROPLET** (a new login forgets it). It runs one SQL statement as the admin login and prints the result:

```bash
asql() {
  U="$(grep -m1 '^SYSTEM_DATABASE_URL=' /srv/shareat-shared/.env.local | cut -d= -f2- | tr -d '\r' | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")"
  (cd "$(readlink -f /srv/shareat)" && DATABASE_URL="$U" node -e "require('postgres')(process.env.DATABASE_URL,{max:1}).unsafe(process.argv[1]).then(r=>{console.log(r);process.exit(0)}).catch(e=>{console.error(e.message);process.exit(1)})" "$1")
  unset U
}
```

### 4.1 Fill the new Firestore (ASK BOSS BEFORE THIS STEP)
The new Firestore is empty. The relay only publishes changes it has queued, so the clock terminals' roster and credentials need the queue refilled. BOSS confirms this step first; the idea is to mark the queue rows as not yet sent so the next relay run publishes the current truth for each row (the relay re-reads the live data, it does not replay old snapshots, and writing the same document twice is safe).

Count first (read-only):

```bash
asql "select count(*) filter (where published_at is null) as waiting, count(*) as total from mirror_outbox"
```

If BOSS says go:

```bash
asql "update mirror_outbox set published_at = null where published_at is not null"
```

### 4.2 Start the timer and run it once by hand

```bash
systemctl start shareat-firestore-relay.timer
```

```bash
cd /srv/shareat && sudo -u shareat env NODE_ENV=production npm run firestore-relay -- --manual
```

No `FAILED OUTRIGHT` line. Run it again until the mirror line shows `posted 0` (everything is published).

### 4.3 Give each clock terminal a new token (the ERP, in a browser)
Tablets hold a sign-in for the OLD project and will not sync until re-paired. In the ERP go to Attendance, Terminals. For each terminal press **Re-pair (new token)**, then put the token into that tablet's pairing screen. The token is shown once.

---

## 5. Smoke tests (do all of them)

**DROPLET:** the storage check. Every line must be a tick:

```bash
cd /srv/shareat && sudo -u shareat env NODE_ENV=production npm run storage-smoke
```

Then, on `https://erp2.shareat.net`:
1. Sign in with your email and your usual password. It works.
2. Open a staff profile that has a photo. The photo shows.
3. Upload a small file (for example a receipt photo on an expense draft). It uploads and opens again.
4. On a store tablet that was re-paired (4.3): sign in with a PIN.
5. Make a clock punch on a terminal. Within about 2 minutes it appears in Attendance.

If any of the five fails, go to Rollback.

---

## 6. Afterwards

- **Delete the secret files** on the laptop and the server (they hold uids and password hashes):

```powershell
Remove-Item C:\Users\ianla\uids.txt, C:\Users\ianla\old-users.json, C:\Users\ianla\new-users.json
```

```bash
rm -f /srv/shareat-shared/secrets/uids.txt
```

- Keep the old bucket, the old accounts and the env backups for at least two weeks. Deleting them is a separate decision for you and BOSS.
- BOSS records the move in the bible and `docs/ops/README.md`.

---

## Rollback (put the old values back)

Nothing in Postgres changed, so going back is just the old settings again.

### R1. Put the old env files back (**DROPLET**)
Use the stamp from step 2.1:

```bash
cp -p /root/env.local.bak.<STAMP> /srv/shareat-shared/.env.local
```

```bash
cp -p /root/customer.env.bak.<STAMP> /srv/shareat-shared/customer.env
```

### R2. Put the old browser values back and rebuild
In GitHub, set the five `NEXT_PUBLIC_FIREBASE_*` secrets back to their old values (from your password manager, or ask BOSS for the notes). Ask BOSS for a deploy (rebuild).

### R3. Restart and re-pair

```bash
systemctl restart shareat-erp shareat-customer
```

Clock terminals: press **Re-pair (new token)** again for each terminal (the tablets now need an OLD-project token).

### R4. Check it works against the old bucket
The storage check refuses the old bucket unless you say it is a rollback:

```bash
cd /srv/shareat && sudo -u shareat env NODE_ENV=production npm run storage-smoke -- --allow-old-bucket
```

### R5. Clock sync
If the relay timer is off, start it:

```bash
systemctl start shareat-firestore-relay.timer
```

Punches made on a tablet while it pointed at the new project stay in Firestore of `shareat-system`. Ask BOSS to drain them before you delete anything.
