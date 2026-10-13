# Registers the nightly backup in Task Scheduler. Run once from an elevated PowerShell in this folder.
param([string]$At = '02:30')

$script = Join-Path $PSScriptRoot 'backup.ps1'
$action   = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$script`""
$trigger  = New-ScheduledTaskTrigger -Daily -At $At
# StartWhenAvailable: if the PC was off/asleep at 02:30, run as soon as it is back on
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 15)
# S4U: runs whether or not you are signed in, without storing your Windows password
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited

Register-ScheduledTask -TaskName 'Shareat DB Backup' -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "Registered 'Shareat DB Backup' daily at $At. Test now with:  Start-ScheduledTask 'Shareat DB Backup'"
