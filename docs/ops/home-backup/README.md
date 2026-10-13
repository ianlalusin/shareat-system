# Shareat System DB → home PC nightly backup

Dumps `shareat-system-db` (DigitalOcean managed Postgres 18, `defaultdb`) every night to
`C:\Backups\shareat-system-db` on the home PC. It keeps 30 days and never keeps fewer than the 7 newest.
DigitalOcean's own 7-day daily backups keep running too; this is the off-cloud copy.

## One-time setup (on the home PC)

1. **Copy this folder** to the home PC, e.g. `C:\Tools\shareat-db-home-backup`.

2. **Install the PostgreSQL 18 client.** Download the Windows installer from postgresql.org →
   Download → Windows. In the component screen, tick **Command Line Tools** only; no server needed.
   It must be version 18 or newer, because an older `pg_dump` refuses an 18 server.

3. **Allow the home PC's IP to reach the DB.** DO console → Databases → `shareat-system-db` →
   Network Access / Trusted Sources → add your home IP (google "what is my ip" *on the home PC*).
   Keep the existing `shareat-system-prod` entry.
   ⚠️ If your ISP changes your home IP, backups fail with a timeout. Re-add the new IP when that happens.

4. **Store the password** (never in the script). DO console → the database → Connection Details →
   user `doadmin` → copy the password. Then in PowerShell on the home PC:
   ```powershell
   New-Item -ItemType Directory -Force "$env:APPDATA\postgresql" | Out-Null
   notepad "$env:APPDATA\postgresql\pgpass.conf"
   ```
   Paste this single line, with the real password, and save:
   ```
   shareat-system-db-do-user-39783702-0.m.db.ondigitalocean.com:25060:defaultdb:doadmin:PASTE_PASSWORD_HERE
   ```

5. **Test once by hand:**
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\backup.ps1
   ```
   You should see `OK  C:\Backups\shareat-system-db\shareat-system-db_<date>.dump (N MB)`.

6. **Schedule it.** Open PowerShell **as Administrator** in this folder:
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install-task.ps1
   Start-ScheduledTask 'Shareat DB Backup'
   ```
   It runs daily at 02:30, whether or not you are signed in. If the PC was off, it runs as soon as it's back on.

## Checking it
- Log: `C:\Backups\shareat-system-db\backup.log` (one `OK` / `FAIL` line per run).
- Every dump is verified with `pg_restore --list` before it is kept, and failed runs leave no file.

## Restoring (into a fresh/local Postgres 18)
```powershell
createdb -h localhost -U postgres shareat_restore
pg_restore -h localhost -U postgres -d shareat_restore --no-owner --no-privileges C:\Backups\shareat-system-db\<file>.dump
```

## Optional: least-privilege backup user
`doadmin` is full admin. For a read-only backup login, run this once as doadmin, then use
`shareat_backup` in `pgpass.conf` and run `backup.ps1 -DbUser shareat_backup` (edit the task's arguments):
```sql
CREATE ROLE shareat_backup LOGIN PASSWORD '<choose one>';
GRANT pg_read_all_data TO shareat_backup;
```
