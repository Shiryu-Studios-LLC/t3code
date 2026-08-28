@echo off
set ELECTRON_RUN_AS_NODE=
cd /d I:\t3code\apps\desktop
start "T3 Studio" "I:\t3code\apps\desktop\node_modules\electron\dist\electron.exe" "I:\t3code\apps\desktop\dist-electron\main.cjs"
