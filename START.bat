@echo off
setlocal
cd /d "%~dp0"
title GEMINI BULK IMAGE STUDIO

rem Some tools export ELECTRON_RUN_AS_NODE=1; Electron must start as a GUI app.
set ELECTRON_RUN_AS_NODE=

where node >nul 2>nul
if errorlevel 1 goto no_node

if exist node_modules goto start

echo [*] Installing dependencies...
call npm install --no-audit --no-fund
if errorlevel 1 goto install_failed

:start
echo [*] Starting app...
call npx electron .
if not "%ERRORLEVEL%"=="0" goto fallback
goto done

:fallback
echo.
echo [!] Normal launch failed. This usually means this environment blocks
echo     Chromium's sandbox or the default Windows profile folder.
echo [*] Retrying in development fallback mode - local profile, no OS sandbox...
set GBS_DISABLE_SINGLE_INSTANCE=1
set GBS_USER_DATA_DIR=%CD%\data\dev-profile
call npx electron . --no-sandbox
if not "%ERRORLEVEL%"=="0" (
  echo [X] App exited with error
  pause
)
goto done

:no_node
echo [!] Node.js 20+ required. Install from https://nodejs.org
pause
exit /b 1

:install_failed
echo [X] npm install failed
pause
exit /b 1

:done
endlocal
