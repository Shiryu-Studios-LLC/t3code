@echo off
setlocal

set "T3_ROOT=%~dp0"
set "T3_LAUNCHER=%T3_ROOT%Launch-T3Studios.ps1"
set "T3_POWERSHELL=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"

if not exist "%T3_LAUNCHER%" (
  echo T3 Studio could not start because the smart launcher is missing:
  echo   %T3_LAUNCHER%
  pause
  exit /b 1
)

if /i "%~1"=="--check" (
  "%T3_POWERSHELL%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%T3_LAUNCHER%" -Check
  exit /b %errorlevel%
)

start "T3 Studio" "%T3_POWERSHELL%" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "%T3_LAUNCHER%"
endlocal
