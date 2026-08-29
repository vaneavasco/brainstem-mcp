@echo off
setlocal
rem brainstem.cmd -- one-command launcher. All logic lives in src\cli\brainstem.ts; this
rem only makes sure node + docker exist and dependencies are installed, then delegates.
rem Set BRAINSTEM_SKIP_INSTALL=1 to skip the dependency-install step entirely (used by
rem the launcher test, so a stale-lockfile check never runs npm ci mid-suite).
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 24 is required. Install: winget install OpenJS.NodeJS.LTS & exit /b 1)
for /f "delims=" %%v in ('node -p "process.versions.node.split('.')[0]"') do set MAJOR=%%v
if %MAJOR% LSS 24 (echo Node.js %MAJOR% found; version 24 or newer is required. & exit /b 1)
where docker >nul 2>nul || (echo Docker Desktop is required: https://docs.docker.com/desktop/ & exit /b 1)
if "%BRAINSTEM_SKIP_INSTALL%"=="1" goto :after_install
node -e "function s(p){try{return require('fs').statSync(p).mtimeMs}catch(e){return -1}};process.exit(Math.sign(s('package-lock.json')-s('node_modules/.package-lock.json'))===1?1:0)"
if errorlevel 1 (
  echo Installing dependencies...
  call npm ci --omit=dev --silent --no-audit --no-fund || exit /b 1
)
:after_install
node src\cli\brainstem.ts %*
exit /b %ERRORLEVEL%
