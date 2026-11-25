@echo off
setlocal
if not exist "%ProgramFiles%\Git\bin\bash.exe" (
  echo RESULT: BLOCKED - Git Bash is required. No installation was attempted.
  exit /b 2
)
"%ProgramFiles%\Git\bin\bash.exe" "%~dp0cup.sh" "%~1"
exit /b %errorlevel%
