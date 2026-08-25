@echo off
rem Runs the shareat-system daily review headless. Scheduled via Windows Task Scheduler at 04:00.
cd /d C:\Users\ianla\webapps\shareat-system
echo ===== daily review started %date% %time% ===== > .claude\daily-review-last-run.log
claude -p "/daily-review" --model sonnet --dangerously-skip-permissions >> .claude\daily-review-last-run.log 2>&1
echo ===== finished %date% %time% exit %errorlevel% ===== >> .claude\daily-review-last-run.log
