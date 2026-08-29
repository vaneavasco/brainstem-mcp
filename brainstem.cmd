@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 24 is required. Install: winget install OpenJS.NodeJS.LTS & exit /b 1)
for /f "delims=" %%v in ('node -p "process.versions.node.split('.')[0]"') do set MAJOR=%%v
if %MAJOR% LSS 24 (echo Node.js %MAJOR% found; version 24 or newer is required. & exit /b 1)
where docker >nul 2>nul || (echo Docker Desktop is required: https://docs.docker.com/desktop/ & exit /b 1)
if not exist node_modules\.package-lock.json (
  echo Installing dependencies...
  call npm ci --omit=dev --silent --no-audit --no-fund || exit /b 1
)
node src\cli\brainstem.ts %*
exit /b %ERRORLEVEL%
