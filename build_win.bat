@echo off
setlocal

cd /d %~dp0

echo === JKH BUILD (Python 3.8 ONLY) ===
py -3.8 --version
if errorlevel 1 (
  echo ERROR: Python 3.8 not found. Install Python 3.8.x and ensure 'py -3.8' works.
  pause
  exit /b 1
)

if not exist requirements.txt (
  echo ERROR: requirements.txt not found in %cd%
  pause
  exit /b 1
)

if not exist launcher.py (
  echo ERROR: launcher.py not found in %cd%
  pause
  exit /b 1
)

if not exist build\JKH.spec (
  echo ERROR: build\JKH.spec not found in %cd%\build
  echo Put the correct JKH.spec into build\JKH.spec
  pause
  exit /b 1
)

echo Cleaning old build/dist...
if exist build\__pycache__ rmdir /s /q build\__pycache__
if exist build\JKH rmdir /s /q build\JKH
if exist dist rmdir /s /q dist

echo Installing deps (pinned for Win7 compatibility)...
py -3.8 -m pip install --upgrade pip
py -3.8 -m pip install -r requirements.txt

echo === Building with PyInstaller ===
py -3.8 -m PyInstaller build\JKH.spec

echo.
echo DONE. Look in dist\JKH\JKH.exe
pause
