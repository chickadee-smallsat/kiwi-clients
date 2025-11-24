@echo off
setlocal enabledelayedexpansion

:: ------------------------------------------------
:: CONFIGURATION — CHANGE THESE
:: ------------------------------------------------
set "REPO_URL=https://github.com/chickadee-smallsat/kiwi-mainboard-clients.git"
for /f "usebackq delims=" %%D in (`powershell -NoProfile -Command "[Environment]::GetFolderPath('Desktop')"`) do set "DESKTOP_DIR=%%D"
set "REPO_DIR=%DESKTOP_DIR%\kiwi-mainboard-clients"

set "ENV_NAME=kiwi"
set "PY_SCRIPT=%REPO_DIR%\python-client\app.py"
set "SHORTCUT_NAME=Kiwi-Client.lnk"

set "GIT_EXE=%PROGRAMFILES%\Git\bin\git.exe"
set "PYTHON_EXE=%USERPROFILE%\Miniconda3\python.exe"

:: ------------------------------------------------
echo Installing Git with winget...
echo ------------------------------------------------
winget install --id Git.Git -e --silent
echo Git installed.
echo.

:: ------------------------------------------------
echo Installing Miniconda with winget...
echo ------------------------------------------------
winget install --id Anaconda.Miniconda3 -e --silent
echo Miniconda installed.
echo.

:: ------------------------------------------------
echo Initializing conda...
echo ------------------------------------------------
call "%USERPROFILE%\Miniconda3\Scripts\conda.exe" init
call "%USERPROFILE%\Miniconda3\Scripts\activate.bat"

:: ------------------------------------------------
echo Cloning git repo...
echo ------------------------------------------------

if not exist "%REPO_DIR%" (
    "%GIT_EXE%" clone "%REPO_URL%" "%REPO_DIR%"
) else (
    echo Repo already exists, pulling latest...
    cd "%REPO_DIR%"
    "%GIT_EXE%" pull
)

:: ------------------------------------------------
echo Installing requirements...
echo ------------------------------------------------
if exist "%REPO_DIR%\python-client\requirements.txt" (
    "%PYTHON_EXE%" -m pip install -r "%REPO_DIR%\python-client\requirements.txt"
)

:: ------------------------------------------------
echo Creating desktop shortcut...
echo ------------------------------------------------

set "SHORTCUT=%DESKTOP_DIR%\%SHORTCUT_NAME%"

powershell -NoProfile -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut('%SHORTCUT%'); $s.TargetPath = '%PYTHON_EXE%'; $s.Arguments = '""%PY_SCRIPT%""'; $s.WorkingDirectory = '%REPO_DIR%'; $s.IconLocation = '%PYTHON_EXE%'; $s.Save()"

echo Shortcut created on Desktop: %SHORTCUT%
echo.

echo ------------------------------------------------
echo SETUP COMPLETE
echo ------------------------------------------------
pause