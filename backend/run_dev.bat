@echo off
setlocal

REM === JKH Desktop DEV launcher ===
cd /d "%~dp0"

REM Проверка Python
python --version >nul 2>&1
if errorlevel 1 (
  echo Python not found in PATH
  pause
  exit /b 1
)

REM Установка зависимостей (один раз или при обновлении)
pip install -r requirements.txt

REM Запуск сервера
python launcher.py

pause
