@echo off
setlocal EnableExtensions

set "T3_ROOT=%~dp0"
set "T3_LAUNCHER=%T3_ROOT%scripts\launch-desktop.ps1"
set "T3_POWERSHELL=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
set "T3_MODE=alpha"

if /i "%~1"=="--dev" (
  set "T3_MODE=dev"
  shift
) else if /i "%~1"=="--alpha" (
  set "T3_MODE=alpha"
  shift
) else if /i "%~1"=="--release" (
  set "T3_MODE=release"
  shift
) else if /i "%~1"=="--check" (
  set "T3_MODE=alpha-check"
  shift
) else if /i "%~1"=="--force-build" (
  set "T3_MODE=alpha-force-build"
  shift
) else if /i "%~1"=="--help" (
  goto :help
) else if /i "%~1"=="-h" (
  goto :help
) else if not "%~1"=="" (
  echo Unknown option: %~1
  echo.
  goto :help-error
)

if /i "%T3_MODE%"=="dev" goto :dev
if /i "%T3_MODE%"=="release" goto :release
goto :alpha

:dev
echo Starting T3 Studio in Dev mode with live reload...
pushd "%T3_ROOT%" >nul
call pnpm dev:desktop %*
set "T3_EXIT=%errorlevel%"
popd >nul
if not "%T3_EXIT%"=="0" pause
exit /b %T3_EXIT%

:alpha
if not exist "%T3_LAUNCHER%" (
  echo T3 Studio Alpha could not start because the launcher is missing:
  echo   %T3_LAUNCHER%
  pause
  exit /b 1
)

set "T3_ALPHA_ARGS="
if /i "%T3_MODE%"=="alpha-check" set "T3_ALPHA_ARGS=-Check"
if /i "%T3_MODE%"=="alpha-force-build" set "T3_ALPHA_ARGS=-ForceBuild"
if /i "%~1"=="--check" set "T3_ALPHA_ARGS=-Check"
if /i "%~1"=="--force-build" set "T3_ALPHA_ARGS=-ForceBuild"

echo Starting T3 Studio Alpha from the current source build...
"%T3_POWERSHELL%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%T3_LAUNCHER%" %T3_ALPHA_ARGS%
set "T3_EXIT=%errorlevel%"
if not "%T3_EXIT%"=="0" pause
exit /b %T3_EXIT%

:release
if defined T3_RELEASE_EXE if exist "%T3_RELEASE_EXE%" goto :start-release

for %%P in (
  "%LOCALAPPDATA%\Programs\T3 Code\T3 Code.exe"
  "%LOCALAPPDATA%\Programs\T3 Studio\T3 Studio.exe"
  "%LOCALAPPDATA%\Programs\T3 Studio (Alpha)\T3 Studio (Alpha).exe"
  "%ProgramFiles%\T3 Code\T3 Code.exe"
  "%ProgramFiles%\T3 Studio\T3 Studio.exe"
  "%T3_ROOT%release\win-unpacked\T3 Code.exe"
  "%T3_ROOT%release\win-unpacked\T3 Studio.exe"
  "%T3_ROOT%release\win-unpacked\T3 Studio (Alpha).exe"
) do if exist "%%~P" (
  set "T3_RELEASE_EXE=%%~P"
  goto :start-release
)

echo T3 Studio Release is not installed or could not be found.
echo Install the release, or set T3_RELEASE_EXE to its full executable path.
pause
exit /b 1

:start-release
echo Starting T3 Studio Release...
start "" "%T3_RELEASE_EXE%" %*
exit /b %errorlevel%

:help
echo Usage: Launch-T3Studios.bat [mode] [options]
echo.
echo   no flag       Dev mode (current default; live reload)
echo   --dev         Dev mode (live reload)
echo   --alpha       Alpha smart build from this repository
echo   --release     Installed release version
echo   --check       Check whether the Alpha build is current
echo   --force-build Force rebuild and launch Alpha
echo   --help        Show this help
echo.
echo Set T3_RELEASE_EXE if the installed release is in a custom location.
exit /b 0

:help-error
call :help
exit /b 2
