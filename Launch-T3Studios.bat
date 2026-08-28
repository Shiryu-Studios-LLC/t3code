@echo off
setlocal

set "T3_ROOT=%~dp0"
set "T3_ELECTRON=%T3_ROOT%apps\desktop\node_modules\electron\dist\electron.exe"
set "T3_MAIN=%T3_ROOT%apps\desktop\dist-electron\main.cjs"

if not exist "%T3_ELECTRON%" (
  echo T3 Studio could not start because Electron is missing:
  echo   %T3_ELECTRON%
  echo.
  echo Open PowerShell in %T3_ROOT% and run: pnpm install
  pause
  exit /b 1
)

if not exist "%T3_MAIN%" (
  echo T3 Studio could not start because the desktop build is missing:
  echo   %T3_MAIN%
  echo.
  echo Open PowerShell in %T3_ROOT% and run: pnpm build:desktop
  pause
  exit /b 1
)

if /i "%~1"=="--check" (
  echo T3 Studio launcher check passed.
  echo Electron: %T3_ELECTRON%
  echo App:      %T3_MAIN%
  exit /b 0
)

set "ELECTRON_RUN_AS_NODE="
cd /d "%T3_ROOT%"
start "T3 Studio" "%T3_ELECTRON%" "%T3_MAIN%"

if errorlevel 1 (
  echo T3 Studio failed to launch.
  pause
  exit /b 1
)

endlocal
