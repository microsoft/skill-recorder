@echo off
chcp 65001 >nul 2>&1
setlocal
title Copilot Login (Skill Recorder)

REM Copilot CLI ships with Skill Recorder's dependencies (under node_modules)
set "CLI=%~dp0node_modules\@github\copilot-win32-x64\copilot.exe"

if not exist "%CLI%" (
    echo [Error] Copilot CLI not found: %CLI%
    echo Ensure dependencies are installed (npm ci).
    pause
    exit /b 1
)

echo ==============================================================
echo   GitHub Copilot sign-in (used by Skill Recorder)
echo   Mode: browser OAuth flow (the code is NOT shown in terminal)
echo   Running this opens your browser to the GitHub authorize page.
echo   If it does not open, copy the URL printed below into a browser.
echo   Click "Authorize" in the browser to finish.
echo ==============================================================
echo.

"%CLI%" login

echo.
echo --------------------------------------------------------------
echo Sign-in flow finished. If successful, return to Skill Recorder and use Analyze.
echo Press any key to close...
pause >nul
