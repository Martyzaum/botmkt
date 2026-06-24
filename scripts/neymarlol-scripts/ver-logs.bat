@echo off
rem ====================================================================
rem  VER-LOGS (cmd puro) - abre uma janela CMD por slot seguindo o log
rem  que o supervisor grava em Desktop\_logs\slot-<N>.log.
rem
rem    ver-logs.bat          -> 16 janelas
rem    ver-logs.bat 4        -> 4 janelas
rem
rem  Cada janela so redesenha quando o log muda (Ctrl+C pra sair).
rem ====================================================================
setlocal enabledelayedexpansion
set "LOGS=%USERPROFILE%\Desktop\_logs"
if /i "%~1"=="_tail" goto :tail

set "N=%~1"
if "%N%"=="" set "N=16"
if not exist "%LOGS%" mkdir "%LOGS%" >nul 2>&1
for /l %%i in (1,1,%N%) do (
  if not exist "%LOGS%\slot-%%i.log" type nul > "%LOGS%\slot-%%i.log"
  start "botlog %%i" cmd /k call "%~f0" _tail %%i
)
echo Abertas %N% janela(s) cmd seguindo %LOGS%\slot-*.log
exit /b

:tail
set "F=%LOGS%\slot-%~2.log"
title botlog %~2
set "sz="
:loop
set "cur="
for %%A in ("%F%") do set "cur=%%~zA"
if not "!cur!"=="!sz!" (
  cls
  echo ===== slot %~2 =====
  type "%F%" 2>nul
  set "sz=!cur!"
)
timeout /t 2 /nobreak >nul
goto loop
