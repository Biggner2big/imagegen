@echo off
setlocal
cd /d "%~dp0"
title GEMINI BULK IMAGE STUDIO - BUILD

set ELECTRON_RUN_AS_NODE=

where node >nul 2>nul
if errorlevel 1 goto no_node

if exist node_modules goto build

echo [*] Installing dependencies...
call npm install
if errorlevel 1 goto install_failed

:build
rem Keep temporary files inside the project: NSIS cannot always create its
rem temporary files in the default Windows temp folder on locked-down machines.
if not exist ".cache\temp" mkdir ".cache\temp"
set "TEMP=%CD%\.cache\temp"
set "TMP=%CD%\.cache\temp"

echo [*] Building Windows installer...
call npm run build
if errorlevel 1 goto build_failed

echo.
echo [*] Installer at: dist\Gemini Bulk Image Studio Setup 2.0.0.exe
pause
goto done

:no_node
echo [!] Node.js 20+ required. Install from https://nodejs.org
pause
exit /b 1

:install_failed
echo [X] npm install failed
pause
exit /b 1

:build_failed
echo.
echo [X] Build failed.
echo     If it failed while extracting winCodeSign with
echo     "Cannot create symbolic link", enable Windows Developer Mode
echo     or run BUILD.bat as Administrator, then try again.
pause
exit /b 1

:done
endlocal
