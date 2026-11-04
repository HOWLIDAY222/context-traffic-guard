@echo off
setlocal DisableDelayedExpansion
if defined CTG_NODE (
  "%CTG_NODE%" -e "process.exit(Number(process.versions.node.split('.')[0])>=24?0:1)" >nul 2>&1
  if not errorlevel 1 (
    "%CTG_NODE%" --no-warnings "%~dp0scripts\setup.mjs" %*
    exit /b
  )
)
node.exe -e "process.exit(Number(process.versions.node.split('.')[0])>=24?0:1)" >nul 2>&1
if not errorlevel 1 (
  node.exe --no-warnings "%~dp0scripts\setup.mjs" %*
  exit /b
)
set "CTG_RUNTIME=%USERPROFILE%\.context-traffic-guard\runtime"
for /d %%V in ("%CTG_RUNTIME%\node-v24.*-win-*") do for /d %%P in ("%%~fV\node-v24.*-win-*") do (
  if exist "%%~fP\node.exe" (
    "%%~fP\node.exe" -e "process.exit(Number(process.versions.node.split('.')[0])>=24?0:1)" >nul 2>&1
    if not errorlevel 1 (
      set "CTG_NODE=%%~fP\node.exe"
      goto ctg_run
    )
  )
)
set "CTG_ARCH="
if /i "%PROCESSOR_ARCHITECTURE%"=="AMD64" set "CTG_ARCH=x64"
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "CTG_ARCH=arm64"
if /i "%PROCESSOR_ARCHITEW6432%"=="AMD64" set "CTG_ARCH=x64"
if /i "%PROCESSOR_ARCHITEW6432%"=="ARM64" set "CTG_ARCH=arm64"
if not defined CTG_ARCH goto ctg_fail
if not exist "%SystemRoot%\System32\curl.exe" goto ctg_fail
if not exist "%SystemRoot%\System32\tar.exe" goto ctg_fail
if not exist "%CTG_RUNTIME%" mkdir "%CTG_RUNTIME%"
set "CTG_WORK=%CTG_RUNTIME%\download-%RANDOM%-%RANDOM%"
if exist "%CTG_WORK%" goto ctg_fail
mkdir "%CTG_WORK%"
if errorlevel 1 goto ctg_fail
echo Preparing a private Node.js 24 runtime from nodejs.org. System PATH is unchanged.
"%SystemRoot%\System32\curl.exe" --fail --silent --show-error --proto "=https" --tlsv1.2 --max-time 60 "https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt" -o "%CTG_WORK%\SHASUMS256.txt"
if errorlevel 1 goto ctg_fail
rem Normalize the official LF checksum list for FINDSTR /X on Windows.
for /f "usebackq delims=" %%L in ("%CTG_WORK%\SHASUMS256.txt") do >>"%CTG_WORK%\checksums.txt" echo(%%L
"%SystemRoot%\System32\findstr.exe" /R /X /C:"[0-9a-f][0-9a-f]*  node-v24\.[0-9][0-9]*\.[0-9][0-9]*-win-%CTG_ARCH%\.zip" "%CTG_WORK%\checksums.txt" > "%CTG_WORK%\selected.txt"
set "CTG_MATCHES=0"
for /f "usebackq tokens=1,2" %%H in ("%CTG_WORK%\selected.txt") do (
  set "CTG_EXPECTED=%%H"
  set "CTG_FILENAME=%%I"
  set /a CTG_MATCHES+=1 >nul
)
if not "%CTG_MATCHES%"=="1" goto ctg_fail
if "%CTG_EXPECTED:~63,1%"=="" goto ctg_fail
if not "%CTG_EXPECTED:~64,1%"=="" goto ctg_fail
for /f "tokens=2 delims=-" %%V in ("%CTG_FILENAME%") do set "CTG_RELEASE=%%V"
"%SystemRoot%\System32\curl.exe" --fail --silent --show-error --proto "=https" --tlsv1.2 --max-time 300 "https://nodejs.org/dist/%CTG_RELEASE%/%CTG_FILENAME%" -o "%CTG_WORK%\archive.zip"
if errorlevel 1 goto ctg_fail
"%SystemRoot%\System32\certutil.exe" -hashfile "%CTG_WORK%\archive.zip" SHA256 > "%CTG_WORK%\hash.txt"
if errorlevel 1 goto ctg_fail
"%SystemRoot%\System32\findstr.exe" /R /X /C:"[0-9a-fA-F][0-9a-fA-F]*" "%CTG_WORK%\hash.txt" > "%CTG_WORK%\digest.txt"
set "CTG_ACTUAL="
for /f "usebackq" %%H in ("%CTG_WORK%\digest.txt") do set "CTG_ACTUAL=%%H"
if /i not "%CTG_ACTUAL%"=="%CTG_EXPECTED%" goto ctg_fail
set "CTG_PACKAGE=%CTG_FILENAME:~0,-4%"
set "CTG_DEST=%CTG_RUNTIME%\%CTG_PACKAGE%-%RANDOM%-%RANDOM%"
if exist "%CTG_DEST%" goto ctg_fail
mkdir "%CTG_DEST%"
if errorlevel 1 goto ctg_fail
"%SystemRoot%\System32\tar.exe" -xf "%CTG_WORK%\archive.zip" -C "%CTG_DEST%"
if errorlevel 1 goto ctg_fail
set "CTG_NODE=%CTG_DEST%\%CTG_PACKAGE%\node.exe"
"%CTG_NODE%" -e "process.exit(Number(process.versions.node.split('.')[0])>=24?0:1)" >nul 2>&1
if errorlevel 1 goto ctg_fail
del /q "%CTG_WORK%\archive.zip" "%CTG_WORK%\SHASUMS256.txt" "%CTG_WORK%\selected.txt" "%CTG_WORK%\checksums.txt" "%CTG_WORK%\hash.txt" "%CTG_WORK%\digest.txt" >nul 2>&1
rmdir "%CTG_WORK%" >nul 2>&1
:ctg_run
"%CTG_NODE%" --no-warnings "%~dp0scripts\setup.mjs" %*
exit /b
:ctg_fail
echo Context Guard could not prepare its runtime. Ask your AI agent to use an available Node.js 24 runtime, then run scripts/setup.mjs.
if "%~1"=="" pause
exit /b 1
