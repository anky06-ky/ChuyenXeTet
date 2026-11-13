@echo off
chcp 65001 >nul
cd /d "%~dp0"
title TetLive Studio
where node >nul 2>nul
if errorlevel 1 (
  echo Chua tim thay Node.js. Cai Node.js LTS 22.19 tro len tai https://nodejs.org roi chay lai.
  goto :error
)
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=19)?0:1)"
if errorlevel 1 (
  echo Node.js qua cu. Ket noi TikTok LIVE can Node.js 22.19 tro len.
  goto :error
)
if not exist ".venv\Scripts\python.exe" (
  python -m venv .venv
  if errorlevel 1 goto :error
)
.venv\Scripts\python.exe -m pip install --disable-pip-version-check -r requirements.txt
if errorlevel 1 goto :error
set "NEED_NPM="
if not exist "node_modules\" set "NEED_NPM=1"
if not exist "node_modules\piratetok-live-js\" set "NEED_NPM=1"
if defined NEED_NPM (
  call npm install --no-fund --no-audit
  if errorlevel 1 goto :error
)
call npm run build
if errorlevel 1 goto :error
echo.
echo TetLive Studio: http://127.0.0.1:8000
echo Overlay OBS / TikTok LIVE Studio: http://127.0.0.1:8000/?overlay=1
echo Keep this window open while playing. Press Ctrl+C to stop.
echo.
.venv\Scripts\python.exe -m uvicorn backend.app:app --host 127.0.0.1 --port 8000
goto :eof
:error
echo.
echo Could not start TetLive. See the message above.
pause
