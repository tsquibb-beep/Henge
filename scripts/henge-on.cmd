@echo off
rem Henge deploy / switch back on.
rem Copies henge.js from this repo into Spicetify's Extensions folder, registers
rem it and re-applies. Safe to run repeatedly. Pass /nopause to skip the pause.
setlocal
set "SPICETIFY=%LOCALAPPDATA%\spicetify\spicetify.exe"
set "EXTDIR=%APPDATA%\spicetify\Extensions"
if not exist "%SPICETIFY%" (
    echo spicetify.exe not found at "%SPICETIFY%"
    goto :end
)
copy /Y "%~dp0..\henge.js" "%EXTDIR%\henge.js" >nul || (
    echo Could not copy henge.js to "%EXTDIR%"
    goto :end
)
rem Remove then add, so the extensions list never gets a duplicate entry.
"%SPICETIFY%" config extensions henge.js-
"%SPICETIFY%" config extensions henge.js
"%SPICETIFY%" apply
echo.
echo Henge deployed. Restart Spotify if it did not relaunch on its own.
echo Ctrl+Alt+H toggles the layout without a restart.
:end
if /i not "%~1"=="/nopause" pause
