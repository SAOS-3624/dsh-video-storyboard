@echo off
REM Start Edge with the DevTools port, so the storyboard plugin can read the
REM real playback position (video.currentTime) and the page URL.
REM
REM   start-edge-debug.cmd          uses port 9333
REM   start-edge-debug.cmd 9444     uses another port
REM
REM Why 9333 and not 9222: 9222 is the DevTools convention and other Electron
REM apps (WorkBuddy among them) grab it. Connecting there reads THEIR window.
REM
REM This starts a SEPARATE window with its own profile. Your normal Edge is
REM untouched and can stay open.

setlocal
set PORT=%~1
if "%PORT%"=="" set PORT=9333

set "PROFILE=%USERPROFILE%\.dsh\edge-watch"
set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" (
  echo Edge not found. Install it, or start your browser manually with:
  echo   msedge.exe --remote-debugging-port=%PORT%
  exit /b 1
)

REM --user-data-dir is MANDATORY: Chromium refuses to open the DevTools port on
REM the default profile (a security fix). So this window uses its own profile -
REM log in to Bilibili once inside it, and it will remember.
echo Starting a dedicated Edge window on port %PORT%
echo Profile: %PROFILE%
if not exist "%PROFILE%" mkdir "%PROFILE%"
start "" "%EDGE%" --remote-debugging-port=%PORT% --user-data-dir="%PROFILE%" --no-first-run --no-default-browser-check

echo.
echo Now tell the plugin about the port. Put this in %USERPROFILE%\.dsh\video.json:
echo   { "browserPort": %PORT% }
echo.
echo Then restart DSH once. After that, every video you open is picked up
echo automatically - no links, no title search.
endlocal
