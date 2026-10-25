# POS receipt bridge - runbook (T-472)

The bridge copies every POS receipt from POS's Firebase into our database each night, read-only, from **1 January 2027** (older data is test data, bible row 379). It posts nothing and never writes to Firebase. It checks each day's receipts against the POS day total and says so on the Sales days page.

## 1. The key (Ian)
1. In Google Cloud, project `shareat-hub-v2`: create a service account `pos-receipt-bridge-readonly` with ONLY the role **Cloud Datastore Viewer**, and make a JSON key. (Never the POS v2 server key: that one can write.)
2. Save it as `C:\Users\ianla\shareat-master-data\keys\pos-bridge-reader.json`. Never paste it in chat or commit it.
3. From Git Bash in the repo: `bash docs/ops/install-pos-bridge-key.sh`. It checks the key is for `shareat-hub-v2`, copies it to `/srv/shareat-shared/secrets/pos-bridge-reader.json` (owner `shareat`, mode 600) and prints only a short SHA-256 prefix from both sides, which must match. It never prints the key.

## 2. Heartbeat (Ian)
Create a healthcheck (period 1 day, grace about 2 h) in the backup alert service. On the droplet add `POS_BRIDGE_HEARTBEAT_URL=<url>` to `/srv/shareat-shared/.env.local` (edit with `nano`, never echo it). A clean run pings it, a failed run pings `<url>/fail`. Unset = one log line.

## 3. Install the timer
Ship the code as usual (CI), then on the droplet re-run `docs/ops/provision.sh` (it installs the `.service` and `.timer`), then
`systemctl enable --now shareat-pos-receipt-bridge.timer`. Check with `systemctl is-enabled` and `is-active`. It runs **06:30 Manila** (after the 06:00 day import), `Persistent=true`.

## 4. December dry run
Before 1 January, on the droplet as `shareat`, in `/srv/shareat`:
```
npm run pos-receipt-bridge -- --dry-run                       # reads yesterday only, writes NOTHING (no receipts, checks or run row)
npm run pos-receipt-bridge -- --dry-run --date=2026-12-20     # one named day
```
It prints how many receipts it read and would write, and any problem (a key for the wrong project, a receipt it cannot copy, POS counting more receipts than were read). A LIVE run in December writes nothing either: the 2027-01-01 floor applies to writes only.

## 5. Live from 2 January
The first night that writes is 2 Jan 06:30 (for 1 Jan's sales). A first run reads the whole 7-day window; after that a night reads **yesterday plus any day with no day check yet** (about 8.4k Firestore reads a night, inside the free tier that POS's live traffic shares). A later void, edit or offline sync is picked up by the change-time queries. A `gone` mark is only found on days that are re-read.
Manual run for a named day: `npm run pos-receipt-bridge -- --manual --date=2027-01-05`.

## 6. Reading the result
`scheduler_runs`, job `pos_receipt_bridge` (one row per org per run); the log is `/var/log/shareat/pos-receipt-bridge.log`. A day whose receipts differ from the POS day total shows as one line on the Sales days page ("Receipt check: ...").
