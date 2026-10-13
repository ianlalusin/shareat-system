# Nightly pg_dump of shareat-system-db (DO managed Postgres 18) to this PC.
# Password comes from %APPDATA%\postgresql\pgpass.conf — never stored in this file.
param(
    [string]$DbHost    = 'shareat-system-db-do-user-39783702-0.m.db.ondigitalocean.com',
    [int]$Port         = 25060,
    [string]$DbUser    = 'doadmin',
    [string]$Database  = 'defaultdb',
    [string]$BackupDir = 'C:\Backups\shareat-system-db',
    [int]$KeepDays     = 30
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $BackupDir | Out-Null
$log = Join-Path $BackupDir 'backup.log'
function Log($msg) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $msg" | Tee-Object -FilePath $log -Append }

# Locate pg_dump 18+ (PATH first, then the default EDB install folders)
$pgBin = $null
$onPath = Get-Command pg_dump.exe -ErrorAction SilentlyContinue
if ($onPath) { $pgBin = Split-Path $onPath.Source }
if (-not $pgBin) {
    $pgBin = Get-ChildItem 'C:\Program Files\PostgreSQL\*\bin\pg_dump.exe' -ErrorAction SilentlyContinue |
        Sort-Object { [int]$_.Directory.Parent.Name } -Descending | Select-Object -First 1 | ForEach-Object { $_.DirectoryName }
}
if (-not $pgBin) { Log 'FAIL pg_dump.exe not found - install PostgreSQL 18 command line tools'; exit 1 }
$pgDump    = Join-Path $pgBin 'pg_dump.exe'
$pgRestore = Join-Path $pgBin 'pg_restore.exe'

$stamp = Get-Date -Format 'yyyy-MM-dd_HHmm'
$out   = Join-Path $BackupDir "shareat-system-db_$stamp.dump"
$tmp   = "$out.partial"
$env:PGSSLMODE = 'require'

try {
    & $pgDump -h $DbHost -p $Port -U $DbUser -d $Database -Fc --no-password -f $tmp 2>> $log
    if ($LASTEXITCODE -ne 0) { throw "pg_dump exit code $LASTEXITCODE" }

    # Verify the archive is readable before trusting it
    & $pgRestore --list $tmp > $null 2>> $log
    if ($LASTEXITCODE -ne 0) { throw "pg_restore --list failed on the new dump" }

    Move-Item $tmp $out -Force
    $mb = [math]::Round((Get-Item $out).Length / 1MB, 1)
    Log "OK   $out ($mb MB)"
}
catch {
    Remove-Item $tmp -ErrorAction SilentlyContinue
    Log "FAIL $_"
    exit 1
}

# Prune old dumps, but always keep the 7 newest regardless of age
Get-ChildItem $BackupDir -Filter 'shareat-system-db_*.dump' | Sort-Object LastWriteTime -Descending |
    Select-Object -Skip 7 | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$KeepDays) } |
    ForEach-Object { Remove-Item $_.FullName; Log "PRUNE $($_.Name)" }
