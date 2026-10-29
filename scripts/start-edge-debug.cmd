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
REM Close every Edge window first, otherwise the new flag is ignored and the
REM already-running instance just opens a tab.

setlocal
set PORT=%~1
if "%PORT%"=="" set PORT=9333

set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" (
  echo Edge not found. Install it, or start your browser manually with:
  echo   msedge.exe --remote-debugging-port=%PORT%
  exit /b 1
)

echo Starting Edge with --remote-debugging-port=%PORT%
start "" "%EDGE%" --remote-debugging-port=%PORT%

echo.
echo Now tell the plugin about the port. Put this in %USERPROFILE%\.dsh\video.json:
echo   { "browserPort": %PORT% }
echo.
echo Then restart DSH once. After that, every video you open is picked up
echo automatically - no links, no title search.
endlocal
