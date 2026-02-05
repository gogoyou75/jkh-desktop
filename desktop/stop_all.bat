@echo off
echo ===============================
echo STOP JKH / PYTHON / PORT 8765
echo ===============================

REM --- Остановить JKH.exe ---
taskkill /F /IM JKH.exe >nul 2>&1

REM --- Остановить Python процессы ---
taskkill /F /IM python.exe >nul 2>&1
taskkill /F /IM pythonw.exe >nul 2>&1
taskkill /F /IM waitress-serve.exe >nul 2>&1

REM --- Освободить порт 8765 ---
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :8765') do (
    taskkill /F /PID %%a >nul 2>&1
)

echo.
echo DONE. All processes stopped.
echo Port 8765 should be free now.
echo.
pause
