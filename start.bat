@echo off
chcp 65001 >nul 2>&1
setlocal
title Skill Recorder Launcher

REM Project root = this bat's own directory (portable, no hardcoded path)
cd /d "%~dp0"
if errorlevel 1 (
    echo [Error] Cannot locate project directory.
    pause
    exit /b 1
)

REM Verify Node >= 24 (package.json engines hard requirement)
for /f "tokens=* usebackq" %%v in (`node -v 2^>nul`) do set NODE_VER=%%v
if not defined NODE_VER (
    echo [Error] Node.js not found in PATH. Install Node 24+ and retry.
    pause
    exit /b 1
)
set NODE_MAJOR=%NODE_VER:~1,2%
if %NODE_MAJOR% LSS 24 (
    echo [Error] Detected Node %NODE_VER%; Skill Recorder requires Node 24+.
    echo Download Node 24 from https://nodejs.org and add it to PATH.
    pause
    exit /b 1
)

REM Electron binary mirror (faster resolution on some networks)
set "ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/"

echo ==============================================================
echo   Skill Recorder Launcher
echo   Node  : %NODE_VER%
echo   Dir   : %CD%
echo   Mode  : dev (Vite HMR + Electron GUI)
echo ==============================================================
echo.
echo   On first launch the app requests screen-recording / mic access.
echo   Shortcut Ctrl+Shift+R starts/stops recording. Close this window to stop.
echo.

REM Development mode (no pre-build needed, Vite compiles live)
REM For production mode, replace the next line with: npm run start
npm run dev

set "DEV_EXIT=%ERRORLEVEL%"
echo.
echo --------------------------------------------------------------
echo [Skill Recorder] npm run dev exited with code = %DEV_EXIT%
if not "%DEV_EXIT%"=="0" (
    echo Launch failed. See the error / stack trace above.
)
echo Press any key to close...
pause >nul
