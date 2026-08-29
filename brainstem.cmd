@echo off
setlocal
rem brainstem.cmd -- one-command launcher. All logic lives in src\cli\brainstem.ts; this
rem only makes sure node + docker exist and dependencies are installed, then delegates.
rem Set BRAINSTEM_SKIP_INSTALL=1 to skip the dependency-install step entirely (used by
rem the launcher test, so a stale-lockfile check never rewrites node_modules mid-suite).
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 24 is required. Install: winget install OpenJS.NodeJS.LTS & exit /b 1)
for /f "delims=" %%v in ('node -p "process.versions.node.split('.')[0]"') do set MAJOR=%%v
if %MAJOR% LSS 24 (echo Node.js %MAJOR% found; version 24 or newer is required. & exit /b 1)
where docker >nul 2>nul || (echo Docker Desktop is required: https://docs.docker.com/desktop/ & exit /b 1)
if "%BRAINSTEM_SKIP_INSTALL%"=="1" goto :after_install
rem node_modules\.bin\vitest present means a developer checkout with devDependencies
rem installed; npm ci --omit=dev would delete every one of them. Install the full
rem tree there and the runtime-only tree everywhere else. Comments stay OUT of the
rem parenthesized block below: cmd.exe parses a whole block at once and rem lines
rem inside one are a well-known way to break it.
node -e "function s(p){try{return require('fs').statSync(p).mtimeMs}catch(e){return -1}};process.exit(Math.sign(s('package-lock.json')-s('node_modules/.package-lock.json'))===1?1:0)"
if errorlevel 1 (
  echo Installing dependencies...
  if exist "node_modules\.bin\vitest" (
    call npm ci --no-audit --no-fund --loglevel=error || exit /b 1
  ) else (
    call npm ci --omit=dev --no-audit --no-fund --loglevel=error || exit /b 1
  )
)
:after_install
node src\cli\brainstem.ts %*
exit /b %ERRORLEVEL%
