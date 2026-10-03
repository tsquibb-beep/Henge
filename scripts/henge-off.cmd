@echo off
rem Henge emergency off switch.
rem Unloads henge.js from Spicetify and re-applies. Sleek, Marketplace and every
rem other extension are left alone. Pass /nopause to skip the final pause.
setlocal
set "SPICETIFY=%LOCALAPPDATA%\spicetify\spicetify.exe"
if not exist "%SPICETIFY%" (
    echo spicetify.exe not found at "%SPICETIFY%"
    goto :end
)
"%SPICETIFY%" config extensions henge.js-
"%SPICETIFY%" apply
echo.
echo Henge unloaded. Restart Spotify if it did not relaunch on its own.
:end
if /i not "%~1"=="/nopause" pause
