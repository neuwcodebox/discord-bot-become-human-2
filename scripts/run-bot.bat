@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..") do set "ROOT_DIR=%%~fI"

cd /d "%ROOT_DIR%"
if errorlevel 1 exit /b %errorlevel%

git pull --ff-only
if errorlevel 1 exit /b %errorlevel%

call npm install
if errorlevel 1 exit /b %errorlevel%

call npm run build
if errorlevel 1 exit /b %errorlevel%

node dist/index.mjs %*
exit /b %errorlevel%
