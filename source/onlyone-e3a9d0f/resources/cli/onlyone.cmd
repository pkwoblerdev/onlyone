@echo off
setlocal
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\..\onlyone.exe" "%~dp0onlyone.cjs" %*
exit /b %ERRORLEVEL%
