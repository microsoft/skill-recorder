@echo off
chcp 65001 >nul 2>&1
setlocal
title Skill Recorder Stopper
echo ==============================================================
echo   Stopping Skill Recorder (only this project's processes)...
echo ==============================================================
echo.

REM Match by command line so we only kill Electron/node processes spawned
REM from this project directory - NOT other Electron apps like VS Code/Discord.
powershell -NoProfile -Command "$procs = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*skill-recorder*' -and $_.Name -notmatch 'cmd.exe|powershell.exe|conhost.exe' }; if ($procs.Count -eq 0) { Write-Output '  No running Skill Recorder processes found' } else { foreach ($p in $procs) { try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; Write-Output ('  Stopped ' + $p.Name + ' (PID ' + $p.ProcessId + ')') } catch { Write-Output ('  Skipped ' + $p.Name + ' (PID ' + $p.ProcessId + ')') } } }"

echo.
echo   Done. You can close this window.
pause >nul
